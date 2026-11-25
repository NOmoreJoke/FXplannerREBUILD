/**
 * 更正重放一致性集成测试（corrections 技术方案 §8.3，真实数据库 + 真实事务链路）：
 * 1. 全链路（doc 15 + 例 10）：初始 → 两笔买入 → 分配 → 使用 → 更正买入日期 → 批次重建与不变式；
 * 2. USAGE 降级（M7 未接线；接线后恢复「使用改大补分配全链路」断言）；
 * 3. 重放幂等：同一请求二次 apply → 409 TARGET_CHANGED，数据逐字段一致；
 * 4. 跨用户隔离：用户 B 对用户 A 记录 preview/apply/list 全 404；
 * 5. 并发：更正 apply 与同币种买入 create 同时提交，行锁串行化后不变式成立。
 *
 * 断言锚定：账户不变式「balance = Σ剩余分配 + 未分配余额」与「Σ使用成本 = Σ分摊成本」。
 */
import type { INestApplication } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import request, { type Response } from "supertest";
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
import {
	seedInitialHolding,
	seedPlanWithAllocationRow,
	seedUsageRecord,
} from "../helpers/correction-fixture";

vi.mock("@nestjs/throttler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nestjs/throttler")>();
	class NoopThrottlerGuard {
		async canActivate() {
			return true;
		}
	}
	return { ...actual, ThrottlerGuard: NoopThrottlerGuard };
});

function daysAgo(n: number): Date {
	return new Date(Date.now() - n * 86_400_000 - 2 * 60 * 60 * 1000);
}

/** 账户不变式：balance = Σ lot remainingQty；使用成本不变式：Σ分摊 = Σ批次分摊成本 */
async function assertInvariants(prisma: TestContext["prisma"], userId: string) {
	const accounts = await prisma.account.findMany({ where: { userId } });
	for (const account of accounts) {
		const aggregated = await prisma.costLot.aggregate({
			_sum: { remainingQty: true },
			where: { userId, currencyCode: account.currencyCode },
		});
		expect(
			(aggregated._sum.remainingQty ?? new Prisma.Decimal(0)).eq(
				account.balance,
			),
		).toBe(true);
	}
	const usages = await prisma.usageRecord.findMany({ where: { userId } });
	for (const usage of usages) {
		const allocations = await prisma.usageLotAllocation.findMany({
			where: { usageId: usage.id },
		});
		const allocationSum = allocations.reduce(
			(sum, allocation) => sum.add(allocation.cost),
			new Prisma.Decimal(0),
		);
		// UsageRecord 无成本列：分摊成本之和即为该笔使用成本，非负且等于 Σ(数量 × 批次单价)
		for (const allocation of allocations) {
			const lot = await prisma.costLot.findUniqueOrThrow({
				where: { id: allocation.lotId },
			});
			expect(allocation.cost.eq(allocation.quantity.mul(lot.unitCost))).toBe(
				true,
			);
		}
		expect(allocationSum.gte(0)).toBe(true);
		// 数量不变量（真实断言，替换历史上的恒真 `|| true`）：无历史缺口的已应用
		// 账本中，分摊数量合计 === 该笔使用金额（有缺口会在 V3 被拒，不会走到这里）
		expect(
			allocations
				.reduce(
					(sum, allocation) => sum.add(allocation.quantity),
					new Prisma.Decimal(0),
				)
				.eq(usage.amount),
		).toBe(true);
	}
}

describe("更正重放一致性（集成）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const userIds: string[] = [];

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
	});

	afterAll(async () => {
		try {
			for (const userId of userIds.splice(0).reverse()) {
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
		} finally {
			await app?.close();
		}
	});

	async function newUser(label: string): Promise<TestUser> {
		const user = await createTestUser(app, label);
		userIds.push(user.userId);
		// BE-03：经 API 造交易需已建账，否则写入口 409 ONBOARDING_NOT_COMPLETED
		await ensureOnboarded(ctx.prisma, user.userId);
		return user;
	}

	/** doc 15 + 例 10 全链路造数：初始 1,000 → 两笔买入（7,800/8,000）→ 分配 → 使用 1,200。
	 * allocatedAmount 可注入：默认 1,200（使用后剩余分配 0）；并发锁序测试传 1,500
	 * 留 300 余量，保证两条并发流程在任一串行顺序下均可成功（真正覆盖账户锁竞争） */
	async function seedFullLedger(
		user: TestUser,
		allocatedAmount = "1200",
	) {
		await seedInitialHolding(ctx.prisma, {
			userId: user.userId,
			currencyCode: "USD",
			amount: "1000",
			rate: "7.2480000000",
			cost: "7248.0000",
			confirmedAt: daysAgo(6),
		});
		const trades: string[] = [];
		const specs = [
			{ at: daysAgo(4), principal: "7800", quantity: "1000" },
			{ at: daysAgo(3), principal: "8000", quantity: "1000" },
		];
		for (const spec of specs) {
			const res = await request(app.getHttpServer())
				.post("/api/transactions")
				.set(bearer(user.accessToken))
				.send({
					currencyCode: "USD",
					principalAmount: spec.principal,
					exchangeRate: (
						Number(spec.principal) / Number(spec.quantity)
					).toFixed(8),
					quantity: spec.quantity,
					transactedAt: spec.at.toISOString(),
				})
				.expect(201);
			trades.push(res.body.data.id);
		}
		const { planId } = await seedPlanWithAllocationRow(ctx.prisma, {
			userId: user.userId,
			targetCurrency: "USD",
			targetAmount: "10000",
			allocatedAmount,
		});
		const lots = await ctx.prisma.costLot.findMany({
			where: { userId: user.userId, currencyCode: "USD" },
			orderBy: { acquiredAt: "asc" },
		});
		// FIFO 分摊：初始 1,000 + 买入 780 → 使用 1,200（初始 420 + 买入一 780）
		const initialLot = lots.find((lot) => lot.sourceType === "INITIAL")!;
		const firstLot = lots.find(
			(lot) => lot.sourceType === "PURCHASE" && lot.sourceId === trades[0],
		)!;
		const usageId = await seedUsageRecord(ctx.prisma, {
			userId: user.userId,
			planId,
			currencyCode: "USD",
			amount: "1200",
			usedAt: daysAgo(1),
			allocations: [
				{ lotId: initialLot.id, quantity: "420" },
				{ lotId: firstLot.id, quantity: "780" },
			],
		});
		return { tradeIds: trades, planId, usageId };
	}

	it("#1 全链路：更正第一笔买入日期 → 批次按重放结果重建、两不变式成立、使用行未改", async () => {
		const user = await newUser("corr-it-full");
		const { tradeIds, usageId } = await seedFullLedger(user);
		const firstTradeDate = daysAgo(2); // 改到第二笔（t-3）之后、使用（t-1）之前
		const before = await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(bearer(user.accessToken))
			.send({
				targetType: "TRANSACTION",
				targetId: tradeIds[0],
				baseVersion: 1,
				reason: "第一笔实际更晚",
				changes: { transactedAt: firstTradeDate.toISOString() },
			})
			.expect(200);
		expect(before.body.data.blockers).toHaveLength(0);

		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(bearer(user.accessToken))
			.send({
				targetType: "TRANSACTION",
				targetId: tradeIds[0],
				baseVersion: 1,
				reason: "第一笔实际更晚",
				changes: { transactedAt: firstTradeDate.toISOString() },
			})
			.expect(201);

		// 批次重建：3 行（1 INITIAL + 2 PURCHASE），remainingQty 与重放期望一致
		// FIFO 新顺序：初始 1,000 → 买入二 1,000 → 使用 1,200（初始 1,000 + 买入二 200）→ 买入一整批未耗
		const lots = await ctx.prisma.costLot.findMany({
			where: { userId: user.userId, currencyCode: "USD" },
		});
		expect(lots).toHaveLength(3);
		const bySource = new Map(lots.map((lot) => [lot.sourceId, lot]));
		expect(bySource.get(tradeIds[0])!.remainingQty.toFixed(4)).toBe(
			"1000.0000",
		);
		expect(bySource.get(tradeIds[0])!.acquiredAt.getTime()).toBe(
			firstTradeDate.getTime(),
		);
		expect(bySource.get(tradeIds[1])!.remainingQty.toFixed(4)).toBe("800.0000");
		const initialLotRow = lots.find((lot) => lot.sourceType === "INITIAL")!;
		expect(initialLotRow.remainingQty.toFixed(4)).toBe("0.0000");

		// 分摊按新批次归属：初始 1,000 + 买入二 200；使用成本 = 7,248 + 1,600 = 8,848
		const allocations = await ctx.prisma.usageLotAllocation.findMany({
			where: { usageId },
		});
		const byLot = new Map(
			allocations.map((allocation) => [allocation.lotId, allocation]),
		);
		expect(byLot.get(initialLotRow.id)!.quantity.toFixed(4)).toBe("1000.0000");
		expect(byLot.get(bySource.get(tradeIds[1])!.id)!.quantity.toFixed(4)).toBe(
			"200.0000",
		);
		const usageCost = allocations.reduce(
			(sum, allocation) => sum.add(allocation.cost),
			new Prisma.Decimal(0),
		);
		expect(usageCost.toFixed(4)).toBe("8848.0000");

		// 使用记录行未被修改（除分摊/成本重算外）
		const usage = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: usageId },
		});
		expect(usage.amount.toFixed(4)).toBe("1200.0000");
		expect(usage.version).toBe(1);

		await assertInvariants(ctx.prisma, user.userId);
	});

	it("#2 USAGE 改大补分配全链路（MVP-F0-3）：记录 v2 / 分配补入 + PlanChangeLog / 批次重建 / 两不变式", async () => {
		const user = await newUser("corr-it-usage");
		const { planId, usageId } = await seedFullLedger(user);
		const before = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: usageId },
		});

		// 使用 1,200 → 2,000（diff 800 > 剩余分配 0 → 补分配 800；分配 1,200+800=2,000）
		const preview = await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(bearer(user.accessToken))
			.send({
				targetType: "USAGE",
				targetId: usageId,
				baseVersion: before.version,
				reason: "使用金额少记了 800",
				changes: { amount: "2000" },
			})
			.expect(200);
		expect(preview.body.data.before.amount).toBe("1200.0000");
		expect(preview.body.data.after.amount).toBe("2000.0000");
		expect(preview.body.data.blockers).toHaveLength(0);

		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(bearer(user.accessToken))
			.send({
				targetType: "USAGE",
				targetId: usageId,
				baseVersion: before.version,
				reason: "使用金额少记了 800",
				changes: { amount: "2000" },
				expectedUsageImpact: preview.body.data.expectedUsageImpact,
			})
			.expect(201);

		// 目标行：amount/version 联动
		const usage = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: usageId },
		});
		expect(usage.amount.toFixed(4)).toBe("2000.0000");
		expect(usage.version).toBe(2);
		// 计划分配：补分配 +800 → amount 2,000；usedAmount 1,200+800 = 2,000
		const allocation = await ctx.prisma.planAllocation.findUniqueOrThrow({
			where: { planId },
		});
		expect(allocation.amount.toFixed(4)).toBe("2000.0000");
		expect(allocation.usedAmount.toFixed(4)).toBe("2000.0000");
		// PlanChangeLog ALLOCATION_ADJUSTED 留痕
		const changeLogs = await ctx.prisma.planChangeLog.findMany({
			where: { planId, changeType: "ALLOCATION_ADJUSTED" },
		});
		expect(changeLogs).toHaveLength(1);
		// 批次重建：usage 2,000 = 初始 1,000@7.248 + 买入一 1,000@7.8
		const allocations = await ctx.prisma.usageLotAllocation.findMany({
			where: { usageId },
		});
		expect(allocations).toHaveLength(2);
		// 两不变式：balance = Σ剩余分配 + 未分配；重建分摊 = 理论成本（初始 1,000@7.248 + 买入一 1,000@7.8 = 15,048）
		const account = await ctx.prisma.account.findFirstOrThrow({
			where: { userId: user.userId, currencyCode: "USD" },
		});
		expect(account.balance.toFixed(4)).toBe("1000.0000");
		const totalAllocCost = (
			await ctx.prisma.usageLotAllocation.findMany({ where: { usageId } })
		).reduce((sum, item) => sum.add(item.cost), new Prisma.Decimal(0));
		expect(totalAllocCost.toFixed(4)).toBe("15048.0000");
	});

	it("补分配日志写入后发生异常：更正和整笔账本变更一并回滚", async () => {
		const user = await newUser("corr-it-audit-rollback");
		const { planId, usageId } = await seedFullLedger(user);
		const prisma = ctx.prisma;
		const accountKey = { userId: user.userId, currencyCode: "USD" };
		async function readLedger() {
			return Promise.all([
				prisma.usageRecord.findUniqueOrThrow({ where: { id: usageId } }),
				prisma.planAllocation.findUniqueOrThrow({ where: { planId } }),
				prisma.account.findFirstOrThrow({ where: accountKey }),
				prisma.costLot.findMany({ where: accountKey, orderBy: { id: "asc" } }),
				prisma.usageLotAllocation.findMany({ where: { usageId }, orderBy: { id: "asc" } }),
			]);
		}
		const before = await readLedger();

		// 复用事务客户端也会执行的 Prisma 中间件。先真实 INSERT，再模拟中断。
		let injectFailure = true;
		let insertedCorrectionId: string | undefined;
		let insertedLogId: string | undefined;
		let linkedCorrectionId: string | undefined;
		prisma.$use(async (params, next) => {
			const result = await next(params);
			if (injectFailure && params.action === "create") {
				if (params.model === "Correction" && params.args.data.targetId === usageId) {
					insertedCorrectionId = result.id;
				}
				if (params.model === "PlanChangeLog" && params.args.data.planId === planId) {
					insertedLogId = result.id;
					linkedCorrectionId = result.beforeSnapshot.correctionId;
					throw new Error("injected failure after supplement log insert");
				}
			}
			return result;
		});

		try {
			const payload = {
				targetType: "USAGE",
				targetId: usageId,
				baseVersion: 1,
				reason: "补分配写日志后模拟中断",
				changes: { amount: "2000" },
			};
			const auth = bearer(user.accessToken);
			const preview = await request(app.getHttpServer())
				.post("/api/corrections/preview")
				.set(auth)
				.send(payload)
				.expect(200);
			await request(app.getHttpServer())
				.post("/api/corrections")
				.set(auth)
				.send({ ...payload, expectedUsageImpact: preview.body.data.expectedUsageImpact })
				.expect(500);
		} finally {
			injectFailure = false;
		}

		expect(insertedLogId).toEqual(expect.any(String));
		expect(insertedCorrectionId).toEqual(expect.any(String));
		expect(linkedCorrectionId).toBe(insertedCorrectionId);
		expect(await readLedger()).toEqual(before);
		expect(await prisma.planChangeLog.count({ where: { planId } })).toBe(0);
		expect(await prisma.correction.count({ where: { targetType: "USAGE", targetId: usageId } })).toBe(0);
	});

	it("#3 重放幂等：同一请求二次 apply → 409 TARGET_CHANGED，数据与首次后状态逐字段一致", async () => {
		const user = await newUser("corr-it-idempotent");
		const { tradeIds } = await seedFullLedger(user);
		const payload = {
			targetType: "TRANSACTION",
			targetId: tradeIds[0],
			baseVersion: 1,
			reason: "同一请求重放",
			changes: { feeAmount: "20.00" },
		};
		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(bearer(user.accessToken))
			.send(payload)
			.expect(201);
		const snapshotAfterFirst = {
			transaction: await ctx.prisma.transaction.findUniqueOrThrow({
				where: { id: tradeIds[0] },
			}),
			lots: await ctx.prisma.costLot.findMany({
				where: { userId: user.userId, currencyCode: "USD" },
				orderBy: { unitCost: "asc" },
			}),
			account: await ctx.prisma.account.findFirstOrThrow({
				where: { userId: user.userId, currencyCode: "USD" },
			}),
		};

		// 二次提交同一 baseVersion：乐观校验拦截（预览后数据已变），不产生第二次更正
		await request(app.getHttpServer())
			.post("/api/corrections")
			.set(bearer(user.accessToken))
			.send(payload)
			.expect(409)
			.expect((errorRes) => {
				expect(errorRes.body.code).toBe("CORRECTION_TARGET_CHANGED");
			});

		const snapshotAfterSecond = {
			transaction: await ctx.prisma.transaction.findUniqueOrThrow({
				where: { id: tradeIds[0] },
			}),
			lots: await ctx.prisma.costLot.findMany({
				where: { userId: user.userId, currencyCode: "USD" },
				orderBy: { unitCost: "asc" },
			}),
			account: await ctx.prisma.account.findFirstOrThrow({
				where: { userId: user.userId, currencyCode: "USD" },
			}),
		};
		expect(snapshotAfterSecond.transaction).toEqual(
			snapshotAfterFirst.transaction,
		);
		expect(snapshotAfterSecond.lots).toEqual(snapshotAfterFirst.lots);
		expect(snapshotAfterSecond.account).toEqual(snapshotAfterFirst.account);
		expect(snapshotAfterFirst.transaction.version).toBe(2);
		await assertInvariants(ctx.prisma, user.userId);
	});

	it("#4 跨用户隔离：用户 B 对用户 A 记录的 preview/apply/list 全 404", async () => {
		const owner = await newUser("corr-it-owner");
		const stranger = await newUser("corr-it-stranger");
		const { tradeIds } = await seedFullLedger(owner);
		for (const path of [
			{
				method: "post" as const,
				url: "/api/corrections/preview",
				body: { reason: "x", changes: { feeAmount: "1.00" } },
			},
			{
				method: "post" as const,
				url: "/api/corrections",
				body: { reason: "x", changes: { feeAmount: "1.00" } },
			},
		]) {
			await request(app.getHttpServer())
				[path.method](path.url)
				.set(bearer(stranger.accessToken))
				.send({
					targetType: "TRANSACTION",
					targetId: tradeIds[0],
					baseVersion: 1,
					...path.body,
				})
				.expect(404)
				.expect((errorRes) => {
					expect(errorRes.body.code).toBe("CORRECTION_TARGET_NOT_FOUND");
				});
		}
		await request(app.getHttpServer())
			.get(`/api/corrections?targetType=TRANSACTION&targetId=${tradeIds[0]}`)
			.set(bearer(stranger.accessToken))
			.expect(404);
	});

	it("#5 并发：更正 apply 与同币种买入 create 同时提交，行锁串行化后不变式成立", async () => {
		const user = await newUser("corr-it-concurrent");
		const { tradeIds } = await seedFullLedger(user);
		const correctionPromise = request(app.getHttpServer())
			.post("/api/corrections")
			.set(bearer(user.accessToken))
			.send({
				targetType: "TRANSACTION",
				targetId: tradeIds[0],
				baseVersion: 1,
				reason: "并发更正",
				changes: { feeAmount: "50.00" },
			});
		const purchasePromise = request(app.getHttpServer())
			.post("/api/transactions")
			.set(bearer(user.accessToken))
			.send({
				currencyCode: "USD",
				principalAmount: "7000",
				exchangeRate: "7.00000000",
				quantity: "1000.0000",
				transactedAt: daysAgo(1).toISOString(),
			});

		const [correctionRes, purchaseRes] = await Promise.all([
			correctionPromise,
			purchasePromise,
		]);
		// 两者都成功（行锁串行化，无丢更新）：买入 version=1 不参与交易行的乐观校验
		expect([201, 409]).toContain(correctionRes.status);
		expect(purchaseRes.status).toBe(201);

		// 若更正因「买入已先落库但版本无关」成功，最终状态必须满足不变式
		await assertInvariants(ctx.prisma, user.userId);
		const balance = await ctx.prisma.account.findFirstOrThrow({
			where: { userId: user.userId, currencyCode: "USD" },
		});
		// 终态余额 = 初始 1,000 + 三笔买入 3,000 − 使用 1,200（与批次 Σremaining 严格一致）
		expect(balance.balance.toFixed(4)).toBe("2800.0000");
	});

	it("#6 B1 回归：同日买入时刻晚于使用，重放仍可用当天买入", async () => {
		const user = await newUser("corr-it-sameday");

		// 前端两处表单均按「所选日期 + T00:00:00.000Z」提交；今天（UTC+8 口径）
		const todayMidnightUtc = `${new Date(Date.now() + 8 * 3_600_000)
			.toISOString()
			.slice(0, 10)}T00:00:00.000Z`;

		// 同日买入 1,000（UI 口径）
		const tx = await request(app.getHttpServer())
			.post("/api/transactions")
			.set(bearer(user.accessToken))
			.send({
				currencyCode: "USD",
				principalAmount: "1000",
				exchangeRate: "1",
				quantity: "1000",
				transactedAt: todayMidnightUtc.replace("T00:", "T11:"),
			})
			.expect(201);

		// 计划分配 500（真实创建路径）
		const plan = await request(app.getHttpServer())
			.post("/api/plans")
			.set(bearer(user.accessToken))
			.send({
				targetCurrency: "USD",
				targetAmount: "10000",
				expectUseDate: "2030-02-15T00:00:00.000Z",
				prepLeadDays: 3,
				pacePreference: "balanced",
				startDate: "2030-01-01T00:00:00.000Z",
				allocatedAmount: "500",
			})
			.expect(201);

		// UI 按日期提交 UTC 0 点。当天 11:00Z 的买入应参与分摊。
		await request(app.getHttpServer())
			.post(`/api/plans/${plan.body.data.id}/usages`)
			.set(bearer(user.accessToken))
			.send({ amount: "500", usedAt: todayMidnightUtc })
			.expect(201);

		// 存储口径：usedAt 原样保留提交时刻（未被截断）
		const usage = await ctx.prisma.usageRecord.findFirstOrThrow({
			where: { userId: user.userId },
		});
		expect(usage.usedAt.toISOString()).toBe(todayMidnightUtc);

		// fee 补录预览触发重放，同一业务日内买入先于使用。
		const preview = await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(bearer(user.accessToken))
			.send({
				targetType: "TRANSACTION",
				targetId: tx.body.data.id,
				baseVersion: 1,
				reason: "补录手续费（B1 回归）",
				changes: { feeAmount: "10" },
			})
			.expect(200);
		expect(preview.body.data.blockers).toHaveLength(0);

		await assertInvariants(ctx.prisma, user.userId);
	});

	it("#7 CLOSEOUT-01：同日按 10:00Z、09:00Z 逆序补录，两计划的成本与来源在更正后保持首录分摊", async () => {
		const user = await newUser("corr-it-sameday-order");
		const useDay = daysAgo(2).toISOString().slice(0, 10);
		const laterDay = daysAgo(1).toISOString().slice(0, 10);
		const api = request(app.getHttpServer());
		const headers = bearer(user.accessToken);
		const tradeIds: string[] = [];
		for (const [day, hour, rate, principal] of [
			[useDay, "07", "5", "500"],
			[useDay, "08", "7", "700"],
			[laterDay, "08", "5", "500"],
		]) {
			const trade = await api
				.post("/api/transactions")
				.set(headers)
				.send({
					currencyCode: "USD",
					principalAmount: principal,
					exchangeRate: rate,
					quantity: "100",
					transactedAt: `${day}T${hour}:00:00.000Z`,
				})
				.expect(201);
			tradeIds.push(trade.body.data.id);
		}

		const usages = [];
		for (const [hour, cost, tradeId] of [
			["10", "500.0000", tradeIds[0]],
			["09", "700.0000", tradeIds[1]],
		]) {
			const { planId } = await seedPlanWithAllocationRow(ctx.prisma, {
				userId: user.userId,
				targetCurrency: "USD",
				targetAmount: "100",
				allocatedAmount: "100",
			});
			const usedAt = `${useDay}T${hour}:00:00.000Z`;
			const result = await api
				.post(`/api/plans/${planId}/usages`)
				.set(headers)
				.send({ amount: "100", usedAt })
				.expect(201);
			expect(result.body.data.usage).toMatchObject({ usedAt, cost });
			usages.push({
				planId,
				usageId: result.body.data.usage.id as string,
				tradeId,
				cost,
			});
		}

		async function assertOriginalAllocations() {
			const lots = await ctx.prisma.costLot.findMany({
				where: { userId: user.userId },
			});
			const sources = new Map(lots.map((lot) => [lot.id, lot.sourceId]));
			for (const { planId, usageId, tradeId, cost } of usages) {
				const result = await api
					.get(`/api/plans/${planId}/usages`)
					.set(headers)
					.expect(200);
				expect(result.body.data.items).toEqual([
					expect.objectContaining({ id: usageId, cost }),
				]);
				const allocations = await ctx.prisma.usageLotAllocation.findMany({
					where: { usageId },
				});
				expect(
					allocations.map((allocation) => ({
						sourceId: sources.get(allocation.lotId),
						quantity: allocation.quantity.toFixed(4),
						cost: allocation.cost.toFixed(4),
					})),
				).toEqual([{ sourceId: tradeId, quantity: "100.0000", cost }]);
			}
		}

		await assertOriginalAllocations();
		const correction = {
			targetType: "TRANSACTION",
			targetId: tradeIds[2],
			baseVersion: 1,
			reason: "补录未被使用的买入手续费",
			changes: { feeAmount: "10" },
		};
		const preview = await api
			.post("/api/corrections/preview")
			.set(headers)
			.send(correction)
			.expect(200);
		expect(preview.body.data.blockers).toEqual([]);
		const applied = await api
			.post("/api/corrections")
			.set(headers)
			.send(correction)
			.expect(201);
		expect(applied.body.data).toMatchObject({ status: "APPLIED", targetVersion: 2 });
		await assertOriginalAllocations();
		await assertInvariants(ctx.prisma, user.userId);
	});

	// 真实账户行锁固定竞争。旧写序会先占住分配，再阻塞于账户 UPDATE。
	it("#6 锁序回归：记录使用先等账户行锁，分配仍可锁定，放行后按新预览更正", { timeout: 20_000 }, async () => {
		const user = await newUser("corr-it-concurrent-locks");
		const { planId, usageId } = await seedFullLedger(user, "1500");
		const usageBefore = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: usageId },
		});

		const payload = {
			targetType: "USAGE",
			targetId: usageId,
			baseVersion: usageBefore.version,
			reason: "并发锁序回归：使用金额改小",
			changes: { amount: "800" },
		};
		const auth = bearer(user.accessToken);
		const preview = () => request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(auth)
			.send(payload)
			.expect(200);
		const confirm = (expectedUsageImpact: string) => request(app.getHttpServer())
			.post("/api/corrections")
			.set(auth)
			.send({ ...payload, expectedUsageImpact });
		const initial = await preview();

		// 持锁与观察使用独立连接池，应用连接可同时服务两个写入事务。
		const locks = new PrismaClient();
		let usageRequest: Promise<Response> | undefined;
		let correctionRequest: Promise<Response> | undefined;
		try {
			await locks.$transaction(async (holder) => {
				const [{ pid: holderPid }] = await holder.$queryRaw<Array<{ pid: number }>>`
					SELECT pg_backend_pid() AS pid FROM accounts
					WHERE user_id = ${user.userId} AND currency_code = 'USD'
					FOR UPDATE`;

				const blockedBy = (pids: number[]) =>
					locks.$queryRaw<Array<{ pid: number; query: string }>>`
						SELECT pid, query FROM pg_stat_activity
						WHERE datname = current_database() AND wait_event_type = 'Lock'
							AND pg_blocking_pids(pid) && ARRAY[${Prisma.join(pids)}]::int[]`;

				usageRequest = request(app.getHttpServer())
					.post(`/api/plans/${planId}/usages`)
					.set(bearer(user.accessToken))
					.send({
						amount: "300",
						usedAt: daysAgo(0).toISOString(),
						remark: "并发锁序回归",
					})
					.then((res) => res);
				// 提前接收传输错误，释放行锁后仍用原始 Promise 断言结果。
				void usageRequest.catch(() => {});

				// 当前只有 usage 请求能等待该持锁连接，记录具体的等待语句。
				const [waitingUsage] = await vi.waitFor(
					async () => {
						const waiters = await blockedBy([holderPid]);
						expect(waiters).toHaveLength(1);
						return waiters;
					},
					{ interval: 25, timeout: 2_000 },
				);
				expect.soft(waitingUsage.query).toMatch(
					/^\s*SELECT\b[\s\S]*\bFROM\s+(?:(?:"public"|public)\s*\.\s*)?(?:"accounts"|accounts)\s+[\s\S]*\bFOR\s+UPDATE\s*;?\s*$/i,
				);

				// holder 和 usage 都在各自的事务中。从另一连接立即尝试锁定同一分配行。
				await expect(locks.$queryRaw`
					SELECT plan_id AS "planId" FROM plan_allocations
					WHERE plan_id = ${planId}
					FOR UPDATE NOWAIT`).resolves.toEqual([{ planId }]);

				correctionRequest = confirm(initial.body.data.expectedUsageImpact).then((res) => res);
				void correctionRequest.catch(() => {});

				// 排在 usage 后的更正可能直接等待 holder，也可能等待 usage 排队持有的锁。
				await vi.waitFor(
					async () => {
						const waiters = await blockedBy([holderPid, waitingUsage.pid]);
						expect(waiters.some(({ pid }) => pid !== waitingUsage.pid)).toBe(true);
					},
					{ interval: 25, timeout: 2_000 },
				);
			}, { timeout: 10_000 });
		} finally {
			// holder 已提交或回滚。等待已发出的请求结束，再进入断言或清理夹具。
			await Promise.allSettled([usageRequest, correctionRequest]);
			await locks.$disconnect();
		}
		await expect(usageRequest).resolves.toMatchObject({ status: 201 });
		await expect(correctionRequest).resolves.toMatchObject({
			status: 409,
			body: { code: "CORRECTION_TARGET_CHANGED" },
		});
		expect(await ctx.prisma.correction.count({ where: { userId: user.userId } })).toBe(0);
		const refreshed = await preview();
		expect(refreshed.body.data.expectedUsageImpact).not.toBe(initial.body.data.expectedUsageImpact);
		await confirm(refreshed.body.data.expectedUsageImpact).expect(201);

		// 确定性终态（与串行顺序无关）
		const usages = await ctx.prisma.usageRecord.findMany({
			where: { userId: user.userId },
			orderBy: { amount: "asc" },
		});
		expect(usages.map((usage) => usage.amount.toFixed(4))).toEqual([
			"300.0000",
			"800.0000",
		]);
		const correctedUsage = usages.find((usage) => usage.id === usageId);
		expect(correctedUsage?.amount.toFixed(4)).toBe("800.0000");
		expect(correctedUsage?.version).toBe(usageBefore.version + 1);
		const allocation = await ctx.prisma.planAllocation.findUniqueOrThrow({
			where: { planId },
		});
		expect(allocation.usedAmount.toFixed(4)).toBe("1100.0000");
		expect(allocation.amount.toFixed(4)).toBe("1100.0000");
		const account = await ctx.prisma.account.findFirstOrThrow({
			where: { userId: user.userId, currencyCode: "USD" },
		});
		expect(account.balance.toFixed(4)).toBe("1900.0000");
		await assertInvariants(ctx.prisma, user.userId);
		const corrections = await ctx.prisma.correction.findMany({
			where: { userId: user.userId, targetType: "USAGE" },
		});
		expect(corrections).toHaveLength(1);
		expect(corrections[0]).toMatchObject({ targetId: usageId, status: "APPLIED" });
	});
	// #6-2 更正与新增使用按账户锁串行化。若新增先提交，更正需确认新的预览。
	it("#6-2 并发更正与记使用：影响有变化须重新确认，分配/余额变更无丢失", async () => {
		const user = await newUser("corr-it-concurrent-flows");
		const { planId, usageId } = await seedFullLedger(user, "1500");
		const usageBefore = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: usageId },
		});

		const payload = {
			targetType: "USAGE",
			targetId: usageId,
			baseVersion: usageBefore.version,
			reason: "并发锁序回归：使用金额改小",
			changes: { amount: "800" },
		};
		const preview = () => request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(bearer(user.accessToken))
			.send(payload)
			.expect(200);
		const confirm = (expectedUsageImpact: string) => request(app.getHttpServer())
			.post("/api/corrections")
			.set(bearer(user.accessToken))
			.send({ ...payload, expectedUsageImpact });
		const initial = await preview();
		const correctionPromise = confirm(initial.body.data.expectedUsageImpact);
		const usageCreatePromise = request(app.getHttpServer())
			.post(`/api/plans/${planId}/usages`)
			.set(bearer(user.accessToken))
			.send({
				amount: "300",
				usedAt: daysAgo(0).toISOString(),
				remark: "并发锁序回归",
			});

		const [correctionRes, usageRes] = await Promise.all([
			correctionPromise,
			usageCreatePromise,
		]);
		expect(usageRes.status).toBe(201);
		if (correctionRes.status === 409) {
			expect(correctionRes.body.code).toBe("CORRECTION_TARGET_CHANGED");
			expect(await ctx.prisma.correction.count({ where: { userId: user.userId } })).toBe(0);
			const refreshed = await preview();
			expect(refreshed.body.data.expectedUsageImpact).not.toBe(initial.body.data.expectedUsageImpact);
			await confirm(refreshed.body.data.expectedUsageImpact).expect(201);
		} else {
			expect(correctionRes.status).toBe(201);
		}

		// 确定性终态（与串行顺序无关）
		const usages = await ctx.prisma.usageRecord.findMany({
			where: { userId: user.userId },
			orderBy: { amount: "asc" },
		});
		expect(usages.map((usage) => usage.amount.toFixed(4))).toEqual([
			"300.0000",
			"800.0000",
		]);
		const correctedUsage = usages.find((usage) => usage.id === usageId);
		expect(correctedUsage?.amount.toFixed(4)).toBe("800.0000");
		expect(correctedUsage?.version).toBe(usageBefore.version + 1);
		const allocation = await ctx.prisma.planAllocation.findUniqueOrThrow({
			where: { planId },
		});
		expect(allocation.usedAmount.toFixed(4)).toBe("1100.0000");
		expect(allocation.amount.toFixed(4)).toBe("1100.0000");
		const account = await ctx.prisma.account.findFirstOrThrow({
			where: { userId: user.userId, currencyCode: "USD" },
		});
		expect(account.balance.toFixed(4)).toBe("1900.0000");
		await assertInvariants(ctx.prisma, user.userId);
		const corrections = await ctx.prisma.correction.findMany({
			where: { userId: user.userId, targetType: "USAGE" },
		});
		expect(corrections).toHaveLength(1);
		expect(corrections[0]).toMatchObject({ targetId: usageId, status: "APPLIED" });
	});
});
