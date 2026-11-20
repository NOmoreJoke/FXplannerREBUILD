/**
 * 计划接口测试 —— 阶段 1：存量回归基线（技术方案 §8.2「回归基线先行」强制时序）。
 *
 * 仅覆盖既有 POST /api/plans/schedule-preview 与 POST /api/plans：
 * - caps 两字段精确值（4 位小数）
 * - 超限 409 INSUFFICIENT_ALLOCATABLE_BALANCE 附 caps 现值
 * - NO_AVAILABLE_DATES / AMOUNT_TOO_SMALL / INVALID_PLAN_PARAMS 各错误分支
 * - allocatedAmount = 0 仍建 allocation 行
 *
 * computeCaps 迁移 plan-calculator 前先跑绿留档，迁移后重跑同一测试对照，
 * 作为「usedAmount = 0 域内逐位一致」的验收证据（§3.4 口径注）。
 *
 * 时钟策略：断言日期全部用显式 startDate / 远期 expectUseDate 锚定，默认不冻结时钟；
 * 唯一依赖「今天」的默认起始日用例采用 transaction.spec #11 的
 * vi.useFakeTimers({ toFake: ["Date"], now: Date.now() }) 局部冻结模式
 * （禁 vi.setSystemTime；禁全局 fake timers——会干扰 supertest）。
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
	cleanupPlanData,
	createPlanViaApi,
	ensureAccount,
	PLAN_EXPECT_USE_DATE,
	PLAN_START_DATE,
	seedPlanWithAllocation,
	setAllocationUsedAmount,
	type SeedPlanOptions,
} from "../helpers/plan-test-helper";

// 关闭全局接口限流（同 transaction.spec：APP_GUARD token 被 scanner 改写，只能 mock 类）
vi.mock("@nestjs/throttler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nestjs/throttler")>();
	class NoopThrottlerGuard {
		async canActivate() {
			return true;
		}
	}
	return { ...actual, ThrottlerGuard: NoopThrottlerGuard };
});

/** 2030-02-15 往前数 3 个工作日（周五 → 周二），preview 最晚准备日精确锚定值 */
const LATEST_PREP_DATE = "2030-02-12T00:00:00.000Z";

/** schedule-preview / create 默认请求体（显式 startDate，日期断言不依赖时钟） */
function planBody(overrides: Record<string, unknown> = {}) {
	return {
		targetCurrency: "USD",
		targetAmount: "50000",
		expectUseDate: PLAN_EXPECT_USE_DATE,
		prepLeadDays: 3,
		pacePreference: "balanced",
		startDate: PLAN_START_DATE,
		...overrides,
	};
}

/** 「明天」起首个工作日（UTC 口径，跳过周六日）——默认起始日断言用 */
function firstWorkdayAfterTodayIso(): string {
	const now = new Date();
	const day = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	);
	day.setUTCDate(day.getUTCDate() + 1);
	while (day.getUTCDay() === 0 || day.getUTCDay() === 6) {
		day.setUTCDate(day.getUTCDate() + 1);
	}
	return day.toISOString();
}

describe("PlanController（接口）—— 存量回归基线", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let userCaps: TestUser; // 账户 10000 + USD 计划(分配 2500.1234) + JPY 账户 800 + JPY 计划(分配 800)
	let userCreate: TestUser; // 账户 10000，走接口创建
	let userErr: TestUser; // 无账户，错误分支 + amount=0 用例
	let userFresh: TestUser; // 全新用户（无账户无计划）
	const userIds: string[] = [];
	const planIds: string[] = [];

	function postPreview(user: TestUser, body: Record<string, unknown>) {
		return request(app.getHttpServer())
			.post("/api/plans/schedule-preview")
			.set(bearer(user.accessToken))
			.send(body);
	}

	function postCreate(user: TestUser, body: Record<string, unknown>) {
		return request(app.getHttpServer())
			.post("/api/plans")
			.set(bearer(user.accessToken))
			.send(body);
	}

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		userCaps = await createTestUser(app, "plan-caps");
		userCreate = await createTestUser(app, "plan-create");
		userErr = await createTestUser(app, "plan-err");
		userFresh = await createTestUser(app, "plan-fresh");
		userIds.push(
			userCaps.userId,
			userCreate.userId,
			userErr.userId,
			userFresh.userId,
		);
		// BE-03：建计划/preview caps 需已建账，否则写入口 409 ONBOARDING_NOT_COMPLETED
		for (const user of [userCaps, userCreate, userErr, userFresh]) {
			await ensureOnboarded(ctx.prisma, user.userId);
		}

		// userCaps：USD 余额 10000、USD 计划分配 2500.1234；JPY 余额 800、JPY 计划分配 800
		await ensureAccount(ctx.prisma, userCaps.userId, "USD", "10000");
		await ensureAccount(ctx.prisma, userCaps.userId, "JPY", "800");
		planIds.push(
			await seedPlanWithAllocation(ctx.prisma, userCaps.userId, {
				targetCurrency: "USD",
				allocatedAmount: "2500.1234",
			}),
		);
		planIds.push(
			await seedPlanWithAllocation(ctx.prisma, userCaps.userId, {
				targetCurrency: "JPY",
				allocatedAmount: "800",
			}),
		);
		await ensureAccount(ctx.prisma, userCreate.userId, "USD", "10000");
	});

	afterAll(async () => {
		try {
			// plan_allocations 无外键无级联：必须先按 planId 显式清理孤儿行
			await cleanupPlanData(ctx.prisma, planIds);
			for (const userId of userIds) {
				await cleanupUser(ctx.prisma, userId);
			}
		} finally {
			await app?.close();
		}
	});

	it("#1 未登录访问 schedule-preview 与 POST /plans 均 401", async () => {
		await request(app.getHttpServer())
			.post("/api/plans/schedule-preview")
			.send(planBody())
			.expect(401);
		await request(app.getHttpServer())
			.post("/api/plans")
			.send(planBody())
			.expect(401);
	});

	it("#2 schedule-preview：全新用户 caps 双 0 精确值 + 排期精确锚定 + 不落库", async () => {
		const res = await postPreview(userFresh, planBody()).expect(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data.caps).toEqual({
			allocatableBalance: "0.0000",
			maxAllocatable: "0.0000",
		});
		expect(res.body.data.latestPrepDate).toBe(LATEST_PREP_DATE);
		expect(res.body.data.installments).toHaveLength(3);
		const [first, mid, last] = res.body.data.installments;
		expect(first).toMatchObject({
			seq: 1,
			scheduledAt: PLAN_START_DATE,
			amount: "16666.6600",
		});
		expect(mid).toMatchObject({ seq: 2, amount: "16666.6600" });
		expect(last).toMatchObject({
			seq: 3,
			scheduledAt: LATEST_PREP_DATE,
			amount: "16666.6800", // 零头入尾批，合计恒等于分批总额
		});
		// 只读不落库
		expect(
			await ctx.prisma.plan.count({ where: { userId: userFresh.userId } }),
		).toBe(0);
	});

	it("#3 schedule-preview：caps 扣减同币种既有分配（4 位精确），跨币种不挤占", async () => {
		// USD：10000 − 2500.1234（JPY 计划分配不参与 USD 口径）
		const usd = await postPreview(userCaps, planBody()).expect(200);
		expect(usd.body.data.caps).toEqual({
			allocatableBalance: "7499.8766",
			maxAllocatable: "7499.8766", // min(7499.8766, target 50000)
		});

		// min 取 target 侧：目标 1000 < 可分配 7499.8766
		const small = await postPreview(
			userCaps,
			planBody({ targetAmount: "1000" }),
		).expect(200);
		expect(small.body.data.caps).toEqual({
			allocatableBalance: "7499.8766",
			maxAllocatable: "1000.0000",
		});

		// JPY：800 − 800（USD 侧数据互不影响，同币种口径闭合）
		const jpy = await postPreview(
			userCaps,
			planBody({ targetCurrency: "JPY", targetAmount: "100000" }),
		).expect(200);
		expect(jpy.body.data.caps).toEqual({
			allocatableBalance: "0.0000",
			maxAllocatable: "0.0000",
		});
	});

	it("#3a schedule-preview：allocatedAmount 参与分批总额扣减，与 create 排期口径一致", async () => {
		// target 10000 − allocated 2500.1234 = 7499.8766，均衡三等分（按 USD 2 位精度
		// 向下取整）：前两批 2499.95，零头入尾批 2499.9766（与用例 #4 create 同参数对照）
		const res = await postPreview(
			userCreate,
			planBody({ targetAmount: "10000", allocatedAmount: "2500.1234" }),
		).expect(200);
		expect(res.body.data.installments).toHaveLength(3);
		expect(res.body.data.installments[0].amount).toBe("2499.9500");
		expect(res.body.data.installments[1].amount).toBe("2499.9500");
		expect(res.body.data.installments[2].amount).toBe("2499.9766");
	});

	it("#3b schedule-preview：allocatedAmount 缺省 → 按全额目标排期（向后兼容）", async () => {
		const res = await postPreview(
			userFresh,
			planBody({ targetAmount: "30000" }),
		).expect(200);
		// 30000 均衡三等分：10000/10000/10000
		expect(
			res.body.data.installments.map((i: { amount: string }) => i.amount),
		).toEqual(["10000.0000", "10000.0000", "10000.0000"]);
	});

	it("#3c schedule-preview：allocatedAmount ≥ 目标金额 → 400 AMOUNT_TOO_SMALL", async () => {
		// 等于：分批总额 = 0
		const equal = await postPreview(
			userFresh,
			planBody({ targetAmount: "50000", allocatedAmount: "50000" }),
		).expect(400);
		expect(equal.body.code).toBe("AMOUNT_TOO_SMALL");

		// 超过：分批总额为负，同样拒
		const over = await postPreview(
			userFresh,
			planBody({ targetAmount: "50000", allocatedAmount: "60000" }),
		).expect(400);
		expect(over.body.code).toBe("AMOUNT_TOO_SMALL");
	});

	it("#3d schedule-preview：allocatedAmount 非法（负数/非数字）→ 400 INVALID_PLAN_PARAMS", async () => {
		for (const allocatedAmount of ["-1", "abc"]) {
			const res = await postPreview(
				userFresh,
				planBody({ targetAmount: "50000", allocatedAmount }),
			).expect(400);
			expect(res.body.code).toBe("INVALID_PLAN_PARAMS");
		}
	});

	it("#4 create：分配额 4 位小数全链路（201 → allocation 行 → caps 回收）", async () => {
		const res = await postCreate(
			userCreate,
			planBody({ targetAmount: "10000", allocatedAmount: "2500.1234" }),
		).expect(201);
		expect(res.body.success).toBe(true);
		const plan = res.body.data;
		expect(plan).toMatchObject({
			targetCurrency: "USD",
			targetAmount: "10000.0000",
			allocatedAmount: "2500.1234",
			remainingAmount: "2500.1234", // usedAmount = 0
			status: "ACTIVE",
			prepLeadDays: 3,
			pacePreference: "balanced",
		});
		expect(plan.name).toBeNull();
		expect(plan.installments).toHaveLength(3);
		expect(plan.installments[0].scheduledAt).toBe(PLAN_START_DATE);
		expect(plan.installments[2].scheduledAt).toBe(LATEST_PREP_DATE);
		planIds.push(plan.id);

		// allocation 行：amount 精确、usedAmount = 0
		const allocation = await ctx.prisma.planAllocation.findUnique({
			where: { planId: plan.id },
		});
		expect(allocation?.amount.toFixed(4)).toBe("2500.1234");
		expect(allocation?.usedAmount.toFixed(4)).toBe("0.0000");
		expect(
			await ctx.prisma.planInstallment.count({ where: { planId: plan.id } }),
		).toBe(3);

		// caps 回收：后续 preview 扣减该分配
		const after = await postPreview(
			userCreate,
			planBody({ targetAmount: "50000" }),
		).expect(200);
		expect(after.body.data.caps.allocatableBalance).toBe("7499.8766");

		// FXP 缺陷修复验收点：同参数 preview 排期与 create 落库排期逐批一致
		const sameParamsPreview = await postPreview(
			userCreate,
			planBody({ targetAmount: "10000", allocatedAmount: "2500.1234" }),
		).expect(200);
		expect(sameParamsPreview.body.data.installments).toEqual(plan.installments);
	});

	it("#5 create：allocatedAmount=0 仍建 allocation 行（无账户 caps=0 可分配）", async () => {
		const res = await postCreate(
			userErr,
			planBody({ targetAmount: "100", allocatedAmount: "0" }),
		).expect(201);
		expect(res.body.data.allocatedAmount).toBe("0.0000");
		planIds.push(res.body.data.id as string);

		const allocation = await ctx.prisma.planAllocation.findUnique({
			where: { planId: res.body.data.id },
		});
		expect(allocation).not.toBeNull(); // amount=0 也必须落行（1:1 数据形态一致）
		expect(allocation?.amount.toFixed(4)).toBe("0.0000");
		expect(allocation?.usedAmount.toFixed(4)).toBe("0.0000");
		// 排期 = 全额目标（无分配扣减）
		expect(res.body.data.installments).toHaveLength(3);
		expect(
			res.body.data.installments
				.reduce(
					(sum: number, item: { amount: string }) => sum + Number(item.amount),
					0,
				)
				.toFixed(4),
		).toBe("100.0000");
	});

	it("#6 create：allocatedAmount 缺省 → 0.0000，仍建 allocation 行", async () => {
		const res = await postCreate(
			userErr,
			planBody({ targetAmount: "200" }),
		).expect(201);
		expect(res.body.data.allocatedAmount).toBe("0.0000");
		planIds.push(res.body.data.id as string);
		const allocation = await ctx.prisma.planAllocation.findUnique({
			where: { planId: res.body.data.id },
		});
		expect(allocation?.amount.toFixed(4)).toBe("0.0000");
	});

	it("#7 create 超限：409 INSUFFICIENT_ALLOCATABLE_BALANCE 附 caps 现值", async () => {
		const before = await ctx.prisma.plan.count({
			where: { userId: userCaps.userId },
		});
		const res = await postCreate(
			userCaps,
			planBody({ allocatedAmount: "7499.8767" }), // 可分配 7499.8766 + 0.0001
		).expect(409);
		expect(res.body.code).toBe("INSUFFICIENT_ALLOCATABLE_BALANCE");
		// 附 caps 现值（精确 4 位）——前端「可分配余额已变化」模式的数据源
		expect(res.body.data).toEqual({
			allocatableBalance: "7499.8766",
			maxAllocatable: "7499.8766",
		});
		// 事务回滚：未产生计划
		expect(
			await ctx.prisma.plan.count({ where: { userId: userCaps.userId } }),
		).toBe(before);
	});

	it("#8 create 无账户小额分配：409 附 caps 0（分配 0 合法的对照见 #5）", async () => {
		const res = await postCreate(
			userErr,
			planBody({ targetAmount: "100", allocatedAmount: "0.01" }),
		).expect(409);
		expect(res.body.code).toBe("INSUFFICIENT_ALLOCATABLE_BALANCE");
		expect(res.body.data).toEqual({
			allocatableBalance: "0.0000",
			maxAllocatable: "0.0000",
		});
	});

	it("#9 NO_AVAILABLE_DATES：可安排工作日为 0（preview + create 事务回滚）", async () => {
		// 2030-03-02(周六) 起始、用途日 2030-03-02、缓冲 1 天 → 最晚准备日 2030-03-01(周五) < 起始日
		const body = planBody({
			expectUseDate: "2030-03-02T00:00:00.000Z",
			startDate: "2030-03-02T00:00:00.000Z",
		});
		const preview = await postPreview(userErr, body).expect(400);
		expect(preview.body.code).toBe("NO_AVAILABLE_DATES");

		const before = await ctx.prisma.plan.count({
			where: { userId: userErr.userId },
		});
		const created = await postCreate(userErr, body).expect(400);
		expect(created.body.code).toBe("NO_AVAILABLE_DATES");
		expect(
			await ctx.prisma.plan.count({ where: { userId: userErr.userId } }),
		).toBe(before); // 任一失败全部回滚
	});

	it("#10 AMOUNT_TOO_SMALL：分批取整后某批为 0（preview + create 回滚）", async () => {
		// 0.01 balanced 三等分 → 前两批取整 0.00 → R6
		const body = planBody({ targetAmount: "0.01" });
		const preview = await postPreview(userErr, body).expect(400);
		expect(preview.body.code).toBe("AMOUNT_TOO_SMALL");

		const before = await ctx.prisma.plan.count({
			where: { userId: userErr.userId },
		});
		const created = await postCreate(userErr, body).expect(400);
		expect(created.body.code).toBe("AMOUNT_TOO_SMALL");
		expect(
			await ctx.prisma.plan.count({ where: { userId: userErr.userId } }),
		).toBe(before);
	});

	it("#11 INVALID_PLAN_PARAMS：各非法分支均 400 { code, message }", async () => {
		for (const body of [
			planBody({ targetCurrency: "XYZ" }), // 非 15 币种
			planBody({ targetAmount: "0" }), // ≤ 0
			planBody({ targetAmount: "-5" }), // 负数
			planBody({ targetAmount: "abc" }), // 非数字
			planBody({
				expectUseDate: new Date(Date.now() - 86_400_000).toISOString(),
			}), // 不晚于今天
			planBody({ prepLeadDays: 0 }), // < 1
			planBody({ prepLeadDays: 31 }), // > 30
			planBody({ pacePreference: "radical" }), // 枚举外
			planBody({ startDate: new Date(Date.now() - 86_400_000).toISOString() }), // 开始准备日早于今天
		]) {
			const res = await postPreview(userErr, body).expect(400);
			expect(res.body.code).toBe("INVALID_PLAN_PARAMS");
		}
	});

	it("目标币种 = 本位币：preview / create 均 400 INVALID_PLAN_PARAMS（大小写归一，不落库）", async () => {
		// 本位币来自 UserSettings（ensureOnboarded 默认 CNY），显式重申防默认值漂移
		await ensureOnboarded(ctx.prisma, userErr.userId, "CNY");
		for (const targetCurrency of ["CNY", "cny"]) {
			const preview = await postPreview(
				userErr,
				planBody({ targetCurrency }),
			).expect(400);
			expect(preview.body.code).toBe("INVALID_PLAN_PARAMS");
			expect(preview.body.message).toContain("本位币");
		}

		const before = await ctx.prisma.plan.count({
			where: { userId: userErr.userId },
		});
		const created = await postCreate(
			userErr,
			planBody({ targetCurrency: "CNY" }),
		).expect(400);
		expect(created.body.code).toBe("INVALID_PLAN_PARAMS");
		expect(
			await ctx.prisma.plan.count({ where: { userId: userErr.userId } }),
		).toBe(before);
	});

	it("值集回归（FE-03 根治）：pace 合法值 conservative/aggressive 预览排期均生成（节奏分批体现值集语义；值集单一来源后端 DTO）", async () => {
		// conservative 首批 50%（25000）；aggressive 首批 20%（10000，零头入尾批）
		const conservative = await postPreview(
			userErr,
			planBody({ pacePreference: "conservative" }),
		).expect(200);
		expect(conservative.body.data.installments[0]).toMatchObject({
			seq: 1,
			amount: "25000.0000",
		});

		const aggressive = await postPreview(
			userErr,
			planBody({ pacePreference: "aggressive" }),
		).expect(200);
		expect(aggressive.body.data.installments[0]).toMatchObject({
			seq: 1,
			amount: "10000.0000",
		});
	});

	it("#12 DTO 层拒绝 JSON number：400 Bad Request 无模块 code", async () => {
		const res = await postPreview(
			userErr,
			planBody({ targetAmount: 50000 }),
		).expect(400);
		expect(res.body.error).toBe("Bad Request");
		expect(res.body.statusCode).toBe(400);
		expect(res.body.code).toBeUndefined();
	});

	it("#13 默认起始日 = 明天起首个工作日（局部冻结时钟）", async () => {
		// 固定为真实当下并冻结流逝（transaction.spec #11 模式），防午夜/跨秒 flaky
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
		try {
			const res = await postPreview(
				userErr,
				planBody({ startDate: undefined }),
			).expect(200);
			expect(res.body.data.installments[0].scheduledAt).toBe(
				firstWorkdayAfterTodayIso(),
			);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ────────────────── M5 计划管理端点（plan-management §8.2）──────────────────

describe("PlanController（接口）—— M5 管理端点", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const userIds: string[] = [];
	const planIds: string[] = [];

	/** 注册新测试用户并入清理名单；默认建大额 USD 账户兌底（API 建计划/预览 caps 需要） */
	async function newUser(label: string): Promise<TestUser> {
		const user = await createTestUser(app, label);
		userIds.push(user.userId);
		await ensureOnboarded(ctx.prisma, user.userId);
		await ensureAccount(ctx.prisma, user.userId, "USD", "1000000");
		return user;
	}

	/** 接口建计划（显式 startDate，日期断言不依赖时钟），id/updatedAt 入名单 */
	async function newPlan(
		user: TestUser,
		overrides: Record<string, unknown> = {},
	): Promise<{ id: string; updatedAt: string }> {
		// createPlanViaApi 为 async：await 直接得到 Response（Test thenable 被解包）
		const res = await createPlanViaApi(app, user, overrides);
		expect(res.status).toBe(201);
		// PlanDto 不含 updatedAt（乐观锁基准从详情取）
		const detail = await getDetail(user, res.body.data.id).expect(200);
		const plan = {
			id: res.body.data.id as string,
			updatedAt: detail.body.data.updatedAt as string,
		};
		planIds.push(plan.id);
		return plan;
	}

	/** 直插计划 + 分配行（无排期），id 入名单 */
	async function seedPlan(
		userId: string,
		options: SeedPlanOptions = {},
	): Promise<string> {
		const planId = await seedPlanWithAllocation(ctx.prisma, userId, options);
		planIds.push(planId);
		return planId;
	}

	/** updatedAt 毫秒精度：跨步 tick 保证列表排序断言确定性 */
	const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

	function getPlans(user: TestUser, query = "") {
		return request(app.getHttpServer())
			.get(`/api/plans${query}`)
			.set(bearer(user.accessToken));
	}

	function getDetail(user: TestUser, planId: string) {
		return request(app.getHttpServer())
			.get(`/api/plans/${planId}`)
			.set(bearer(user.accessToken));
	}

	function postAdjustPreview(
		user: TestUser,
		planId: string,
		body: Record<string, unknown>,
	) {
		return request(app.getHttpServer())
			.post(`/api/plans/${planId}/adjust-preview`)
			.set(bearer(user.accessToken))
			.send(body);
	}

	function patchPlan(
		user: TestUser,
		planId: string,
		body: Record<string, unknown>,
	) {
		return request(app.getHttpServer())
			.patch(`/api/plans/${planId}`)
			.set(bearer(user.accessToken))
			.send(body);
	}

	function postComplete(user: TestUser, planId: string) {
		return request(app.getHttpServer())
			.post(`/api/plans/${planId}/complete`)
			.set(bearer(user.accessToken));
	}

	function postCancel(user: TestUser, planId: string) {
		return request(app.getHttpServer())
			.post(`/api/plans/${planId}/cancel`)
			.set(bearer(user.accessToken));
	}

	/** 存量 schedule-preview 探针：返回该用户 USD 未分配余额（caps 回收断言用） */
	async function previewCaps(user: TestUser): Promise<string> {
		const res = await request(app.getHttpServer())
			.post("/api/plans/schedule-preview")
			.set(bearer(user.accessToken))
			.send(planBody())
			.expect(200);
		return res.body.data.caps.allocatableBalance as string;
	}

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
	});

	afterAll(async () => {
		try {
			// plan_allocations 无外键无级联：必须先按 planId 显式清理孤儿行
			await cleanupPlanData(ctx.prisma, planIds);
			for (const userId of userIds) {
				await cleanupUser(ctx.prisma, userId);
			}
		} finally {
			await app?.close();
		}
	});

	it("#14 M5 六端点未登录均 401", async () => {
		const server = app.getHttpServer();
		await request(server).get("/api/plans").expect(401);
		await request(server).get("/api/plans/any").expect(401);
		await request(server)
			.post("/api/plans/any/adjust-preview")
			.send({})
			.expect(401);
		await request(server).patch("/api/plans/any").send({}).expect(401);
		await request(server).post("/api/plans/any/complete").expect(401);
		await request(server).post("/api/plans/any/cancel").expect(401);
	});

	it("#15 GET /plans 全量：updatedAt 倒序 + 列表项字段（含下一准备节点）", async () => {
		const user = await newUser("plan-m5-list");
		const p1 = await newPlan(user, {
			targetAmount: "10000",
			allocatedAmount: "2000",
		});
		await tick();
		const p2 = await newPlan(user, {
			targetAmount: "20000",
			allocatedAmount: "15000",
		});
		const p3 = await seedPlan(user.userId, {
			targetAmount: "5000",
			allocatedAmount: "1000",
		});
		await tick();
		// 构造完成态（创建接口不允许 alloc == target：分批总额为 0；直改分配行模拟 M7 后沉淀）
		await ctx.prisma.planAllocation.update({
			where: { planId: p2.id },
			data: { amount: "20000" },
		});
		await setAllocationUsedAmount(ctx.prisma, p2.id, "20000");
		await tick();
		await postComplete(user, p2.id).expect(200);
		await tick();
		await postCancel(user, p3).expect(200);

		const res = await getPlans(user).expect(200);
		expect(res.body.success).toBe(true);
		const items = res.body.data.items;
		expect(items.map((item: { id: string }) => item.id)).toEqual([
			p3,
			p2.id,
			p1.id,
		]);

		const item1 = items[2];
		expect(item1).toMatchObject({
			id: p1.id,
			name: null,
			status: "ACTIVE",
			targetCurrency: "USD",
			targetAmount: "10000.0000",
			usedAmount: "0.0000",
			allocatedAmount: "2000.0000",
			remainingAllocation: "2000.0000",
			gap: "8000.0000",
			latestPrepDate: LATEST_PREP_DATE,
			nextInstallmentAt: PLAN_START_DATE, // 2030 远期 → 未到期最早准备节点
		});
		expect(typeof item1.updatedAt).toBe("string");
		expect(items[1]).toMatchObject({
			id: p2.id,
			status: "COMPLETED",
			targetAmount: "20000.0000",
			usedAmount: "20000.0000",
			remainingAllocation: "0.0000",
			gap: "0.0000", // 钱已备齐
		});
		expect(items[0]).toMatchObject({
			id: p3,
			status: "CANCELLED",
			allocatedAmount: "0.0000", // amount → max(used, 0)，used = 0
			nextInstallmentAt: null, // 取消后准备节点清空
		});
	}, 20000);

	it("#16 GET /plans?status= 三值过滤", async () => {
		const user = await newUser("plan-m5-filter");
		await seedPlan(user.userId, { targetAmount: "100", allocatedAmount: "0" });
		const active = await getPlans(user, "?status=ACTIVE").expect(200);
		expect(active.body.data.items).toHaveLength(1);
		expect(active.body.data.items[0].status).toBe("ACTIVE");
		// 无 COMPLETED / CANCELLED 计划的空过滤结果
		expect(
			(await getPlans(user, "?status=COMPLETED").expect(200)).body.data.items,
		).toHaveLength(0);
		expect(
			(await getPlans(user, "?status=CANCELLED").expect(200)).body.data.items,
		).toHaveLength(0);
	});

	it("#17 GET /plans 他人计划不可见 + 空列表", async () => {
		const other = await newUser("plan-m5-other");
		const res = await getPlans(other).expect(200);
		expect(res.body.data.items).toEqual([]); // 空列表
		const listUserPlans = await ctx.prisma.plan.findMany({
			where: { userId: { not: other.userId } },
			select: { id: true },
			take: 1,
		});
		for (const plan of listUserPlans) {
			const res2 = await getPlans(other).expect(200);
			expect(
				res2.body.data.items.map((item: { id: string }) => item.id),
			).not.toContain(plan.id);
		}
	});

	it("#18 GET /plans 非法 status：400（DTO @IsIn）", async () => {
		const user = await newUser("plan-m5-status-err");
		const res = await getPlans(user, "?status=FOO").expect(400);
		expect(res.body.error).toBe("Bad Request");
	});

	it("#19 GET /plans/:id 正常：详情字段 + 准备节点 + canXxx 标记", async () => {
		const user = await newUser("plan-m5-detail");
		const plan = await newPlan(user, {
			targetAmount: "10000",
			allocatedAmount: "2000",
		});
		const res = await getDetail(user, plan.id).expect(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data).toMatchObject({
			id: plan.id,
			status: "ACTIVE",
			targetAmount: "10000.0000",
			usedAmount: "0.0000",
			allocatedAmount: "2000.0000",
			remainingAllocation: "2000.0000",
			gap: "8000.0000",
			latestPrepDate: LATEST_PREP_DATE,
			nextInstallmentAt: PLAN_START_DATE,
			pacePreference: "balanced",
			prepLeadDays: 3,
			expectUseDate: PLAN_EXPECT_USE_DATE,
			planStartDate: PLAN_START_DATE, // M5 起 create 落库
			canModify: true,
			canCancel: true,
			canComplete: false,
			canReopen: false,
		});
		expect(res.body.data.installments).toHaveLength(3);
		expect(res.body.data.installments[0]).toMatchObject({
			seq: 1,
			scheduledAt: PLAN_START_DATE,
			amount: "2666.6600",
		});
		expect(res.body.data.installments[2]).toMatchObject({
			seq: 3,
			scheduledAt: LATEST_PREP_DATE,
			amount: "2666.6800",
		});
		expect(res.body.data.changeLogs).toEqual([]); // 存量无历史
		// 乐观锁基准：列表与详情的 updatedAt 一致
		const listRes = await getPlans(user).expect(200);
		expect(listRes.body.data.items[0].updatedAt).toBe(res.body.data.updatedAt);
	}, 20000);

	it("#20 GET /plans/:id 不存在与他人的均 404 PLAN_NOT_FOUND（防枚举）", async () => {
		const user = await newUser("plan-m5-detail-404");
		const stranger = await newUser("plan-m5-detail-404-b");
		const foreignPlan = await seedPlan(stranger.userId, {
			allocatedAmount: "0",
		});

		const ghost = await getDetail(user, "no-such-plan-id").expect(404);
		expect(ghost.body.code).toBe("PLAN_NOT_FOUND");
		const foreign = await getDetail(user, foreignPlan).expect(404);
		expect(foreign.body.code).toBe("PLAN_NOT_FOUND");
	});

	it("#21 adjust-preview：ACTIVE 常规预览（caps/impact/before/after 精确 + 只读不落库）", async () => {
		const user = await newUser("plan-m5-pv");
		await ensureAccount(ctx.prisma, user.userId, "USD", "10000"); // 兜底账户改回精确余额供 caps 断言
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "2000",
		});
		const before = await getDetail(user, planId).expect(200);

		const res = await postAdjustPreview(user, planId, {
			newTargetAmount: "12000",
		}).expect(200);
		expect(res.body.data).toMatchObject({
			valid: true,
			reopen: false,
			caps: {
				limit: "10000.0000", // min(还需使用 12000, 未分配 8000 + 原分配 2000)
				unallocatedBalance: "8000.0000", // 10000 − 本计划剩余 2000
				stillNeeded: "12000.0000",
			},
			impact: {
				releasedAmount: "0.0000", // 调高目标分配不动
				newGap: "10000.0000", // 12000 − 剩余分配 2000
				scheduleDropped: false,
			},
			before: {
				targetAmount: "10000.0000",
				allocAmount: "2000.0000",
				remainingAllocation: "2000.0000",
				gap: "8000.0000",
				pacePreference: "balanced",
				prepLeadDays: 3,
				planStartDate: null, // seed 计划未落基线
			},
			after: {
				targetAmount: "12000.0000",
				allocAmount: "2000.0000",
				gap: "10000.0000",
			},
			newLatestPrepDate: LATEST_PREP_DATE,
		});
		expect(res.body.data.impact.newSchedule).toHaveLength(3);
		// 分批总额 = 12000 − 0 − 2000 = 10000 → 3333.33 ×2 + 零头入尾批
		expect(
			res.body.data.impact.newSchedule.map(
				(item: { amount: string }) => item.amount,
			),
		).toEqual(["3333.3300", "3333.3300", "3333.3400"]);
		// 只读不落库：updatedAt / 排期 / 变更记录均未动
		const after = await getDetail(user, planId).expect(200);
		expect(after.body.data.updatedAt).toBe(before.body.data.updatedAt);
		expect(after.body.data.installments).toHaveLength(0);
		expect(after.body.data.changeLogs).toHaveLength(0);
	}, 20000);

	it("#22 adjust-preview：COMPLETED 调高目标 → reopen 标记；CANCELLED → 409", async () => {
		const user = await newUser("plan-m5-pv-reopen");
		// 严格完成态（used == target 且剩余分配 == 0）
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "10000",
			usedAmount: "10000",
		});
		await postComplete(user, planId).expect(200); // 先构造 COMPLETED
		const reopen = await postAdjustPreview(user, planId, {
			newTargetAmount: "12000",
		}).expect(200);
		expect(reopen.body.data).toMatchObject({
			valid: true,
			reopen: true,
			caps: null, // 重开场景 caps 三值无意义，省略
			impact: { newGap: "2000.0000" },
			after: { targetAmount: "12000.0000", allocAmount: "10000.0000" },
		});

		// 非严格完成态的 COMPLETED（used < target）→ 409
		// （该状态当前接口不可达——M8 更正后才会出现，直改 status 构造）
		const half = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "5000",
			usedAmount: "5000",
		});
		await ctx.prisma.plan.update({
			where: { id: half },
			data: { status: "COMPLETED" },
		});
		const bad = await postAdjustPreview(user, half, {
			newTargetAmount: "12000",
		}).expect(409);
		expect(bad.body.code).toBe("PLAN_INVALID_TRANSITION");

		// CANCELLED 终态预览 → 409（写死）
		const cancelledId = await seedPlan(user.userId, { allocatedAmount: "0" });
		await postCancel(user, cancelledId).expect(200);
		const gone = await postAdjustPreview(user, cancelledId, {
			newTargetAmount: "12000",
		}).expect(409);
		expect(gone.body.code).toBe("PLAN_INVALID_TRANSITION");
	}, 20000);

	it("#23 adjust-preview：至少一项 400 / 金额超 4 位小数 400 / JSON number 400", async () => {
		const user = await newUser("plan-m5-pv-params");
		const planId = await seedPlan(user.userId, { allocatedAmount: "0" });

		const empty = await postAdjustPreview(user, planId, {}).expect(400);
		expect(empty.body.code).toBe("INVALID_PLAN_PARAMS");
		expect(empty.body.message).toContain("至少");

		// 10000.00005：解析层直接拒绝，禁依赖 Postgres 静默舍入
		const tooPrecise = await postAdjustPreview(user, planId, {
			newTargetAmount: "10000.00005",
		}).expect(400);
		expect(tooPrecise.body.code).toBe("INVALID_PLAN_PARAMS");
		expect(tooPrecise.body.message).toContain("4 位小数");

		// JSON number 直拒（DTO @IsString），无模块 code
		const jsonNumber = await postAdjustPreview(user, planId, {
			prepLeadDays: 3.5,
		}).expect(400);
		expect(jsonNumber.body.error).toBe("Bad Request");
		expect(jsonNumber.body.code).toBeUndefined();
	}, 20000);

	it("#24 PATCH 调低目标：分配自动释放原子生效（余额不动 + caps 回收 + 排期清空）", async () => {
		const user = await newUser("plan-m5-adj1");
		await ensureAccount(ctx.prisma, user.userId, "USD", "10000");
		const plan = await newPlan(user, {
			targetAmount: "10000",
			allocatedAmount: "6000",
		});
		// 释放前 caps：未分配 = 10000 − 6000
		const beforePreview = await previewCaps(user);
		expect(beforePreview).toBe("4000.0000");

		const res = await patchPlan(user, plan.id, {
			newTargetAmount: "4000",
			expectedUpdatedAt: plan.updatedAt,
		}).expect(200);
		expect(res.body.data).toMatchObject({
			targetAmount: "4000.0000",
			allocatedAmount: "4000.0000", // 自动释放至新目标（不高于 used 下限）
			remainingAllocation: "4000.0000",
			gap: "0.0000", // 钱已备齐
		});
		expect(res.body.data.installments).toEqual([]); // 缺口为 0 清空准备节点
		const log = res.body.data.changeLogs[0];
		expect(log).toMatchObject({
			changeType: "TARGET_ADJUSTED", // 目标变化优先归类
			beforeTarget: "10000.0000",
			afterTarget: "4000.0000",
			beforeAlloc: "6000.0000",
			afterAlloc: "4000.0000",
			releasedAmount: "2000.0000",
		});
		// 释放原子生效：账户余额不动，分配行下调，caps 回收 2000
		const account = await ctx.prisma.account.findUnique({
			where: {
				userId_currencyCode: { userId: user.userId, currencyCode: "USD" },
			},
		});
		expect(account?.balance.toFixed(4)).toBe("10000.0000");
		const allocation = await ctx.prisma.planAllocation.findUnique({
			where: { planId: plan.id },
		});
		expect(allocation?.amount.toFixed(4)).toBe("4000.0000");
		expect(await previewCaps(user)).toBe("6000.0000");
	}, 20000);

	it("#25 PATCH 调高目标：缺口更新 + 排期重建（首日 = 原开始日）", async () => {
		const user = await newUser("plan-m5-adj2");
		const plan = await newPlan(user, {
			targetAmount: "10000",
			allocatedAmount: "2000",
		});
		const res = await patchPlan(user, plan.id, {
			newTargetAmount: "12000",
			expectedUpdatedAt: plan.updatedAt,
		}).expect(200);
		expect(res.body.data).toMatchObject({
			targetAmount: "12000.0000",
			allocatedAmount: "2000.0000", // 调高目标分配不动
			gap: "10000.0000",
		});
		expect(res.body.data.installments).toHaveLength(3);
		expect(res.body.data.installments[0].scheduledAt).toBe(PLAN_START_DATE);
		// 分批总额 = 12000 − 0 − 2000 = 10000
		expect(res.body.data.installments[2].amount).toBe("3333.3400");
		expect(res.body.data.changeLogs[0]).toMatchObject({
			changeType: "TARGET_ADJUSTED",
			beforeTarget: "10000.0000",
			afterTarget: "12000.0000",
			releasedAmount: "0.0000",
		});
	}, 20000);

	it("#26 PATCH 目标 < 已用：400 附 used 与差额（例 08）", async () => {
		const user = await newUser("plan-m5-adj3");
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "6000",
			usedAmount: "4000",
		});
		const detail = await getDetail(user, planId).expect(200);
		const res = await patchPlan(user, planId, {
			newTargetAmount: "3000",
			expectedUpdatedAt: detail.body.data.updatedAt,
		}).expect(400);
		expect(res.body.code).toBe("PLAN_TARGET_BELOW_USED");
		expect(res.body.data).toEqual({
			used: "4000.0000",
			shortfall: "1000.0000",
		});
		// 拦截不落库：updatedAt 未动，同一 expected 仍可用（后续用例 #27 续用该 plan）
	});

	it("#27 PATCH 新分配 < 已用：400 附差额；== used 边界合法（安全 #1）", async () => {
		const user = await newUser("plan-m5-adj3");
		// 复用 #26 的用户不行（vitest 各 it 独立建用户成本低）：重新造同构数据
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "6000",
			usedAmount: "4000",
		});
		const detail = await getDetail(user, planId).expect(200);
		const below = await patchPlan(user, planId, {
			newAllocAmount: "3000",
			expectedUpdatedAt: detail.body.data.updatedAt,
		}).expect(400);
		expect(below.body.code).toBe("PLAN_ALLOCATION_BELOW_USED");
		expect(below.body.data).toEqual({
			used: "4000.0000",
			shortfall: "1000.0000",
		});

		// 400 不落库 → updatedAt 不变，同一 expected 直接提交边界值 4000 == used
		const ok = await patchPlan(user, planId, {
			newAllocAmount: "4000",
			expectedUpdatedAt: detail.body.data.updatedAt,
		}).expect(200);
		expect(ok.body.data).toMatchObject({
			allocatedAmount: "4000.0000",
			remainingAllocation: "0.0000", // 全部已用沉淀，承认边界
			gap: "6000.0000",
		});
		expect(ok.body.data.changeLogs[0]).toMatchObject({
			changeType: "ALLOCATION_ADJUSTED",
			beforeAlloc: "6000.0000",
			afterAlloc: "4000.0000",
			releasedAmount: "2000.0000",
		});
	});

	it("#28 PATCH 超上限：400 PLAN_ALLOCATION_LIMIT 附最新 caps（不截断输入）", async () => {
		const user = await newUser("plan-m5-adj4");
		await ensureAccount(ctx.prisma, user.userId, "USD", "10000");
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "2000",
		});
		// 同币种他计划挤占未分配余额（恒等式同币种口径）
		await seedPlan(user.userId, {
			targetAmount: "50000",
			allocatedAmount: "3000",
		});
		const detail = await getDetail(user, planId).expect(200);
		// 上限 = min(还需使用 10000, 未分配 5000 + 原分配 2000) = 7000；输入 7000.0001
		const res = await patchPlan(user, planId, {
			newAllocAmount: "7000.0001",
			expectedUpdatedAt: detail.body.data.updatedAt,
		}).expect(400);
		expect(res.body.code).toBe("PLAN_ALLOCATION_LIMIT");
		expect(res.body.data.caps).toEqual({
			limit: "7000.0000",
			unallocatedBalance: "5000.0000",
			stillNeeded: "10000.0000",
		});
	});

	it("#29 PATCH expectedUpdatedAt 过期：409 PLAN_STATE_CHANGED", async () => {
		const user = await newUser("plan-m5-adj5");
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "2000",
		});
		const detail = await getDetail(user, planId).expect(200);
		// 提交前本计划被另写一次（prepLeadDays 3 → 5，updatedAt 跳变）
		await ctx.prisma.plan.update({
			where: { id: planId },
			data: { prepLeadDays: 5 },
		});
		const res = await patchPlan(user, planId, {
			prepLeadDays: 4,
			expectedUpdatedAt: detail.body.data.updatedAt,
		}).expect(409);
		expect(res.body.code).toBe("PLAN_STATE_CHANGED");
		// 直改生效、过期 PATCH 未叠加生效
		const after = await ctx.prisma.plan.findUnique({ where: { id: planId } });
		expect(after?.prepLeadDays).toBe(5);
	});

	it("#30 COMPLETED 修改 409 / reopen 缺确认 400 / 带分配参数 400 / 带确认 → ACTIVE + REOPENED", async () => {
		const user = await newUser("plan-m5-adj6");
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "10000",
			usedAmount: "10000", // 严格完成态
		});
		const ready = await getDetail(user, planId).expect(200);
		expect(ready.body.data.canComplete).toBe(true);
		expect(ready.body.data.canReopen).toBe(false);

		await postComplete(user, planId).expect(200);
		const done = await getDetail(user, planId).expect(200);
		expect(done.body.data.canModify).toBe(false);
		expect(done.body.data.canReopen).toBe(true);
		const expected = done.body.data.updatedAt;

		// COMPLETED 非「调高目标重开」：409
		const nonReopen = await patchPlan(user, planId, {
			prepLeadDays: 5,
			expectedUpdatedAt: expected,
		}).expect(409);
		expect(nonReopen.body.code).toBe("PLAN_INVALID_TRANSITION");

		// reopen 缺 confirmReopen：400
		const noConfirm = await patchPlan(user, planId, {
			newTargetAmount: "12000",
			expectedUpdatedAt: expected,
		}).expect(400);
		expect(noConfirm.body.code).toBe("INVALID_PLAN_PARAMS");

		// 重开携带分配参数：400（重开只改目标，分配与节奏不动）
		const withAlloc = await patchPlan(user, planId, {
			newTargetAmount: "12000",
			confirmReopen: true,
			newAllocAmount: "5000",
			expectedUpdatedAt: expected,
		}).expect(400);
		expect(withAlloc.body.code).toBe("INVALID_PLAN_PARAMS");

		// 带确认：ACTIVE + REOPENED 记录，分配不动，新增部分体现为缺口
		const ok = await patchPlan(user, planId, {
			newTargetAmount: "12000",
			confirmReopen: true,
			expectedUpdatedAt: expected,
		}).expect(200);
		expect(ok.body.data).toMatchObject({
			status: "ACTIVE",
			targetAmount: "12000.0000",
			allocatedAmount: "10000.0000", // 分配不动（已用沉淀）
			usedAmount: "10000.0000",
			remainingAllocation: "0.0000",
			gap: "2000.0000", // 新增部分为缺口（《06》例 14）
			canModify: true,
			canReopen: false,
		});
		expect(ok.body.data.installments).toHaveLength(3); // 缺口 2000 → 重建排期
		expect(ok.body.data.changeLogs[0]).toMatchObject({
			changeType: "REOPENED",
			beforeTarget: "10000.0000",
			afterTarget: "12000.0000",
			releasedAmount: "0.0000",
		});
	}, 20000);

	it("#31 PATCH 事务内排期失败：NO_AVAILABLE_DATES 全回滚（计划/分配/日志零改动）", async () => {
		const user = await newUser("plan-m5-adj7");
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "0",
		});
		const before = await getDetail(user, planId).expect(200);
		const beforePlan = await ctx.prisma.plan.findUnique({
			where: { id: planId },
		});

		// 2030-03-02（周六）起始、最晚准备日 2030-02-14 < 起始日 → 无可安排工作日
		const res = await patchPlan(user, planId, {
			prepLeadDays: 1,
			startDate: "2030-03-02T00:00:00.000Z",
			expectedUpdatedAt: before.body.data.updatedAt,
		}).expect(400);
		expect(res.body.code).toBe("NO_AVAILABLE_DATES");

		// 全回滚：目标/节奏/缓冲/updatedAt/变更记录均未动
		const afterPlan = await ctx.prisma.plan.findUnique({
			where: { id: planId },
		});
		expect(afterPlan?.targetAmount.toFixed(4)).toBe("10000.0000");
		expect(afterPlan?.prepLeadDays).toBe(beforePlan?.prepLeadDays);
		expect(afterPlan?.pacePreference).toBe(beforePlan?.pacePreference);
		expect(afterPlan?.updatedAt.getTime()).toBe(
			beforePlan?.updatedAt.getTime(),
		);
		expect(await ctx.prisma.planChangeLog.count({ where: { planId } })).toBe(0);
		expect(await ctx.prisma.planInstallment.count({ where: { planId } })).toBe(
			0,
		);
	});

	it("#32 PATCH 仅改节奏：重建后第一批 = 原开始日（planStartDate 基准，不漂移到明天）", async () => {
		const user = await newUser("plan-m5-adj8");
		const plan = await newPlan(user, {
			targetAmount: "10000",
			allocatedAmount: "2000",
		});
		const res = await patchPlan(user, plan.id, {
			pacePreference: "aggressive",
			expectedUpdatedAt: plan.updatedAt,
		}).expect(200);
		// gap 8000 重建：earliest 取落库的 planStartDate（非「明天起首个工作日」）
		expect(res.body.data.installments).toHaveLength(3);
		expect(res.body.data.installments[0].scheduledAt).toBe(PLAN_START_DATE);
		expect(res.body.data.installments[2].scheduledAt).toBe(LATEST_PREP_DATE);
		// aggressive 20/30/50
		expect(
			res.body.data.installments.map((item: { amount: string }) => item.amount),
		).toEqual(["1600.0000", "2400.0000", "4000.0000"]);
		const row = await ctx.prisma.plan.findUnique({ where: { id: plan.id } });
		expect(row?.planStartDate?.toISOString()).toBe(PLAN_START_DATE); // 基准已落库
		// 节奏-only 变更 → PARAMS_ADJUSTED（主类型枚举无归属，快照承载明细）
		expect(res.body.data.changeLogs[0].changeType).toBe("PARAMS_ADJUSTED");
	}, 20000);

	it("#33 changeLog 快照含节奏/缓冲变更 + 最晚准备日重算", async () => {
		const user = await newUser("plan-m5-adj8");
		const plan = await newPlan(user, {
			targetAmount: "10000",
			allocatedAmount: "2000",
		});
		await patchPlan(user, plan.id, {
			pacePreference: "aggressive",
			expectedUpdatedAt: plan.updatedAt,
		}).expect(200);
		const mid = await getDetail(user, plan.id).expect(200);

		const res = await patchPlan(user, plan.id, {
			pacePreference: "conservative",
			prepLeadDays: 5,
			expectedUpdatedAt: mid.body.data.updatedAt,
		}).expect(200);
		const log = res.body.data.changeLogs[0];
		expect(log.changeType).toBe("PARAMS_ADJUSTED");
		expect(log.beforeSnapshot).toMatchObject({
			pacePreference: "aggressive",
			prepLeadDays: 3,
			planStartDate: PLAN_START_DATE,
			targetAmount: "10000.0000",
			status: "ACTIVE",
		});
		expect(log.afterSnapshot).toMatchObject({
			pacePreference: "conservative",
			prepLeadDays: 5,
			planStartDate: PLAN_START_DATE,
		});
		// 准备缓冲 3 → 5：最晚准备日 2030-02-12 → 2030-02-08，排期末批随之重算
		expect(res.body.data.latestPrepDate).toBe("2030-02-08T00:00:00.000Z");
		expect(res.body.data.installments[2].scheduledAt).toBe(
			"2030-02-08T00:00:00.000Z",
		);
		// conservative 50/30/20
		expect(res.body.data.installments[0].amount).toBe("4000.0000");
	}, 20000);

	it("#34 complete 未达标：400 PLAN_COMPLETE_NOT_READY 附差值，状态不变", async () => {
		const user = await newUser("plan-m5-cmp1");
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "0",
		});
		const res = await postComplete(user, planId).expect(400);
		expect(res.body.code).toBe("PLAN_COMPLETE_NOT_READY");
		expect(res.body.data).toMatchObject({
			targetAmount: "10000.0000",
			usedAmount: "0.0000",
			remainingAllocation: "0.0000",
			targetShortfall: "10000.0000",
		});
		const row = await ctx.prisma.plan.findUnique({ where: { id: planId } });
		expect(row?.status).toBe("ACTIVE"); // 回滚：状态未变
		expect(await ctx.prisma.planChangeLog.count({ where: { planId } })).toBe(0);
	});

	it("#35 complete 达标：COMPLETED + 记录 + 数据不变；重复 409", async () => {
		const user = await newUser("plan-m5-cmp2");
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "10000",
			usedAmount: "10000",
		});
		const res = await postComplete(user, planId).expect(200);
		expect(res.body.data).toMatchObject({
			status: "COMPLETED",
			targetAmount: "10000.0000",
			allocatedAmount: "10000.0000", // 数据不变
			remainingAllocation: "0.0000",
			gap: "0.0000",
			canModify: false,
			canCancel: false,
			canComplete: false,
			canReopen: true,
		});
		expect(res.body.data.changeLogs[0]).toMatchObject({
			changeType: "COMPLETED",
			beforeTarget: "10000.0000",
			afterTarget: "10000.0000",
			beforeAlloc: "10000.0000",
			afterAlloc: "10000.0000",
			releasedAmount: "0.0000",
		});
		const allocation = await ctx.prisma.planAllocation.findUnique({
			where: { planId },
		});
		expect(allocation?.amount.toFixed(4)).toBe("10000.0000");

		// 重复完成：409（条件更新 WHERE status=ACTIVE 命中 0 行）
		const again = await postComplete(user, planId).expect(409);
		expect(again.body.code).toBe("PLAN_INVALID_TRANSITION");
		expect(await ctx.prisma.planChangeLog.count({ where: { planId } })).toBe(1);
	}, 20000);

	it("#36 complete 超用（used > alloc）：400 拒绝完成，防带病完成", async () => {
		const user = await newUser("plan-m5-cmp3");
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "4000",
			usedAmount: "5000",
		});
		const res = await postComplete(user, planId).expect(400);
		expect(res.body.code).toBe("PLAN_COMPLETE_NOT_READY");
		expect(res.body.message).toContain("超用");
		expect(res.body.data.overused).toBe("1000.0000");
		const row = await ctx.prisma.plan.findUnique({ where: { id: planId } });
		expect(row?.status).toBe("ACTIVE");
	});

	it("#37 cancel：释放剩余 / amount→used / 余额不动 / caps 回收", async () => {
		const user = await newUser("plan-m5-cnc");
		await ensureAccount(ctx.prisma, user.userId, "USD", "10000");
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "6000",
			usedAmount: "4000",
		});
		// 取消前：剩余分配 2000 → 未分配 8000
		expect(await previewCaps(user)).toBe("8000.0000");

		const res = await postCancel(user, planId).expect(200);
		expect(res.body.data).toMatchObject({
			status: "CANCELLED",
			allocatedAmount: "4000.0000", // amount → max(used, 0)，已用沉淀不恢复
			usedAmount: "4000.0000",
			remainingAllocation: "0.0000",
			installments: [],
			canModify: false,
			canCancel: false,
		});
		expect(res.body.data.changeLogs[0]).toMatchObject({
			changeType: "CANCELLED",
			beforeAlloc: "6000.0000",
			afterAlloc: "4000.0000",
			releasedAmount: "2000.0000",
		});
		// 账户余额与真实记录不动；释放后未分配余额回升至全额
		const account = await ctx.prisma.account.findUnique({
			where: {
				userId_currencyCode: { userId: user.userId, currencyCode: "USD" },
			},
		});
		expect(account?.balance.toFixed(4)).toBe("10000.0000");
		expect(await previewCaps(user)).toBe("10000.0000");
		expect(await ctx.prisma.planInstallment.count({ where: { planId } })).toBe(
			0,
		);
	}, 20000);

	it("#38 cancel 重复：409 PLAN_INVALID_TRANSITION", async () => {
		const user = await newUser("plan-m5-cnc2");
		const planId = await seedPlan(user.userId, { allocatedAmount: "0" });
		await postCancel(user, planId).expect(200);
		const again = await postCancel(user, planId).expect(409);
		expect(again.body.code).toBe("PLAN_INVALID_TRANSITION");
	});

	it("#39 并发：交错 cancel+complete 恰一成功（READ COMMITTED 重估 WHERE），changeLog 无矛盾记录", async () => {
		const user = await newUser("plan-m5-conc");
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "10000",
			usedAmount: "10000", // complete 可达标准
		});

		// A：手工交互式事务——先读（status=ACTIVE，快照读不加锁）后暂停
		let releaseA!: () => void;
		const gate = new Promise<void>((resolve) => (releaseA = resolve));
		let started = false;
		const attemptA = ctx.prisma
			.$transaction(async (tx) => {
				started = true;
				await tx.plan.findFirst({
					where: { id: planId, userId: user.userId },
				});
				await gate; // A 暂停：B 可完整提交
				// A 恢复：条件更新基于最新已提交行重估 WHERE status=ACTIVE
				const updated = await tx.plan.updateMany({
					where: { id: planId, userId: user.userId, status: "ACTIVE" },
					data: { status: "COMPLETED" },
				});
				if (updated.count === 0) {
					throw new Error("PLAN_INVALID_TRANSITION");
				}
				return "COMPLETED";
			})
			.then(() => "COMPLETED" as const)
			.catch((error: unknown) =>
				error instanceof Error ? error.message : "UNKNOWN",
			);
		while (!started) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		// B：cancel 经接口完整提交（A 的快照读不加锁，不阻塞 B）
		await postCancel(user, planId).expect(200);
		releaseA();

		// 恰一成功：B 成功，A 重估后 409 语义
		expect(await attemptA).toBe("PLAN_INVALID_TRANSITION");
		const logs = await ctx.prisma.planChangeLog.findMany({
			where: { planId },
		});
		expect(logs.map((log) => log.changeType)).toEqual(["CANCELLED"]); // 无矛盾记录
		const row = await ctx.prisma.plan.findUnique({ where: { id: planId } });
		expect(row?.status).toBe("CANCELLED");
	}, 20000);

	it("#40 并发双 PATCH 同 expectedUpdatedAt：恰一成功，另一 409", async () => {
		const user = await newUser("plan-m5-conc2");
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "2000",
		});
		const detail = await getDetail(user, planId).expect(200);
		const expected = detail.body.data.updatedAt;

		const first = await patchPlan(user, planId, {
			prepLeadDays: 4,
			expectedUpdatedAt: expected,
		}).expect(200);
		// 第二个请求持同一 expected：乐观锁失配 409
		const second = await patchPlan(user, planId, {
			prepLeadDays: 6,
			expectedUpdatedAt: expected,
		}).expect(409);
		expect(second.body.code).toBe("PLAN_STATE_CHANGED");
		expect(first.body.data.prepLeadDays).toBe(4); // 仅第一个生效
	});

	it("#41 链路 a：preview → 直改他计划收紧余额（本计划 updatedAt 不变）→ PATCH 400 附最新 caps（预览未被采信）", async () => {
		const user = await newUser("plan-m5-chain");
		await ensureAccount(ctx.prisma, user.userId, "USD", "10000");
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "2000",
		});
		const otherId = await seedPlan(user.userId, {
			targetAmount: "50000",
			allocatedAmount: "1000",
		});
		const detail = await getDetail(user, planId).expect(200);

		// 预览：newAlloc 9000 合法（未分配 7000 + 原分配 2000 = 上限 9000）
		const pv = await postAdjustPreview(user, planId, {
			newAllocAmount: "9000",
		}).expect(200);
		expect(pv.body.data.valid).toBe(true);
		expect(pv.body.data.caps).toEqual({
			limit: "9000.0000",
			unallocatedBalance: "7000.0000",
			stillNeeded: "10000.0000",
		});

		// 直改他计划 allocation 收紧余额：本计划 updatedAt 不动（乐观锁测不到）
		await ctx.prisma.planAllocation.update({
			where: { planId: otherId },
			data: { amount: "3000" },
		});
		const stillSame = await getDetail(user, planId).expect(200);
		expect(stillSame.body.data.updatedAt).toBe(detail.body.data.updatedAt);

		// PATCH：乐观锁通过，但事务内重算拦截（最新 caps：未分配 5000，上限 7000）
		const res = await patchPlan(user, planId, {
			newAllocAmount: "9000",
			expectedUpdatedAt: detail.body.data.updatedAt,
		}).expect(400);
		expect(res.body.code).toBe("PLAN_ALLOCATION_LIMIT");
		expect(res.body.data.caps).toEqual({
			limit: "7000.0000",
			unallocatedBalance: "5000.0000",
			stillNeeded: "10000.0000",
		});
		// 证明预览结果未被采信：分配未写入
		const allocation = await ctx.prisma.planAllocation.findUnique({
			where: { planId },
		});
		expect(allocation?.amount.toFixed(4)).toBe("2000.0000");
	}, 20000);

	it("#42 链路 b：preview → 本计划被再写一次 → 旧 expected 409 → 重新预览后提交成功（端到端重放）", async () => {
		const user = await newUser("plan-m5-chain2");
		const planId = await seedPlan(user.userId, {
			targetAmount: "10000",
			allocatedAmount: "0",
		});
		const first = await getDetail(user, planId).expect(200);

		await postAdjustPreview(user, planId, {
			newTargetAmount: "12000",
		}).expect(200);
		// 提交前对本计划再写一次（prepLeadDays 3 → 4，updatedAt 跳变）
		await patchPlan(user, planId, {
			prepLeadDays: 4,
			expectedUpdatedAt: first.body.data.updatedAt,
		}).expect(200);

		// 用预览时的旧 expected 提交 → 409
		const stale = await patchPlan(user, planId, {
			newTargetAmount: "12000",
			expectedUpdatedAt: first.body.data.updatedAt,
		}).expect(409);
		expect(stale.body.code).toBe("PLAN_STATE_CHANGED");

		// 重新预览 → 用最新 expected 提交成功
		await postAdjustPreview(user, planId, {
			newTargetAmount: "12000",
		}).expect(200);
		const latest = await getDetail(user, planId).expect(200);
		const ok = await patchPlan(user, planId, {
			newTargetAmount: "12000",
			expectedUpdatedAt: latest.body.data.updatedAt,
		}).expect(200);
		expect(ok.body.data).toMatchObject({
			targetAmount: "12000.0000",
			prepLeadDays: 4, // 前一次生效的参数保留
			gap: "12000.0000",
		});
	}, 20000);
});
