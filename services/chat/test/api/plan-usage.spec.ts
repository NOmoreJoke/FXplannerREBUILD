/**
 * 资金使用接口测试（usage-recording 技术方案 §8.2，13 条用例 + 守卫兜底）。
 * 走 test-app 基建；世界造数：POST /api/transactions（汇率 1 → unitCost = 1，
 * 精确构造用填法 A 非整汇率）+ seedPlanWithAllocation 直插计划/分配行。
 * 日期断言锚定 UTC+8 日界（transaction.spec 同款 yesterday/now 口径）。
 * 末尾为 ToB R1 W24 组织化用例（权限矩阵 / 跨组织隔离 / 锁内降权 / 审计回滚 / 共享 FIFO）。
 */
import type { INestApplication } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../../src/audit/audit.service";
import {
	cleanupUser,
	createTestApp,
	createTestUser,
	orgBearer,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";
import {
	PLAN_EXPECT_USE_DATE,
	PLAN_START_DATE,
	seedPlanWithAllocation,
} from "../helpers/plan-test-helper";
import { ensureOnboarded } from "../helpers/onboarding-helper";
import { utc8DayStart } from "../../src/usage/usage-calculator";
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

/** 汇率 1 的简化买入体（本金 = 数量 → unitCost = 1，成本断言可复算） */
function simpleBody(currencyCode: string, quantity: string) {
	return {
		currencyCode,
		principalAmount: quantity,
		exchangeRate: "1",
		quantity,
		feeAmount: "0",
		transactedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
	};
}

/** 今天（UTC+8 当日 0 点）：既不晚于今天也不早于任何合理起点 */
function todayIso(): string {
	return utc8DayStart(new Date()).toISOString();
}

describe("UsageController（接口）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let userMain: TestUser; // #1 正常记账 / #10 空列表 / #11 混排（共用世界）
	let userErr: TestUser; // #3~#6 参数与拦截类
	let userState: TestUser; // #7 状态流转
	let userJpy: TestUser; // #9 日元精度
	let userOther: TestUser; // #8/#12 防枚举探测
	let userMix: TestUser; // #11 混排（unitCost 1 干净世界）
	let userDetail: TestUser; // #13 详情派生字段（准备中世界）
	let userUp: TestUser; // #13 用完世界（USED_UP + canComplete）
	let userLedgerStart: TestUser; // #5 账本起点
	let planMain = ""; // userMain 的主计划
	let planErr = ""; // userErr 的主计划（#3~#4/#6）
	let planStart = ""; // userLedgerStart 的主计划（#5）
	const userIds: string[] = [];

	function postUsage(
		user: TestUser,
		planId: string,
		body: Record<string, unknown>,
	) {
		return request(app.getHttpServer())
			.post(`/api/plans/${planId}/usages`)
			.set(orgBearer(user))
			.send(body);
	}

	function getUsages(user: TestUser, planId: string) {
		return request(app.getHttpServer())
			.get(`/api/plans/${planId}/usages`)
			.set(orgBearer(user));
	}

	function postTx(user: TestUser, body: Record<string, unknown>) {
		return request(app.getHttpServer())
			.post("/api/transactions")
			.set(orgBearer(user))
			.send(body);
	}

	/** 世界造数：买入（建账户+批次）+ 直插计划/分配 */
	async function seedWorld(
		user: TestUser,
		options: {
			currency?: string;
			targetAmount?: string;
			allocatedAmount?: string;
			quantity?: string;
			rate?: string;
		} = {},
	): Promise<string> {
		const currency = options.currency ?? "USD";
		const quantity = options.quantity ?? "10000";
		if (options.rate) {
			// 填法 A：receivedAmountOf(本金, 汇率, 2) = 数量（非 1 单位成本用）
			await postTx(user, {
				currencyCode: currency,
				principalAmount: options.rate === "0.78" ? "7800.00" : quantity,
				exchangeRate: options.rate,
				quantity,
				feeAmount: "0",
				transactedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
			}).expect(201);
		} else {
			await postTx(user, simpleBody(currency, quantity)).expect(201);
		}
		return seedPlanWithAllocation(ctx.prisma, user.userId, {
			targetCurrency: currency,
			targetAmount: options.targetAmount ?? "10000",
			allocatedAmount: options.allocatedAmount ?? "10000",
		});
	}

	// 造数用户多（9 用户 × 注册/登录/建账 + 多世界造数），放宽 hook 超时
	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		userMain = await createTestUser(app, "usage-main");
		userErr = await createTestUser(app, "usage-err");
		userState = await createTestUser(app, "usage-state");
		userJpy = await createTestUser(app, "usage-jpy");
		userOther = await createTestUser(app, "usage-other");
		userMix = await createTestUser(app, "usage-mix");
		userDetail = await createTestUser(app, "usage-detail");
		userUp = await createTestUser(app, "usage-up");
		userLedgerStart = await createTestUser(app, "usage-start");
		userIds.push(
			userMain.userId,
			userErr.userId,
			userState.userId,
			userJpy.userId,
			userOther.userId,
			userMix.userId,
			userDetail.userId,
			userUp.userId,
			userLedgerStart.userId,
		);
		// BE-03：录交易/记使用需已建账，否则写入口 409 ONBOARDING_NOT_COMPLETED
		for (const user of [
			userMain,
			userErr,
			userState,
			userJpy,
			userOther,
			userMix,
			userDetail,
			userUp,
			userLedgerStart,
		]) {
			await ensureOnboarded(ctx.prisma, user.userId);
		}

		// #1 世界：买 10,000（unitCost 0.78）+ 目标/分配 10,000
		planMain = await seedWorld(userMain, { rate: "0.78" });
		// #3 世界：分配 2,000（余额 10,000，超额拦截看分配侧）
		planErr = await seedWorld(userErr, { allocatedAmount: "2000" });
		// #5 世界：账本起点 = 10 天前（UTC+8 日初）。ToB R1 W24 起使用写入口读取**组织**的
		// 记账起点（resolveOrganizationPreferences），ensureOnboarded 同步更新 UserSettings 与
		// 默认组织 OrganizationSettings（transaction.spec #11 同款夹具）
		await postTx(userLedgerStart, simpleBody("USD", "1000")).expect(201);
		await ensureOnboarded(
			ctx.prisma,
			userLedgerStart.userId,
			"CNY",
			utc8DayStart(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)),
		);
		planStart = await seedPlanWithAllocation(
			ctx.prisma,
			userLedgerStart.userId,
			{ targetCurrency: "USD", targetAmount: "1000", allocatedAmount: "1000" },
		);
		await postUsage(userLedgerStart, planStart, {
			amount: "1",
			usedAt: todayIso(),
		}).expect(201); // 世界自检：起点内可记
	}, 120_000);

	afterAll(async () => {
		for (const userId of userIds) {
			await cleanupUser(ctx.prisma, userId);
		}
		await app.close();
	});

	it("#0 未登录访问两接口均 401（Controller 级守卫）", async () => {
		await request(app.getHttpServer())
			.post(`/api/plans/${planMain}/usages`)
			.send({ amount: "1", usedAt: todayIso() })
			.expect(401);
		await request(app.getHttpServer())
			.get(`/api/plans/${planMain}/usages`)
			.expect(401);
	});

	it("#1 正常记账：201，usage.cost 正确（0.78 × 4,000 = 3,120），plan 快照 READY/剩余 6,000", async () => {
		const res = await postUsage(userMain, planMain, {
			amount: "4000",
			usedAt: todayIso(),
			remark: "秋季学费第一期",
		}).expect(201);
		expect(res.body.success).toBe(true);
		expect(res.body.data.usage).toMatchObject({
			planId: planMain,
			currencyCode: "USD",
			amount: "4000.0000",
			usedAt: todayIso(), // 服务端归一化到 UTC+8 当日 0 点（与校验日界同源）
			remark: "秋季学费第一期",
			cost: "3120.0000", // 4,000 × 0.78
			version: 1,
		});
		expect(res.body.data.plan).toMatchObject({
			targetAmount: "10000.0000",
			usedAmount: "4000.0000",
			allocatedAmount: "10000.0000",
			remainingAllocation: "6000.0000",
			stillNeeded: "6000.0000",
			gap: "0.0000",
			fundStatus: "READY",
			canComplete: false,
		});
	});

	it("#2 remark 缺省：201，remark = null", async () => {
		const res = await postUsage(userMain, planMain, {
			amount: "100",
			usedAt: todayIso(),
		}).expect(201);
		expect(res.body.data.usage.remark).toBeNull();
	});

	it("#3 金额超剩余分配：409 INSUFFICIENT_PLAN_ALLOCATION 附当前剩余，无落库", async () => {
		const before = await ctx.prisma.usageRecord.count();
		const res = await postUsage(userErr, planErr, {
			amount: "2500",
			usedAt: todayIso(),
		}).expect(409);
		expect(res.body.code).toBe("INSUFFICIENT_PLAN_ALLOCATION");
		expect(res.body.data).toEqual({
			remainingAllocation: "2000.0000",
			requestedAmount: "2500.0000",
		});
		// 本次不记账（需求 §7）：记录数不变、余额与 usedAmount 不变
		expect(await ctx.prisma.usageRecord.count()).toBe(before);
		const account = await ctx.prisma.account.findFirst({
			where: { organizationId: userErr.defaultOrganizationId, currencyCode: "USD" },
		});
		expect(account?.balance.toFixed(4)).toBe("10000.0000");
		const allocation = await ctx.prisma.planAllocation.findUnique({
			where: { planId: planErr },
		});
		expect(allocation?.usedAmount.toFixed(4)).toBe("0.0000");
	});

	it("#4 金额非法：≤ 0 / 5 位小数 / 非数字 / 超上限 → 400 INVALID_USAGE_PARAMS", async () => {
		const badAmounts = ["0", "-5", "abc", "1.00001", "100000000000"];
		for (const amount of badAmounts) {
			const res = await postUsage(userErr, planErr, {
				amount,
				usedAt: todayIso(),
			}).expect(400);
			expect(res.body.code).toBe("INVALID_USAGE_PARAMS");
		}
	});

	it("#5 日期三类异常 message 可区分：晚于今天 / 早于账本起点 / 非法格式", async () => {
		const planId = planStart;
		const tomorrow = await postUsage(userLedgerStart, planId, {
			amount: "1",
			usedAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
		}).expect(400);
		expect(tomorrow.body.message).toMatch(/不能晚于今天/);
		const tooEarly = await postUsage(userLedgerStart, planId, {
			amount: "1",
			usedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
		}).expect(400);
		expect(tooEarly.body.message).toMatch(/不能早于记账起点/);
		const malformed = await postUsage(userLedgerStart, planId, {
			amount: "1",
			usedAt: "not-a-date",
		}).expect(400);
		expect(malformed.body.message).toMatch(/有效的 ISO 8601/);
	});

	it("#6 remark 超 200 字：400 INVALID_USAGE_PARAMS", async () => {
		const planId = planErr;
		const res = await postUsage(userErr, planId, {
			amount: "1",
			usedAt: todayIso(),
			remark: "字".repeat(201),
		}).expect(400);
		expect(res.body.code).toBe("INVALID_USAGE_PARAMS");
		expect(res.body.message).toMatch(/备注/);
	});

	it("#7 COMPLETED / CANCELLED 计划：409 PLAN_INVALID_TRANSITION", async () => {
		const completed = await seedPlanWithAllocation(
			ctx.prisma,
			userState.userId,
			{
				targetCurrency: "USD",
				targetAmount: "1000",
				allocatedAmount: "0",
			},
		);
		const cancelled = await seedPlanWithAllocation(
			ctx.prisma,
			userState.userId,
			{
				targetCurrency: "USD",
				targetAmount: "1000",
				allocatedAmount: "0",
			},
		);
		await ctx.prisma.plan.update({
			where: { id: completed },
			data: { status: "COMPLETED" },
		});
		await ctx.prisma.plan.update({
			where: { id: cancelled },
			data: { status: "CANCELLED" },
		});
		for (const planId of [completed, cancelled]) {
			const res = await postUsage(userState, planId, {
				amount: "1",
				usedAt: todayIso(),
			}).expect(409);
			expect(res.body.code).toBe("PLAN_INVALID_TRANSITION");
			expect(res.body.message).toMatch(/仅进行中/);
		}
	});

	it("#8 他人计划 / 不存在 id：404 PLAN_NOT_FOUND（两场景响应一致，防枚举）", async () => {
		const byOther = await postUsage(userOther, planMain, {
			amount: "1",
			usedAt: todayIso(),
		}).expect(404);
		const nonexistent = await request(app.getHttpServer())
			.post("/api/plans/nonexistent-plan-id/usages")
			.set(orgBearer(userOther))
			.send({ amount: "1", usedAt: todayIso() })
			.expect(404);
		expect(byOther.body.code).toBe("PLAN_NOT_FOUND");
		expect(byOther.body).toEqual(nonexistent.body);
	});

	it("#9 日元金额带小数：400 INVALID_USAGE_PARAMS（整数币种）", async () => {
		const planId = await seedWorld(userJpy, {
			currency: "JPY",
			targetAmount: "10000",
			allocatedAmount: "10000",
			quantity: "10000",
		});
		const res = await postUsage(userJpy, planId, {
			amount: "100.5",
			usedAt: todayIso(),
		}).expect(400);
		expect(res.body.code).toBe("INVALID_USAGE_PARAMS");
		expect(res.body.message).toMatch(/整数币种/);
	});

	it("#10 空列表：200 { items: [] }", async () => {
		const fresh = await seedPlanWithAllocation(ctx.prisma, userMain.userId, {
			targetCurrency: "USD",
			targetAmount: "1000",
			allocatedAmount: "0",
		});
		const res = await getUsages(userMain, fresh).expect(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data).toEqual({ items: [] });
	});

	it("#11 多笔混排（补录历史日期）：usedAt 倒序、同刻 createdAt 倒序、含 cost/version/remark", async () => {
		// 独立用户（unitCost 1 的干净世界）：userMain 已有 0.78 批次，FIFO 混批成本不可直接复算预期
		const planId = await seedWorld(userMix, {
			targetAmount: "5000",
			allocatedAmount: "5000",
			quantity: "5000",
		});
		// 录入顺序：今天两笔（同刻）→ 3 天前补录一笔
		const first = await postUsage(userMix, planId, {
			amount: "100",
			usedAt: todayIso(),
			remark: "第一笔",
		}).expect(201);
		const second = await postUsage(userMix, planId, {
			amount: "200",
			usedAt: todayIso(),
		}).expect(201);
		const backdated = await postUsage(userMix, planId, {
			amount: "300",
			usedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
			remark: "补录",
		}).expect(201);

		const res = await getUsages(userMix, planId).expect(200);
		const items = res.body.data.items;
		expect(items.map((item: { id: string }) => item.id)).toEqual([
			second.body.data.usage.id, // 同刻 createdAt 倒序：后录在前
			first.body.data.usage.id,
			backdated.body.data.usage.id, // usedAt 更早：最后
		]);
		expect(items[0]).toMatchObject({
			amount: "200.0000",
			cost: "200.0000", // unitCost 1
			version: 1,
			remark: null,
		});
		expect(items[2].remark).toBe("补录");
	});

	it("#12 他人计划列表：404 不泄露存在性", async () => {
		const res = await getUsages(userOther, planMain).expect(404);
		expect(res.body.code).toBe("PLAN_NOT_FOUND");
	});

	it("#13 既有详情接口：使用后含 stillNeeded/fundStatus 且值正确（准备中 → 用完 USED_UP）", async () => {
		// 准备中世界：目标 1,000、分配 500（缺口 500 → PREPARING，钱未备齐）
		const planId = await seedWorld(userDetail, {
			targetAmount: "1000",
			allocatedAmount: "500",
			quantity: "1000",
		});
		const before = await request(app.getHttpServer())
			.get(`/api/plans/${planId}`)
			.set(orgBearer(userDetail))
			.expect(200);
		expect(before.body.data.stillNeeded).toBe("1000.0000");
		expect(before.body.data.fundStatus).toBe("PREPARING");
		expect(before.body.data.canComplete).toBe(false);

		await postUsage(userDetail, planId, {
			amount: "500",
			usedAt: todayIso(),
		}).expect(201);
		const afterPartial = await request(app.getHttpServer())
			.get(`/api/plans/${planId}`)
			.set(orgBearer(userDetail))
			.expect(200);
		expect(afterPartial.body.data.stillNeeded).toBe("500.0000");
		expect(afterPartial.body.data.fundStatus).toBe("PREPARING"); // 仍有缺口

		// 用完世界：目标 = 分配 = 余额 = 1,000 → 记满后 USED_UP + canComplete
		const planUp = await seedWorld(userUp, {
			targetAmount: "1000",
			allocatedAmount: "1000",
			quantity: "1000",
		});
		await postUsage(userUp, planUp, {
			amount: "1000",
			usedAt: todayIso(),
		}).expect(201);
		const afterUsedUp = await request(app.getHttpServer())
			.get(`/api/plans/${planUp}`)
			.set(orgBearer(userUp))
			.expect(200);
		expect(afterUsedUp.body.data.stillNeeded).toBe("0.0000");
		expect(afterUsedUp.body.data.fundStatus).toBe("USED_UP");
		expect(afterUsedUp.body.data.canComplete).toBe(true);
	});
});

/**
 * BE-03 未建账防线（回归）：plan/transaction/usage 三个写入口在无 UserSettings 时
 * 统一 409 ONBOARDING_NOT_COMPLETED，错误体附 /onboarding 引导；建账后解除。
 * 对齐 reminder/settings/data-request 既有 409 防线（fx-audit BE-03，已拍板口径）。
 */
describe("未建账写入口防线（BE-03 回归）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let user: TestUser;
	const userIds: string[] = [];

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		user = await createTestUser(app, "gate-keep");
		userIds.push(user.userId);
		// 注意：刻意不 ensureOnboarded——本 describe 专测未建账拦截
	}, 30_000);

	afterAll(async () => {
		for (const userId of userIds) {
			await cleanupUser(ctx.prisma, userId);
		}
		await app.close();
	});

	it("未建账建计划 → 409 ONBOARDING_NOT_COMPLETED，message 指向 /onboarding", async () => {
		const res = await request(app.getHttpServer())
			.post("/api/plans")
			.set(orgBearer(user))
			.send({
				targetCurrency: "USD",
				targetAmount: "1000",
				expectUseDate: "2030-02-15T00:00:00.000Z",
				prepLeadDays: 3,
				pacePreference: "balanced",
			})
			.expect(409);
		expect(res.body.code).toBe("ONBOARDING_NOT_COMPLETED");
		expect(res.body.message).toContain("/onboarding");
	});

	it("未建账录交易 → 409 同码同引导", async () => {
		const res = await request(app.getHttpServer())
			.post("/api/transactions")
			.set(orgBearer(user))
			.send({
				currencyCode: "USD",
				principalAmount: "1000.00",
				exchangeRate: "1",
				quantity: "1000.00",
				transactedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
			})
			.expect(409);
		expect(res.body.code).toBe("ONBOARDING_NOT_COMPLETED");
		expect(res.body.message).toContain("/onboarding");
	});

	it("未建账记使用 → 409 优先于计划 404（引导建账而非泄露不存在）", async () => {
		const res = await request(app.getHttpServer())
			.post("/api/plans/tx-nonexistent-plan/usages")
			.set(orgBearer(user))
			.send({ amount: "1", usedAt: todayIso() })
			.expect(409);
		expect(res.body.code).toBe("ONBOARDING_NOT_COMPLETED");
		expect(res.body.message).toContain("/onboarding");
	});

	it("建账后防线解除：建计划（分配 0）不再 409", async () => {
		await ensureOnboarded(ctx.prisma, user.userId);
		const res = await request(app.getHttpServer())
			.post("/api/plans")
			.set(orgBearer(user))
			.send({
				targetCurrency: "USD",
				targetAmount: "1000",
				expectUseDate: "2030-02-15T00:00:00.000Z",
				prepLeadDays: 3,
				pacePreference: "balanced",
			})
			.expect(201);
		expect(res.body.data.status).toBe("ACTIVE");
	});
});

/** 相对今天的过去第 n 天（固定时刻，避开 UTC+8 日界边界） */
function daysAgo(n: number): Date {
	return new Date(Date.now() - n * 86_400_000 - 2 * 3_600_000);
}

/**
 * ToB R1 W24：Usage 写接口 Actor 化（LEDGER-01 / AUTH-01）。
 * 组织共享账本下的权限矩阵、跨组织隔离、锁内降权 / 禁用、审计原子性与跨成员共享 FIFO 池。
 * 每个用例自建组织与成员并在 afterEach 清理（先清派生行再删用户，不留孤儿组织），
 * 写入全部走带 X-Organization-Id 的接口；支持按用例名 `-t` 独立运行。
 */
describe("ToB R1 W24：Usage 写接口 Actor 化 + 权限矩阵 + 跨组织隔离 + 锁内降权 + 审计回滚 + 共享 FIFO（支持 -t 独立运行）", () => {
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

	function orgPostUsage(
		user: TestUser,
		orgId: string,
		planId: string,
		body: Record<string, unknown>,
		requestId?: string,
	) {
		return request(app.getHttpServer())
			.post(`/api/plans/${planId}/usages`)
			.set(orgHeaders(user, orgId, requestId))
			.send(body);
	}

	function getUsagesAs(user: TestUser, orgId: string, planId: string) {
		return request(app.getHttpServer())
			.get(`/api/plans/${planId}/usages`)
			.set(orgHeaders(user, orgId));
	}

	/**
	 * 组织世界：buyer 买入 USD + 接口建计划（目标额 = 买入量，分配额 = 目标额的 80%，
	 * 给排期留出非零的分批总额；全额分配会因排期金额为 0 被 400 拒绝），返回计划 id
	 */
	async function seedOrgWorld(
		org: OrgLedger,
		options: { buyer?: TestUser; quantity?: string; unitCost?: string } = {},
	): Promise<string> {
		const buyer = options.buyer ?? org.owner;
		const quantity = options.quantity ?? "10000";
		await request(app.getHttpServer())
			.post("/api/transactions")
			.set(orgHeaders(buyer, org.orgId))
			.send(purchaseBody("USD", quantity, options.unitCost ?? "1", daysAgo(1)))
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
				allocatedAmount: new Prisma.Decimal(quantity).mul("0.8").toFixed(4),
			})
			.expect(201);
		return plan.body.data.id as string;
	}

	it.each(["OPERATOR", "VIEWER"] as const)(
		"W24-USAGE-1 %s 记录使用 → 403 PERMISSION_DENIED + DENIED 审计（带 requestId）+ 零账本写入",
		async (role) => {
			const org = await createOrgLedger(app, ctx.prisma, `w24-usage-denied-${role.toLowerCase()}`, [
				role,
			]);
			orgs.push(org);
			const member = org.members[0];
			const planId = await seedOrgWorld(org);
			const requestId = `req-w24-usage-denied-${role}-${Date.now()}`;

			const res = await orgPostUsage(
				member,
				org.orgId,
				planId,
				{ amount: "100", usedAt: todayIso() },
				requestId,
			).expect(403);
			expect(res.body.code).toBe("PERMISSION_DENIED");

			// 零账本写入：无使用记录、余额与已用额不动、无 usage.create 审计
			expect(
				await ctx.prisma.usageRecord.count({ where: { organizationId: org.orgId } }),
			).toBe(0);
			const account = await ctx.prisma.account.findFirstOrThrow({
				where: { organizationId: org.orgId, currencyCode: "USD" },
			});
			expect(account.balance.toFixed(4)).toBe("10000.0000");
			const allocation = await ctx.prisma.planAllocation.findUniqueOrThrow({
				where: { planId },
			});
			expect(allocation.usedAmount.toFixed(4)).toBe("0.0000");
			expect(
				await ctx.prisma.auditLog.count({
					where: { organizationId: org.orgId, action: "usage.create" },
				}),
			).toBe(0);

			// DENIED 审计：组织、操作者、权限点、角色与 requestId 齐全
			const denied = await ctx.prisma.auditLog.findMany({
				where: {
					organizationId: org.orgId,
					actorUserId: member.userId,
					action: "permission.denied.usage.create",
					result: "DENIED",
					requestId,
				},
			});
			expect(denied).toHaveLength(1);
			expect(denied[0].detail).toMatchObject({
				required: "usage.create",
				role,
			});
		},
	);

	it("W24-USAGE-2 跨组织 planId：多组织用户带 Org B 头对 Org A 计划记使用 → 404 PLAN_NOT_FOUND（与不存在 id 同响应），零写入", async () => {
		const org = await createOrgLedger(app, ctx.prisma, "w24-usage-cross-org");
		orgs.push(org);
		const owner = org.owner;
		const planId = await seedOrgWorld(org);
		const orgB = await createSecondOrg(ctx.prisma, owner, "W24 使用跨组织 B");
		orgs.push(orgB);

		const body = { amount: "100", usedAt: todayIso() };
		const cross = await orgPostUsage(owner, orgB.orgId, planId, body).expect(404);
		expect(cross.body.code).toBe("PLAN_NOT_FOUND");
		const nonexistent = await orgPostUsage(owner, orgB.orgId, "nonexistent-plan-id", body).expect(
			404,
		);
		// 防枚举：跨组织计划与不存在的 id 响应体一致
		expect(cross.body).toEqual(nonexistent.body);

		// Org A 零写入；两个组织都没有这次越权请求的任何痕迹
		expect(await ctx.prisma.usageRecord.count({ where: { planId } })).toBe(0);
		const allocation = await ctx.prisma.planAllocation.findUniqueOrThrow({ where: { planId } });
		expect(allocation.usedAmount.toFixed(4)).toBe("0.0000");
		expect(
			await ctx.prisma.auditLog.count({
				where: {
					organizationId: { in: [org.orgId, orgB.orgId] },
					action: { in: ["usage.create", "permission.denied.usage.create"] },
				},
			}),
		).toBe(0);

		// 对照：同一用户带 Org A 头即可记录
		await orgPostUsage(owner, org.orgId, planId, body).expect(201);
	});

	it("W24-USAGE-3 锁等期间降权（FINANCE → OPERATOR）：事务内按最新角色复验 → 403 + DENIED 审计（记录降权后的角色）+ 零写入", async () => {
		const org = await createOrgLedger(app, ctx.prisma, "w24-usage-demote", ["FINANCE"]);
		orgs.push(org);
		const finance = org.members[0];
		const planId = await seedOrgWorld(org);
		const requestId = `req-w24-usage-demote-${Date.now()}`;

		const res = await runBehindAdvisoryLock(
			ctx.prisma,
			`membership:${org.orgId}`,
			() =>
				orgPostUsage(
					finance,
					org.orgId,
					planId,
					{ amount: "100", usedAt: todayIso() },
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
		expect(
			await ctx.prisma.usageRecord.count({ where: { organizationId: org.orgId } }),
		).toBe(0);
		const allocation = await ctx.prisma.planAllocation.findUniqueOrThrow({ where: { planId } });
		expect(allocation.usedAmount.toFixed(4)).toBe("0.0000");
		// 审计记的是锁内重读到的最新角色（OPERATOR），不是 Guard 放行时的 FINANCE
		const denied = await ctx.prisma.auditLog.findMany({
			where: {
				organizationId: org.orgId,
				actorUserId: finance.userId,
				action: "permission.denied.usage.create",
				result: "DENIED",
				requestId,
			},
		});
		expect(denied).toHaveLength(1);
		expect(denied[0].detail).toMatchObject({
			required: "usage.create",
			role: "OPERATOR",
		});
	});

	it("W24-USAGE-4 锁等期间被禁用：已禁用成员 → 404 ORGANIZATION_NOT_FOUND（不泄露组织数据）+ 零写入零 SUCCESS 审计", async () => {
		const org = await createOrgLedger(app, ctx.prisma, "w24-usage-disabled", ["FINANCE"]);
		orgs.push(org);
		const finance = org.members[0];
		const planId = await seedOrgWorld(org);

		const res = await runBehindAdvisoryLock(
			ctx.prisma,
			`membership:${org.orgId}`,
			() => orgPostUsage(finance, org.orgId, planId, { amount: "100", usedAt: todayIso() }),
			async () => {
				await ctx.prisma.membership.update({
					where: {
						organizationId_userId: {
							organizationId: org.orgId,
							userId: finance.userId,
						},
					},
					data: { status: "DISABLED" },
				});
			},
		);

		expect(res.status).toBe(404);
		expect(res.body.code).toBe("ORGANIZATION_NOT_FOUND");
		expect(
			await ctx.prisma.usageRecord.count({ where: { organizationId: org.orgId } }),
		).toBe(0);
		expect(
			await ctx.prisma.auditLog.count({
				where: { organizationId: org.orgId, action: "usage.create" },
			}),
		).toBe(0);
	});

	it("W24-USAGE-5 AuditService.recordInTx 故障注入：使用记录 / 分摊明细 / 批次扣减 / 账户余额 / 分配已用整单回滚", async () => {
		const org = await createOrgLedger(app, ctx.prisma, "w24-usage-audit-fault", ["FINANCE"]);
		orgs.push(org);
		const finance = org.members[0];
		// owner 与 finance 各买一批：回滚必须覆盖跨成员的批次扣减
		const planId = await seedOrgWorld(org, { quantity: "1000" });
		await request(app.getHttpServer())
			.post("/api/transactions")
			.set(orgHeaders(finance, org.orgId))
			.send(purchaseBody("USD", "500", "2", daysAgo(1)))
			.expect(201);
		const before = await readOrgLedgerSnapshot(ctx.prisma, org.orgId);

		vi.spyOn(app.get(AuditService), "recordInTx").mockRejectedValueOnce(
			new Error("injected tx audit failure"),
		);
		// 600 = owner 的 1,000@1 批次先耗 600
		await orgPostUsage(finance, org.orgId, planId, {
			amount: "600",
			usedAt: todayIso(),
		}).expect(500);

		// 账本逐行回到写前（含批次剩余量与余额），没有「账已改但审计丢」
		expect(await readOrgLedgerSnapshot(ctx.prisma, org.orgId)).toEqual(before);
		expect(
			await ctx.prisma.auditLog.count({
				where: { organizationId: org.orgId, action: "usage.create" },
			}),
		).toBe(0);

		// 对照：故障只注入一次，同一请求随后可正常记账并写审计
		const ok = await orgPostUsage(finance, org.orgId, planId, {
			amount: "600",
			usedAt: todayIso(),
		}).expect(201);
		expect(ok.body.data.usage.cost).toBe("600.0000");
		expect(
			await ctx.prisma.auditLog.count({
				where: { organizationId: org.orgId, action: "usage.create", result: "SUCCESS" },
			}),
		).toBe(1);
	});

	it("W24-USAGE-6 跨成员共享 FIFO：Finance 1 买入两批 → Finance 2 记使用消耗的是 Finance 1 的批次，记录人 / 审计归属 Finance 2", async () => {
		const org = await createOrgLedger(app, ctx.prisma, "w24-usage-shared-fifo", [
			"FINANCE",
			"FINANCE",
		]);
		orgs.push(org);
		const [finance1, finance2] = org.members;
		const purchaseIds: string[] = [];
		for (const [days, unitCost] of [
			[4, "7.8"],
			[3, "8"],
		] as const) {
			const purchase = await request(app.getHttpServer())
				.post("/api/transactions")
				.set(orgHeaders(finance1, org.orgId))
				.send(purchaseBody("USD", "1000", unitCost, daysAgo(days)))
				.expect(201);
			purchaseIds.push(purchase.body.data.id);
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
		const planId = plan.body.data.id as string;
		const requestId = `req-w24-usage-shared-${Date.now()}`;

		const res = await orgPostUsage(
			finance2,
			org.orgId,
			planId,
			{ amount: "1200", usedAt: todayIso() },
			requestId,
		).expect(201);
		// Finance 2 自己没有任何买入：1,200 只能来自 Finance 1 的两批 → 1,000×7.8 + 200×8
		const usageId = res.body.data.usage.id as string;
		expect(res.body.data.usage).toMatchObject({
			id: usageId,
			cost: "9400.0000",
			createdById: finance2.userId,
		});

		const snapshot = await readOrgLedgerSnapshot(ctx.prisma, org.orgId);
		expect(snapshot.usages).toEqual([
			expect.objectContaining({
				id: usageId,
				createdById: finance2.userId,
				organizationId: org.orgId,
			}),
		]);
		expect(snapshot.lots.map((lot) => lot.organizationId)).toEqual([
			org.orgId,
			org.orgId,
		]);
		// 按来源批次比对剩余量（不依赖行 id 字典序）：买入一 1,000 全耗，买入二只耗 200
		const remainingBySource = new Map(
			snapshot.lots.map((lot) => [lot.sourceId, lot.remainingQty]),
		);
		expect(remainingBySource.get(purchaseIds[0])).toBe("0.0000");
		expect(remainingBySource.get(purchaseIds[1])).toBe("800.0000");
		expect(snapshot.allocations).toEqual([
			{ usageId, sourceId: purchaseIds[0], quantity: "1000.0000", cost: "7800.0000" },
			{ usageId, sourceId: purchaseIds[1], quantity: "200.0000", cost: "1600.0000" },
		]);
		expect(snapshot.accounts[0].balance).toBe("800.0000");

		// Finance 1 读到 Finance 2 记的使用；审计带组织、记录人与 requestId
		const list = await getUsagesAs(finance1, org.orgId, planId).expect(200);
		expect(list.body.data.items).toEqual([
			expect.objectContaining({ id: usageId, cost: "9400.0000", createdById: finance2.userId }),
		]);
		expect(
			await ctx.prisma.auditLog.findMany({
				where: { organizationId: org.orgId, action: "usage.create" },
			}),
		).toEqual([
			expect.objectContaining({
				actorUserId: finance2.userId,
				actorType: "USER",
				targetType: "usage_record",
				targetId: usageId,
				result: "SUCCESS",
				requestId,
			}),
		]);
	});
});
