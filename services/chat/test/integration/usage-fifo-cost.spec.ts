import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../src/prisma/prisma.service";
import { utc8DayStart } from "../../src/transaction/transaction-calculator";
import {
	bearer,
	cleanupUser,
	createTestApp,
	createTestUser,
	type TestUser,
} from "../helpers/test-app";
import { ensureOnboarded } from "../helpers/onboarding-helper";
import { seedPlanWithAllocation } from "../helpers/plan-test-helper";

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
		// 账本起点 = 10 天前（UTC+8 日初）：对齐 onboarding 建账口径
		const start = utc8DayStart(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
		await prisma.userSettings.upsert({
			where: { userId: user.userId },
			update: { ledgerStartedAt: start },
			create: {
				userId: user.userId,
				baseCurrency: "CNY",
				locale: "zh-CN",
				region: "CN",
				ledgerStartedAt: start,
			},
		});

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
