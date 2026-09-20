/**
 * 报告域测试数据工具（reports 技术方案 §10，test/helpers，禁止 spec 间复制）。
 *
 * M7/M8 未上线，使用分摊事实无法经 API 产生——本 helper 直插 DB 构造
 * UsageRecord + UsageLotAllocation + CostLot（PURCHASE 含关联 Transaction）
 * + Correction（模拟 M8 更正留痕），供接口/集成测试自行种分摊数据（方案 §10 前言）。
 *
 * CostLot 口径对齐 account-calculator.buildPurchaseLot：
 * totalCost = principal + (fee ?? 0)、unitCost = totalCost ÷ quantity
 * （toFixed(10) 与 Decimal(20,10) 列一致）。
 *
 * 清理：全部业务行随 cleanupUser（prisma.user.delete 级联）删除，
 * 无孤儿残留（UsageLotAllocation 无 FK，但只挂在测试用户的 UsageRecord 链上）。
 */
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../src/prisma/prisma.service";

/** 默认锚定时间（断言不依赖真实时钟，与 plan-test-helper 显式日期先例一致） */
export const SEED_ACQUIRED_AT = new Date("2026-01-01T00:00:00.000Z");
export const SEED_USED_AT = new Date("2026-01-02T00:00:00.000Z");
export const SEED_CORRECTED_AT = new Date("2026-02-01T00:00:00.000Z");

/** 确保 userSettings 存在（baseCurrency 成本列依赖） */
export async function ensureSettings(
	prisma: PrismaService,
	userId: string,
	baseCurrency = "CNY",
): Promise<void> {
	await prisma.userSettings.upsert({
		where: { userId },
		update: { baseCurrency },
		create: { userId, baseCurrency, locale: "zh-CN", region: "CN" },
	});
}

export interface SeedLotOptions {
	sourceType: "INITIAL" | "PURCHASE";
	quantity: string;
	/** 批次总成本对应的本金部分（INITIAL/PURCHASE 均必填，成本口径唯一来源） */
	principal: string;
	/** PURCHASE 手续费：字符串 = 明确、null = 未明确（feeAmount 列 NULL）；缺省 "0" */
	fee?: string | null;
	acquiredAt?: Date;
	/** PURCHASE 交易关联的计划（Transaction.planId，updatedAt 口径用） */
	planId?: string | null;
}

export interface SeededLot {
	lotId: string;
	/** PURCHASE 来源时为交易 id；INITIAL 时为 InitialHolding id */
	sourceId: string;
	totalCost: string;
	unitCost: string;
}

/**
 * 种一个成本批次（FIFO 事实）：INITIAL 建 InitialHolding + CostLot；
 * PURCHASE 建 Transaction（可带 planId）+ CostLot。成本按
 * totalCost = principal + (fee ?? 0) 落库，unitCost = totalCost ÷ quantity。
 */
export async function seedCostLot(
	prisma: PrismaService,
	userId: string,
	currencyCode: string,
	options: SeedLotOptions,
): Promise<SeededLot> {
	const acquiredAt = options.acquiredAt ?? SEED_ACQUIRED_AT;
	const totalCostDecimal = new Prisma.Decimal(options.principal).add(
		options.fee ?? 0,
	);
	const unitCostDecimal = totalCostDecimal.div(options.quantity);

	if (options.sourceType === "INITIAL") {
		const holding = await prisma.initialHolding.create({
			data: {
				userId,
				currencyCode,
				amount: options.quantity,
				// INITIAL 成本口径 = 记账起点汇率 × 数量；测试只关心 totalCost，
				// rate 仅为列约束填充（report 读侧不 join InitialHolding）
				rate: unitCostDecimal.toFixed(10),
				rawRate: unitCostDecimal.toFixed(10),
				rateSource: "MANUAL",
				rateObservedAt: acquiredAt,
				cost: totalCostDecimal.toFixed(4),
				confirmedAt: acquiredAt,
			},
		});
		const lot = await prisma.costLot.create({
			data: {
				userId,
				currencyCode,
				sourceType: "INITIAL",
				sourceId: holding.id,
				quantity: options.quantity,
				remainingQty: options.quantity,
				unitCost: unitCostDecimal.toFixed(10),
				totalCost: totalCostDecimal.toFixed(4),
				acquiredAt,
			},
		});
		return {
			lotId: lot.id,
			sourceId: holding.id,
			totalCost: totalCostDecimal.toFixed(4),
			unitCost: unitCostDecimal.toFixed(10),
		};
	}

	const transaction = await prisma.transaction.create({
		data: {
			userId,
			currencyCode,
			quantity: options.quantity,
			principalAmount: options.principal,
			// undefined = 未传（缺省 "0"）；null = 手续费未明确（feeAmount 列 NULL）
			feeAmount: options.fee === undefined ? "0" : options.fee,
			exchangeRate: unitCostDecimal.toFixed(10),
			rateSource: "MANUAL",
			rateObservedAt: acquiredAt,
			planId: options.planId ?? null,
			transactedAt: acquiredAt,
		},
	});
	const lot = await prisma.costLot.create({
		data: {
			userId,
			currencyCode,
			sourceType: "PURCHASE",
			sourceId: transaction.id,
			quantity: options.quantity,
			remainingQty: options.quantity,
			unitCost: unitCostDecimal.toFixed(10),
			totalCost: totalCostDecimal.toFixed(4),
			acquiredAt,
		},
	});
	return {
		lotId: lot.id,
		sourceId: transaction.id,
		totalCost: totalCostDecimal.toFixed(4),
		unitCost: unitCostDecimal.toFixed(10),
	};
}

export interface SeedUsageOptions {
	planId: string;
	currencyCode: string;
	amount: string;
	usedAt?: Date;
	/** FIFO 消耗明细（写侧 M7 职责的固化结果；cost 为全精度消耗成本） */
	allocations: { lotId: string; quantity: string; cost: string }[];
}

/** 种一条使用记录 + 分摊明细（返回 usageId） */
export async function seedUsage(
	prisma: PrismaService,
	userId: string,
	options: SeedUsageOptions,
): Promise<string> {
	const usedAt = options.usedAt ?? SEED_USED_AT;
	const usage = await prisma.usageRecord.create({
		data: {
			userId,
			planId: options.planId,
			currencyCode: options.currencyCode,
			amount: options.amount,
			usedAt,
			// @updatedAt 显式锚定（Prisma 允许覆盖自动值）：updatedAt 口径断言不依赖真实时钟
			updatedAt: usedAt,
		},
	});
	for (const allocation of options.allocations) {
		await prisma.usageLotAllocation.create({
			data: {
				usageId: usage.id,
				lotId: allocation.lotId,
				quantity: allocation.quantity,
				cost: allocation.cost,
			},
		});
	}
	return usage.id;
}

/** 模拟 M8 更正留痕（APPLIED；targetType USAGE / TRANSACTION） */
export async function seedCorrection(
	prisma: PrismaService,
	userId: string,
	targetType: "USAGE" | "TRANSACTION",
	targetId: string,
	createdAt: Date = SEED_CORRECTED_AT,
): Promise<void> {
	await prisma.correction.create({
		data: {
			userId,
			targetType,
			targetId,
			reason: "测试更正",
			beforeSnapshot: { amount: "1" },
			afterSnapshot: { amount: "2" },
			status: "APPLIED",
			createdAt,
			updatedAt: createdAt,
		},
	});
}

/** 直改计划状态（complete/cancel 接口校验严苛，测试直接落终态） */
export async function setPlanStatus(
	prisma: PrismaService,
	planId: string,
	status: "ACTIVE" | "COMPLETED" | "CANCELLED",
): Promise<void> {
	await prisma.plan.update({ where: { id: planId }, data: { status } });
}
