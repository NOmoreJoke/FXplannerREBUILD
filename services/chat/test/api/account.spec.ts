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
import { ensureOnboarded } from "../helpers/onboarding-helper";
import {
	ensureAccount,
	seedPlanWithAllocation,
	setAllocationUsedAmount,
	cleanupPlanData,
} from "../helpers/plan-test-helper";

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
	let userUsage: TestUser; // M7 流水成本用户（2 笔 CAD 买入 + 一笔使用）
	let userAllocView: TestUser; // 阶段5 §2 分配视图用户（多计划 + 取消链路）
	let planAllocId = ""; // #4/#5 直插的超量分配计划（#5 取消时用）
	const planAllocViewIds: string[] = []; // #17/#18 直插计划（allocation 无级联，afterAll 显式清理）
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

	function getAllocations(user: TestUser, currencyCode: string) {
		return request(app.getHttpServer())
			.get(`/api/accounts/${currencyCode}/allocations`)
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
		userUsage = await createTestUser(app, "acct-usage");
		userAllocView = await createTestUser(app, "acct-alloc-view");
		userIds.push(
			userMain.userId,
			userAlloc.userId,
			userCost.userId,
			userOld.userId,
			userLedger.userId,
			userOther.userId,
			userUsage.userId,
			userAllocView.userId,
		);
		// BE-03：经 API 造交易需已建账，否则写入口 409 ONBOARDING_NOT_COMPLETED。
		// userOther 例外：保持无 settings/无账户（#2 空列表、#14 越权 404 语义依赖）
		for (const user of [
			userMain,
			userAlloc,
			userCost,
			userOld,
			userLedger,
			userUsage,
			userAllocView,
		]) {
			await ensureOnboarded(ctx.prisma, user.userId);
		}

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
			transactedAt: new Date(
				Date.now() - 3 * 24 * 60 * 60 * 1000,
			).toISOString(),
		}).expect(201);
		await postTx(userLedger, simpleBody("CAD", "2000")).expect(201); // fee 缺省 = 未知
	}, 120_000); // 造数用户多（7 用户建账 + 多笔交易），放宽 hook 超时

	afterAll(async () => {
		await cleanupPlanData(ctx.prisma, [...planAllocViewIds, planAllocId]);
		for (const userId of userIds) {
			await cleanupUser(ctx.prisma, userId);
		}
		await app.close();
	});

	it("#1 未登录访问四个端点均 401（Controller 级守卫）", async () => {
		await request(app.getHttpServer()).get("/api/accounts").expect(401);
		await request(app.getHttpServer()).get("/api/accounts/CAD").expect(401);
		await request(app.getHttpServer())
			.get("/api/accounts/CAD/transactions")
			.expect(401);
		await request(app.getHttpServer())
			.get("/api/accounts/CAD/allocations")
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
		expect(res.body.data.baseCurrency).toBe("CNY"); // settings 已由 ensureOnboarded 建
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
		expect(res.body.data.baseCurrency).toBe("CNY"); // settings 已由 ensureOnboarded 建
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
		expect(res.body.data.baseCurrency).toBe("CNY"); // settings 已由 ensureOnboarded 建
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
		expect(new Date(latest.occurredAt).getTime()).toBeGreaterThan(
			new Date(earliest.occurredAt).getTime(),
		);
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

	it("#15 M7 使用行成本：USAGE 行 totalCost = FIFO 聚合成本（不再为 null）", async () => {
		// 独立用户避免干扰 #12/#13 的流水断言：买 1,020（fee 20 → totalCost 1,020，unitCost = 1）
		// + 2,000（unitCost 1）→ 两批同价，使用 1,500 成本 1,500.0000
		await postTx(userUsage, {
			currencyCode: "CAD",
			principalAmount: "1000.00",
			exchangeRate: "0.98039216", // 填法 B：impliedRate(1000, 1020) 8 位舍入，双向自洽
			quantity: "1020.00",
			feeAmount: "20.00",
			transactedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
		}).expect(201);
		await postTx(userUsage, simpleBody("CAD", "2000")).expect(201);
		const planId = await seedPlanWithAllocation(ctx.prisma, userUsage.userId, {
			targetCurrency: "CAD",
			targetAmount: "2000",
			allocatedAmount: "2000",
		});
		// 使用 1,500：FIFO 先耗 1,020@1 = 1,020 + 480@1 = 480 → 1,500
		await request(app.getHttpServer())
			.post(`/api/plans/${planId}/usages`)
			.set(bearer(userUsage.accessToken))
			.send({
				amount: "1500",
				usedAt: new Date().toISOString(),
			})
			.expect(201);

		const res = await getLedger(userUsage, "CAD").expect(200);
		const usageRow = res.body.data.items.find(
			(item: { type: string }) => item.type === "USAGE",
		);
		expect(usageRow).toBeDefined();
		expect(usageRow.quantity).toBe("1500.0000");
		expect(usageRow.totalCost).toBe("1500.0000"); // §3.5 遗留落地：M7 起填实（两批同价 unitCost 1）
		expect(usageRow.feeKnown).toBe(true);
		expect(usageRow.version).toBe(1);
	});

	// ── 阶段5 §2 分配明细视图（GET /api/accounts/:currencyCode/allocations）──

	it("#16 多计划分配：逐条金额与剩余分配正确、按计划创建时间升序", async () => {
		// 独立用户：账户 10000 + 两个计划（A 分配 6000 已用 1000；B 分配 3000 未用）
		await ensureAccount(ctx.prisma, userAllocView.userId, "CAD", "10000");
		const planA = await seedPlanWithAllocation(ctx.prisma, userAllocView.userId, {
			targetCurrency: "CAD",
			name: "计划A",
			targetAmount: "10000",
			allocatedAmount: "6000",
		});
		await setAllocationUsedAmount(ctx.prisma, planA, "1000");
		const planB = await seedPlanWithAllocation(ctx.prisma, userAllocView.userId, {
			targetCurrency: "CAD",
			name: "计划B",
			targetAmount: "10000",
			allocatedAmount: "3000",
		});
		planAllocViewIds.push(planA, planB);

		const res = await getAllocations(userAllocView, "CAD").expect(200);
		expect(res.body.success).toBe(true);
		const items = res.body.data.items;
		expect(items).toHaveLength(2);
		// 升序 = 创建顺序（A 先建）；remainingAllocation 服务端算好
		expect(items[0]).toEqual({
			planId: planA,
			planName: "计划A",
			planStatus: "ACTIVE",
			amount: "6000.0000",
			usedAmount: "1000.0000",
			remainingAllocation: "5000.0000",
		});
		expect(items[1]).toEqual({
			planId: planB,
			planName: "计划B",
			planStatus: "ACTIVE",
			amount: "3000.0000",
			usedAmount: "0.0000",
			remainingAllocation: "3000.0000",
		});
	});

	it("#17 已取消计划：剩余 0 如实返回（amount 收敛为已用）；未分配余额恢复可对账", async () => {
		// 新建计划分配 6000 已用 2000 → 取消：amount → max(used,0)=2000，剩余 0，仍列出
		const planId = await seedPlanWithAllocation(ctx.prisma, userAllocView.userId, {
			targetCurrency: "CAD",
			name: "待取消计划",
			targetAmount: "10000",
			allocatedAmount: "6000",
		});
		await setAllocationUsedAmount(ctx.prisma, planId, "2000");
		planAllocViewIds.push(planId);
		await cancelPlan(userAllocView, planId).expect(200);

		const res = await getAllocations(userAllocView, "CAD").expect(200);
		const cancelled = res.body.data.items.find(
			(item: { planId: string }) => item.planId === planId,
		);
		expect(cancelled).toEqual({
			planId,
			planName: "待取消计划",
			planStatus: "CANCELLED",
			amount: "2000.0000", // 取消释放后 amount = 已用（§3.4）
			usedAmount: "2000.0000",
			remainingAllocation: "0.0000",
		});
		// 对账：Σ剩余分配（A 5000 + B 3000 + 取消 0）与列表 allocatedAmount 一致
		const list = await getAccounts(userAllocView).expect(200);
		const cad = list.body.data.accounts.find(
			(account: { currencyCode: string }) => account.currencyCode === "CAD",
		);
		expect(cad.allocatedAmount).toBe("8000.0000");
		expect(cad.unallocatedAmount).toBe("2000.0000");
	});

	it("#18 无计划账户：items 空数组；400/404/他人 404 口径与详情接口一致", async () => {
		// userMain 有 USD 账户但无任何 USD 计划 → 空数组
		const empty = await getAllocations(userMain, "USD").expect(200);
		expect(empty.body.data).toEqual({ items: [] });

		await getAllocations(userMain, "").expect(404); // 缺少币种路径段
		await getAllocations(userMain, "XYZ").expect(400); // INVALID_ACCOUNT_CURRENCY
		await getAllocations(userMain, "JPY").expect(404); // 未建账户
		// 他人账户币种：404 不泄露存在性（userOther 无账户，userCost 有 CAD）
		const res = await getAllocations(userOther, "CAD").expect(404);
		expect(res.body.code).toBe("ACCOUNT_NOT_FOUND");
	});

	it("#19 读取计划后并发取消：分配明细保持同一数据库快照", async () => {
		const currency = "EUR";
		const user = userAllocView;
		await ensureAccount(ctx.prisma, user.userId, currency, "10000");
		const planId = await seedPlanWithAllocation(ctx.prisma, user.userId, {
			targetCurrency: currency,
			name: "并发取消计划",
			allocatedAmount: "6000.1250",
			usedAmount: "2000.0101",
		});
		planAllocViewIds.push(planId);
		const beforeCancellation = {
			planId,
			planName: "并发取消计划",
			planStatus: "ACTIVE",
			amount: "6000.1250",
			usedAmount: "2000.0101",
			remainingAllocation: "4000.1149",
		};

		// 真实 Plan 查询返回后，等取消接口完成提交，再让分配请求继续读取。
		let cancelPending = true;
		ctx.prisma.$use(async (params, next) => {
			const result = await next(params);
			if (
				cancelPending &&
				params.model === "Plan" &&
				params.action === "findMany" &&
				params.args.where?.userId === user.userId &&
				params.args.where?.targetCurrency === currency
			) {
				cancelPending = false;
				await cancelPlan(user, planId).expect(200);
			}
			return result;
		});

		const overlappingRead = await getAllocations(user, currency).expect(200);
		expect(cancelPending).toBe(false);
		expect(overlappingRead.body.data).toEqual({ items: [beforeCancellation] });

		const laterRead = await getAllocations(user, currency).expect(200);
		expect(laterRead.body.data).toEqual({
			items: [
				{
					...beforeCancellation,
					planStatus: "CANCELLED",
					amount: "2000.0101",
					remainingAllocation: "0.0000",
				},
			],
		});
	});
});
