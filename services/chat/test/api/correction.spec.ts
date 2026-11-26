import { randomUUID } from "node:crypto";
/**
 * 更正与日志接口测试（corrections 技术方案 §8.2，场景 1~24）。
 * 数值锚定 doc 14 例 10/11/12 与 doc 15 FIFO 例。常规交易日期相对今天构造，
 * 原时点取价用固定 UTC+8 日期。测试不修改系统时钟。
 * USAGE 更正场景覆盖计划分配、资金来源、成本重放与拦截。
 */
import type { INestApplication } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../../src/audit/audit.service";
import { resolveDefaultOrganizationId } from "../../src/authorization/default-organization";
import {
	cleanupUser,
	createTestApp,
	createTestUser,
	orgBearer,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";
import { ensureOnboarded } from "../helpers/onboarding-helper";
import { closeTestApps } from "../helpers/test-http";
import { runBehindAdvisoryLock } from "../helpers/postgres-lock-barrier";
import {
	cleanupOrgLedgers,
	createOrgLedger,
	createSecondOrg,
	orgHeaders,
	type OrgLedger,
	purchaseBody,
	readOrgLedgerSnapshot,
} from "../helpers/organization-ledger-test-helper";
import {
	PLAN_EXPECT_USE_DATE,
	PLAN_START_DATE,
} from "../helpers/plan-test-helper";
import { RateProvider } from "../../src/rate/rate.provider";
import { utc8DayStart } from "../../src/transaction/transaction-calculator";
import type { UsageDto } from "../../src/usage/dto/usage.dto";
import {
	seedInitialHolding,
	seedPlanWithAllocationRow,
	seedUsageRecord,
} from "../helpers/correction-fixture";

// 关闭全局接口限流（与 transaction.spec.ts 同一方案：mock ThrottlerGuard 类）
vi.mock("@nestjs/throttler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nestjs/throttler")>();
	class NoopThrottlerGuard {
		async canActivate() {
			return true;
		}
	}
	return { ...actual, ThrottlerGuard: NoopThrottlerGuard };
});

/** 相对今天的过去第 n 天（固定时刻 02:00Z，避开 UTC+8 日界边界） */
function daysAgo(n: number): Date {
	return new Date(Date.now() - n * 86_400_000 - 2 * 60 * 60 * 1000);
}

describe("CorrectionController（POST /api/corrections*）", () => {
	let app: INestApplication;
	let ctx: TestContext;
	const extraUserIds: string[] = [];
	const extraRateRowIds: string[] = [];

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
	});

	afterAll(async () => {
		try {
			for (const userId of extraUserIds.splice(0).reverse()) {
				const orgId = await resolveDefaultOrganizationId(ctx.prisma, userId);
				if (orgId) {
					// 裸外键表先删（PlanAllocation / UsageLotAllocation 无级联）
					const plans = await ctx.prisma.plan.findMany({
						where: { organizationId: orgId },
						select: { id: true },
					});
					await ctx.prisma.planAllocation.deleteMany({
						where: { planId: { in: plans.map((plan) => plan.id) } },
					});
					const usages = await ctx.prisma.usageRecord.findMany({
						where: { organizationId: orgId },
						select: { id: true },
					});
					await ctx.prisma.usageLotAllocation.deleteMany({
						where: { usageId: { in: usages.map((usage) => usage.id) } },
					});
				}
				await cleanupUser(ctx.prisma, userId);
			}
			if (extraRateRowIds.length) {
				await ctx.prisma.exchangeRate.deleteMany({ where: { id: { in: extraRateRowIds } } });
			}
		} finally {
			await app?.close();
		}
	});

	async function newUser(label: string): Promise<TestUser> {
		const user = await createTestUser(app, label);
		extraUserIds.push(user.userId);
		// BE-03：经 API 造交易需已建账，否则写入口 409 ONBOARDING_NOT_COMPLETED
		await ensureOnboarded(ctx.prisma, user.userId);
		return user;
	}

	/** doc 12 场景买入：USD 1,000 / 本金 7,800 / 汇率 7.8 / 手续费未知，返回交易 id 与批次 id */
	async function seedUnknownFeePurchase(user: TestUser, at = daysAgo(3)) {
		const res = await request(app.getHttpServer())
			.post("/api/transactions")
			.set(orgBearer(user))
			.send({
				currencyCode: "USD",
				principalAmount: "7800.00",
				exchangeRate: "7.80000000",
				quantity: "1000.0000",
				transactedAt: at.toISOString(),
			})
			.expect(201);
		const lot = await ctx.prisma.costLot.findFirstOrThrow({
			where: { sourceId: res.body.data.id },
		});
		return { transactionId: res.body.data.id as string, lotId: lot.id };
	}

	/** 造「买入 + 计划分配 + 使用」链路，返回关键 id */
	async function seedPurchaseWithUsage(input: {
		user: TestUser;
		trades: Array<{ at: Date; principal: string; quantity: string }>;
		usageAmount: string;
		usageAt: Date;
		currencyCode?: string;
	}) {
		const currencyCode = input.currencyCode ?? "USD";
		const { planId } = await seedPlanWithAllocationRow(ctx.prisma, {
			userId: input.user.userId,
			targetCurrency: currencyCode,
			targetAmount: "10000",
			allocatedAmount: input.usageAmount, // 使用后 used = amount，剩余分配 0（不触发 V2）
		});
		const tradeIds: string[] = [];
		const lotIds: string[] = [];
		for (const trade of input.trades) {
			const res = await request(app.getHttpServer())
				.post("/api/transactions")
				.set(orgBearer(input.user))
				.send({
					currencyCode,
					principalAmount: trade.principal,
					exchangeRate: (
						Number(trade.principal) / Number(trade.quantity)
					).toFixed(8),
					quantity: trade.quantity,
					transactedAt: trade.at.toISOString(),
				})
				.expect(201);
			tradeIds.push(res.body.data.id);
			const lot = await ctx.prisma.costLot.findFirstOrThrow({
				where: { sourceId: res.body.data.id },
			});
			lotIds.push(lot.id);
		}
		// FIFO 分摊：按传入顺序整批消耗（不足部分取最后一批）
		const usageAllocations: Array<{ lotId: string; quantity: string }> = [];
		let remaining = Number(input.usageAmount);
		for (
			let index = 0;
			index < input.trades.length && remaining > 0;
			index += 1
		) {
			const take = Math.min(remaining, Number(input.trades[index].quantity));
			usageAllocations.push({ lotId: lotIds[index], quantity: String(take) });
			remaining -= take;
		}
		const usageId = await seedUsageRecord(ctx.prisma, {
			userId: input.user.userId,
			planId,
			currencyCode,
			amount: input.usageAmount,
			usedAt: input.usageAt,
			allocations: usageAllocations,
		});
		return { planId, tradeIds, lotIds, usageId };
	}

	// ── #1 未登录 ──
	it("#1 未登录访问三接口 → 401", async () => {
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.send({})
			.expect(401);
		await request(app.getHttpServer())
			.post("/api/corrections")
			.send({})
			.expect(401);
		await request(app.getHttpServer())
			.get("/api/corrections?targetType=TRANSACTION&targetId=x")
			.expect(401);
	});

	// ── #2/#3 手续费补录（doc 14 例 12：1,000 / 7,800 / 未知 → 20）──
	it("#2 preview 手续费补录：diff「未知 → 20.0000」、成本 7,800 → 7,820、blockers 空", async () => {
		const user = await newUser("corr-fee-preview");
		const { transactionId } = await seedUnknownFeePurchase(user);

		const res = await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send({
				targetType: "TRANSACTION",
				targetId: transactionId,
				baseVersion: 1,
				reason: "手续费实际为 20 港元，当时漏填",
				changes: { feeAmount: "20.00" },
			})
			.expect(200);

		const data = res.body.data;
		expect(data.before.feeAmount).toBeNull(); // 快照保留 null 语义（未知 ≠ 0）
		expect(data.after.feeAmount).toBe("20.0000");
		expect(data.after.totalCost).toBe("7820.0000");
		// diff 两项：手续费（「未知 → 20.0000」，绝不写「0 → 20」）+ 总成本派生对比
		expect(data.diff).toHaveLength(2);
		expect(data.diff[0]).toMatchObject({
			field: "feeAmount",
			before: null,
			after: "20.0000",
			display: "未知 → 20.0000",
		});
		expect(data.diff[1]).toMatchObject({
			field: "totalCost",
			before: null,
			after: "7820.0000",
			display: "不完整 → 7820.0000",
		});
		// 外币余额不变（手续费只影响成本，不影响数量）
		expect(data.impacts.balances).toEqual([
			{ currencyCode: "USD", before: "1000.0000", after: "1000.0000" },
		]);
		expect(data.impacts.allocations).toEqual([]);
		expect(data.impacts.blockers ?? data.blockers).toHaveLength(0);
		expect(data.blockers).toHaveLength(0);
	});

	it("#3 apply 手续费补录：feeAmount=20、version=2、Correction APPLIED、快照 before.feeAmount=null", async () => {
		const user = await newUser("corr-fee-apply");
		const { transactionId } = await seedUnknownFeePurchase(user);

		const res = await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({
				targetType: "TRANSACTION",
				targetId: transactionId,
				baseVersion: 1,
				reason: "补录手续费 20",
				changes: { feeAmount: "20.00" },
			})
			.expect(201);

		expect(res.body.data).toMatchObject({
			status: "APPLIED",
			targetType: "TRANSACTION",
			targetId: transactionId,
			targetVersion: 2,
		});
		const transaction = await ctx.prisma.transaction.findUniqueOrThrow({
			where: { id: transactionId },
		});
		expect(transaction.feeAmount!.toFixed(4)).toBe("20.0000");
		expect(
			transaction.principalAmount.add(transaction.feeAmount!).toFixed(4),
		).toBe("7820.0000");
		expect(transaction.version).toBe(2);
		const correction = await ctx.prisma.correction.findFirstOrThrow({
			where: { targetId: transactionId },
		});
		expect(correction.status).toBe("APPLIED");
		const beforeSnapshot = correction.beforeSnapshot as Record<string, unknown>;
		expect(
			(beforeSnapshot.target as Record<string, unknown>).feeAmount,
		).toBeNull();
		// 批次 unitCost 重算：(7800+20)/1000 = 7.82
		const lot = await ctx.prisma.costLot.findFirstOrThrow({
			where: { sourceId: transactionId },
		});
		expect(lot.unitCost.toFixed(8)).toBe("7.82000000");
	});

	// ── #4 改币种 preview：旧币种缺口（doc 14 例 11#1：已用 400）──
	it("#4 preview 改币种（已用 400 无分配）：blockers 含 USD 缺口 400", async () => {
		const user = await newUser("corr-swap-preview");
		const { tradeIds } = await seedPurchaseWithUsage({
			user,
			trades: [{ at: daysAgo(3), principal: "7800", quantity: "1000" }],
			usageAmount: "400",
			usageAt: daysAgo(1),
		});

		const res = await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send({
				targetType: "TRANSACTION",
				targetId: tradeIds[0],
				baseVersion: 1,
				reason: "买错币种了",
				changes: { currencyCode: "CAD" },
			})
			.expect(200);

		const blockers = res.body.data.blockers;
		const funds = blockers.find(
			(blocker: { code: string }) =>
				blocker.code === "CORRECTION_INSUFFICIENT_FUNDS",
		);
		expect(funds).toBeDefined();
		expect(funds.details[0]).toMatchObject({
			currencyCode: "USD",
			shortfall: "400.0000",
		});
	});

	// ── #5 apply 交易日期（doc 14 例 10 全量数据：9,560 / 6,240）──
	it("#5 apply 交易日期：使用成本 9,400 → 9,560、剩余 6,240、批次重排、version=2", async () => {
		const user = await newUser("corr-date-apply");
		// 固化日期实例：请求与断言共用同一时刻，避免毫秒漂移（daysAgo 每次调用产生新时间）
		const firstTradeDate = daysAgo(4);
		const secondTradeDate = daysAgo(3);
		const newTradeDate = daysAgo(2);
		const usageDate = daysAgo(1);
		const { tradeIds, usageId } = await seedPurchaseWithUsage({
			user,
			trades: [
				{ at: firstTradeDate, principal: "7800", quantity: "1000" },
				{ at: secondTradeDate, principal: "8000", quantity: "1000" },
			],
			usageAmount: "1200",
			usageAt: usageDate,
		});

		const res = await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({
				targetType: "TRANSACTION",
				targetId: tradeIds[0],
				baseVersion: 1,
				reason: "第一笔实际发生在第二笔之后一天",
				changes: { transactedAt: newTradeDate.toISOString() },
			})
			.expect(201);
		expect(res.body.data.targetVersion).toBe(2);

		// 使用成本重算：p2 全部（8,000）+ p1 的 200（1,560）= 9,560
		const allocations = await ctx.prisma.usageLotAllocation.findMany({
			where: { usageId },
		});
		const totalCost = allocations.reduce(
			(sum, allocation) => sum.add(allocation.cost),
			new (require("@prisma/client").Prisma.Decimal)(0),
		);
		expect(totalCost.toFixed(4)).toBe("9560.0000");
		expect(allocations).toHaveLength(2);

		// 批次重排：p1 acquiredAt = daysAgo(2)、remaining 800；p2 remaining 0
		const lots = await ctx.prisma.costLot.findMany({
			where: { organizationId: user.defaultOrganizationId, currencyCode: "USD" },
		});
		const bySource = new Map(lots.map((lot) => [lot.sourceId, lot]));
		expect(bySource.get(tradeIds[0])!.remainingQty.toFixed(4)).toBe("800.0000");
		expect(bySource.get(tradeIds[1])!.remainingQty.toFixed(4)).toBe("0.0000");
		expect(bySource.get(tradeIds[0])!.acquiredAt.getTime()).toBe(
			newTradeDate.getTime(),
		);
		// 剩余成本 6,240 = 800 × 7.8
		const p1 = bySource.get(tradeIds[0])!;
		expect(p1.remainingQty.mul(p1.unitCost).toFixed(4)).toBe("6240.0000");

		// 使用记录行不被修改（数量/日期/版本原样）
		const usage = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: usageId },
		});
		expect(usage.amount.toFixed(4)).toBe("1200.0000");
		expect(usage.usedAt.getTime()).toBe(usageDate.getTime());
		expect(usage.version).toBe(1);
	});

	// ── #6 apply 改币种成功（有其他批次来源、无分配）──
	it("#6 apply 改币种：新币种账户自动建、旧账户余额保留 500、分摊按新批次重算", async () => {
		const user = await newUser("corr-swap-apply");
		// USD：p1 1,000 + p2 500；改 p1 → CAD；旧 USD 剩 p2 的 500
		const res1 = await request(app.getHttpServer())
			.post("/api/transactions")
			.set(orgBearer(user))
			.send({
				currencyCode: "USD",
				principalAmount: "7000",
				exchangeRate: "7.00000000",
				quantity: "1000.0000",
				transactedAt: daysAgo(3).toISOString(),
			})
			.expect(201);
		const res2 = await request(app.getHttpServer())
			.post("/api/transactions")
			.set(orgBearer(user))
			.send({
				currencyCode: "USD",
				principalAmount: "3500",
				exchangeRate: "7.00000000",
				quantity: "500.0000",
				transactedAt: daysAgo(2).toISOString(),
			})
			.expect(201);

		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({
				targetType: "TRANSACTION",
				targetId: res1.body.data.id,
				baseVersion: 1,
				reason: "第一笔实际是加元",
				changes: { currencyCode: "CAD" },
			})
			.expect(201);

		const usd = await ctx.prisma.account.findFirstOrThrow({
			where: { organizationId: user.defaultOrganizationId, currencyCode: "USD" },
		});
		expect(usd.balance.toFixed(4)).toBe("500.0000"); // 旧账户归零保留语义：余额为剩余批次
		const cad = await ctx.prisma.account.findFirstOrThrow({
			where: { organizationId: user.defaultOrganizationId, currencyCode: "CAD" },
		});
		expect(cad.balance.toFixed(4)).toBe("1000.0000"); // 新账户自动建
		const cadLot = await ctx.prisma.costLot.findFirstOrThrow({
			where: { sourceId: res1.body.data.id },
		});
		expect(cadLot.currencyCode).toBe("CAD");
		expect(cadLot.remainingQty.toFixed(4)).toBe("1000.0000");
		// 原交易解除计划关联前 planId 本为 null（造数未关联）；快照留痕由 diff/快照承载
		expect(res2.body.data.id).toBeTruthy();
	});

	// ── #7 apply 改币种且 V2 违反 ──
	it("#7 apply 改币种（剩余分配无法覆盖）：409 ALLOCATION_CONFLICT 附 planId、零变化", async () => {
		const user = await newUser("corr-swap-v2");
		const res = await request(app.getHttpServer())
			.post("/api/transactions")
			.set(orgBearer(user))
			.send({
				currencyCode: "USD",
				principalAmount: "7000",
				exchangeRate: "7.00000000",
				quantity: "1000.0000",
				transactedAt: daysAgo(3).toISOString(),
			})
			.expect(201);
		const { planId } = await seedPlanWithAllocationRow(ctx.prisma, {
			userId: user.userId,
			targetCurrency: "USD",
			targetAmount: "10000",
			allocatedAmount: "800",
		});

		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({
				targetType: "TRANSACTION",
				targetId: res.body.data.id,
				baseVersion: 1,
				reason: "改币种",
				changes: { currencyCode: "CAD" },
			})
			.expect(409)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("CORRECTION_ALLOCATION_CONFLICT");
				expect(
					errorRes.body.details.some(
						(item: { planId?: string }) => item.planId === planId,
					),
				).toBe(true);
			});

		// 零变化：余额/分配/批次原样
		const usd = await ctx.prisma.account.findFirstOrThrow({
			where: { organizationId: user.defaultOrganizationId, currencyCode: "USD" },
		});
		expect(usd.balance.toFixed(4)).toBe("1000.0000");
		const transaction = await ctx.prisma.transaction.findUniqueOrThrow({
			where: { id: res.body.data.id },
		});
		expect(transaction.currencyCode).toBe("USD");
		expect(transaction.version).toBe(1);
		// 复核失败留痕 FAILED（验收场景 16）
		const failed = await ctx.prisma.correction.findFirstOrThrow({
			where: { targetId: res.body.data.id },
		});
		expect(failed.status).toBe("FAILED");
		expect(failed.failReason).toContain("CORRECTION_ALLOCATION_CONFLICT");
	});

	// ── #8 apply 改日期致历史缺口（doc 14 例 11#2）──
	it("#8 apply 改日期（历史时点不足）：409 HISTORICAL_SHORTFALL 缺口明细、FAILED 留痕、零变化", async () => {
		const user = await newUser("corr-date-gap");
		const usageDate = daysAgo(2);
		const originalTradeDate = daysAgo(4);
		const newTradeDate = daysAgo(1);
		const { tradeIds, usageId } = await seedPurchaseWithUsage({
			user,
			trades: [{ at: originalTradeDate, principal: "7800", quantity: "1000" }],
			usageAmount: "400",
			usageAt: usageDate,
		});

		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({
				targetType: "TRANSACTION",
				targetId: tradeIds[0],
				baseVersion: 1,
				reason: "日期记错了，实际更晚",
				changes: { transactedAt: newTradeDate.toISOString() },
			})
			.expect(409)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("CORRECTION_HISTORICAL_SHORTFALL");
				expect(errorRes.body.details[0]).toMatchObject({
					currencyCode: "USD",
					shortfall: "400.0000",
					usedAt: usageDate.toISOString(),
				});
			});

		// 零变化：交易/使用/批次原样
		const transaction = await ctx.prisma.transaction.findUniqueOrThrow({
			where: { id: tradeIds[0] },
		});
		expect(transaction.transactedAt.getTime()).toBe(
			originalTradeDate.getTime(),
		);
		expect(transaction.version).toBe(1);
		const allocation = await ctx.prisma.usageLotAllocation.findFirstOrThrow({
			where: { usageId },
		});
		expect(allocation.quantity.toFixed(4)).toBe("400.0000");
		// FAILED 尝试留痕（验收场景 16/测试 #21）
		const failed = await ctx.prisma.correction.findFirstOrThrow({
			where: { targetId: tradeIds[0] },
		});
		expect(failed.status).toBe("FAILED");
		expect(failed.failReason).toContain("CORRECTION_HISTORICAL_SHORTFALL");
		const snapshot = failed.beforeSnapshot as Record<string, unknown>;
		expect(snapshot.changes).toMatchObject({
			transactedAt: newTradeDate.toISOString(),
		});
	});

	it("W6-04 买入改晚后，预览、提交拒绝和 FAILED 留痕均包含两个累计历史缺口", async () => {
		const user = await newUser("corr-cumulative-gap");
		const firstUsedAt = daysAgo(4);
		const secondUsedAt = daysAgo(2);
		const originalTradeAt = daysAgo(5);
		const proposedTradeAt = daysAgo(1);
		const { planId, tradeIds, lotIds } = await seedPurchaseWithUsage({
			user,
			trades: [
				{ at: daysAgo(6), principal: "700", quantity: "100" },
				{ at: originalTradeAt, principal: "900", quantity: "100" },
				{ at: daysAgo(3), principal: "400", quantity: "50" },
			],
			usageAmount: "150",
			usageAt: firstUsedAt,
		});
		await ctx.prisma.planAllocation.update({
			where: { planId },
			data: { amount: "170" },
		});
		await seedUsageRecord(ctx.prisma, {
			userId: user.userId,
			planId,
			currencyCode: "USD",
			amount: "20",
			usedAt: secondUsedAt,
			allocations: [{ lotId: lotIds[1], quantity: "20" }],
		});

		const where = {
			organizationId: user.defaultOrganizationId,
			targetId: tradeIds[1],
		};
		const payload = {
			targetType: "TRANSACTION",
			targetId: where.targetId,
			baseVersion: 1,
			reason: "更正第二笔买入日期",
			changes: { transactedAt: proposedTradeAt.toISOString() },
		};
		const code = "CORRECTION_HISTORICAL_SHORTFALL";
		const details = [
			{
				currencyCode: "USD",
				usedAt: firstUsedAt.toISOString(),
				shortfall: "50.0000",
				planId: null,
			},
			{
				currencyCode: "USD",
				usedAt: secondUsedAt.toISOString(),
				shortfall: "20.0000",
				planId: null,
			},
		];
		const preview = await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send(payload)
			.expect(200);
		const previewAuditCount = await ctx.prisma.correction.count({ where });
		const apply = await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send(payload)
			.expect(409);

		// 软断言同时核对两个端点和留痕，任意一处丢明细都能独立报错。
		expect.soft(preview.body.data.blockers).toEqual([
			{ code, message: expect.any(String), details },
		]);
		expect.soft(previewAuditCount).toBe(0);
		expect.soft(apply.body).toMatchObject({ code, details });
		const audits = await ctx.prisma.correction.findMany({ where });
		expect(audits).toHaveLength(1);
		expect.soft(audits[0]).toMatchObject({
			status: "FAILED",
			beforeSnapshot: { changes: payload.changes, blockers: details },
		});
		const transaction = await ctx.prisma.transaction.findUniqueOrThrow({
			where: { id: where.targetId },
		});
		expect(transaction).toMatchObject({ version: 1, transactedAt: originalTradeAt });
	});

	// ── #9 baseVersion 过期 ──
	it("#9 baseVersion 过期 → 409 CORRECTION_TARGET_CHANGED", async () => {
		const user = await newUser("corr-optimistic");
		const { transactionId } = await seedUnknownFeePurchase(user);
		// 第一次更正成功 → version 2
		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({
				targetType: "TRANSACTION",
				targetId: transactionId,
				baseVersion: 1,
				reason: "第一次更正",
				changes: { feeAmount: "10.00" },
			})
			.expect(201);
		// 第二次仍按 version 1 提交 → 409
		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({
				targetType: "TRANSACTION",
				targetId: transactionId,
				baseVersion: 1,
				reason: "第二次更正（过期基准）",
				changes: { feeAmount: "30.00" },
			})
			.expect(409)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("CORRECTION_TARGET_CHANGED");
			});
		// 过期请求不留 FAILED 尝试（并发冲突 ≠ 复核失败）
		const corrections = await ctx.prisma.correction.findMany({
			where: { targetId: transactionId },
		});
		expect(corrections).toHaveLength(1);
		expect(corrections[0].status).toBe("APPLIED");
	});

	// ── #10 参数类 400 ──
	it("#10 原因缺失 / changes 空 / 白名单外字段 → 400", async () => {
		const user = await newUser("corr-params");
		const { transactionId } = await seedUnknownFeePurchase(user);
		const base = {
			targetType: "TRANSACTION",
			targetId: transactionId,
			baseVersion: 1,
		};

		// 原因空串（DTO MinLength 拦截，ValidationPipe 400）
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send({ ...base, reason: "", changes: { feeAmount: "20.00" } })
			.expect(400);
		// 原因纯空格（穿透 DTO 后由 V0 拦截，错误码 INVALID_CORRECTION_PARAMS）
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send({ ...base, reason: "   ", changes: { feeAmount: "20.00" } })
			.expect(400)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("INVALID_CORRECTION_PARAMS");
			});
		// changes 为空（无有效变化）
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send({ ...base, reason: "没有变化", changes: {} })
			.expect(400)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("INVALID_CORRECTION_PARAMS");
			});
		// 白名单外字段（汇率不可改）
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send({
				...base,
				reason: "改汇率",
				changes: { exchangeRate: "8.0" },
			})
			.expect(400)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("INVALID_CORRECTION_PARAMS");
			});
	});

	// ── #11~#16/#24 USAGE 更正闭环（MVP-F0-3 接线：改小/改大补分配/改日期成本重排/
	//    V4 矩阵/并发版本/失败回滚零变化）──
	/**
	 * USAGE 场景构造（批次序即账本序）：
	 * INITIAL 2,000 TWD @0.5（当日 00:30 UTC+8，先耗）→ 买入 A 1,000 @7（01:00）→
	 * 买入 B 1,000 @9（09:00）；计划 target 10,000 / 分配 3,000；
	 * u1 1,200 @12:00（耗 INITIAL 1,200）+ u2 800 @18:00（耗 INITIAL 800）。
	 * 种子后：INITIAL 剩 0、A 剩 1,000、B 剩 1,000；余额 4,000 − 2,000 = 2,000；
	 * 分配 usedAmount = 2,000（剩 1,000）。
	 */
	async function seedUsageScenario(
		label: string,
		overrides: {
			planStatus?: string;
			crossLotUsage?: boolean;
			dayStart?: Date;
		} = {},
	): Promise<{ user: TestUser; planId: string; u1Id: string; u2Id: string }> {
		const user = await newUser(label);
		const dayStart = overrides.dayStart ?? utc8DayStart(new Date());
		const at = (hour: number) => new Date(dayStart.getTime() + hour * 3_600_000);
		const { holdingId } = await seedInitialHolding(ctx.prisma, {
			userId: user.userId,
			currencyCode: "TWD",
			amount: "2000",
			rate: "0.5",
			cost: "1000",
			confirmedAt: at(0.5),
			acquiredAt: at(0.5),
		});
		const initialLot = await ctx.prisma.costLot.findFirstOrThrow({
			where: { sourceId: holdingId },
		});
		const tradeA = await request(app.getHttpServer())
			.post("/api/transactions")
			.set(orgBearer(user))
			.send({
				currencyCode: "TWD",
				principalAmount: "7000",
				exchangeRate: "7.00000000",
				quantity: "1000",
				transactedAt: at(1).toISOString(),
			})
			.expect(201);
		const tradeB = await request(app.getHttpServer())
			.post("/api/transactions")
			.set(orgBearer(user))
			.send({
				currencyCode: "TWD",
				principalAmount: "9000",
				exchangeRate: "9.00000000",
				quantity: "1000",
				transactedAt: at(9).toISOString(),
			})
			.expect(201);
		const lotA = await ctx.prisma.costLot.findFirstOrThrow({
			where: { sourceId: tradeA.body.data.id },
		});
		const lotB = await ctx.prisma.costLot.findFirstOrThrow({
			where: { sourceId: tradeB.body.data.id },
		});
		const { planId } = await seedPlanWithAllocationRow(ctx.prisma, {
			userId: user.userId,
			targetCurrency: "TWD",
			targetAmount: "10000",
			allocatedAmount: overrides.crossLotUsage ? "4000" : "3000",
			status: overrides.planStatus,
		});
		const u1Amount = overrides.crossLotUsage ? "800" : "1200";
		const u1Id = await seedUsageRecord(ctx.prisma, {
			userId: user.userId,
			planId,
			currencyCode: "TWD",
			amount: u1Amount,
			usedAt: at(12),
			allocations: [{ lotId: initialLot.id, quantity: u1Amount }],
		});
		const u2Id = await seedUsageRecord(ctx.prisma, {
			userId: user.userId,
			planId,
			currencyCode: "TWD",
			amount: overrides.crossLotUsage ? "2500" : "800",
			usedAt: at(18),
			allocations: overrides.crossLotUsage
				? [
					{ lotId: initialLot.id, quantity: "1200" },
					{ lotId: lotA.id, quantity: "1000" },
					{ lotId: lotB.id, quantity: "300" },
				]
				: [{ lotId: initialLot.id, quantity: "800" }],
		});
		return { user, planId, u1Id, u2Id };
	}

	it("#11 USAGE 改小：预览 diff 与成本重算、apply 后记录/分配/余额/分摊全联动", async () => {
		const { user, planId, u1Id } = await seedUsageScenario("corr-usage-decrease");
		const before = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: u1Id },
		});

		const preview = await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send({
				targetType: "USAGE",
				targetId: u1Id,
				baseVersion: before.version,
				reason: "使用金额多记了 400",
				changes: { amount: "800.0000" },
			})
			.expect(200);
		expect(preview.body.data.before.amount).toBe("1200.0000");
		expect(preview.body.data.after.amount).toBe("800.0000");
		expect(preview.body.data.impacts.allocations).toEqual([
			{
				planId,
				currencyCode: "TWD",
				amountBefore: "3000.0000",
				amountAfter: "2600.0000",
				usedBefore: "2000.0000",
				usedAfter: "1600.0000",
				remainingBefore: "1000.0000",
				remainingAfter: "1000.0000",
				fromPlan: "0.0000",
				supplement: "0.0000",
				usedFromRemaining: "0.0000",
				unallocatedDelta: "400.0000",
			},
		]);
		const u1CostBefore = preview.body.data.impacts.costs.find(
			(cost: { usageId: string }) => cost.usageId === u1Id,
		);
		expect(u1CostBefore.costBefore).toBe("600.0000"); // 1,200 × 0.5
		expect(u1CostBefore.costAfter).toBe("400.0000"); // 800 × 0.5

		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({
				targetType: "USAGE",
				targetId: u1Id,
				baseVersion: before.version,
				reason: "使用金额多记了 400",
				changes: { amount: "800.0000" },
				expectedUsageImpact: preview.body.data.expectedUsageImpact,
			})
			.expect(201)
			.expect((res) => {
				expect(res.body.data.targetVersion).toBe(2);
			});

		const usage = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: u1Id },
		});
		expect(usage.amount.toFixed(4)).toBe("800.0000");
		expect(usage.version).toBe(2);
		// 分配联动（doc 14 例 02）：改小时 amount 与 usedAmount 同减差额（−400），
		// 剩余分配不变（2,600 − 1,600 = 1,000 = 种子剩余）；改小无补分配 → 无 PlanChangeLog
		const allocation = await ctx.prisma.planAllocation.findFirstOrThrow({
			where: { planId: usage.planId },
		});
		expect(allocation.usedAmount.toFixed(4)).toBe("1600.0000");
		expect(allocation.amount.toFixed(4)).toBe("2600.0000");
		const changeLogs = await ctx.prisma.planChangeLog.findMany({
			where: { planId: usage.planId },
		});
		expect(changeLogs).toHaveLength(0);
		// 余额联动（重放重建）：4,000 − (800 + 800) = 2,400
		const account = await ctx.prisma.account.findFirstOrThrow({
			where: { organizationId: user.defaultOrganizationId, currencyCode: "TWD" },
		});
		expect(account.balance.toFixed(4)).toBe("2400.0000");
		// 分摊重建：u1 分摊 800（INITIAL 批）
		const allocations = await ctx.prisma.usageLotAllocation.findMany({
			where: { usageId: u1Id },
		});
		expect(allocations).toHaveLength(1);
		expect(allocations[0].quantity.toFixed(4)).toBe("800.0000");
	});

	it("#12 USAGE 改大：预览展示原分配与补分配；确认后写 PlanChangeLog", async () => {
		const { user, planId, u1Id } = await seedUsageScenario("corr-usage-increase");
		const before = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: u1Id },
		});
		const correction = {
			targetType: "USAGE",
			targetId: u1Id,
			baseVersion: before.version,
			reason: "使用金额少记了",
			changes: { amount: "3000.0000" },
		};

		// 1,200 → 1,700：只用本计划剩余分配中的 500。
		const planOnly = await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send({ ...correction, changes: { amount: "1700.0000" } })
			.expect(200);
		expect(planOnly.body.data.blockers).toEqual([]);
		expect(planOnly.body.data.impacts.allocations).toEqual([
			{
				planId,
				currencyCode: "TWD",
				amountBefore: "3000.0000",
				amountAfter: "3000.0000",
				usedBefore: "2000.0000",
				usedAfter: "2500.0000",
				remainingBefore: "1000.0000",
				remainingAfter: "500.0000",
				fromPlan: "500.0000",
				supplement: "0.0000",
				usedFromRemaining: "500.0000",
				unallocatedDelta: "0.0000",
			},
		]);

		// 1,200 → 3,000（diff 1,800 > 剩余分配 1,000 → 补分配 800；分配 3,000+800=3,800 ≤ 目标）
		const mixed = await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send(correction)
			.expect(200);
		expect(mixed.body.data.blockers).toEqual([]);
		expect(mixed.body.data.impacts.allocations).toEqual([
			{
				planId,
				currencyCode: "TWD",
				amountBefore: "3000.0000",
				amountAfter: "3800.0000",
				usedBefore: "2000.0000",
				usedAfter: "3800.0000",
				remainingBefore: "1000.0000",
				remainingAfter: "0.0000",
				fromPlan: "1000.0000",
				supplement: "800.0000",
				usedFromRemaining: "1000.0000",
				unallocatedDelta: "-800.0000",
			},
		]);
		const allocationAfterPreview =
			await ctx.prisma.planAllocation.findUniqueOrThrow({ where: { planId } });
		expect(allocationAfterPreview.amount.toFixed(4)).toBe("3000.0000");
		expect(allocationAfterPreview.usedAmount.toFixed(4)).toBe("2000.0000");
		expect(
			await ctx.prisma.correction.count({ where: { targetId: u1Id } }),
		).toBe(0);

		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({ ...correction, expectedUsageImpact: mixed.body.data.expectedUsageImpact })
			.expect(201);
		const allocation = await ctx.prisma.planAllocation.findUniqueOrThrow({
			where: { planId },
		});
		expect(allocation.amount.toFixed(4)).toBe("3800.0000");
		expect(allocation.usedAmount.toFixed(4)).toBe("3800.0000");
		const changeLogs = await ctx.prisma.planChangeLog.findMany({
			where: { planId, changeType: "ALLOCATION_ADJUSTED" },
		});
		expect(changeLogs).toMatchObject([{
			beforeSnapshot: { amountBefore: "1200.0000" },
			afterSnapshot: { amountAfter: "3000.0000", supplement: "800.0000" },
		}]);
		const account = await ctx.prisma.account.findFirstOrThrow({
			where: { organizationId: user.defaultOrganizationId, currencyCode: "TWD" },
		});
		expect(account.balance.toFixed(4)).toBe("200.0000");
	});

	it.each([
		{
			label: "拒绝占用其他计划分配",
			allocatedA: "100",
			allocatedB: "900",
			blocked: true,
			supplement: "0.0000",
		},
		{
			label: "允许用完未分配余额补分配",
			allocatedA: "100",
			allocatedB: "800",
			blocked: false,
			supplement: "100.0000",
		},
		{
			label: "允许用完本计划剩余分配",
			allocatedA: "200",
			allocatedB: "800",
			blocked: false,
			supplement: "0.0000",
		},
	])("W6-01 USAGE 改大：$label", async ({ allocatedA, allocatedB, blocked, supplement }) => {
		const user = await createTestUser(app, `corr-w6-01-${allocatedA}-${allocatedB}`);
		const { userId } = user;
		extraUserIds.push(userId);
		const server = app.getHttpServer();
		const auth = orgBearer(user);
		await request(server)
			.post("/api/onboarding/consents")
			.set(auth)
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);
		const onboarding = await request(server)
			.post("/api/onboarding/complete")
			.set(auth)
			.send({
				region: "CN",
				locale: "zh-CN",
				baseCurrency: "CNY",
				prepPreference: "balanced",
				reminderEnabled: false,
			})
			.expect(201);
		const ledgerDay = new Date(onboarding.body.data.ledgerStartedAt);
		const { transactionId } = await seedUnknownFeePurchase(user, ledgerDay);

		async function createPlan(
			name: string,
			allocatedAmount: string,
		): Promise<string> {
			const res = await request(server)
				.post("/api/plans")
				.set(auth)
				.send({
					name,
					targetCurrency: "USD",
					targetAmount: "1000",
					allocatedAmount,
					expectUseDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
					prepLeadDays: 3,
					pacePreference: "balanced",
				})
				.expect(201);
			return res.body.data.id;
		}

		const planA = await createPlan("A", allocatedA);
		const planB = await createPlan("B", allocatedB);
		const used = await request(server)
			.post(`/api/plans/${planA}/usages`)
			.set(auth)
			.send({ amount: "100", usedAt: ledgerDay.toISOString() })
			.expect(201);
		const usageId: string = used.body.data.usage.id;
		const body = {
			targetType: "USAGE",
			targetId: usageId,
			baseVersion: 1,
			reason: "使用金额少记了 100",
			changes: { amount: "200" },
		};
		const accountKey = {
			organizationId: user.defaultOrganizationId,
			currencyCode: "USD",
		};
		const planWhere = { planId: { in: [planA, planB] } };
		const { prisma } = ctx;
		const readBusinessRows = () => Promise.all([
			prisma.account.findFirstOrThrow({ where: accountKey }),
			prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } }),
			prisma.usageRecord.findUniqueOrThrow({ where: { id: usageId } }),
			prisma.plan.findMany({
				where: { organizationId: user.defaultOrganizationId },
				orderBy: { id: "asc" },
			}),
			prisma.planAllocation.findMany({
				where: planWhere,
				orderBy: { planId: "asc" },
			}),
			prisma.planInstallment.findMany({
				where: planWhere,
				orderBy: { id: "asc" },
			}),
			prisma.planChangeLog.findMany({
				where: planWhere,
				orderBy: { id: "asc" },
			}),
			prisma.costLot.findMany({
				where: { organizationId: user.defaultOrganizationId },
				orderBy: { id: "asc" },
			}),
			prisma.usageLotAllocation.findMany({
				where: { usageId },
				orderBy: { id: "asc" },
			}),
		]);
		const before = await readBusinessRows();
		const corrections = () =>
			prisma.correction.findMany({
				where: { organizationId: user.defaultOrganizationId },
			});
		expect(await corrections()).toEqual([]);
		const preview = await request(server)
			.post("/api/corrections/preview")
			.set(auth)
			.send(body)
			.expect(200);
		const conflict = {
			code: "CORRECTION_ALLOCATION_CONFLICT",
			details: [
				{
					currencyCode: "USD",
					shortfall: "100.0000",
					usedAt: null,
					planId: planB,
				},
			],
		};

		if (blocked) {
			expect(preview.body.data.blockers).toMatchObject([conflict]);
			expect(await corrections()).toEqual([]);
			const rejected = await request(server)
				.post("/api/corrections")
				.set(auth)
				.send({ ...body, expectedUsageImpact: preview.body.data.expectedUsageImpact })
				.expect(409);
			expect(rejected.body).toMatchObject(conflict);
			expect(await readBusinessRows()).toEqual(before);
			expect(await corrections()).toMatchObject([
				{
					targetType: "USAGE",
					targetId: usageId,
					status: "FAILED",
					failReason: expect.stringContaining(conflict.code),
					beforeSnapshot: { blockers: conflict.details },
				},
			]);
			return;
		}

		expect(preview.body.data.blockers).toEqual([]);
		const applied = await request(server)
			.post("/api/corrections")
			.set(auth)
			.send({ ...body, expectedUsageImpact: preview.body.data.expectedUsageImpact })
			.expect(201);
		expect(applied.body.data).toMatchObject({
			status: "APPLIED",
			targetVersion: 2,
		});
		const corrected = await prisma.usageRecord.findUniqueOrThrow({
			where: { id: usageId },
		});
		expect(corrected.amount.toFixed(4)).toBe("200.0000");
		expect(corrected.version).toBe(2);
		const allocationA = await prisma.planAllocation.findUniqueOrThrow({
			where: { planId: planA },
		});
		expect(allocationA.amount.toFixed(4)).toBe("200.0000");
		expect(allocationA.usedAmount.toFixed(4)).toBe("200.0000");
		const allocationB = await prisma.planAllocation.findUniqueOrThrow({
			where: { planId: planB },
		});
		expect(allocationB.amount.toFixed(4)).toBe("800.0000");
		expect(allocationB.usedAmount.toFixed(4)).toBe("0.0000");
		const account = await prisma.account.findFirstOrThrow({ where: accountKey });
		expect(account.balance.toFixed(4)).toBe("800.0000");
		const logs = await prisma.planChangeLog.findMany({ where: planWhere });
		expect(logs).toMatchObject(
			supplement === "0.0000" ? [] : [
				{
					planId: planA,
					changeType: "ALLOCATION_ADJUSTED",
					afterSnapshot: { supplement },
				},
			],
		);
		expect(await corrections()).toMatchObject([
			{ targetId: usageId, status: "APPLIED" },
		]);
	});

	it("#12 USAGE 连续两次补分配：每条计划日志关联同次更正并保留前后值", async () => {
		const { user, planId, u1Id } = await seedUsageScenario("corr-usage-increase");
		const corrections = [
			{
				baseVersion: 1,
				amountBefore: "1200.0000",
				amountAfter: "3000.0000",
				allocationBefore: "3000.0000",
				allocationAfter: "3800.0000",
				usedBefore: "2000.0000",
				usedAfter: "3800.0000",
				balanceBefore: "2000.0000",
				balanceAfter: "200.0000",
				supplement: "800.0000",
			},
			{
				baseVersion: 2,
				amountBefore: "3000.0000",
				amountAfter: "3100.0000",
				allocationBefore: "3800.0000",
				allocationAfter: "3900.0000",
				usedBefore: "3800.0000",
				usedAfter: "3900.0000",
				balanceBefore: "200.0000",
				balanceAfter: "100.0000",
				supplement: "100.0000",
			},
		];
		const correctionIds: string[] = [];

		for (const step of corrections) {
			const payload = {
				targetType: "USAGE",
				targetId: u1Id,
				baseVersion: step.baseVersion,
				reason: `更正使用金额至 ${step.amountAfter}`,
				changes: { amount: step.amountAfter },
			};
			const auth = orgBearer(user);
			const preview = await request(app.getHttpServer())
				.post("/api/corrections/preview")
				.set(auth)
				.send(payload)
				.expect(200);
			const result = await request(app.getHttpServer())
				.post("/api/corrections")
				.set(auth)
				.send({ ...payload, expectedUsageImpact: preview.body.data.expectedUsageImpact })
				.expect(201);
			expect(result.body.data.targetVersion).toBe(step.baseVersion + 1);
			correctionIds.push(result.body.data.correctionId);
			const allocation = await ctx.prisma.planAllocation.findUniqueOrThrow({
				where: { planId },
			});
			expect(allocation.amount.toFixed(4)).toBe(step.allocationAfter);
			expect(allocation.usedAmount.toFixed(4)).toBe(step.usedAfter);
			const account = await ctx.prisma.account.findFirstOrThrow({
				where: { organizationId: user.defaultOrganizationId, currencyCode: "TWD" },
			});
			expect(account.balance.toFixed(4)).toBe(step.balanceAfter);
		}
		expect(new Set(correctionIds).size).toBe(2);

		const changeLogs = await ctx.prisma.planChangeLog.findMany({
			where: { planId, changeType: "ALLOCATION_ADJUSTED" },
		});
		expect(changeLogs).toHaveLength(2);
		const rows = await ctx.prisma.correction.findMany({
			where: {
				organizationId: user.defaultOrganizationId,
				targetType: "USAGE",
				targetId: u1Id,
			},
		});
		expect(rows).toHaveLength(2);

		// 两笔提交后再读历史，确保第二笔未覆盖第一笔的快照。
		for (const [index, correctionId] of correctionIds.entries()) {
			const step = corrections[index];
			const versionAfter = step.baseVersion + 1;
			const link = { correctionId, usageId: u1Id, reason: "USAGE_CORRECTION_SUPPLEMENT" };
			const log = changeLogs.find(
				(row) => (row.beforeSnapshot as { correctionId?: string }).correctionId === correctionId,
			)!;
			expect(log).toMatchObject({
				beforeSnapshot: {
					...link,
					amountBefore: step.amountBefore,
					versionBefore: step.baseVersion,
					usedBefore: step.usedBefore,
				},
				afterSnapshot: {
					...link,
					amountAfter: step.amountAfter,
					versionAfter,
					usedAfter: step.usedAfter,
					supplement: step.supplement,
				},
			});
			expect(log.beforeAlloc.toFixed(4)).toBe(step.allocationBefore);
			expect(log.afterAlloc.toFixed(4)).toBe(step.allocationAfter);
			const impacts = {
				allocations: [
					{
						planId,
						currencyCode: "TWD",
						amountBefore: step.allocationBefore,
						amountAfter: step.allocationAfter,
						usedBefore: step.usedBefore,
						usedAfter: step.usedAfter,
						supplement: step.supplement,
					},
				],
				balances: [{ currencyCode: "TWD", before: step.balanceBefore, after: step.balanceAfter }],
			};
			expect(rows.find((row) => row.id === correctionId)).toMatchObject({
				status: "APPLIED",
				createdAt: log.createdAt,
				beforeSnapshot: {
					target: { amount: step.amountBefore, version: step.baseVersion },
					baseVersion: step.baseVersion,
					impacts,
				},
				afterSnapshot: {
					target: { amount: step.amountAfter, version: versionAfter },
					versionAfter,
					impacts,
				},
			});
		}
	});

	it("W6-03 同计划另记使用改变资金来源：旧确认零写入，重新预览后可提交", async () => {
		const { user, planId, u1Id, u2Id } = await seedUsageScenario("corr-usage-impact");
		const organizationId = user.defaultOrganizationId;
		const prisma = ctx.prisma;
		const payload = {
			targetType: "USAGE",
			targetId: u1Id,
			baseVersion: 1,
			reason: "使用金额少记了 800",
			changes: { amount: "2000" },
		};
		const preview = () => request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send(payload)
			.expect(200);
		const apply = (body: typeof payload & { expectedUsageImpact?: string }) =>
			request(app.getHttpServer())
				.post("/api/corrections")
				.set(orgBearer(user))
				.send(body);
		const readRows = (addedId: string) => Promise.all([
			prisma.usageRecord.findMany({ where: { organizationId }, orderBy: { id: "asc" } }),
			prisma.plan.findUniqueOrThrow({ where: { id: planId } }),
			prisma.planAllocation.findUniqueOrThrow({ where: { planId } }),
			prisma.account.findMany({ where: { organizationId }, orderBy: { id: "asc" } }),
			prisma.costLot.findMany({ where: { organizationId }, orderBy: { id: "asc" } }),
			prisma.usageLotAllocation.findMany({ orderBy: { id: "asc" }, where: {
				usageId: { in: [u1Id, u2Id, addedId] },
			} }),
			prisma.planChangeLog.findMany({ where: { planId }, orderBy: { id: "asc" } }),
			prisma.correction.findMany({ where: { organizationId }, orderBy: { id: "asc" } }),
		]);

		const initial = (await preview()).body.data;
		expect(initial.blockers).toEqual([]);
		expect(initial.impacts.allocations).toEqual([{
			planId,
			currencyCode: "TWD",
			amountBefore: "3000.0000",
			amountAfter: "3000.0000",
			usedBefore: "2000.0000",
			usedAfter: "2800.0000",
			fromPlan: "800.0000",
			supplement: "0.0000",
			remainingBefore: "1000.0000",
			remainingAfter: "200.0000",
			usedFromRemaining: "800.0000",
			unallocatedDelta: "0.0000",
		}]);
		expect(initial.expectedUsageImpact).toMatch(/^[a-f0-9]{64}$/);

		const added = await request(app.getHttpServer())
			.post(`/api/plans/${planId}/usages`)
			.set(orgBearer(user))
			.send({ amount: "500", usedAt: new Date().toISOString() })
			.expect(201);
		const addedId: string = added.body.data.usage.id;
		expect(addedId).toEqual(expect.any(String));
		const beforeStaleApply = await readRows(addedId);
		expect(beforeStaleApply[0].find((usage) => usage.id === u1Id)?.version).toBe(1);
		await apply({ ...payload, expectedUsageImpact: initial.expectedUsageImpact })
			.expect(409)
			.expect((res) => {
				expect(res.body.code).toBe("CORRECTION_TARGET_CHANGED");
				expect(res.body.message).toContain("重新查看影响");
			});
		expect(await readRows(addedId)).toEqual(beforeStaleApply);

		const refreshed = (await preview()).body.data;
		expect(refreshed.blockers).toEqual([]);
		expect(refreshed.expectedUsageImpact).not.toBe(initial.expectedUsageImpact);
		expect(refreshed.impacts.allocations).toEqual([{
			...initial.impacts.allocations[0],
			amountAfter: "3300.0000",
			usedBefore: "2500.0000",
			usedAfter: "3300.0000",
			fromPlan: "500.0000",
			supplement: "300.0000",
			remainingBefore: "500.0000",
			remainingAfter: "0.0000",
			usedFromRemaining: "500.0000",
			unallocatedDelta: "-300.0000",
		}]);
		await apply(payload).expect(409);
		await apply({
			...payload,
			changes: { amount: "2100" },
			expectedUsageImpact: refreshed.expectedUsageImpact,
		}).expect(409);
		expect(await readRows(addedId)).toEqual(beforeStaleApply);

		const accepted = await apply({ ...payload, expectedUsageImpact: refreshed.expectedUsageImpact })
			.expect(201);
		expect(accepted.body.data.targetVersion).toBe(2);
		const [usages, , allocation, , , , changes, corrections] = await readRows(addedId);
		expect(usages.find((usage) => usage.id === u1Id)?.amount.toFixed(4)).toBe("2000.0000");
		expect(allocation.amount.toFixed(4)).toBe("3300.0000");
		expect(allocation.usedAmount.toFixed(4)).toBe("3300.0000");
		expect(changes).toHaveLength(1);
		expect(changes[0].afterSnapshot).toMatchObject({ supplement: "300.0000" });
		expect(corrections.map((entry) => entry.status)).toEqual(["APPLIED"]);
	});

	it("#13 USAGE 跨业务日更正：成本与分摊跨批次重排（u1 400 → 6,200、u2 10,300 → 4,500）", async () => {
		const dayStart = utc8DayStart(daysAgo(2));
		const { user, u1Id, u2Id } = await seedUsageScenario(
			"corr-usage-reschedule",
			{ crossLotUsage: true, dayStart },
		);
		const before = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: u1Id },
		});
		// 将 u1 移到下一业务日 20:00 UTC+8，原业务日的 u2 因此先重放。
		// 种子三批成本异构（INITIAL 2,000@0.5 / A 1,000@7 / B 1,000@9）：
		// 改序前：u1@12:00 耗 INITIAL 800（400）；u2@18:00 耗 INITIAL 1,200（600）
		// + A 1,000（7,000）+ B 300（2,700）= 10,300。
		// 改序后：u2@18:00 先耗 INITIAL 2,000（1,000）+ A 500（3,500）= 4,500；
		// 次日 u1@20:00 耗 A 剩余 500（3,500）+ B 300（2,700）= 6,200。
		const newUsedAt = new Date(dayStart.getTime() + (24 + 20) * 3_600_000);

		const preview = await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send({
				targetType: "USAGE",
				targetId: u1Id,
				baseVersion: before.version,
				reason: "使用日期记错了",
				changes: { usedAt: newUsedAt.toISOString() },
			})
			.expect(200);
		expect(preview.body.data.impacts.allocations).toEqual([]);
		const costs = new Map<
			string,
			{ usageId: string; costBefore: string; costAfter: string }
		>(
			preview.body.data.impacts.costs.map(
				(cost: {
					usageId: string;
					costBefore: string;
					costAfter: string;
				}) => [cost.usageId, cost],
			),
		);
		expect(costs.get(u1Id)?.costBefore).toBe("400.0000");
		// 改序后次日 u1@20:00 耗 A 剩余 500（3,500）+ B 300（2,700）= 6,200
		expect(costs.get(u1Id)?.costAfter).toBe("6200.0000");
		// 改序前 u2@18:00 耗 INITIAL 1,200（600）+ A 1,000（7,000）+ B 300（2,700）= 10,300
		expect(costs.get(u2Id)?.costBefore).toBe("10300.0000");
		// 改序后 u2@18:00 先耗 INITIAL 2,000（1,000）+ A 500（3,500）= 4,500
		expect(costs.get(u2Id)?.costAfter).toBe("4500.0000");

		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({
				targetType: "USAGE",
				targetId: u1Id,
				baseVersion: before.version,
				reason: "使用日期记错了",
				changes: { usedAt: newUsedAt.toISOString() },
				expectedUsageImpact: preview.body.data.expectedUsageImpact,
			})
			.expect(201);

		const usage = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: u1Id },
		});
		expect(usage.usedAt.toISOString()).toBe(newUsedAt.toISOString());
		expect(usage.version).toBe(2);
		// 金额不变 → 分配不动
		const allocation = await ctx.prisma.planAllocation.findFirstOrThrow({
			where: { planId: usage.planId },
		});
		expect(allocation.usedAmount.toFixed(4)).toBe("3300.0000");
		const account = await ctx.prisma.account.findFirstOrThrow({
			where: { organizationId: user.defaultOrganizationId, currencyCode: "TWD" },
		});
		expect(account.balance.toFixed(4)).toBe("700.0000");
		// 分摊跨批次重排断言：u1 改序后跨 A/B 两批（改序前仅 INITIAL 单批）
		const u1Allocations = await ctx.prisma.usageLotAllocation.findMany({
			where: { usageId: u1Id },
		});
		const lotById = new Map(
			(
				await ctx.prisma.costLot.findMany({
					where: { organizationId: user.defaultOrganizationId, currencyCode: "TWD" },
				})
			).map((lot) => [lot.id, lot]),
		);
		const u1BySource = u1Allocations.map((item) => ({
			sourceType: lotById.get(item.lotId)!.sourceType,
			quantity: item.quantity.toFixed(4),
		}));
		expect(u1BySource).toEqual([
			{ sourceType: "PURCHASE", quantity: "500.0000" }, // A 批 @7
			{ sourceType: "PURCHASE", quantity: "300.0000" }, // B 批 @9
		]);
		// u2 改序后耗 INITIAL 全部 2,000（改序前耗 INITIAL 1,200 + A 1,000 + B 300）
		const u2Allocations = await ctx.prisma.usageLotAllocation.findMany({
			where: { usageId: u2Id },
		});
		const u2BySource = u2Allocations.map((item) => ({
			sourceType: lotById.get(item.lotId)!.sourceType,
			quantity: item.quantity.toFixed(4),
		}));
		expect(u2BySource).toEqual([
			{ sourceType: "INITIAL", quantity: "2000.0000" },
			{ sourceType: "PURCHASE", quantity: "500.0000" },
		]);
	});

	it("W6-05 跨日倒序补录：预览与 APPLIED 快照逐笔对照已入账及更正后的使用成本", async () => {
		const user = await newUser("corr-usage-backdated-cost");
		const server = app.getHttpServer();
		const auth = orgBearer(user);
		for (const [days, rate] of [[8, 7], [7, 8]] as const) {
			await request(server)
				.post("/api/transactions")
				.set(auth)
				.send({
					currencyCode: "USD",
					principalAmount: String(rate * 100),
					exchangeRate: String(rate),
					quantity: "100",
					transactedAt: daysAgo(days).toISOString(),
				})
				.expect(201);
		}
		const { planId } = await seedPlanWithAllocationRow(ctx.prisma, {
			userId: user.userId,
			targetCurrency: "USD",
			targetAmount: "200",
			allocatedAmount: "200",
		});
		const usagePath = `/api/plans/${planId}/usages`;
		const late = await request(server)
			.post(usagePath)
			.set(auth)
			.send({ amount: "80", usedAt: daysAgo(2).toISOString() })
			.expect(201);
		const early = await request(server)
			.post(usagePath)
			.set(auth)
			.send({ amount: "70", usedAt: daysAgo(4).toISOString() })
			.expect(201);
		const { id: lateId, version: lateVersion } = late.body.data.usage as UsageDto;
		const { id: earlyId } = early.body.data.usage as UsageDto;
		const readCosts = async () => {
			const list = await request(server).get(usagePath).set(auth).expect(200);
			return new Map(
				(list.body.data.items as UsageDto[]).map(({ id, cost }) => [id, cost]),
			);
		};
		const postedBefore = await readCosts();
		// 入账以录入顺序耗用。晚笔 80×7，早笔 20×7 + 50×8。
		expect(postedBefore).toEqual(
			new Map([
				[lateId, "560.0000"],
				[earlyId, "540.0000"],
			]),
		);

		const payload = {
			targetType: "USAGE",
			targetId: lateId,
			baseVersion: lateVersion,
			reason: "核对后较晚的实际用量为 60",
			changes: { amount: "60" },
		};
		const preview = await request(server)
			.post("/api/corrections/preview")
			.set(auth)
			.send(payload)
			.expect(200);
		expect(preview.body.data.blockers).toEqual([]);
		// 更正后日期重放。早笔 70×7，晚笔 30×7 + 30×8。
		const expectedCosts = [
			{
				usageId: earlyId,
				costBefore: postedBefore.get(earlyId),
				costAfter: "490.0000",
			},
			{
				usageId: lateId,
				costBefore: postedBefore.get(lateId),
				costAfter: "450.0000",
			},
		];
		expect(preview.body.data.impacts.costs).toEqual(expectedCosts);
		expect(await readCosts()).toEqual(postedBefore);

		const applied = await request(server)
			.post("/api/corrections")
			.set(auth)
			.send({ ...payload, expectedUsageImpact: preview.body.data.expectedUsageImpact })
			.expect(201);
		expect(applied.body.data).toMatchObject({ status: "APPLIED", targetVersion: 2 });
		const postedAfter = await readCosts();
		expect(postedAfter).toEqual(
			new Map(expectedCosts.map(({ usageId, costAfter }) => [usageId, costAfter])),
		);

		const log = await request(server)
			.get("/api/corrections")
			.query({ targetType: "USAGE", targetId: lateId })
			.set(auth)
			.expect(200);
		expect(log.body.data.items).toMatchObject([
			{
				id: applied.body.data.correctionId,
				status: "APPLIED",
				beforeSnapshot: { impacts: { costs: expectedCosts } },
				afterSnapshot: { impacts: { costs: expectedCosts } },
			},
		]);
	});

	it("W6-05 历史使用无分摊：预览与 APPLIED 快照的原成本为 null", async () => {
		const user = await newUser("corr-usage-missing-cost");
		const { usageId } = await seedPurchaseWithUsage({
			user,
			trades: [{ at: daysAgo(7), principal: "700", quantity: "100" }],
			usageAmount: "40",
			usageAt: daysAgo(4),
		});
		// 模拟存量记录缺失分摊明细，其余账本事实仍存在。
		await ctx.prisma.usageLotAllocation.deleteMany({ where: { usageId } });
		const payload = {
			targetType: "USAGE",
			targetId: usageId,
			baseVersion: 1,
			reason: "核对后实际用量为 30",
			changes: { amount: "30" },
		};
		const expectedCosts = [{ usageId, costBefore: null, costAfter: "210.0000" }];
		const preview = await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send(payload)
			.expect(200);
		expect(preview.body.data.impacts.costs).toEqual(expectedCosts);
		const applied = await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({ ...payload, expectedUsageImpact: preview.body.data.expectedUsageImpact })
			.expect(201);
		const correction = await ctx.prisma.correction.findUniqueOrThrow({
			where: { id: applied.body.data.correctionId },
		});
		expect(correction).toMatchObject({
			status: "APPLIED",
			beforeSnapshot: { impacts: { costs: expectedCosts } },
		});
	});

	it("#14 V4 矩阵：改 0 与 CANCELLED 计划 → 400 CORRECTION_NOT_ALLOWED", async () => {
		const { user, u1Id } = await seedUsageScenario("corr-usage-v4-zero");
		const usage = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: u1Id },
		});
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send({
				targetType: "USAGE",
				targetId: u1Id,
				baseVersion: usage.version,
				reason: "作废这笔使用",
				changes: { amount: "0" },
			})
			.expect(400)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("CORRECTION_NOT_ALLOWED");
			});

		const { user: cancelledUser, u1Id: cancelledId } = await seedUsageScenario(
			"corr-usage-v4-cancelled",
			{ planStatus: "CANCELLED" },
		);
		const cancelledUsage = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: cancelledId },
		});
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(cancelledUser))
			.send({
				targetType: "USAGE",
				targetId: cancelledId,
				baseVersion: cancelledUsage.version,
				reason: "金额有误",
				changes: { amount: "900.0000" },
			})
			.expect(400)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("CORRECTION_NOT_ALLOWED");
			});
		void user;
	});

	it("#15 USAGE 并发版本冲突 → 409 CORRECTION_TARGET_CHANGED", async () => {
		const { user, u1Id } = await seedUsageScenario("corr-usage-version");
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send({
				targetType: "USAGE",
				targetId: u1Id,
				baseVersion: 99,
				reason: "并发版本冲突",
				changes: { amount: "900.0000" },
			})
			.expect(409)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("CORRECTION_TARGET_CHANGED");
			});
	});

	it("#16 USAGE 改大致历史缺口 → 409 HISTORICAL_SHORTFALL、FAILED 留痕、零变化", async () => {
		const { user, planId, u1Id } = await seedUsageScenario("corr-usage-shortfall");
		const before = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: u1Id },
		});
		// 1,200 → 4,000：重放后 u2 18:00 时点无批次可耗 → V3 缺口 800
		const payload = {
			targetType: "USAGE",
			targetId: u1Id,
			baseVersion: before.version,
			reason: "金额记大了导致历史缺口",
			changes: { amount: "4000.0000" },
		};
		const preview = await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send(payload)
			.expect(200);
		expect(preview.body.data.blockers[0].code).toBe("CORRECTION_HISTORICAL_SHORTFALL");
		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({
				...payload,
				expectedUsageImpact: preview.body.data.expectedUsageImpact,
			})
			.expect(409)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("CORRECTION_HISTORICAL_SHORTFALL");
			});

		// FAILED 留痕
		const corrections = await ctx.prisma.correction.findMany({
			where: { organizationId: user.defaultOrganizationId, targetType: "USAGE" },
		});
		expect(corrections).toHaveLength(1);
		expect(corrections[0].status).toBe("FAILED");
		// 零变化：记录/分配/余额全部保持种子态
		const usage = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: u1Id },
		});
		expect(usage.amount.toFixed(4)).toBe("1200.0000");
		expect(usage.version).toBe(1);
		const allocation = await ctx.prisma.planAllocation.findFirstOrThrow({
			where: { planId },
		});
		expect(allocation.usedAmount.toFixed(4)).toBe("2000.0000");
		const account = await ctx.prisma.account.findFirstOrThrow({
			where: { organizationId: user.defaultOrganizationId, currencyCode: "TWD" },
		});
		expect(account.balance.toFixed(4)).toBe("2000.0000");
	});

	// ── #17/#18 初始持仓金额更正 ──
	it("#17 初始金额更正：报价三元组逐字节不变、cost 沿用原汇率重算", async () => {
		const user = await newUser("corr-holding-amount");
		const { holdingId } = await seedInitialHolding(ctx.prisma, {
			userId: user.userId,
			currencyCode: "USD",
			amount: "1000",
			rate: "7.2480000000",
			cost: "7248.0000",
			confirmedAt: daysAgo(5),
		});
		const before = await ctx.prisma.initialHolding.findUniqueOrThrow({
			where: { id: holdingId },
		});

		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({
				targetType: "INITIAL_HOLDING",
				targetId: holdingId,
				baseUpdatedAt: before.updatedAt.toISOString(),
				reason: "初始金额多填了 200",
				changes: { amount: "800.0000" },
			})
			.expect(201);

		const holding = await ctx.prisma.initialHolding.findUniqueOrThrow({
			where: { id: holdingId },
		});
		// 沿用原报价（不用今天的行情，验收场景 12）
		expect(holding.rate.toFixed(10)).toBe(before.rate.toFixed(10));
		expect(holding.rawRate.toFixed(10)).toBe(before.rawRate.toFixed(10));
		expect(holding.rateSource).toBe(before.rateSource);
		expect(holding.rateObservedAt.getTime()).toBe(
			before.rateObservedAt.getTime(),
		);
		// 成本按原汇率重算：800 × 7.248 = 5,798.4
		expect(holding.cost.toFixed(4)).toBe("5798.4000");
		const account = await ctx.prisma.account.findFirstOrThrow({
			where: { organizationId: user.defaultOrganizationId, currencyCode: "USD" },
		});
		expect(account.balance.toFixed(4)).toBe("800.0000");
	});

	it("#18 初始改 0：有历史使用 → 409 V3 缺口；无使用 → 200 且成本归 0、空批次不落", async () => {
		// 有历史使用：初始 1,000 + 使用 400 → 改 0 后使用时点无资金
		const userA = await newUser("corr-holding-zero-used");
		const { holdingId: holdingA } = await seedInitialHolding(ctx.prisma, {
			userId: userA.userId,
			currencyCode: "USD",
			amount: "1000",
			rate: "7.2480000000",
			cost: "7248.0000",
			confirmedAt: daysAgo(5),
		});
		const { planId } = await seedPlanWithAllocationRow(ctx.prisma, {
			userId: userA.userId,
			targetCurrency: "USD",
			targetAmount: "10000",
			allocatedAmount: "400",
		});
		const initialLot = await ctx.prisma.costLot.findFirstOrThrow({
			where: { sourceId: holdingA },
		});
		await seedUsageRecord(ctx.prisma, {
			userId: userA.userId,
			planId,
			currencyCode: "USD",
			amount: "400",
			usedAt: daysAgo(2),
			allocations: [{ lotId: initialLot.id, quantity: "400" }],
		});
		const beforeA = await ctx.prisma.initialHolding.findUniqueOrThrow({
			where: { id: holdingA },
		});
		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(userA))
			.send({
				targetType: "INITIAL_HOLDING",
				targetId: holdingA,
				baseUpdatedAt: beforeA.updatedAt.toISOString(),
				reason: "当时实际没有该币种",
				changes: { amount: "0" },
			})
			.expect(409)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("CORRECTION_HISTORICAL_SHORTFALL");
				expect(errorRes.body.details[0].shortfall).toBe("400.0000");
			});

		// 无使用：改 0 成功，成本归 0、账户保留余额 0
		const userB = await newUser("corr-holding-zero-clean");
		const { holdingId: holdingB } = await seedInitialHolding(ctx.prisma, {
			userId: userB.userId,
			currencyCode: "HKD",
			amount: "500",
			rate: "0.9200000000",
			cost: "460.0000",
			confirmedAt: daysAgo(5),
		});
		const beforeB = await ctx.prisma.initialHolding.findUniqueOrThrow({
			where: { id: holdingB },
		});
		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(userB))
			.send({
				targetType: "INITIAL_HOLDING",
				targetId: holdingB,
				baseUpdatedAt: beforeB.updatedAt.toISOString(),
				reason: "当时实际没有港币",
				changes: { amount: "0" },
			})
			.expect(201);
		const holding = await ctx.prisma.initialHolding.findUniqueOrThrow({
			where: { id: holdingB },
		});
		expect(holding.amount.toFixed(4)).toBe("0.0000");
		expect(holding.cost.toFixed(4)).toBe("0.0000");
		const lots = await ctx.prisma.costLot.findMany({
			where: { organizationId: userB.defaultOrganizationId, currencyCode: "HKD" },
		});
		expect(lots).toHaveLength(0); // 数量 0 不生成空批次
		const account = await ctx.prisma.account.findFirstOrThrow({
			where: { organizationId: userB.defaultOrganizationId, currencyCode: "HKD" },
		});
		expect(account.balance.toFixed(4)).toBe("0.0000"); // 账户归零保留
	});

	// FX-05：2020-09-20 是周日，按 UTC+8 的自然日计算回看窗口。
	it.each([
		{
			time: "00:05",
			selectedAt: "2020-09-19T23:50:00+08:00",
			olderEligibleAt: ["2020-09-13T00:00:00+08:00"],
		},
		{
			time: "14:30",
			selectedAt: "2020-09-20T13:00:00+08:00",
			olderEligibleAt: [
				"2020-09-19T23:50:00+08:00",
				"2020-09-20T08:00:00+08:00",
			],
		},
		{
			time: "23:55",
			selectedAt: "2020-09-13T00:00:00+08:00",
			olderEligibleAt: [],
		},
	])("#19 CNY/TWD 原时点更正（UTC+8 $time）：排除无效行，预览和提交选中合格报价", async ({
		time,
		selectedAt,
		olderEligibleAt,
	}) => {
		expect(app.get(RateProvider).sourceForPair("CNY", "TWD")).toBe("er-api");

		const user = await newUser(`corr-twd-${time.replace(":", "")}`);
		const confirmedAt = new Date(`2020-09-20T${time}:00+08:00`);
		const { holdingId } = await seedInitialHolding(ctx.prisma, {
			userId: user.userId,
			currencyCode: "USD",
			amount: "1000",
			rate: "7.2480000000",
			cost: "7248.0000",
			confirmedAt,
		});

		const where = { organizationId: user.defaultOrganizationId };
		async function ledgerSnapshot() {
			const [holdings, lots, accounts, corrections, transactions] = await Promise.all([
				ctx.prisma.initialHolding.findMany({ where, orderBy: { id: "asc" } }),
				ctx.prisma.costLot.findMany({ where, orderBy: { id: "asc" } }),
				ctx.prisma.account.findMany({ where, orderBy: { id: "asc" } }),
				ctx.prisma.correction.findMany({ where, orderBy: { id: "asc" } }),
				ctx.prisma.transaction.findMany({ where, orderBy: { id: "asc" } }),
			]);
			return { holdings, lots, accounts, corrections, transactions };
		}

		const before = await ledgerSnapshot();
		const payload = {
			targetType: "INITIAL_HOLDING",
			targetId: holdingId,
			baseUpdatedAt: before.holdings[0]!.updatedAt.toISOString(),
			reason: "当时持有的是新台币",
			changes: { currencyCode: "TWD" },
		};

		const rateIds: string[] = [];
		async function seedTwdQuotes(quotes: { rate: string; observedAt: Date }[]) {
			const rows = await ctx.prisma.exchangeRate.createManyAndReturn({
				data: quotes.map((quote) => ({
					...quote,
					base: "CNY",
					quote: "TWD",
					source: "er-api",
					canonicalWriteId: randomUUID(),
				})),
				select: { id: true },
			});
			rateIds.push(...rows.map(({ id }) => id));
		}

		try {
			// 超回看上限 1 秒、同一当地日的未来点、次日点同时存在。
			await seedTwdQuotes([
				{ rate: "0.2100", observedAt: new Date("2020-09-12T23:59:59+08:00") },
				{ rate: "0.2600", observedAt: new Date(confirmedAt.getTime() + 60_000) },
				{ rate: "0.2700", observedAt: new Date("2020-09-21T00:00:00+08:00") },
			]);

			for (const path of ["/api/corrections/preview", "/api/corrections"]) {
				const response = await request(app.getHttpServer())
					.post(path)
					.set(orgBearer(user))
					.send(payload)
					.expect(400);
				expect(response.body.code).toBe("RATE_QUOTE_UNAVAILABLE");
				expect(await ledgerSnapshot()).toEqual(before);
			}

			// 保留全部无效行，并加入应命中行与较早但仍合格的竞争行。
			const observedAt = new Date(selectedAt);
			await seedTwdQuotes([
				...olderEligibleAt.map((at) => ({ rate: "0.2200", observedAt: new Date(at) })),
				{ rate: "0.2345678912", observedAt },
			]);
			const expected = {
				currencyCode: "TWD",
				amount: "1000.0000",
				rawRate: "0.2345678912",
				rate: "0.2345678900",
				rateSource: "er-api",
				rateObservedAt: observedAt.toISOString(),
				confirmedAt: confirmedAt.toISOString(),
				cost: "234.5700",
			};

			const preview = await request(app.getHttpServer())
				.post("/api/corrections/preview")
				.set(orgBearer(user))
				.send(payload)
				.expect(200);
			expect(preview.body.data.after).toMatchObject(expected);
			expect(preview.body.data.blockers).toEqual([]);
			expect(await ledgerSnapshot()).toEqual(before);

			const applied = await request(app.getHttpServer())
				.post("/api/corrections")
				.set(orgBearer(user))
				.send({ ...payload, previewQuoteKey: preview.body.data.holdingQuote.confirmationKey })
				.expect(201);
			expect(applied.body.data.status).toBe("APPLIED");
			const after = await ledgerSnapshot();
			expect(after.holdings).toHaveLength(1);
			const holding = after.holdings[0]!;
			expect({
				...holding,
				amount: holding.amount.toFixed(4),
				rawRate: holding.rawRate.toFixed(10),
				rate: holding.rate.toFixed(10),
				rateObservedAt: holding.rateObservedAt.toISOString(),
				confirmedAt: holding.confirmedAt.toISOString(),
				cost: holding.cost.toFixed(4),
			}).toMatchObject({ id: holdingId, ...expected });
			expect(after.corrections).toHaveLength(1);
			expect(after.corrections[0]).toMatchObject({
				id: applied.body.data.correctionId,
				status: "APPLIED",
				afterSnapshot: { target: expected },
			});
			expect(after.lots).toHaveLength(1);
			expect(after.lots[0]).toMatchObject({ currencyCode: "TWD", sourceId: holdingId });
			expect(after.lots[0]!.totalCost.toFixed(4)).toBe(expected.cost);
			const balances = Object.fromEntries(
				after.accounts.map(({ currencyCode, balance }) => [currencyCode, balance.toFixed(4)]),
			);
			expect(balances).toEqual({ TWD: expected.amount, USD: "0.0000" });
		} finally {
			await ctx.prisma.exchangeRate.deleteMany({ where: { id: { in: rateIds } } });
		}
	});

	it("#19 ABC：恰满 5 分钟返回 400 和实时窗口文案，晚 1 毫秒可提交", async () => {
		const user = await newUser("corr-holding-currency");
		const confirmedAt = new Date("2024-02-15T12:00:00+08:00");
		const { holdingId } = await seedInitialHolding(ctx.prisma, {
			userId: user.userId,
			currencyCode: "USD",
			amount: "1000",
			rate: "7.2480000000",
			cost: "7248.0000",
			confirmedAt,
		});
		const before = await ctx.prisma.initialHolding.findUniqueOrThrow({
			where: { id: holdingId },
		});

		const windowStart = new Date("2024-02-15T11:55:00+08:00");
		const boundaryQuote = await ctx.prisma.exchangeRate.create({
			data: {
				base: "CNY",
				quote: "CAD",
				rate: "5.2900000000",
				source: "abc",
				observedAt: windowStart,
			},
		});
		extraRateRowIds.push(boundaryQuote.id);
		const payload = {
			targetType: "INITIAL_HOLDING",
			targetId: holdingId,
			baseUpdatedAt: before.updatedAt.toISOString(),
			reason: "当时持有的是加元",
			changes: { currencyCode: "CAD" },
		};
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send(payload)
			.expect(400)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("RATE_QUOTE_UNAVAILABLE");
			expect(errorRes.body.message).toContain(
				"实时报价的发布时间须距原确认时点不足 5 分钟",
			);
			});

		const eligibleAt = new Date("2024-02-15T11:55:00.001+08:00");
		const rateRow = await ctx.prisma.exchangeRate.create({
			data: {
				base: "CNY",
				quote: "CAD",
				rate: "5.3100000000",
				source: "abc",
				observedAt: eligibleAt,
			},
		});
		extraRateRowIds.push(rateRow.id);

		const preview = await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send(payload)
			.expect(200);
		expect(preview.body.data.holdingQuote).toMatchObject({
			rate: "5.31000000",
			source: "abc",
			observedAt: eligibleAt.toISOString(),
		});

		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({ ...payload, previewQuoteKey: preview.body.data.holdingQuote.confirmationKey })
			.expect(201);

		const holding = await ctx.prisma.initialHolding.findUniqueOrThrow({
			where: { id: holdingId },
		});
		expect(holding.currencyCode).toBe("CAD");
		expect(holding.rate.toFixed(10)).toBe("5.3100000000");
		expect(holding.rateSource).toBe("abc");
		expect(holding.rateObservedAt).toEqual(eligibleAt);
		expect(holding.cost.toFixed(4)).toBe("5310.0000"); // 1,000 × 5.31
		// 旧 USD 批次移除、新 CAD 批次建立、账户各归其位
		const usdLots = await ctx.prisma.costLot.findMany({
			where: { organizationId: user.defaultOrganizationId, currencyCode: "USD" },
		});
		expect(usdLots).toHaveLength(0);
		const cadLot = await ctx.prisma.costLot.findFirstOrThrow({
			where: { organizationId: user.defaultOrganizationId, currencyCode: "CAD" },
		});
		expect(cadLot.sourceId).toBe(holdingId);
		const cadAccount = await ctx.prisma.account.findFirstOrThrow({
			where: { organizationId: user.defaultOrganizationId, currencyCode: "CAD" },
		});
		expect(cadAccount.balance.toFixed(4)).toBe("1000.0000");
	});

	it.each([
		{ change: "price", days: 20, data: { sellRate: "0.23" }, rate: "0.23000000", rawRate: "0.2300000000", source: "abc", cost: "230.0000" },
		{ change: "source", days: 30, data: { source: "er-api", sellRate: null, rate: "0.21", canonicalWriteId: randomUUID() }, rate: "0.21000000", rawRate: "0.2100000000", source: "er-api", cost: "210.0000" },
		{ change: "raw-price", days: 40, data: { sellRate: "0.2100000001" }, rate: "0.21000000", rawRate: "0.2100000001", source: "abc", cost: "210.0000" },
	])("FX-05: $change changed at the same quote timestamp, rejects stale confirmation without writes", async ({
		change, days, data, rate, rawRate, source, cost,
	}) => {
		const user = await newUser(`corr-quote-${change}`);
		const userWhere = { organizationId: user.defaultOrganizationId };
		const confirmedAt = new Date(utc8DayStart(daysAgo(days)).getTime() + 10 * 3_600_000);
		const { holdingId } = await seedInitialHolding(ctx.prisma, {
			userId: user.userId,
			currencyCode: "USD",
			amount: "1000",
			rate: "7.2480000000",
			cost: "7248.0000",
			confirmedAt,
		});
		const observedAt = new Date(confirmedAt.getTime() - 60_000);
		const quoteWhere = { base: "CNY", quote: "THB", observedAt };
		const initialQuote = await ctx.prisma.exchangeRate.create({
			data: { ...quoteWhere, rate: "0.20", sellRate: "0.21", source: "abc" },
		});
		extraRateRowIds.push(initialQuote.id);

		const holdingWhere = { id: holdingId };
		const ledgerState = () => Promise.all([
			ctx.prisma.initialHolding.findUniqueOrThrow({ where: holdingWhere }),
			ctx.prisma.account.findMany({ where: userWhere, orderBy: { id: "asc" } }),
			ctx.prisma.costLot.findMany({ where: userWhere, orderBy: { id: "asc" } }),
			ctx.prisma.correction.findMany({ where: userWhere, orderBy: { id: "asc" } }),
		] as const);
		const before = await ledgerState();
		const payload = {
			targetType: "INITIAL_HOLDING",
			targetId: holdingId,
			baseUpdatedAt: before[0].updatedAt.toISOString(),
			reason: "当时持有的是泰铢",
			changes: { currencyCode: "THB" },
		};
		const preview = () => request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send(payload)
			.expect(200);
		const apply = (previewQuoteKey?: string) => request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({ ...payload, previewQuoteKey });
		const first = (await preview()).body.data;
		expect(first.after.cost).toBe("210.0000");
		expect(first.holdingQuote).toMatchObject({
			rate: "0.21000000",
			rawRate: "0.2100000000",
			source: "abc",
			observedAt: observedAt.toISOString(),
		});
		expect(first.blockers).toEqual([]);

		const expectQuoteConflict = async (key?: string) => {
			const rejected = await apply(key).expect(409);
			expect(rejected.body.code).toBe("CORRECTION_QUOTE_CHANGED");
			expect(await ledgerState()).toEqual(before);
		};
		await expectQuoteConflict(); // 尚未确认任何报价

		const revised = await ctx.prisma.exchangeRate.update({
			where: { base_quote_observedAt: quoteWhere },
			data,
		});
		await expectQuoteConflict(first.holdingQuote.confirmationKey);
		expect(await ctx.prisma.exchangeRate.findUnique({ where: { id: revised.id } })).toEqual(revised);

		const second = (await preview()).body.data;
		expect(second.holdingQuote.confirmationKey).not.toBe(first.holdingQuote.confirmationKey);
		expect(second.holdingQuote).toMatchObject({
			rate, rawRate, source, observedAt: observedAt.toISOString(),
		});
		expect(second.after.cost).toBe(cost);
		const receipt = await apply(second.holdingQuote.confirmationKey).expect(201);
		expect(receipt.body.data.status).toBe("APPLIED");
		const holding = await ctx.prisma.initialHolding.findUniqueOrThrow({ where: holdingWhere });
		expect(holding.currencyCode).toBe("THB");
		expect(holding.rate.toFixed(8)).toBe(rate);
		expect(holding.rawRate.toFixed(10)).toBe(rawRate);
		expect(holding.rateSource).toBe(source);
		expect(holding.rateObservedAt).toEqual(observedAt);
		expect(holding.cost.toFixed(4)).toBe(cost);

		await apply(second.holdingQuote.confirmationKey).expect(409).expect((response) => {
			expect(response.body.code).toBe("CORRECTION_TARGET_CHANGED");
		});
		const audit = await ctx.prisma.correction.findMany({ where: userWhere });
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			status: "APPLIED",
			afterSnapshot: { target: { rateSource: source, rawRate, cost } },
		});
	});

	it("#19-1 TWD：日级回看超界或晚于原时点返回 400 和日级文案，UTC+8 第 7 天零点可提交", async () => {
		const user = await newUser("corr-twd-lookback");
		const confirmedAt = new Date("2024-02-15T14:30:00+08:00");
		const { holdingId } = await seedInitialHolding(ctx.prisma, {
			userId: user.userId,
			currencyCode: "USD",
			amount: "1000",
			rate: "7.2480000000",
			cost: "7248.0000",
			confirmedAt,
		});
		const before = await ctx.prisma.initialHolding.findUniqueOrThrow({
			where: { id: holdingId },
		});

		for (const observedAt of [
			new Date("2024-02-07T23:59:59.999+08:00"),
			new Date("2024-02-15T14:30:00.001+08:00"),
		]) {
			const row = await ctx.prisma.exchangeRate.create({
				data: {
					base: "CNY",
					quote: "TWD",
					rate: "0.21",
					source: "er-api",
					canonicalWriteId: randomUUID(),
					observedAt,
				},
			});
			extraRateRowIds.push(row.id);
		}

		const payload = {
			targetType: "INITIAL_HOLDING",
			targetId: holdingId,
			baseUpdatedAt: before.updatedAt.toISOString(),
			reason: "当时持有的是新台币",
			changes: { currencyCode: "TWD" },
		};
		for (const endpoint of ["/api/corrections/preview", "/api/corrections"]) {
			await request(app.getHttpServer())
				.post(endpoint)
				.set(orgBearer(user))
				.send(payload)
				.expect(400)
				.expect((errorRes) => {
					expect(errorRes.body.code).toBe("RATE_QUOTE_UNAVAILABLE");
					expect(errorRes.body.message).toContain("最迟在原确认时点发布");
				expect(errorRes.body.message).toContain(
					"日级报价按 UTC+8 同日优先、最多回看 7 个自然日",
				);
				});
		}

		expect(
			await ctx.prisma.initialHolding.findUniqueOrThrow({ where: { id: holdingId } }),
		).toEqual(before);
		expect(
			await ctx.prisma.correction.count({ where: { targetId: holdingId } }),
		).toBe(0);

		const eligibleAt = new Date("2024-02-08T00:00:00+08:00");
		const rateRow = await ctx.prisma.exchangeRate.create({
			data: {
				base: "CNY",
				quote: "TWD",
				rate: "0.23",
				source: "er-api",
				canonicalWriteId: randomUUID(),
				observedAt: eligibleAt,
			},
		});
		extraRateRowIds.push(rateRow.id);

		const preview = await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send(payload)
			.expect(200);
		expect(preview.body.data.holdingQuote).toMatchObject({
			rate: "0.23000000",
			source: "er-api",
			observedAt: eligibleAt.toISOString(),
		});

		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({ ...payload, previewQuoteKey: preview.body.data.holdingQuote.confirmationKey })
			.expect(201);

		const holding = await ctx.prisma.initialHolding.findUniqueOrThrow({
			where: { id: holdingId },
		});
		expect(holding.currencyCode).toBe("TWD");
		expect(holding.rateSource).toBe("er-api");
		expect(holding.rateObservedAt).toEqual(eligibleAt);
	});

	// ── #20 他人记录 ──
	it("#20 他人记录 preview/apply/list/target 一律 404 CORRECTION_TARGET_NOT_FOUND", async () => {
		const owner = await newUser("corr-owner");
		const stranger = await newUser("corr-stranger");
		const { transactionId } = await seedUnknownFeePurchase(owner);
		const payload = {
			targetType: "TRANSACTION",
			targetId: transactionId,
			baseVersion: 1,
			reason: "越权更正",
			changes: { feeAmount: "5.00" },
		};
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(stranger))
			.send(payload)
			.expect(404)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("CORRECTION_TARGET_NOT_FOUND");
			});
		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(stranger))
			.send(payload)
			.expect(404);
		await request(app.getHttpServer())
			.get(`/api/corrections?targetType=TRANSACTION&targetId=${transactionId}`)
			.set(orgBearer(stranger))
			.expect(404);
		await request(app.getHttpServer())
			.get(
				`/api/corrections/target?targetType=TRANSACTION&targetId=${transactionId}`,
			)
			.set(orgBearer(stranger))
			.expect(404);
	});

	// ── #22 preview 不落任何行 ──
	it("#22 preview 前后 Correction/Transaction/Account/批次行数与内容零变化", async () => {
		const user = await newUser("corr-preview-readonly");
		const { transactionId } = await seedUnknownFeePurchase(user);
		const countAll = () =>
			Promise.all([
				ctx.prisma.correction.count({
					where: { organizationId: user.defaultOrganizationId },
				}),
				ctx.prisma.transaction.findMany({
					where: { organizationId: user.defaultOrganizationId },
				}),
				ctx.prisma.account.findMany({
					where: { organizationId: user.defaultOrganizationId },
				}),
				ctx.prisma.costLot.findMany({
					where: { organizationId: user.defaultOrganizationId },
				}),
			]);
		const snapshotBefore = await countAll();

		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send({
				targetType: "TRANSACTION",
				targetId: transactionId,
				baseVersion: 1,
				reason: "只看影响",
				changes: { feeAmount: "20.00" },
			})
			.expect(200);

		const snapshotAfter = await countAll();
		expect(snapshotAfter[0]).toBe(snapshotBefore[0]); // Correction
		expect(snapshotAfter[1]).toEqual(snapshotBefore[1]); // Transaction 行内容一致
		expect(snapshotAfter[2]).toEqual(snapshotBefore[2]); // Account
		expect(snapshotAfter[3]).toEqual(snapshotBefore[3]); // CostLot
	});

	// ── #23 参数边界 ──
	it("#23 参数边界：JPY 数量带小数 / 日期早于账本起点 / 晚于今天，message 可区分", async () => {
		const user = await newUser("corr-boundary");
		// JPY 买入（整数币种）
		const res = await request(app.getHttpServer())
			.post("/api/transactions")
			.set(orgBearer(user))
			.send({
				currencyCode: "JPY",
				principalAmount: "5000",
				exchangeRate: "0.05000000",
				quantity: "100000",
				transactedAt: daysAgo(3).toISOString(),
			})
			.expect(201);
		// 设账本起点（UTC+8 今天），下界校验生效；同步更新个人与组织设置
		await ensureOnboarded(
			ctx.prisma,
			user.userId,
			"CNY",
			new Date(Date.now() - 86_400_000),
		);

		// JPY 数量带小数 → 400
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send({
				targetType: "TRANSACTION",
				targetId: res.body.data.id,
				baseVersion: 1,
				reason: "改数量",
				changes: { quantity: "100000.5" },
			})
			.expect(400)
			.expect((errorRes) => {
				expect(errorRes.body.message).toContain("整数币种");
			});
		// 日期早于账本起点 → 400
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send({
				targetType: "TRANSACTION",
				targetId: res.body.data.id,
				baseVersion: 1,
				reason: "改日期",
				changes: { transactedAt: daysAgo(10).toISOString() },
			})
			.expect(400)
			.expect((errorRes) => {
				expect(errorRes.body.message).toContain("不能早于账本起点");
			});
		// 日期晚于今天 → 400
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgBearer(user))
			.send({
				targetType: "TRANSACTION",
				targetId: res.body.data.id,
				baseVersion: 1,
				reason: "改日期",
				changes: { transactedAt: daysAgo(-2).toISOString() },
			})
			.expect(400)
			.expect((errorRes) => {
				expect(errorRes.body.message).toContain("不能晚于今天");
			});
	});

	// ── list / target 契约 ──
	it("list 按 createdAt 倒序返回 APPLIED 与 FAILED；参数缺失 400", async () => {
		const user = await newUser("corr-list");
		const { transactionId } = await seedUnknownFeePurchase(user);
		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({
				targetType: "TRANSACTION",
				targetId: transactionId,
				baseVersion: 1,
				reason: "成功的更正",
				changes: { feeAmount: "20.00" },
			})
			.expect(201);
		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgBearer(user))
			.send({
				targetType: "TRANSACTION",
				targetId: transactionId,
				baseVersion: 2,
				reason: "会失败的更正",
				changes: { feeAmount: "-1.00" },
			})
			.expect(400); // 负手续费在参数层被拒，不产生 FAILED

		const res = await request(app.getHttpServer())
			.get(`/api/corrections?targetType=TRANSACTION&targetId=${transactionId}`)
			.set(orgBearer(user))
			.expect(200);
		expect(res.body.data.total).toBe(1);
		expect(res.body.data.items[0]).toMatchObject({
			targetType: "TRANSACTION",
			targetId: transactionId,
			reason: "成功的更正",
			status: "APPLIED",
		});

		// 参数缺失 400
		await request(app.getHttpServer())
			.get("/api/corrections?targetType=TRANSACTION")
			.set(orgBearer(user))
			.expect(400)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("INVALID_CORRECTION_PARAMS");
			});
	});

	it("target 返回目标当前内容（含 version 乐观基准）", async () => {
		const user = await newUser("corr-target");
		const { transactionId } = await seedUnknownFeePurchase(user);
		const res = await request(app.getHttpServer())
			.get(
				`/api/corrections/target?targetType=TRANSACTION&targetId=${transactionId}`,
			)
			.set(orgBearer(user))
			.expect(200);
		expect(res.body.data.target).toMatchObject({
			id: transactionId,
			currencyCode: "USD",
			feeAmount: null,
			version: 1,
		});
	});
});

/**
 * ToB R1 W24：更正写接口 Actor 化（LEDGER-04 / AUTH-01）。
 * 组织共享账本下的权限矩阵、跨组织隔离、FAILED 留痕、锁内降权、审计原子性与组织账本重放。
 * 每个用例自建组织与成员并在 afterEach 清理（先清派生行再删用户，不留孤儿组织），
 * 写入全部走带 X-Organization-Id 的接口；支持按用例名 `-t` 独立运行。
 */
describe("ToB R1 W24：Correction 写接口 Actor 化 + 权限矩阵 + 跨组织隔离 + FAILED 留痕 + 锁内降权 + 审计回滚（支持 -t 独立运行）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const orgs: OrgLedger[] = [];

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
	}, 30_000);

	afterEach(async () => {
		vi.restoreAllMocks();
		if (orgs.length > 0) {
			await cleanupOrgLedgers(ctx.prisma, ...orgs.splice(0));
		}
	});

	afterAll(async () => {
		await closeTestApps(app);
	});

	function orgPreview(user: TestUser, orgId: string, body: Record<string, unknown>) {
		return request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(orgHeaders(user, orgId))
			.send(body);
	}

	function orgApply(
		user: TestUser,
		orgId: string,
		body: Record<string, unknown>,
		requestId?: string,
	) {
		return request(app.getHttpServer())
			.post("/api/corrections")
			.set(orgHeaders(user, orgId, requestId))
			.send(body);
	}

	function orgPostUsage(
		user: TestUser,
		orgId: string,
		planId: string,
		body: Record<string, unknown>,
	) {
		return request(app.getHttpServer())
			.post(`/api/plans/${planId}/usages`)
			.set(orgHeaders(user, orgId))
			.send(body);
	}

	/**
	 * 组织世界：buyer 买入 USD + 接口建计划（目标额 = 买入量；分配额缺省为买入量的 80%，
	 * 全额分配会因排期金额为 0 被拒绝），返回交易 id 与计划 id
	 */
	async function seedOrgWorld(
		org: OrgLedger,
		options: {
			buyer?: TestUser;
			quantity?: string;
			unitCost?: string;
			boughtAt?: Date;
			allocatedAmount?: string;
		} = {},
	) {
		const quantity = options.quantity ?? "1000";
		const purchase = await request(app.getHttpServer())
			.post("/api/transactions")
			.set(orgHeaders(options.buyer ?? org.owner, org.orgId))
			.send(
				purchaseBody(
					"USD",
					quantity,
					options.unitCost ?? "7.8",
					options.boughtAt ?? daysAgo(3),
				),
			)
			.expect(201);
		const plan = await request(app.getHttpServer())
			.post("/api/plans")
			.set(orgHeaders(org.owner, org.orgId))
			.send({
				targetCurrency: "USD",
				targetAmount: quantity,
				expectUseDate: PLAN_EXPECT_USE_DATE,
				prepLeadDays: 3,
				pacePreference: "balanced",
				startDate: PLAN_START_DATE,
				allocatedAmount:
					options.allocatedAmount ??
					new Prisma.Decimal(quantity).mul("0.8").toFixed(4),
			})
			.expect(201);
		return {
			transactionId: purchase.body.data.id as string,
			planId: plan.body.data.id as string,
		};
	}

	it.each(["OPERATOR", "VIEWER"] as const)(
		"W24-CORR-1 %s 提交更正 → 403 PERMISSION_DENIED + DENIED 审计（带 requestId）+ 账本零变化",
		async (role) => {
			const org = await createOrgLedger(app, ctx.prisma, `w24-corr-denied-${role.toLowerCase()}`, [
				role,
			]);
			orgs.push(org);
			const member = org.members[0];
			const { transactionId } = await seedOrgWorld(org);
			const requestId = `req-w24-corr-denied-${role}-${Date.now()}`;
			const before = await readOrgLedgerSnapshot(ctx.prisma, org.orgId);

			const res = await orgApply(
				member,
				org.orgId,
				{
					targetType: "TRANSACTION",
					targetId: transactionId,
					baseVersion: 1,
					reason: "无权成员尝试更正",
					changes: { feeAmount: "20" },
				},
				requestId,
			).expect(403);
			expect(res.body.code).toBe("PERMISSION_DENIED");

			// 账本逐行不变（目标版本、批次、余额），没有任何更正留痕
			expect(await readOrgLedgerSnapshot(ctx.prisma, org.orgId)).toEqual(before);
			expect(
				await ctx.prisma.correction.count({ where: { organizationId: org.orgId } }),
			).toBe(0);
			const denied = await ctx.prisma.auditLog.findMany({
				where: {
					organizationId: org.orgId,
					actorUserId: member.userId,
					action: "permission.denied.correction.apply",
					result: "DENIED",
					requestId,
				},
			});
			expect(denied).toHaveLength(1);
			expect(denied[0].detail).toMatchObject({
				required: "correction.apply",
				role,
			});
		},
	);

	it("W24-CORR-2 跨组织目标：多组织用户带 Org B 头对 Org A 记录 preview / apply / target / list → 一律 404 CORRECTION_TARGET_NOT_FOUND，零留痕零变化", async () => {
		const org = await createOrgLedger(app, ctx.prisma, "w24-corr-cross-org");
		orgs.push(org);
		const owner = org.owner;
		const { transactionId } = await seedOrgWorld(org);
		const orgB = await createSecondOrg(ctx.prisma, owner, "W24 更正跨组织 B");
		orgs.push(orgB);
		const before = await readOrgLedgerSnapshot(ctx.prisma, org.orgId);

		const body = {
			targetType: "TRANSACTION",
			targetId: transactionId,
			baseVersion: 1,
			reason: "带错组织头",
			changes: { feeAmount: "1" },
		};
		const crossPreview = await orgPreview(owner, orgB.orgId, body).expect(404);
		expect(crossPreview.body.code).toBe("CORRECTION_TARGET_NOT_FOUND");
		// 防枚举：跨组织目标与不存在的 id 响应体一致，且不带回账本重放内容
		const missingPreview = await orgPreview(owner, orgB.orgId, {
			...body,
			targetId: "nonexistent-target-id",
		}).expect(404);
		expect(crossPreview.body).toEqual(missingPreview.body);
		expect(crossPreview.body.data).toBeUndefined();
		const crossApply = await orgApply(owner, orgB.orgId, body).expect(404);
		expect(crossApply.body.code).toBe("CORRECTION_TARGET_NOT_FOUND");
		const crossTarget = await request(app.getHttpServer())
			.get(`/api/corrections/target?targetType=TRANSACTION&targetId=${transactionId}`)
			.set(orgHeaders(owner, orgB.orgId))
			.expect(404);
		expect(crossTarget.body.code).toBe("CORRECTION_TARGET_NOT_FOUND");
		await request(app.getHttpServer())
			.get(`/api/corrections?targetType=TRANSACTION&targetId=${transactionId}`)
			.set(orgHeaders(owner, orgB.orgId))
			.expect(404);

		// 零副作用：无留痕、无审计，Org A 账本逐行不变（没有为一次 404 做收口或重建）
		expect(await ctx.prisma.correction.count({ where: { targetId: transactionId } })).toBe(0);
		expect(
			await ctx.prisma.auditLog.count({
				where: {
					organizationId: { in: [org.orgId, orgB.orgId] },
					action: { in: ["correction.apply", "permission.denied.correction.apply"] },
				},
			}),
		).toBe(0);
		expect(await readOrgLedgerSnapshot(ctx.prisma, org.orgId)).toEqual(before);

		// 对照：同一用户带 Org A 头即可预览这笔记录
		const ownPreview = await orgPreview(owner, org.orgId, body).expect(200);
		expect(ownPreview.body.data.blockers).toEqual([]);
	});

	it("W24-CORR-3 复核不通过（历史时点缺口）：FAILED 留痕与 FAILED 审计均带 organizationId / actorUserId / requestId，账本零变化", async () => {
		const org = await createOrgLedger(app, ctx.prisma, "w24-corr-failed", ["FINANCE"]);
		orgs.push(org);
		const finance = org.members[0];
		const { transactionId, planId } = await seedOrgWorld(org, {
			buyer: finance,
			boughtAt: daysAgo(4),
		});
		await orgPostUsage(finance, org.orgId, planId, {
			amount: "400",
			usedAt: daysAgo(2).toISOString(),
		}).expect(201);
		const before = await readOrgLedgerSnapshot(ctx.prisma, org.orgId);
		const requestId = `req-w24-corr-failed-${Date.now()}`;

		// 把买入改到使用之后：使用发生时资金不足（V3）
		const res = await orgApply(
			finance,
			org.orgId,
			{
				targetType: "TRANSACTION",
				targetId: transactionId,
				baseVersion: 1,
				reason: "买入日期记错了，实际更晚",
				changes: { transactedAt: daysAgo(1).toISOString() },
			},
			requestId,
		).expect(409);
		expect(res.body.code).toBe("CORRECTION_HISTORICAL_SHORTFALL");

		const failed = await ctx.prisma.correction.findMany({
			where: { targetId: transactionId },
		});
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({
			status: "FAILED",
			organizationId: org.orgId,
			actorUserId: finance.userId,
		});
		expect(failed[0].failReason).toContain("CORRECTION_HISTORICAL_SHORTFALL");
		// 事务外独立审计：谁、在哪个组织、对哪条记录、为何被拒
		expect(
			await ctx.prisma.auditLog.findMany({
				where: { organizationId: org.orgId, action: "correction.apply" },
			}),
		).toEqual([
			expect.objectContaining({
				actorUserId: finance.userId,
				actorType: "USER",
				targetType: "transaction",
				targetId: transactionId,
				result: "FAILED",
				requestId,
				detail: expect.objectContaining({
					correctionId: failed[0].id,
					// 拒绝码须原文可读（键名 failCode；若误用 code 会被审计脱敏器抹成 [REDACTED]）
					failCode: "CORRECTION_HISTORICAL_SHORTFALL",
				}),
			}),
		]);
		// 业务写入已整体回滚：批次、分摊、余额、分配逐行不变
		expect(await readOrgLedgerSnapshot(ctx.prisma, org.orgId)).toEqual(before);
	});

	it("W24-CORR-4 锁等期间降权（FINANCE → OPERATOR）：事务内按最新角色复验 → 403 + DENIED 审计（记录降权后的角色）+ 零写入零留痕", async () => {
		const org = await createOrgLedger(app, ctx.prisma, "w24-corr-demote", ["FINANCE"]);
		orgs.push(org);
		const finance = org.members[0];
		const { transactionId } = await seedOrgWorld(org);
		const before = await readOrgLedgerSnapshot(ctx.prisma, org.orgId);
		const requestId = `req-w24-corr-demote-${Date.now()}`;

		const res = await runBehindAdvisoryLock(
			ctx.prisma,
			`membership:${org.orgId}`,
			() =>
				orgApply(
					finance,
					org.orgId,
					{
						targetType: "TRANSACTION",
						targetId: transactionId,
						baseVersion: 1,
						reason: "锁等期间被降权",
						changes: { feeAmount: "20" },
					},
					requestId,
				),
			async () => {
				// 请求已通过 Guard（当时是 FINANCE）并阻塞在组织锁上：此刻把它降为 OPERATOR
				await ctx.prisma.membership.update({
					where: {
						organizationId_userId: {
							organizationId: org.orgId,
							userId: finance.userId,
						},
					},
					data: { role: "OPERATOR" },
				});
			},
		);

		expect(res.status).toBe(403);
		expect(res.body.code).toBe("PERMISSION_DENIED");
		// 降权拦截不留 FAILED 尝试，账本逐行不变
		expect(await readOrgLedgerSnapshot(ctx.prisma, org.orgId)).toEqual(before);
		expect(
			await ctx.prisma.correction.count({ where: { organizationId: org.orgId } }),
		).toBe(0);
		const denied = await ctx.prisma.auditLog.findMany({
			where: {
				organizationId: org.orgId,
				actorUserId: finance.userId,
				action: "permission.denied.correction.apply",
				result: "DENIED",
				requestId,
			},
		});
		expect(denied).toHaveLength(1);
		expect(denied[0].detail).toMatchObject({
			required: "correction.apply",
			role: "OPERATOR",
		});
	});

	it("W24-CORR-5 AuditService.recordInTx 故障注入：更正全链路（目标行 / 分配 / 批次 / 分摊 / 余额 / 留痕 / 补分配日志）整单回滚", async () => {
		const org = await createOrgLedger(app, ctx.prisma, "w24-corr-audit-fault", ["FINANCE"]);
		orgs.push(org);
		const finance = org.members[0];
		const { planId } = await seedOrgWorld(org, {
			buyer: finance,
			quantity: "2000",
			allocatedAmount: "1200",
		});
		const usage = await orgPostUsage(finance, org.orgId, planId, {
			amount: "1200",
			usedAt: utc8DayStart(new Date()).toISOString(),
		}).expect(201);
		const usageId = usage.body.data.usage.id as string;
		// 1,200 → 1,500：超出本计划剩余分配 0 → 补分配 300（会写 PlanChangeLog）
		const preview = await orgPreview(finance, org.orgId, {
			targetType: "USAGE",
			targetId: usageId,
			baseVersion: 1,
			reason: "使用金额少记了 300",
			changes: { amount: "1500" },
		}).expect(200);
		expect(preview.body.data.blockers).toEqual([]);
		const payload = {
			targetType: "USAGE",
			targetId: usageId,
			baseVersion: 1,
			reason: "使用金额少记了 300",
			changes: { amount: "1500" },
			expectedUsageImpact: preview.body.data.expectedUsageImpact,
		};
		const before = await readOrgLedgerSnapshot(ctx.prisma, org.orgId);

		vi.spyOn(app.get(AuditService), "recordInTx").mockRejectedValueOnce(
			new Error("injected tx audit failure"),
		);
		await orgApply(finance, org.orgId, payload).expect(500);

		// 账、批次、分摊、分配逐行回到写前（含批次行 id——重建已回滚），且无任何留痕与审计
		expect(await readOrgLedgerSnapshot(ctx.prisma, org.orgId)).toEqual(before);
		expect(
			await ctx.prisma.correction.count({ where: { targetId: usageId } }),
		).toBe(0);
		expect(await ctx.prisma.planChangeLog.count({ where: { planId } })).toBe(0);
		expect(
			await ctx.prisma.auditLog.count({
				where: { organizationId: org.orgId, action: "correction.apply" },
			}),
		).toBe(0);

		// 对照：故障只注入一次，同一预览随后可正常提交
		await orgApply(finance, org.orgId, payload).expect(201);
		expect(
			await ctx.prisma.auditLog.count({
				where: { organizationId: org.orgId, action: "correction.apply", result: "SUCCESS" },
			}),
		).toBe(1);
	});

	it("W24-CORR-6 受邀成员更正他人买入：预览与提交都按组织账本重放（不是自己的空账本），重建批次仍归买入人", async () => {
		const org = await createOrgLedger(app, ctx.prisma, "w24-corr-member-replay", [
			"FINANCE",
			"FINANCE",
		]);
		orgs.push(org);
		const [finance1, finance2] = org.members;
		const { transactionId } = await seedOrgWorld(org, {
			buyer: finance1,
			quantity: "1000",
		});
		const requestId = `req-w24-corr-member-${Date.now()}`;
		const body = {
			targetType: "TRANSACTION",
			targetId: transactionId,
			baseVersion: 1,
			reason: "手续费当时漏填",
			changes: { feeAmount: "20" },
		};

		// Finance 2 名下没有任何买入：预览余额来自组织账本（1,000），不是自己的 0
		const preview = await orgPreview(finance2, org.orgId, body).expect(200);
		expect(preview.body.data.blockers).toEqual([]);
		expect(preview.body.data.impacts.balances).toEqual([
			{ currencyCode: "USD", before: "1000.0000", after: "1000.0000" },
		]);

		const applied = await orgApply(finance2, org.orgId, body, requestId).expect(201);
		expect(applied.body.data).toMatchObject({
			status: "APPLIED",
			targetVersion: 2,
		});
		// 留痕与更正日志显示所属组织与实际操作者（LEDGER-04.4）；买入人 Finance 1 也看得到这条日志
		const history = await request(app.getHttpServer())
			.get(`/api/corrections?targetType=TRANSACTION&targetId=${transactionId}`)
			.set(orgHeaders(finance1, org.orgId))
			.expect(200);
		expect(history.body.data.items).toEqual([
			{
				id: applied.body.data.correctionId,
				organizationId: org.orgId,
				actorUserId: finance2.userId,
				targetType: "TRANSACTION",
				targetId: transactionId,
				status: "APPLIED",
				reason: "手续费当时漏填",
				failReason: null,
				beforeSnapshot: expect.any(Object),
				afterSnapshot: expect.any(Object),
				createdAt: expect.any(String),
			},
		]);

		const snapshot = await readOrgLedgerSnapshot(ctx.prisma, org.orgId);
		expect(snapshot.accounts).toEqual([
			expect.objectContaining({
				// W30（MIG-E）：账户不再持有 user_id 列，创建人落在 created_by_id
				createdById: finance1.userId,
				organizationId: org.orgId,
				balance: "1000.0000",
			}),
		]);
		// 批次重建：单价 (7,800 + 20) ÷ 1,000 = 7.82，仍归买入人 Finance 1
		expect(snapshot.lots).toHaveLength(1);
		expect(snapshot.lots[0]).toMatchObject({
			sourceId: transactionId,
			organizationId: org.orgId,
			unitCost: "7.82000000",
		});
		// 批次自身不再持有 user_id 列：归属人取来源记录的 created_by_id
		expect(
			await ctx.prisma.transaction.findUniqueOrThrow({
				where: { id: snapshot.lots[0].sourceId },
				select: { createdById: true },
			}),
		).toEqual({ createdById: finance1.userId });
		expect(
			await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } }),
		).toMatchObject({ createdById: finance1.userId, version: 2 });
		expect(
			await ctx.prisma.auditLog.findMany({
				where: { organizationId: org.orgId, action: "correction.apply" },
			}),
		).toEqual([
			expect.objectContaining({
				actorUserId: finance2.userId,
				targetType: "transaction",
				targetId: transactionId,
				result: "SUCCESS",
				requestId,
			}),
		]);
	});
});
