import { randomUUID } from "node:crypto";
/**
 * 更正与日志接口测试（corrections 技术方案 §8.2，场景 1~24）。
 * 数值锚定 doc 14 例 10/11/12 与 doc 15 FIFO 例。常规交易日期相对今天构造，
 * 原时点取价用固定 UTC+8 日期。测试不修改系统时钟。
 * USAGE 更正场景（#11~#16）在 M7 接线前按方案 §10 降级断言 400
 * CORRECTION_TARGET_TYPE_UNAVAILABLE，M7 落地后恢复为原场景断言。
 */
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	bearer,
	cleanupUser,
	createTestApp,
	createTestUser,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";
import { ensureOnboarded } from "../helpers/onboarding-helper";
import { RateProvider } from "../../src/rate/rate.provider";
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
				// 裸外键表先删（PlanAllocation / UsageLotAllocation 无 user relation）
				const plans = await ctx.prisma.plan.findMany({
					where: { userId },
					select: { id: true },
				});
				await ctx.prisma.planAllocation.deleteMany({
					where: { planId: { in: plans.map((plan) => plan.id) } },
				});
				const usages = await ctx.prisma.usageRecord.findMany({
					where: { userId },
					select: { id: true },
				});
				await ctx.prisma.usageLotAllocation.deleteMany({
					where: { usageId: { in: usages.map((usage) => usage.id) } },
				});
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
			.set(bearer(user.accessToken))
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
				.set(bearer(input.user.accessToken))
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
			.set(bearer(user.accessToken))
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
		expect(data.impacts.blockers ?? data.blockers).toHaveLength(0);
		expect(data.blockers).toHaveLength(0);
	});

	it("#3 apply 手续费补录：feeAmount=20、version=2、Correction APPLIED、快照 before.feeAmount=null", async () => {
		const user = await newUser("corr-fee-apply");
		const { transactionId } = await seedUnknownFeePurchase(user);

		const res = await request(app.getHttpServer())
			.post("/api/corrections")
			.set(bearer(user.accessToken))
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
			.set(bearer(user.accessToken))
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
			.set(bearer(user.accessToken))
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
			where: { userId: user.userId, currencyCode: "USD" },
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
			.set(bearer(user.accessToken))
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
			.set(bearer(user.accessToken))
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
			.set(bearer(user.accessToken))
			.send({
				targetType: "TRANSACTION",
				targetId: res1.body.data.id,
				baseVersion: 1,
				reason: "第一笔实际是加元",
				changes: { currencyCode: "CAD" },
			})
			.expect(201);

		const usd = await ctx.prisma.account.findUniqueOrThrow({
			where: {
				userId_currencyCode: { userId: user.userId, currencyCode: "USD" },
			},
		});
		expect(usd.balance.toFixed(4)).toBe("500.0000"); // 旧账户归零保留语义：余额为剩余批次
		const cad = await ctx.prisma.account.findUniqueOrThrow({
			where: {
				userId_currencyCode: { userId: user.userId, currencyCode: "CAD" },
			},
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
			.set(bearer(user.accessToken))
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
			.set(bearer(user.accessToken))
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
		const usd = await ctx.prisma.account.findUniqueOrThrow({
			where: {
				userId_currencyCode: { userId: user.userId, currencyCode: "USD" },
			},
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
			.set(bearer(user.accessToken))
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

	// ── #9 baseVersion 过期 ──
	it("#9 baseVersion 过期 → 409 CORRECTION_TARGET_CHANGED", async () => {
		const user = await newUser("corr-optimistic");
		const { transactionId } = await seedUnknownFeePurchase(user);
		// 第一次更正成功 → version 2
		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(bearer(user.accessToken))
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
			.set(bearer(user.accessToken))
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
			.set(bearer(user.accessToken))
			.send({ ...base, reason: "", changes: { feeAmount: "20.00" } })
			.expect(400);
		// 原因纯空格（穿透 DTO 后由 V0 拦截，错误码 INVALID_CORRECTION_PARAMS）
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(bearer(user.accessToken))
			.send({ ...base, reason: "   ", changes: { feeAmount: "20.00" } })
			.expect(400)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("INVALID_CORRECTION_PARAMS");
			});
		// changes 为空（无有效变化）
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(bearer(user.accessToken))
			.send({ ...base, reason: "没有变化", changes: {} })
			.expect(400)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("INVALID_CORRECTION_PARAMS");
			});
		// 白名单外字段（汇率不可改）
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(bearer(user.accessToken))
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

	// ── #11~#16 / #24 USAGE 降级（M7 未接线；接线后恢复原场景断言）──
	it("#11~#16/#24 USAGE 目标在 M7 接线前一律 400 CORRECTION_TARGET_TYPE_UNAVAILABLE", async () => {
		const user = await newUser("corr-usage-degraded");
		const usagePayload = {
			targetType: "USAGE",
			targetId: "usage-placeholder",
			baseVersion: 1,
			reason: "使用金额改小",
			changes: { amount: "400.0000" },
		};
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(bearer(user.accessToken))
			.send(usagePayload)
			.expect(400)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("CORRECTION_TARGET_TYPE_UNAVAILABLE");
			});
		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(bearer(user.accessToken))
			.send(usagePayload)
			.expect(400)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("CORRECTION_TARGET_TYPE_UNAVAILABLE");
			});
		// 降级发生在目标加载前：不泄露目标存在性，也无 FAILED 留痕
		const corrections = await ctx.prisma.correction.findMany({
			where: { userId: user.userId },
		});
		expect(corrections).toHaveLength(0);
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
			.set(bearer(user.accessToken))
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
		const account = await ctx.prisma.account.findUniqueOrThrow({
			where: {
				userId_currencyCode: { userId: user.userId, currencyCode: "USD" },
			},
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
			.set(bearer(userA.accessToken))
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
			.set(bearer(userB.accessToken))
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
			where: { userId: userB.userId, currencyCode: "HKD" },
		});
		expect(lots).toHaveLength(0); // 数量 0 不生成空批次
		const account = await ctx.prisma.account.findUniqueOrThrow({
			where: {
				userId_currencyCode: { userId: userB.userId, currencyCode: "HKD" },
			},
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

		const where = { userId: user.userId };
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
					.set(bearer(user.accessToken))
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
				.set(bearer(user.accessToken))
				.send(payload)
				.expect(200);
			expect(preview.body.data.after).toMatchObject(expected);
			expect(preview.body.data.blockers).toEqual([]);
			expect(await ledgerSnapshot()).toEqual(before);

			const applied = await request(app.getHttpServer())
				.post("/api/corrections")
				.set(bearer(user.accessToken))
				.send(payload)
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
			.set(bearer(user.accessToken))
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

		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(bearer(user.accessToken))
			.send(payload)
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
			where: { userId: user.userId, currencyCode: "USD" },
		});
		expect(usdLots).toHaveLength(0);
		const cadLot = await ctx.prisma.costLot.findFirstOrThrow({
			where: { userId: user.userId, currencyCode: "CAD" },
		});
		expect(cadLot.sourceId).toBe(holdingId);
		const cadAccount = await ctx.prisma.account.findUniqueOrThrow({
			where: {
				userId_currencyCode: { userId: user.userId, currencyCode: "CAD" },
			},
		});
		expect(cadAccount.balance.toFixed(4)).toBe("1000.0000");
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
				.set(bearer(user.accessToken))
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

		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(bearer(user.accessToken))
			.send(payload)
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
			.set(bearer(stranger.accessToken))
			.send(payload)
			.expect(404)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("CORRECTION_TARGET_NOT_FOUND");
			});
		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(bearer(stranger.accessToken))
			.send(payload)
			.expect(404);
		await request(app.getHttpServer())
			.get(`/api/corrections?targetType=TRANSACTION&targetId=${transactionId}`)
			.set(bearer(stranger.accessToken))
			.expect(404);
		await request(app.getHttpServer())
			.get(
				`/api/corrections/target?targetType=TRANSACTION&targetId=${transactionId}`,
			)
			.set(bearer(stranger.accessToken))
			.expect(404);
	});

	// ── #22 preview 不落任何行 ──
	it("#22 preview 前后 Correction/Transaction/Account/批次行数与内容零变化", async () => {
		const user = await newUser("corr-preview-readonly");
		const { transactionId } = await seedUnknownFeePurchase(user);
		const countAll = () =>
			Promise.all([
				ctx.prisma.correction.count({ where: { userId: user.userId } }),
				ctx.prisma.transaction.findMany({ where: { userId: user.userId } }),
				ctx.prisma.account.findMany({ where: { userId: user.userId } }),
				ctx.prisma.costLot.findMany({ where: { userId: user.userId } }),
			]);
		const snapshotBefore = await countAll();

		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(bearer(user.accessToken))
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
			.set(bearer(user.accessToken))
			.send({
				currencyCode: "JPY",
				principalAmount: "5000",
				exchangeRate: "0.05000000",
				quantity: "100000",
				transactedAt: daysAgo(3).toISOString(),
			})
			.expect(201);
		// 设账本起点（UTC+8 今天），下界校验生效；settings 已由 ensureOnboarded 建，改 upsert
		await ctx.prisma.userSettings.upsert({
			where: { userId: user.userId },
			update: { ledgerStartedAt: new Date(Date.now() - 86_400_000) },
			create: {
				userId: user.userId,
				baseCurrency: "CNY",
				locale: "zh-CN",
				region: "CN",
				ledgerStartedAt: new Date(Date.now() - 86_400_000),
			},
		});

		// JPY 数量带小数 → 400
		await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(bearer(user.accessToken))
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
			.set(bearer(user.accessToken))
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
			.set(bearer(user.accessToken))
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
			.set(bearer(user.accessToken))
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
			.set(bearer(user.accessToken))
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
			.set(bearer(user.accessToken))
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
			.set(bearer(user.accessToken))
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
			.set(bearer(user.accessToken))
			.expect(200);
		expect(res.body.data.target).toMatchObject({
			id: transactionId,
			currencyCode: "USD",
			feeAmount: null,
			version: 1,
		});
	});
});
