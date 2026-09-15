/**
 * 外汇账户接口测试（account-module 技术方案 §8.2，14 条用例）。
 * 走 test-app 基建（createTestApp/createTestUser/bearer/cleanupUser）；
 * 买入造数复用 POST /api/transactions（汇率 1 的 simpleBody 风格，transactedAt 用昨天）。
 * 时序注意：场景间共用用户状态（#4/#5 连续、#12/#13 共用造数），vitest 文件内串行执行。
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
import { ensureAccount, seedPlanWithAllocation } from "../helpers/plan-test-helper";

// 关闭全局接口限流：AppModule 以 { provide: APP_GUARD, useClass: ThrottlerGuard } 注册全局限流，
// 但 Nest scanner 会把 APP_GUARD 的 token 改写为带 UUID 的内部 token（scanner.js insertProvider），
// overrideGuard(ThrottlerGuard) / overrideProvider(APP_GUARD) 均不命中，故直接 mock ThrottlerGuard 类
vi.mock("@nestjs/throttler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nestjs/throttler")>();
	class NoopThrottlerGuard {
		async canActivate() {
			return true;
		}
	}
	return { ...actual, ThrottlerGuard: NoopThrottlerGuard };
});

/** 汇率 1 的简化买入体（本金 = 数量，便于余额与成本断言），照抄 transaction.spec.ts 风格 */
function simpleBody(currencyCode: string, quantity: string) {
	return {
		currencyCode,
		principalAmount: quantity,
		exchangeRate: "1",
		quantity,
		transactedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
	};
}

describe("AccountController（接口）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let userMain: TestUser; // 列表/详情/流水主用户（2 CAD + 1 USD）
	let userAlloc: TestUser; // 超量分配与取消计划用户
	let userCost: TestUser; // 详情成本用户（2 笔 CAD 买入）
	let userOld: TestUser; // 回填前旧数据模拟用户
	let userLedger: TestUser; // 流水用户（3 天前 + 昨天）
	let userOther: TestUser; // 他人账户越权探测用户（无任何账户）
	let planAllocId = ""; // #4/#5 直插的超量分配计划（#5 取消时用）
	const userIds: string[] = [];

	function getAccounts(user: TestUser) {
		return request(app.getHttpServer())
			.get("/api/accounts")
			.set(bearer(user.accessToken));
	}

	function getDetail(user: TestUser, currencyCode: string) {
		return request(app.getHttpServer())
			.get(`/api/accounts/${currencyCode}`)
			.set(bearer(user.accessToken));
	}

	function getLedger(user: TestUser, currencyCode: string) {
		return request(app.getHttpServer())
			.get(`/api/accounts/${currencyCode}/transactions`)
			.set(bearer(user.accessToken));
	}

	function postTx(user: TestUser, body: Record<string, unknown>) {
		return request(app.getHttpServer())
			.post("/api/transactions")
			.set(bearer(user.accessToken))
			.send(body);
	}

	function cancelPlan(user: TestUser, planId: string) {
		return request(app.getHttpServer())
			.post(`/api/plans/${planId}/cancel`)
			.set(bearer(user.accessToken));
	}

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		userMain = await createTestUser(app, "acct-main");
		userAlloc = await createTestUser(app, "acct-alloc");
		userCost = await createTestUser(app, "acct-cost");
		userOld = await createTestUser(app, "acct-old");
		userLedger = await createTestUser(app, "acct-ledger");
		userOther = await createTestUser(app, "acct-other");
		userIds.push(
			userMain.userId,
			userAlloc.userId,
			userCost.userId,
			userOld.userId,
			userLedger.userId,
			userOther.userId,
		);

		// #9 详情成本造数：2 笔 CAD 买入，成本均可复算
		// 第一笔：本金 10600 + 手续费 20，数量 10620（汇率按填法 B 反算 8 位舍入）
		//   totalCost = 10620、unitCost = 1
		// 第二笔：本金 7800、汇率 1、数量 7800 → totalCost = 7800、unitCost = 1
		await postTx(userCost, {
			currencyCode: "CAD",
			principalAmount: "10600.00",
			exchangeRate: "0.99811676", // 填法 B：impliedRate(10600, 10620) 8 位舍入，双向自洽
			quantity: "10620.00",
			feeAmount: "20.00",
			transactedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
		}).expect(201);
		await postTx(userCost, simpleBody("CAD", "7800")).expect(201);

		// （userOld 不在 beforeAll 造数：#10/#11 各自独立直插，避免残留状态干扰）

		// #12/#13 流水造数：3 天前带手续费 + 昨天手续费未知（occurredAt 明确可断言倒序）
		await postTx(userLedger, {
			...simpleBody("CAD", "1000"),
			feeAmount: "20",
			transactedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
		}).expect(201);
		await postTx(userLedger, simpleBody("CAD", "2000")).expect(201); // fee 缺省 = 未知
	});

	afterAll(async () => {
		for (const userId of userIds) {
			await cleanupUser(ctx.prisma, userId);
		}
		await app.close();
	});

	it("#1 未登录访问三个端点均 401（Controller 级守卫）", async () => {
		await request(app.getHttpServer()).get("/api/accounts").expect(401);
		await request(app.getHttpServer()).get("/api/accounts/CAD").expect(401);
		await request(app.getHttpServer())
			.get("/api/accounts/CAD/transactions")
			.expect(401);
	});

	it("#2 新用户无账户且无 userSettings：200 { baseCurrency: null, accounts: [] }", async () => {
		const res = await getAccounts(userOther).expect(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data).toEqual({ baseCurrency: null, accounts: [] });
	});

	it("#3 两笔 CAD + 一笔 USD：余额正确、allocated=0、未分配余额=余额、按币种升序", async () => {
		await postTx(userMain, simpleBody("CAD", "1000")).expect(201);
		await postTx(userMain, simpleBody("CAD", "1000")).expect(201);
		await postTx(userMain, simpleBody("USD", "1000")).expect(201);

		const res = await getAccounts(userMain).expect(200);
		expect(res.body.data.baseCurrency).toBeNull(); // 未建 settings
		expect(res.body.data.accounts).toEqual([
			{
				currencyCode: "CAD",
				balance: "2000.0000",
				allocatedAmount: "0.0000", // 全状态求和：无计划分配即为 0
				unallocatedAmount: "2000.0000",
			},
			{
				currencyCode: "USD",
				balance: "1000.0000",
				allocatedAmount: "0.0000",
				unallocatedAmount: "1000.0000",
			},
		]);
	});

	it("#4 超量分配直插：allocatedAmount 如实超量、未分配余额为负不钳 0", async () => {
		await ensureAccount(ctx.prisma, userAlloc.userId, "CAD", "1000");
		planAllocId = await seedPlanWithAllocation(ctx.prisma, userAlloc.userId, {
			targetCurrency: "CAD",
			allocatedAmount: "6000", // > balance 1000：直插制造数据破坏
		});

		const res = await getAccounts(userAlloc).expect(200);
		const cad = res.body.data.accounts.find(
			(account: { currencyCode: string }) => account.currencyCode === "CAD",
		);
		expect(cad.allocatedAmount).toBe("6000.0000");
		expect(cad.unallocatedAmount).toBe("-5000.0000"); // 负数如实返回，禁止钳 0
	});

	it("#5 取消计划（真实释放路径）后：allocated 归零、未分配余额回升", async () => {
		await cancelPlan(userAlloc, planAllocId).expect(200);

		const res = await getAccounts(userAlloc).expect(200);
		const cad = res.body.data.accounts.find(
			(account: { currencyCode: string }) => account.currencyCode === "CAD",
		);
		// cancel 释放：amount → max(used, 0) = 0 → Σ剩余分配 = 0
		expect(cad.allocatedAmount).toBe("0.0000");
		expect(cad.unallocatedAmount).toBe("1000.0000");
	});

	it("#6 小写路径参数 /api/accounts/cad：200 与大写等价", async () => {
		const res = await getDetail(userMain, "cad").expect(200);
		expect(res.body.data.currencyCode).toBe("CAD"); // 服务端规范化转大写
		expect(res.body.data.balance).toBe("2000.0000");
	});

	it("#7 /api/accounts/XYZ：400 INVALID_ACCOUNT_CURRENCY", async () => {
		const res = await getDetail(userMain, "XYZ").expect(400);
		expect(res.body.code).toBe("INVALID_ACCOUNT_CURRENCY");
	});

	it("#8 /api/accounts/JPY（未建账户）：404 ACCOUNT_NOT_FOUND", async () => {
		const res = await getDetail(userMain, "JPY").expect(404);
		expect(res.body.code).toBe("ACCOUNT_NOT_FOUND");
	});

	it("#9 详情成本可复算：remainingTotalCost=18420、averageUnitCost=1（8 位）", async () => {
		const res = await getDetail(userCost, "CAD").expect(200);
		expect(res.body.data.baseCurrency).toBeNull();
		expect(res.body.data.currencyCode).toBe("CAD");
		expect(res.body.data.balance).toBe("18420.0000"); // 10620 + 7800
		expect(res.body.data.allocatedAmount).toBe("0.0000");
		expect(res.body.data.unallocatedAmount).toBe("18420.0000");
		// 10620 + 7800 = 18420；单位成本 (10620/10620 + 7800/7800) 加权恰为 1
		expect(res.body.data.remainingTotalCost).toBe("18420.0000");
		expect(res.body.data.averageUnitCost).toBe("1.00000000");
	});

	it("#10 余额 0 账户 + 全消耗批次：averageUnitCost=null、未分配余额如期计算", async () => {
		// 独立直插（USD 避开其他用例的 CAD 状态）：balance 0 与 Σ remainingQty 0 恰好平衡
		await ensureAccount(ctx.prisma, userOld.userId, "USD", "0");
		await ctx.prisma.costLot.create({
			data: {
				userId: userOld.userId,
				currencyCode: "USD",
				sourceType: "PURCHASE",
				sourceId: `manual-lot-${Date.now()}`,
				quantity: "100",
				remainingQty: "0", // 全消耗
				unitCost: "1",
				totalCost: "100",
				acquiredAt: new Date(),
			},
		});

		const res = await getDetail(userOld, "USD").expect(200);
		expect(res.body.data.balance).toBe("0.0000");
		expect(res.body.data.remainingTotalCost).toBe("0.0000"); // Σ(0 × unitCost) = 0
		expect(res.body.data.averageUnitCost).toBeNull(); // Σ remainingQty = 0 不计算（doc 04）
		expect(res.body.data.unallocatedAmount).toBe("0.0000");
	});

	it("#11 回填前旧数据（账户在、批次缺失）：averageUnitCost=null 不报错", async () => {
		// 直插有余额、无任何交易/批次的账户，等价模拟「录入后 deleteMany 该用户 costLot」
		// 的未回填存量状态；该用户无交易行，回填脚本不会补写（与并行回填测试无竞态）
		await ensureAccount(ctx.prisma, userOld.userId, "CAD", "500");

		const res = await getDetail(userOld, "CAD").expect(200);
		expect(res.body.data.remainingTotalCost).toBeNull(); // 空批次 → null
		expect(res.body.data.averageUnitCost).toBeNull();
		expect(res.body.data.balance).toBe("500.0000"); // 余额展示不受影响
		expect(res.body.data.unallocatedAmount).toBe("500.0000");
	});

	it("#12 流水混合买入：occurredAt 倒序、type/feeKnown/version 字段正确", async () => {
		const res = await getLedger(userLedger, "CAD").expect(200);
		expect(res.body.data.baseCurrency).toBeNull();
		expect(res.body.data.items).toHaveLength(2);

		const [latest, earliest] = res.body.data.items;
		// 昨天买入在前、3 天前买入在后（occurredAt 倒序）
		expect(latest.type).toBe("PURCHASE");
		expect(latest.quantity).toBe("2000.0000");
		expect(latest.feeKnown).toBe(false); // 手续费未知
		expect(latest.version).toBe(1);
		expect(earliest.type).toBe("PURCHASE");
		expect(earliest.quantity).toBe("1000.0000");
		expect(earliest.feeKnown).toBe(true);
		expect(
			new Date(latest.occurredAt).getTime(),
		).toBeGreaterThan(new Date(earliest.occurredAt).getTime());
		// ID 可跳转交易详情（PURCHASE 行即交易 ID）
		const detail = await request(app.getHttpServer())
			.get(`/api/transactions/${latest.id}`)
			.set(bearer(userLedger.accessToken))
			.expect(200);
		expect(detail.body.data.quantity).toBe("2000.0000");
	});

	it("#13 手续费未知买入：totalCost = 本金、feeKnown = false", async () => {
		const res = await getLedger(userLedger, "CAD").expect(200);
		const unknownFee = res.body.data.items.find(
			(item: { feeKnown: boolean }) => !item.feeKnown,
		);
		expect(unknownFee.totalCost).toBe("2000.0000"); // 本金口径（fee 未知不当 0 计算）
	});

	it("#14 他人账户币种：404 不泄露存在性", async () => {
		// userCost 建有 CAD 账户；userOther 无任何账户
		const res = await getDetail(userOther, "CAD").expect(404);
		expect(res.body.code).toBe("ACCOUNT_NOT_FOUND");
	});
});
