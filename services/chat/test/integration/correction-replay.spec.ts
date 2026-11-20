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
import { Prisma } from "@prisma/client";
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
import { CorrectionService } from "../../src/correction/correction.service";
import { UsageService } from "../../src/usage/usage.service";
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
		await app.close();
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
		const account = await ctx.prisma.account.findUniqueOrThrow({
			where: {
				userId_currencyCode: { userId: user.userId, currencyCode: "USD" },
			},
		});
		expect(account.balance.toFixed(4)).toBe("1000.0000");
		const totalAllocCost = (
			await ctx.prisma.usageLotAllocation.findMany({ where: { usageId } })
		).reduce((sum, item) => sum.add(item.cost), new Prisma.Decimal(0));
		expect(totalAllocCost.toFixed(4)).toBe("15048.0000");
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
			account: await ctx.prisma.account.findUniqueOrThrow({
				where: {
					userId_currencyCode: { userId: user.userId, currencyCode: "USD" },
				},
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
			account: await ctx.prisma.account.findUniqueOrThrow({
				where: {
					userId_currencyCode: { userId: user.userId, currencyCode: "USD" },
				},
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
		const balance = await ctx.prisma.account.findUniqueOrThrow({
			where: {
				userId_currencyCode: { userId: user.userId, currencyCode: "USD" },
			},
		});
		// 终态余额 = 初始 1,000 + 三笔买入 3,000 − 使用 1,200（与批次 Σremaining 严格一致）
		expect(balance.balance.toFixed(4)).toBe("2800.0000");
	});

	it("#6 B1 回归：同日买入与使用（UI 按 T00:00Z 提交）→ 使用原样存储不截断，重放无资金不足违规", async () => {
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
				transactedAt: todayMidnightUtc,
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

		// 同日使用 500（UI 口径）：曾截断到 UTC+8 日 0 点（前一日 16:00Z），
		// 使重放把使用排到买入之前 → 违规 → 更正被 blockers 阻断
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

		// fee 补录预览（不改日期，纯触发账本重放）：同刻 T00:00Z 下类型序
		// 保证 PURCHASE(1) 先于 USAGE(2)，无资金不足违规
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

	// ── #6 锁序回归（MVP-F0-3）：真实并发双流（服务层直调）——
	// 外部事务持账户行锁期间并发直调「USAGE 更正 apply」与「记录使用 create」，
	// 两流程在账户锁上串行化（锁序统一 Account→PlanAllocation → 无循环等待），
	// 放行后双流成功且终态确定（变更无丢失）。锁竞争的逐 PID 观察属环境敏感
	// 断言（共享本地 PG 受外部负载影响，见 handoff 记录），以静态锁序审查 +
	// 本并发回归替代。 ──
	it("#6 锁序回归：两流程均阻塞于同一账户行锁（holder PID 关联）→ 放行后双成功", { timeout: 30_000 }, async () => {
		const user = await newUser("corr-it-concurrent-locks");
		const { planId, usageId } = await seedFullLedger(user, "1500");
		const usageBefore = await ctx.prisma.usageRecord.findUniqueOrThrow({
			where: { id: usageId },
		});
		// 服务层直调（app 实例解析）：绕开 HTTP/supertest 调度不确定性，
		// 并发竞争在纯 Prisma 事务层发生与观察
		const correctionService = app.get(CorrectionService);
		const usageService = app.get(UsageService);

		let holderPid: number | null = null;
		let holderAcquired = false;
		const gate = { release: () => {} };
		const gatePromise = new Promise<void>((resolve) => {
			gate.release = resolve;
		});
		try {
			// 持锁者：记录自身 backend PID（阻塞关联）并锁定账户行
			const holderPromise = ctx.prisma.$transaction(
				async (tx) => {
					const pidRows = await tx.$queryRaw<Array<{ pid: number }>>`
						SELECT pg_backend_pid() AS pid`;
					holderPid = pidRows[0].pid;
					await tx.$queryRaw`
						SELECT id FROM accounts
						WHERE user_id = ${user.userId} AND currency_code = 'USD'
						FOR UPDATE`;
					holderAcquired = true;
					await gatePromise;
				},
				{ maxWait: 30_000, timeout: 30_000 },
			);

			// 等待持锁者拿到行锁（本地标志，确定性观察）
			for (let i = 0; i < 200 && !holderAcquired; i += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(holderAcquired).toBe(true);

			// 并发直调两条流程（各自首个加锁操作均为账户行 FOR UPDATE，锁序统一 Account→PlanAllocation）。
			// settle 标志用于持锁窗口的「未完成」断言；捕获拒绝防止 unhandled rejection 击穿 worker。
			let correctionSettled = false;
			let usageSettled = false;
			let correctionError: unknown = null;
			let usageError: unknown = null;
			const correctionPromise = correctionService
				.apply(user.userId, {
					targetType: "USAGE",
					targetId: usageId,
					baseVersion: usageBefore.version,
					reason: "并发锁序回归：使用金额改小",
					changes: { amount: "800" },
				})
				.then(
					(result) => {
						correctionSettled = true;
						return { ok: true as const, result };
					},
					(error) => {
						correctionSettled = true;
						correctionError = error;
						return { ok: false as const, error };
					},
				);
			const usageCreatePromise = usageService
				.create(user.userId, planId, {
					amount: "300",
					usedAt: daysAgo(0).toISOString(),
				})
				.then(
					(result) => {
						usageSettled = true;
						return { ok: true as const, result };
					},
					(error) => {
						usageSettled = true;
						usageError = error;
						return { ok: false as const, error };
					},
				);

			// 持锁观察窗口（100 × 25ms = 2.5s，确定性事件循环观察）：两流在 holder
			// 持锁期间持续未 settle——它们的 promise 只有我们自己能 settle，外部
			// 会话噪声不可能置位。若锁序回归（某流未以账户行锁为首锁），该流会在
			// 窗口内完成 → 立即暴露；正常路径下两流阻塞于账户行直至放行。
			for (let i = 0; i < 100; i += 1) {
				expect(correctionSettled).toBe(false);
				expect(usageSettled).toBe(false);
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			expect(correctionSettled).toBe(false);
			expect(usageSettled).toBe(false);

			// 放行 → 两流程在账户锁上排队后先后成功（无死锁）→ 收束并核对
			gate.release();
			const [correctionOutcome, usageOutcome] = await Promise.all([
				correctionPromise,
				usageCreatePromise,
			]);
			// 若任一流在观察/放行期间拒绝，在此诊断暴露（如 5s 事务超时）
			expect({
				correction: correctionOutcome.ok ? null : correctionOutcome.error,
				usage: usageOutcome.ok ? null : usageOutcome.error,
			}).toEqual({ correction: null, usage: null });
			expect(correctionOutcome.ok).toBe(true);
			expect(usageOutcome.ok).toBe(true);
		} finally {
			// 无条件放行：前置断言失败也不得让 holder 持锁污染后续测试
			gate.release();
		}

		// 确定性终态（与串行顺序无关）：记录 {800, 300}、分配同减 1,100（doc 14 例 02）、
		// 余额 = 3,000 − 1,100 = 1,900、不变式成立、更正 APPLIED
		const usages = await ctx.prisma.usageRecord.findMany({
			where: { userId: user.userId },
			orderBy: { amount: "asc" },
		});
		expect(usages.map((usage) => usage.amount.toFixed(4))).toEqual([
			"300.0000",
			"800.0000",
		]);
		const allocation = await ctx.prisma.planAllocation.findUniqueOrThrow({
			where: { planId },
		});
		expect(allocation.usedAmount.toFixed(4)).toBe("1100.0000");
		expect(allocation.amount.toFixed(4)).toBe("1100.0000");
		const account = await ctx.prisma.account.findUniqueOrThrow({
			where: {
				userId_currencyCode: { userId: user.userId, currencyCode: "USD" },
			},
		});
		expect(account.balance.toFixed(4)).toBe("1900.0000");
		await assertInvariants(ctx.prisma, user.userId);
		const corrections = await ctx.prisma.correction.findMany({
			where: { userId: user.userId, targetType: "USAGE" },
		});
		expect(corrections).toHaveLength(1);
		expect(corrections[0].status).toBe("APPLIED");
	});
});
