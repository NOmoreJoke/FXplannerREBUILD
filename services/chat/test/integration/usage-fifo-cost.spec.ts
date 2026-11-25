import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../src/prisma/prisma.service";
import { utc8DayStart } from "../../src/transaction/transaction-calculator";
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
	PLAN_EXPECT_USE_DATE,
	PLAN_START_DATE,
	seedPlanWithAllocation,
} from "../helpers/plan-test-helper";
import { closeTestApps } from "../helpers/test-http";
import { raceBehindAdvisoryLock } from "../helpers/postgres-lock-barrier";
import {
	cleanupOrgLedgers,
	createOrgLedger,
	orgHeaders,
	type OrgLedger,
	purchaseBody,
	readOrgLedgerSnapshot,
} from "../helpers/organization-ledger-test-helper";

// 关闭全局接口限流（先例：transaction.spec/plan.spec——APP_GUARD token 无法 override，只能 mock 类）
vi.mock("@nestjs/throttler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nestjs/throttler")>();
	class NoopThrottlerGuard {
		async canActivate() {
			return true;
		}
	}
	return { ...actual, ThrottlerGuard: NoopThrottlerGuard };
});

/**
 * 集成测试（真实数据库 + 真实事务链路）：使用扣减 FIFO 成本（usage-recording §8.3）。
 * 验证跨表资金一致性：买入 → 使用 → 批次递减/余额扣减/分配递减三方同事务；
 * 失败整笔回滚（不留半条记录）；同日先 INITIAL 后 PURCHASE；恒等式守恒；
 * 账本起点边界（UTC+8 日界）。
 *
 * 买入造数走真实接口（填法 A：receivedAmountOf(本金, 汇率, 2) = 数量），
 * 单位成本精确可控：7,800 ÷ 1,000 = 7.8、8,000 ÷ 1,000 = 8（15 术语清单 :64 算例）。
 */
describe("使用扣减 FIFO 成本（集成）", () => {
	let app: INestApplication;
	let prisma: PrismaService;
	const users: TestUser[] = [];

	function postTx(user: TestUser, body: Record<string, unknown>) {
		return request(app.getHttpServer())
			.post("/api/transactions")
			.set(bearer(user.accessToken))
			.send(body);
	}

	function postUsage(
		user: TestUser,
		planId: string,
		body: Record<string, unknown>,
	) {
		return request(app.getHttpServer())
			.post(`/api/plans/${planId}/usages`)
			.set(bearer(user.accessToken))
			.send(body);
	}

	/** 填法 A 买入体：本金 ÷ 汇率 = 数量（整除时双向自洽恒成立） */
	function buyA(
		currencyCode: string,
		quantity: string,
		unitCost: string,
		transactedAt?: string,
	) {
		return {
			currencyCode,
			principalAmount: new Prisma.Decimal(quantity).mul(unitCost).toFixed(2),
			exchangeRate: unitCost,
			quantity,
			feeAmount: "0",
			transactedAt:
				transactedAt ??
				new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
		};
	}

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		prisma = ctx.prisma;
	});

	afterAll(async () => {
		for (const user of users) {
			await cleanupUser(prisma, user.userId);
		}
		await app.close();
	});

	it("全链路 FIFO（15 术语清单 :64 算例）：买 1,000@7.8 + 1,000@8.0 → 用 1,200 → 成本 9,400、三方扣减一致", async () => {
		const user = await createTestUser(app, "int-usage-fifo");
		users.push(user);
		// BE-03：经 API 造交易需已建账，否则写入口 409
		await ensureOnboarded(prisma, user.userId);
		await postTx(user, buyA("USD", "1000", "7.8")).expect(201);
		await postTx(user, buyA("USD", "1000", "8")).expect(201);
		const planId = await seedPlanWithAllocation(prisma, user.userId, {
			targetCurrency: "USD",
			targetAmount: "2000",
			allocatedAmount: "2000",
		});

		const res = await postUsage(user, planId, {
			amount: "1200",
			usedAt: new Date().toISOString(),
			remark: "FIFO 算例",
		}).expect(201);
		const usageId = res.body.data.usage.id;
		expect(res.body.data.usage.cost).toBe("9400.0000"); // 1,000×7.8 + 200×8

		// 分摊明细两行：1,000/7,800 + 200/1,600（跨批次先尽最早批次）
		const allocations = await prisma.usageLotAllocation.findMany({
			where: { usageId },
			orderBy: { quantity: "desc" },
		});
		expect(allocations).toHaveLength(2);
		expect(allocations[0].quantity.toFixed(4)).toBe("1000.0000");
		expect(allocations[0].cost.toFixed(4)).toBe("7800.0000");
		expect(allocations[1].quantity.toFixed(4)).toBe("200.0000");
		expect(allocations[1].cost.toFixed(4)).toBe("1600.0000");

		// 批次递减：两 lot remainingQty = 0 / 800（记录使用不删除、不改动原买入记录）
		const lots = await prisma.costLot.findMany({
			where: { userId: user.userId, currencyCode: "USD" },
			orderBy: { unitCost: "asc" },
		});
		expect(lots.map((l) => l.remainingQty.toFixed(4))).toEqual([
			"0.0000",
			"800.0000",
		]);
		expect(lots.map((l) => l.quantity.toFixed(4))).toEqual([
			"1000.0000",
			"1000.0000",
		]); // 原始数量不动

		// 三方一致：账户余额 800、PlanAllocation.usedAmount = 1,200
		const account = await prisma.account.findFirst({
			where: { userId: user.userId, currencyCode: "USD" },
		});
		expect(account?.balance.toFixed(4)).toBe("800.0000");
		const allocation = await prisma.planAllocation.findUnique({
			where: { planId },
		});
		expect(allocation?.usedAmount.toFixed(4)).toBe("1200.0000");

		// 资金面快照：剩余 800、还需 800、钱已备齐
		expect(res.body.data.plan).toMatchObject({
			remainingAllocation: "800.0000",
			stillNeeded: "800.0000",
			gap: "0.0000",
			fundStatus: "READY",
			canComplete: false,
		});
	});

	it("同日顺序（02 文档 :78）：同日先耗 INITIAL（初始持仓）批次，再耗 PURCHASE 批次", async () => {
		const user = await createTestUser(app, "int-usage-sameday");
		users.push(user);
		// BE-03：经 API 造交易需已建账，否则写入口 409
		await ensureOnboarded(prisma, user.userId);
		// 同一时刻 acquiredAt（同日同刻）：FIFO 只能靠 sourceType 分先后
		const sameInstant = new Date(
			Date.now() - 24 * 60 * 60 * 1000,
		).toISOString();
		await postTx(user, buyA("CAD", "1000", "1", sameInstant)).expect(201);
		const purchaseLot = await prisma.costLot.findFirstOrThrow({
			where: {
				userId: user.userId,
				currencyCode: "CAD",
				sourceType: "PURCHASE",
			},
		});
		// 直插 INITIAL 批次：acquiredAt 与买入批次完全相同、createdAt 更早（首次录入语义）
		const initialLot = await prisma.costLot.create({
			data: {
				userId: user.userId,
				currencyCode: "CAD",
				sourceType: "INITIAL",
				sourceId: `manual-initial-${Date.now()}`,
				quantity: "1000",
				remainingQty: "1000",
				unitCost: "0.5",
				totalCost: "500",
				acquiredAt: purchaseLot.acquiredAt,
				createdAt: new Date(purchaseLot.createdAt.getTime() - 60_000),
			},
		});
		// 恒等式修复：直插 INITIAL 批次不入账户，同步余额至 ΣremainingQty = 2,000
		await prisma.account.updateMany({
			where: { userId: user.userId, currencyCode: "CAD" },
			data: { balance: "2000" },
		});

		const planId = await seedPlanWithAllocation(prisma, user.userId, {
			targetCurrency: "CAD",
			targetAmount: "1500",
			allocatedAmount: "1500",
		});
		const res = await postUsage(user, planId, {
			amount: "1500",
			usedAt: new Date().toISOString(),
		}).expect(201);

		// 先耗 INITIAL（1,000@0.5 = 500），再耗 PURCHASE（500@1 = 500）→ 总成本 1,000
		expect(res.body.data.usage.cost).toBe("1000.0000");
		const allocations = await prisma.usageLotAllocation.findMany({
			where: { usageId: res.body.data.usage.id },
		});
		const byLot = new Map(allocations.map((row) => [row.lotId, row]));
		expect(byLot.get(initialLot.id)?.quantity.toFixed(4)).toBe("1000.0000");
		expect(byLot.get(purchaseLot.id)?.quantity.toFixed(4)).toBe("500.0000");
	});

	it("分次使用累计：4,000/4,000/2,000 三笔递进 → USED_UP + canComplete → 完成接口成功", async () => {
		const user = await createTestUser(app, "int-usage-installments");
		users.push(user);
		// BE-03：经 API 造交易需已建账，否则写入口 409
		await ensureOnboarded(prisma, user.userId);
		await postTx(user, buyA("USD", "10000", "1")).expect(201);
		const planId = await seedPlanWithAllocation(prisma, user.userId, {
			targetCurrency: "USD",
			targetAmount: "10000",
			allocatedAmount: "10000",
		});

		const usedAfter: string[] = [];
		for (const amount of ["4000", "4000", "2000"]) {
			const res = await postUsage(user, planId, {
				amount,
				usedAt: new Date().toISOString(),
			}).expect(201);
			usedAfter.push(res.body.data.plan.usedAmount);
		}
		expect(usedAfter).toEqual(["4000.0000", "8000.0000", "10000.0000"]);

		// 恒等式守恒（§8.3 场景 4）：余额 = Σ各计划剩余分配 + 未分配；Σ批次剩余 = 余额
		const account = await prisma.account.findFirst({
			where: { userId: user.userId, currencyCode: "USD" },
		});
		const plans = await prisma.plan.findMany({
			where: { userId: user.userId, targetCurrency: "USD" },
			select: { id: true },
		});
		const allocations = await prisma.planAllocation.findMany({
			where: { planId: { in: plans.map((plan) => plan.id) } },
		});
		const remainingSum = allocations.reduce(
			(sum, row) => sum.add(row.amount).sub(row.usedAmount),
			new Prisma.Decimal(0),
		);
		expect(account?.balance.minus(remainingSum).toFixed(4)).toBe("0.0000");
		const lotRemaining = await prisma.costLot.aggregate({
			where: { userId: user.userId, currencyCode: "USD" },
			_sum: { remainingQty: true },
		});
		expect(lotRemaining._sum.remainingQty?.toFixed(4)).toBe(
			account?.balance.toFixed(4),
		);

		// 第三笔后：fundStatus = USED_UP、canComplete = true（资金快照随最后一笔返回）
		const detail = await request(app.getHttpServer())
			.get(`/api/plans/${planId}`)
			.set(bearer(user.accessToken))
			.expect(200);
		expect(detail.body.data.fundStatus).toBe("USED_UP");
		expect(detail.body.data.canComplete).toBe(true);

		// 完成永远由用户点击触发：确认后计划转 COMPLETED
		await request(app.getHttpServer())
			.post(`/api/plans/${planId}/complete`)
			.set(bearer(user.accessToken))
			.expect(200);
		const completed = await prisma.plan.findUnique({ where: { id: planId } });
		expect(completed?.status).toBe("COMPLETED");
	});

	it("失败整笔回滚：批次剩余不足（人工改 remainingQty）→ 409 USAGE_LOT_SHORTAGE，零落库零扣减", async () => {
		const user = await createTestUser(app, "int-usage-rollback");
		users.push(user);
		// BE-03：经 API 造交易需已建账，否则写入口 409
		await ensureOnboarded(prisma, user.userId);
		await postTx(user, buyA("USD", "10000", "1")).expect(201);
		const planId = await seedPlanWithAllocation(prisma, user.userId, {
			targetCurrency: "USD",
			targetAmount: "10000",
			allocatedAmount: "10000",
		});
		// 人工制造数据异常：批次剩余 5,000 < 分配/余额 10,000（破坏恒等式）
		await prisma.costLot.updateMany({
			where: { userId: user.userId, currencyCode: "USD" },
			data: { remainingQty: "5000" },
		});

		const beforeUsageCount = await prisma.usageRecord.count();
		const beforeAllocCount = await prisma.usageLotAllocation.count();
		const res = await postUsage(user, planId, {
			amount: "6000",
			usedAt: new Date().toISOString(),
		}).expect(409);
		expect(res.body.code).toBe("USAGE_LOT_SHORTAGE");
		expect(res.body.data).toEqual({
			lotRemaining: "5000.0000",
			requestedAmount: "6000.0000",
		});

		// 整笔不生效（需求 §7 中途中断）：零新增、余额与 usedAmount 不变
		expect(await prisma.usageRecord.count()).toBe(beforeUsageCount);
		expect(await prisma.usageLotAllocation.count()).toBe(beforeAllocCount);
		const account = await prisma.account.findFirst({
			where: { userId: user.userId, currencyCode: "USD" },
		});
		expect(account?.balance.toFixed(4)).toBe("10000.0000");
		const allocation = await prisma.planAllocation.findUnique({
			where: { planId },
		});
		expect(allocation?.usedAmount.toFixed(4)).toBe("0.0000");
	});

	it("账本起点边界：起点前一日拒；起点当日放行（同日需确认语义由前端承载，后端放行）", async () => {
		const user = await createTestUser(app, "int-usage-ledger-start");
		users.push(user);
		// BE-03：经 API 造交易需已建账，否则写入口 409
		await ensureOnboarded(prisma, user.userId);
		await postTx(user, buyA("USD", "1000", "1")).expect(201);
		const planId = await seedPlanWithAllocation(prisma, user.userId, {
			targetCurrency: "USD",
			targetAmount: "1000",
			allocatedAmount: "1000",
		});
		// 账本起点 = 10 天前（UTC+8 日初）：对齐 onboarding 建账口径。ToB R1 W24 起使用写入口
		// 读取**组织**的记账起点，ensureOnboarded 同步更新 UserSettings 与默认组织
		// OrganizationSettings（transaction.spec #11 同款夹具）
		const start = utc8DayStart(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
		await ensureOnboarded(prisma, user.userId, "CNY", start);

		// 起点 9-9（前一日）拒
		const tooEarly = await postUsage(user, planId, {
			amount: "1",
			usedAt: new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString(),
		}).expect(400);
		expect(tooEarly.body.message).toMatch(/不能早于记账起点/);

		// 起点 9-10 当日放行
		await postUsage(user, planId, {
			amount: "1",
			usedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
		}).expect(201);
	});
});

/** 相对今天的过去第 n 天（固定时刻，避开 UTC+8 日界边界） */
function daysAgo(n: number): Date {
	return new Date(Date.now() - n * 86_400_000 - 2 * 3_600_000);
}

/**
 * ToB R1 W24：组织共享 FIFO 池在多成员并发下的一致性（LEDGER-01 / LEDGER-04.2）。
 * 并发用 postgres-lock-barrier 的 raceBehindAdvisoryLock 做确定性竞争：屏障先持组织锁
 * （membership:${orgId}），确认全部请求都已通过 Guard 并阻塞在锁上后再同时放行。
 * 每个用例自建组织与成员并在 afterEach 清理；支持按用例名 `-t` 独立运行。
 */
describe("W24 组织共享 FIFO 池的多成员并发一致性（集成）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let prisma: PrismaService;
	const orgs: OrgLedger[] = [];

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		prisma = ctx.prisma;
	}, 30_000);

	afterEach(async () => {
		if (orgs.length > 0) {
			await cleanupOrgLedgers(prisma, ...orgs.splice(0));
		}
	});

	afterAll(async () => {
		await closeTestApps(app);
	});

	function postUsageAs(
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

	/** 造共享池：Finance 1 买入两批（1,000@7.8、1,000@8）→ Finance 2 建计划（分配 1,600） */
	async function seedSharedPool(org: OrgLedger) {
		const [finance1, finance2] = org.members;
		const purchaseIds: string[] = [];
		for (const [days, unitCost] of [
			[4, "7.8"],
			[3, "8"],
		] as const) {
			const res = await request(app.getHttpServer())
				.post("/api/transactions")
				.set(orgHeaders(finance1, org.orgId))
				.send(purchaseBody("USD", "1000", unitCost, daysAgo(days)))
				.expect(201);
			purchaseIds.push(res.body.data.id);
		}
		const plan = await request(app.getHttpServer())
			.post("/api/plans")
			.set(orgHeaders(finance2, org.orgId))
			.send({
				targetCurrency: "USD",
				targetAmount: "2000",
				expectUseDate: PLAN_EXPECT_USE_DATE,
				prepLeadDays: 3,
				pacePreference: "balanced",
				startDate: PLAN_START_DATE,
				allocatedAmount: "1600",
			})
			.expect(201);
		return { finance1, finance2, purchaseIds, planId: plan.body.data.id as string };
	}

	/** 不变式：Σ批次剩余 = 账户余额；每片成本 = 数量 × 批次单价（4 位）；分摊数量合计 = 使用金额 */
	async function expectPoolInvariants(orgId: string, expectedBalance: string) {
		const snapshot = await readOrgLedgerSnapshot(prisma, orgId);
		const unitCostBySource = new Map(
			snapshot.lots.map((lot) => [lot.sourceId, lot.unitCost]),
		);
		expect(snapshot.accounts).toHaveLength(1);
		expect(snapshot.accounts[0].balance).toBe(expectedBalance);
		const lotRemainingSum = snapshot.lots.reduce(
			(sum, lot) => sum.add(new Prisma.Decimal(lot.remainingQty)),
			new Prisma.Decimal(0),
		);
		expect(lotRemainingSum.toFixed(4)).toBe(expectedBalance);
		for (const usage of snapshot.usages) {
			const slices = snapshot.allocations.filter((row) => row.usageId === usage.id);
			const quantitySum = slices.reduce(
				(sum, slice) => sum.add(new Prisma.Decimal(slice.quantity)),
				new Prisma.Decimal(0),
			);
			expect(quantitySum.toFixed(4)).toBe(usage.amount);
			for (const slice of slices) {
				expect(
					new Prisma.Decimal(slice.quantity)
						.mul(new Prisma.Decimal(unitCostBySource.get(slice.sourceId)!))
						.toFixed(4),
				).toBe(slice.cost);
			}
		}
		return snapshot;
	}

	it("W24-FIFO-1 两名成员并发更正同一笔使用（各自带同一份预览）：锁内重读 baseVersion → 一个 201、一个 409 CORRECTION_TARGET_CHANGED，FIFO 与余额终态确定", async () => {
		const org = await createOrgLedger(app, prisma, "w24-fifo-correct-race", [
			"FINANCE",
			"FINANCE",
		]);
		orgs.push(org);
		const { finance1, finance2, purchaseIds, planId } = await seedSharedPool(org);
		const usageId = (
			await postUsageAs(finance2, org.orgId, planId, {
				amount: "1200",
				usedAt: utc8DayStart(new Date()).toISOString(),
			}).expect(201)
		).body.data.usage.id as string;

		// 两人各自预览同一份改动（改小到 800）：组织账本对两人一致，影响指纹相同
		const payload = {
			targetType: "USAGE",
			targetId: usageId,
			baseVersion: 1,
			reason: "并发更正：使用金额多记了 400",
			changes: { amount: "800" },
		};
		const previewAs = (user: TestUser) =>
			request(app.getHttpServer())
				.post("/api/corrections/preview")
				.set(orgHeaders(user, org.orgId))
				.send(payload);
		const [preview1, preview2] = await Promise.all([
			previewAs(finance1).expect(200),
			previewAs(finance2).expect(200),
		]);
		expect(preview1.body.data.blockers).toEqual([]);
		expect(preview2.body.data.expectedUsageImpact).toBe(
			preview1.body.data.expectedUsageImpact,
		);
		const expectedUsageImpact = preview1.body.data.expectedUsageImpact as string;
		const requestIds = [`req-w24-fifo-race-1-${Date.now()}`, `req-w24-fifo-race-2-${Date.now()}`];
		const applyAs = (user: TestUser, requestId: string) =>
			request(app.getHttpServer())
				.post("/api/corrections")
				.set(orgHeaders(user, org.orgId, requestId))
				.send({ ...payload, expectedUsageImpact });

		const [first, second] = await raceBehindAdvisoryLock(prisma, `membership:${org.orgId}`, [
			() => applyAs(finance1, requestIds[0]),
			() => applyAs(finance2, requestIds[1]),
		]);

		// 一胜一负：后到者带的是旧 baseVersion，被锁内重读拦下，不覆盖先到者的结果
		expect([first.status, second.status].sort()).toEqual([201, 409]);
		const [winner, loser] = first.status === 201 ? [first, second] : [second, first];
		const winnerActor = winner === first ? finance1 : finance2;
		expect(loser.body.code).toBe("CORRECTION_TARGET_CHANGED");

		// 终态与谁胜出无关：使用 800 只耗买入一（800×7.8 = 6,240）；改小 400 → 分配 1,600 → 1,200，已用 800
		const snapshot = await expectPoolInvariants(org.orgId, "1200.0000");
		expect(snapshot.usages.map((usage) => [usage.id, usage.amount, usage.version])).toEqual([
			[usageId, "800.0000", 2],
		]);
		expect(snapshot.allocations).toEqual([
			{ usageId, sourceId: purchaseIds[0], quantity: "800.0000", cost: "6240.0000" },
		]);
		expect(
			Object.fromEntries(snapshot.lots.map((lot) => [lot.sourceId, lot.remainingQty])),
		).toEqual({
			[purchaseIds[0]]: "200.0000",
			[purchaseIds[1]]: "1000.0000",
		});
		// 重建后的批次仍归买入人
		expect(new Set(snapshot.lots.map((lot) => lot.userId))).toEqual(
			new Set([finance1.userId]),
		);
		expect(snapshot.planAllocations).toEqual([
			{ planId, amount: "1200.0000", usedAmount: "800.0000" },
		]);
		// 只留一条 APPLIED 与一条 SUCCESS 审计，操作者都是胜者；败者不留 FAILED
		expect(
			await prisma.correction.findMany({ where: { targetId: usageId } }),
		).toEqual([
			expect.objectContaining({
				id: winner.body.data.correctionId,
				status: "APPLIED",
				organizationId: org.orgId,
				actorUserId: winnerActor.userId,
			}),
		]);
		expect(
			await prisma.auditLog.findMany({
				where: { organizationId: org.orgId, action: "correction.apply" },
			}),
		).toEqual([
			expect.objectContaining({
				actorUserId: winnerActor.userId,
				targetType: "usage_record",
				targetId: usageId,
				result: "SUCCESS",
			}),
		]);
	}, 30_000);

	it("W24-FIFO-2 两名成员并发对同一计划记使用（共享 Finance 1 的 FIFO 池）：均 201，分配 / 余额 / 批次扣减无丢失", async () => {
		const org = await createOrgLedger(app, prisma, "w24-fifo-usage-race", [
			"FINANCE",
			"FINANCE",
		]);
		orgs.push(org);
		const { finance1, finance2, purchaseIds, planId } = await seedSharedPool(org);
		const usedAt = utc8DayStart(new Date()).toISOString();

		// 800 与 400 都会跨买入一的批次边界：谁先谁后决定各自成本，但不影响总量与不变式
		const [usageByFinance1, usageByFinance2] = await raceBehindAdvisoryLock(
			prisma,
			`membership:${org.orgId}`,
			[
				() => postUsageAs(finance1, org.orgId, planId, { amount: "800", usedAt }),
				() => postUsageAs(finance2, org.orgId, planId, { amount: "400", usedAt }),
			],
		);
		expect(usageByFinance1.status).toBe(201);
		expect(usageByFinance2.status).toBe(201);

		// 总量确定：共使用 1,200 = 买入一 1,000 + 买入二 200 → 7,800 + 1,600 = 9,400
		const snapshot = await expectPoolInvariants(org.orgId, "800.0000");
		expect(snapshot.usages).toHaveLength(2);
		expect(
			Object.fromEntries(snapshot.lots.map((lot) => [lot.sourceId, lot.remainingQty])),
		).toEqual({
			[purchaseIds[0]]: "0.0000",
			[purchaseIds[1]]: "800.0000",
		});
		expect(snapshot.planAllocations).toEqual([
			{ planId, amount: "1600.0000", usedAmount: "1200.0000" },
		]);
		const totalCost = snapshot.allocations.reduce(
			(sum, slice) => sum.add(new Prisma.Decimal(slice.cost)),
			new Prisma.Decimal(0),
		);
		expect(totalCost.toFixed(4)).toBe("9400.0000");
		// 两笔使用各自只分摊到自己的那一份，合计等于其金额
		const quantityByUsage = new Map<string, Prisma.Decimal>();
		for (const slice of snapshot.allocations) {
			quantityByUsage.set(
				slice.usageId,
				(quantityByUsage.get(slice.usageId) ?? new Prisma.Decimal(0)).add(slice.quantity),
			);
		}
		expect(
			[...quantityByUsage.values()].map((quantity) => quantity.toFixed(4)).sort(),
		).toEqual(["400.0000", "800.0000"]);
		// 记录人各异：两笔 usage.create 审计分别归属 Finance 1 与 Finance 2
		const usageAudits = await prisma.auditLog.findMany({
			where: { organizationId: org.orgId, action: "usage.create", result: "SUCCESS" },
		});
		expect(usageAudits.map((row) => row.actorUserId).sort()).toEqual(
			[finance1.userId, finance2.userId].sort(),
		);
	}, 30_000);
});
