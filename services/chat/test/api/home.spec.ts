import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { ThrottlerStorage } from "@nestjs/throttler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import {
	cleanupUser,
	createTestApp,
	createTestUser,
	orgBearer,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";

/**
 * 接口测试 ↔ src/home/home.controller.ts
 * 首页状态查询（home-state-routing 方案 §6.1）：分流三布尔 + 摘要 + 最新汇率观测时间。
 * 场景编号与方案 §6.1 表格一一对应（#1 ~ #10）。
 *
 * 造数说明：直接用 PrismaService 造 UserSettings / Account / Plan / PlanAllocation /
 * ExchangeRate（方案 §6.1 约定）；PlanAllocation 无 user 关系（不随用户级联删除）、
 * ExchangeRate 全表共享，均在 afterAll 精确清理（专属标识 source="home-test"）。
 */

/** 测试专属汇率行标识（与 rate/prisma 等其他测试的数据隔离） */
const HOME_RATE_SOURCE = "home-test";

/** 固定时点（毫秒精度，ISO 断言可精确比对） */
const EXPECT_USE_DATE = new Date("2026-10-01T00:00:00.000Z");
const LATEST_PREP_DATE = new Date("2026-09-28T00:00:00.000Z");
const FUTURE_OBSERVED_AT = new Date("2030-01-01T00:00:00.000Z");

describe("HomeController（e2e）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let user: TestUser; // 用户 A：主测试用户，数据随场景递进
	let other: TestUser; // 用户 B：数据隔离场景用

	/** 本测试创建的分配记录 ID（PlanAllocation 不随用户级联，需精确清理） */
	const allocationIds: string[] = [];

	beforeAll(async () => {
		// 单接口多场景高频请求（含幂等重复调用，10+ 次），替换 Throttler 存储使其永不超限，
		// 避免全局 60s/10 次限流 429；guard 逻辑保持真实，JwtAuthGuard 不受影响（401 场景照常验证）
		ctx = await createTestApp((builder) =>
			builder.overrideProvider(ThrottlerStorage).useValue({
				increment: async () => ({
					totalHits: 1,
					timeToExpire: 60_000,
					isBlocked: false,
					timeToBlockExpire: 0,
				}),
			}),
		);
		app = ctx.app;
		user = await createTestUser(app, "home-a");
		other = await createTestUser(app, "home-b");
	});

	afterAll(async () => {
		try {
			// PlanAllocation 无 Prisma relation（planId 裸外键），删除用户不级联，按记录的 ID 精确清理
			if (allocationIds.length > 0) {
				await ctx.prisma.planAllocation.deleteMany({
					where: { id: { in: allocationIds } },
				});
			}
			if (user) await cleanupUser(ctx.prisma, user.userId);
			if (other) await cleanupUser(ctx.prisma, other.userId);
			await ctx.prisma.exchangeRate.deleteMany({
				where: { source: HOME_RATE_SOURCE },
			});
		} finally {
			await app?.close();
		}
	});

	it("#1 未携带 token 访问应该 401", () => {
		return request(app.getHttpServer()).get("/api/home/state").expect(401);
	});

	it("#2 新注册用户（无设置/账户/计划）应该三布尔全 false、列表全空", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(orgBearer(user))
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.message).toBe("首页状态查询成功");
		expect(res.body.data).toMatchObject({
			onboardingCompleted: false,
			hasAccounts: false,
			hasPlans: false,
			accounts: [],
			plans: [],
		});
	});

	it("#9 库中无汇率记录时 latestRateObservedAt 应该为 null", async () => {
		// 备份全表 → 清空 → 断言 null → 原样恢复（窗口最小化；
		// rate/prisma 等其他 spec 亦共享此表，恢复保证不污染）
		const backup = await ctx.prisma.exchangeRate.findMany();
		await ctx.prisma.exchangeRate.deleteMany();
		try {
			const res = await request(app.getHttpServer())
				.get("/api/home/state")
				.set(orgBearer(user))
				.expect(200);
			expect(res.body.data.latestRateObservedAt).toBeNull();
		} finally {
			if (backup.length > 0) {
				await ctx.prisma.exchangeRate.createMany({ data: backup });
			}
		}
	});

	it("#3 完成首次设置但跳过外币、无计划：仅 onboardingCompleted=true", async () => {
		await ctx.prisma.userSettings.create({
			data: {
				userId: user.userId,
				locale: "zh-CN",
				region: "CN",
			},
		});
		await ctx.prisma.organizationSettings.create({
			data: {
				organizationId: user.defaultOrganizationId,
				baseCurrency: "CNY",
			},
		});

		const res = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(orgBearer(user))
			.expect(200);

		expect(res.body.data).toMatchObject({
			onboardingCompleted: true,
			hasAccounts: false,
			hasPlans: false,
			accounts: [],
			plans: [],
		});
	});

	it("#4 有 1 个账户、无计划：hasAccounts=true，balance 为 4 位小数字符串", async () => {
		await ctx.prisma.account.create({
			data: {
				organizationId: user.defaultOrganizationId,
				createdById: user.userId,
				currencyCode: "USD",
				balance: "1500.0000",
			},
		});

		const res = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(orgBearer(user))
			.expect(200);

		expect(res.body.data.hasAccounts).toBe(true);
		expect(res.body.data.hasPlans).toBe(false);
		expect(res.body.data.accounts).toEqual([
			{ currencyCode: "USD", balance: "1500.0000" },
		]);
	});

	it("#5 有 1 个计划（有分配）：hasPlans=true，remainingAmount = amount − usedAmount", async () => {
		const plan = await ctx.prisma.plan.create({
			data: {
				organizationId: user.defaultOrganizationId,
				createdById: user.userId,
				targetCurrency: "USD",
				targetAmount: "10000.0000",
				expectUseDate: EXPECT_USE_DATE,
				latestPrepDate: LATEST_PREP_DATE,
			},
		});
		const allocation = await ctx.prisma.planAllocation.create({
			data: {
				planId: plan.id,
				amount: "4000.0000",
				usedAmount: "1000.0000",
			},
		});
		allocationIds.push(allocation.id);

		const res = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(orgBearer(user))
			.expect(200);

		expect(res.body.data.hasPlans).toBe(true);
		expect(res.body.data.plans).toHaveLength(1);
		const planSummary = res.body.data.plans[0];
		expect(planSummary).toMatchObject({
			id: plan.id,
			targetCurrency: "USD",
			targetAmount: "10000.0000",
			allocatedAmount: "4000.0000",
			remainingAmount: "3000.0000",
			expectUseDate: "2026-10-01T00:00:00.000Z",
			latestPrepDate: "2026-09-28T00:00:00.000Z",
			status: "ACTIVE",
		});
	});

	it("#6 有 1 个计划（无分配记录）：allocatedAmount / remainingAmount 均为 0.0000", async () => {
		const plan = await ctx.prisma.plan.create({
			data: {
				organizationId: user.defaultOrganizationId,
				createdById: user.userId,
				targetCurrency: "JPY",
				targetAmount: "120000.0000",
				expectUseDate: EXPECT_USE_DATE,
				latestPrepDate: LATEST_PREP_DATE,
			},
		});

		const res = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(orgBearer(user))
			.expect(200);

		// createdAt 降序：后创建的 JPY 计划在前
		expect(res.body.data.plans).toHaveLength(2);
		expect(res.body.data.plans[0]).toMatchObject({
			id: plan.id,
			targetCurrency: "JPY",
			targetAmount: "120000.0000",
			allocatedAmount: "0.0000",
			remainingAmount: "0.0000",
			status: "ACTIVE",
		});
	});

	it("#7 数据隔离：用户 B 全空，用户 A 的数据不泄露", async () => {
		const resB = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(orgBearer(other))
			.expect(200);

		expect(resB.body.data).toMatchObject({
			onboardingCompleted: false,
			hasAccounts: false,
			hasPlans: false,
			accounts: [],
			plans: [],
		});

		// 同一时刻 A 的状态不受影响
		const resA = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(orgBearer(user))
			.expect(200);
		expect(resA.body.data.hasAccounts).toBe(true);
		expect(resA.body.data.hasPlans).toBe(true);
		expect(resA.body.data.accounts).toHaveLength(1);
		expect(resA.body.data.plans).toHaveLength(2);
	});

	it("#8 库中有汇率记录：返回全表最大 observed_at（ISO 8601）", async () => {
		await ctx.prisma.exchangeRate.create({
			data: {
				base: "USD",
				quote: "CNY",
				rate: "7.1200000000",
				source: HOME_RATE_SOURCE,
				observedAt: new Date("2026-09-20T01:00:00.000Z"),
			},
		});
		// 未来时点一行，保证无论表中有多少其他数据（含并行测试写入），它恒为全表最大
		await ctx.prisma.exchangeRate.create({
			data: {
				base: "USD",
				quote: "CNY",
				rate: "7.1500000000",
				source: HOME_RATE_SOURCE,
				observedAt: FUTURE_OBSERVED_AT,
			},
		});

		const res = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(orgBearer(user))
			.expect(200);

		expect(res.body.data.latestRateObservedAt).toBe("2030-01-01T00:00:00.000Z");
	});

	it("#10 重复调用（幂等）：两次结果一致，无副作用", async () => {
		const first = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(orgBearer(user))
			.expect(200);
		const second = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(orgBearer(user))
			.expect(200);

		expect(second.body.data).toEqual(first.body.data);
		// 幂等的落库证据：测试造的数据量不变（无新增账户/计划/分配/汇率行）
		expect(
			await ctx.prisma.account.count({
				where: { organizationId: user.defaultOrganizationId },
			}),
		).toBe(1);
		expect(
			await ctx.prisma.plan.count({
				where: { organizationId: user.defaultOrganizationId },
			}),
		).toBe(2);
		expect(
			await ctx.prisma.planAllocation.count({
				where: { id: { in: allocationIds } },
			}),
		).toBe(allocationIds.length);
	});

	// ── 以下 portfolio（契约 §2）：CostLot 聚合 + 本位币 ──
	// 造数说明：CostLot 随组织清理，cleanupUser 已覆盖；
	// 本组用例依赖前序场景已为 user 默认组织建 OrganizationSettings（baseCurrency=CNY）

	it("#11 portfolio 无任何 CostLot：totalRemainingCost=0.0000、byCurrency=[]，baseCurrency 取自设置", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/home/portfolio")
			.set(orgBearer(user))
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.message).toBe("持仓聚合查询成功");
		expect(res.body.data).toEqual({
			baseCurrency: "CNY",
			totalRemainingCost: "0.0000",
			byCurrency: [],
		});
	});

	it("#12 portfolio 多币种 CostLot：同币种多条聚合、部分消耗按 remainingQty、耗尽 lot 排除、按币种升序", async () => {
		const acquiredAt = new Date("2026-08-01T00:00:00.000Z");
		// USD 两条（lot1 部分消耗：quantity 1000 → remainingQty 600）
		await ctx.prisma.costLot.create({
			data: {
				organizationId: user.defaultOrganizationId,
				currencyCode: "USD",
				sourceType: "INITIAL",
				sourceId: "home-test-usd-1",
				quantity: "1000.0000",
				remainingQty: "600.0000",
				unitCost: "7.2500000000",
				totalCost: "4350.0000",
				acquiredAt,
			},
		});
		await ctx.prisma.costLot.create({
			data: {
				organizationId: user.defaultOrganizationId,
				currencyCode: "USD",
				sourceType: "PURCHASE",
				sourceId: "home-test-usd-2",
				quantity: "500.0000",
				remainingQty: "500.0000",
				unitCost: "7.5000000000",
				totalCost: "3750.0000",
				acquiredAt,
			},
		});
		// JPY 一条；CAD 一条已耗尽（remainingQty=0，应排除）
		await ctx.prisma.costLot.create({
			data: {
				organizationId: user.defaultOrganizationId,
				currencyCode: "JPY",
				sourceType: "INITIAL",
				sourceId: "home-test-jpy-1",
				quantity: "10000.0000",
				remainingQty: "10000.0000",
				unitCost: "0.0470000000",
				totalCost: "470.0000",
				acquiredAt,
			},
		});
		await ctx.prisma.costLot.create({
			data: {
				organizationId: user.defaultOrganizationId,
				currencyCode: "CAD",
				sourceType: "INITIAL",
				sourceId: "home-test-cad-1",
				quantity: "100.0000",
				remainingQty: "0.0000",
				unitCost: "5.1000000000",
				totalCost: "510.0000",
				acquiredAt,
			},
		});

		const res = await request(app.getHttpServer())
			.get("/api/home/portfolio")
			.set(orgBearer(user))
			.expect(200);

		// USD：ΣremainingQty=1100、Σ成本=4350+3750=8100、均值=8100/1100=7.3636363636…（toFixed(10)）
		// JPY：0.047 → 10 位小数补零；CAD 已耗尽不出现；币种升序 JPY < USD
		expect(res.body.data).toEqual({
			baseCurrency: "CNY",
			totalRemainingCost: "8570.0000",
			byCurrency: [
				{
					currencyCode: "JPY",
					remainingQty: "10000.0000",
					totalRemainingCost: "470.0000",
					avgUnitCost: "0.0470000000",
				},
				{
					currencyCode: "USD",
					remainingQty: "1100.0000",
					totalRemainingCost: "8100.0000",
					avgUnitCost: "7.3636363636",
				},
			],
		});
	});

	it("#13 portfolio 无 OrganizationSettings：baseCurrency=null，聚合仍正常返回", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/home/portfolio")
			.set(orgBearer(other))
			.expect(200);

		expect(res.body.data.baseCurrency).toBeNull();
		expect(res.body.data.totalRemainingCost).toBe("0.0000");
		expect(res.body.data.byCurrency).toEqual([]);
	});

	it("#14 portfolio 未携带 token 访问应该 401", () => {
		return request(app.getHttpServer()).get("/api/home/portfolio").expect(401);
	});
});
