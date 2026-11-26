import { Prisma } from "@prisma/client";
import { resolveDefaultOrganizationId } from "../../src/authorization/default-organization";

/**
 * corrections 接口/集成测试专用造数（AGENTS.md：测试工具进 test/helpers，禁止 spec 间复制）。
 *
 * M7「资金使用」模块由并行开发交付，使用记录尚无稳定录入接口——本文件按方案 §10
 * 契约①「使用创建必须写 UsageRecord(version=1) + UsageLotAllocation + 扣减
 * PlanAllocation.usedAmount + Account.balance」直插数据行，模拟 M7 落库效果，
 * 供更正链路（重放重建/V1~V3 校验）测试使用。M7 接口稳定后可替换为 API 造数。
 */

/** seedUsageRecord 入参：FIFO 分摊明细（lotId + 消耗数量；cost = 数量 × 批次 unitCost） */
export interface SeedUsageInput {
	userId: string;
	organizationId?: string;
	planId: string;
	currencyCode: string;
	amount: string;
	usedAt: Date;
	allocations: Array<{ lotId: string; quantity: string }>;
}

/**
 * 直插一笔使用记录及其全部联动（与 M7 契约①一致）：
 * - UsageRecord(version=1)
 * - UsageLotAllocation（逐批次，cost = quantity × unitCost 全精度）
 * - CostLot.remainingQty 扣减
 * - PlanAllocation.usedAmount 累加（无分配行时跳过——直插场景由调用方保证一致性）
 * - Account.balance 扣减（无账户行时跳过）
 * 返回 usageId。
 */
export async function seedUsageRecord(
	prisma: Prisma.TransactionClient,
	input: SeedUsageInput,
): Promise<string> {
	const organizationId =
		input.organizationId ??
		(await resolveDefaultOrganizationId(prisma, input.userId));
	if (!organizationId) {
		throw new Error(`seedUsageRecord(${input.userId}): 未找到默认组织`);
	}
	const amount = new Prisma.Decimal(input.amount);
	const usage = await prisma.usageRecord.create({
		data: {
			organizationId,
			createdById: input.userId,
			planId: input.planId,
			currencyCode: input.currencyCode,
			amount,
			usedAt: input.usedAt,
		},
	});
	let totalCost = new Prisma.Decimal(0);
	for (const allocation of input.allocations) {
		const lot = await prisma.costLot.findUnique({
			where: { id: allocation.lotId },
		});
		if (!lot) {
			throw new Error(`seedUsageRecord：批次不存在 ${allocation.lotId}`);
		}
		const quantity = new Prisma.Decimal(allocation.quantity);
		const cost = quantity.mul(lot.unitCost);
		totalCost = totalCost.add(cost);
		await prisma.usageLotAllocation.create({
			data: {
				usageId: usage.id,
				lotId: lot.id,
				quantity,
				cost,
			},
		});
		await prisma.costLot.update({
			where: { id: lot.id },
			data: { remainingQty: { decrement: quantity } },
		});
	}
	await prisma.planAllocation.updateMany({
		where: { planId: input.planId },
		data: { usedAmount: { increment: amount } },
	});
	await prisma.account.updateMany({
		where: { organizationId, currencyCode: input.currencyCode },
		data: { balance: { decrement: amount } },
	});
	void totalCost; // 成本聚合由 UsageLotAllocation 行承载（account.ledger 按 usageId 聚合）
	return usage.id;
}

/** seedPlanWithAllocationRow 入参 */
export interface SeedPlanInput {
	userId: string;
	organizationId?: string;
	targetCurrency: string;
	targetAmount: string;
	allocatedAmount: string;
	/** 计划状态（默认 ACTIVE；V4/已完成场景直插 COMPLETED/CANCELLED） */
	status?: string;
}

/**
 * 直插计划 + 1:1 分配行（usedAmount = 0）：绕开 plan 接口的排期/日期约束，
 * 供更正测试构造「已有分配」前置（V2 分配冲突 / 使用更正分配联动）。
 */
export async function seedPlanWithAllocationRow(
	prisma: Prisma.TransactionClient,
	input: SeedPlanInput,
): Promise<{ planId: string }> {
	const organizationId =
		input.organizationId ??
		(await resolveDefaultOrganizationId(prisma, input.userId));
	if (!organizationId) {
		throw new Error(`seedPlanWithAllocationRow(${input.userId}): 未找到默认组织`);
	}
	const plan = await prisma.plan.create({
		data: {
			organizationId,
			createdById: input.userId,
			targetCurrency: input.targetCurrency,
			targetAmount: new Prisma.Decimal(input.targetAmount),
			// latestPrepDate 为 NOT NULL：更正测试不读排期，取使用日期前 30 天占位
			expectUseDate: new Date(Date.now() + 30 * 86_400_000),
			latestPrepDate: new Date(Date.now() + 27 * 86_400_000),
			status: input.status ?? "ACTIVE",
		},
	});
	await prisma.planAllocation.create({
		data: {
			planId: plan.id,
			amount: new Prisma.Decimal(input.allocatedAmount),
			usedAmount: new Prisma.Decimal(0),
		},
	});
	return { planId: plan.id };
}

/**
 * 直插初始持仓 + INITIAL 成本批次 + 账户（绕开 onboarding 取价链路）：
 * 报价三元组显式给定（金额更正「沿用原报价」断言依赖确定的原值）。
 */
export async function seedInitialHolding(
	prisma: Prisma.TransactionClient,
	input: {
		userId: string;
		currencyCode: string;
		amount: string;
		rate: string;
		cost: string;
		confirmedAt: Date;
		/** 批次取得时刻（onboarding 写侧口径 = 账本起点日）；缺省 = confirmedAt */
		acquiredAt?: Date;
		/** ToB R1 租户列；缺省解析 userId 的默认组织 */
		organizationId?: string;
	},
): Promise<{ holdingId: string }> {
	const amount = new Prisma.Decimal(input.amount);
	const organizationId =
		input.organizationId ??
		(await resolveDefaultOrganizationId(prisma, input.userId));
	if (!organizationId) {
		throw new Error(`seedInitialHolding(${input.userId}): 未找到默认组织`);
	}
	const holding = await prisma.initialHolding.create({
		data: {
			organizationId,
			createdById: input.userId,
			currencyCode: input.currencyCode,
			amount,
			rate: new Prisma.Decimal(input.rate),
			rawRate: new Prisma.Decimal(input.rate),
			rateSource: "fixture",
			rateObservedAt: input.confirmedAt,
			cost: new Prisma.Decimal(input.cost),
			confirmedAt: input.confirmedAt,
		},
	});
	await prisma.costLot.create({
		data: {
			organizationId,
			currencyCode: input.currencyCode,
			sourceType: "INITIAL",
			sourceId: holding.id,
			quantity: amount,
			remainingQty: amount,
			unitCost: new Prisma.Decimal(input.rate),
			totalCost: new Prisma.Decimal(input.cost),
			acquiredAt: input.acquiredAt ?? input.confirmedAt,
		},
	});
	await prisma.account.upsert({
		where: {
			organizationId_currencyCode: {
				organizationId,
				currencyCode: input.currencyCode,
			},
		},
		update: { balance: { increment: amount } },
		create: {
			organizationId,
			createdById: input.userId,
			currencyCode: input.currencyCode,
			balance: amount,
		},
	});
	return { holdingId: holding.id };
}
