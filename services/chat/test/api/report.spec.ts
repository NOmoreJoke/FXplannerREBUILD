/**
 * 报告接口测试（reports 技术方案 §10.2）：GET /api/reports/plans、GET /api/reports/plans/:id。
 *
 * M7/M8 未上线不阻塞——分摊事实经 report-test-helper 直插 DB（方案 §10 前言）。
 * 覆盖：401 守卫、空列表、状态/币种过滤、非法参数 400 INVALID_REPORT_PARAMS、
 * 越权/不存在 404 PLAN_NOT_FOUND、种子数据逐字段断言（§4.3 示例数值）、
 * { success, data, message } 包装与 OpenAPI schema 注册。
 */
import type { INestApplication } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSwaggerConfig } from "../../src/config/swagger";
import {
	cleanupUser,
	createTestApp,
	createTestUser,
	orgBearer,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";
import {
	ensureSettings,
	seedCostLot,
	seedUsage,
} from "../helpers/report-test-helper";
import {
	cleanupOrgLedgers,
	createOrgLedger,
	orgHeaders,
	type OrgLedger,
} from "../helpers/organization-ledger-test-helper";
import {
	cleanupPlanData,
	seedPlanWithAllocation,
} from "../helpers/plan-test-helper";
import { ensureOnboarded } from "../helpers/onboarding-helper";

// 关闭全局接口限流（同 plan.spec：APP_GUARD token 被 scanner 改写，只能 mock 类）
vi.mock("@nestjs/throttler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nestjs/throttler")>();
	class NoopThrottlerGuard {
		async canActivate() {
			return true;
		}
	}
	return { ...actual, ThrottlerGuard: NoopThrottlerGuard };
});

describe("ReportController（接口）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let userSeeded: TestUser; // 种子用户：2 计划（USD 有使用 / JPY 无使用）
	let userOther: TestUser; // 全新用户（无计划无 settings）
	let userForeign: TestUser; // 越权探测用户
	let seededPlanId: string; // USD 计划（doc 15 FIFO 例分摊）
	let jpyPlanId: string; // JPY 计划（无使用）
	const userIds: string[] = [];
	const planIds: string[] = [];

	function getPlans(user: TestUser, query = "") {
		return request(app.getHttpServer())
			.get(`/api/reports/plans${query}`)
			.set(orgBearer(user));
	}

	function getDetail(user: TestUser, planId: string) {
		return request(app.getHttpServer())
			.get(`/api/reports/plans/${planId}`)
			.set(orgBearer(user));
	}

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		userSeeded = await createTestUser(app, "rpt-seeded");
		userOther = await createTestUser(app, "rpt-other");
		userForeign = await createTestUser(app, "rpt-foreign");
		userIds.push(userSeeded.userId, userOther.userId, userForeign.userId);
		await ensureSettings(ctx.prisma, userSeeded.userId, "CNY");

		// ── 种子（§4.3 doc 15 FIFO 例扩展）：USD 10,000 计划 ──
		// 批次 A：买入 1,000，本金 7,800 + 手续费 0（明确）→ unitCost 7.8
		// 批次 B：买入 1,000，本金 8,000，手续费未明确（NULL）→ unitCost 8.0
		// 初始批次：1,000，成本 7,000 → unitCost 7.0
		// 使用 u1：1,200 = A 1,000×7.8 (7,800) + B 200×8 (1,600)
		// 使用 u2：100 = 初始 100×7.0 (700)
		// 汇总：数量 1,300、成本 10,100、均价 10,100/1,300 = 7.76923077
		seededPlanId = await seedPlanWithAllocation(ctx.prisma, userSeeded.userId, {
			targetCurrency: "USD",
			targetAmount: "10000",
		});
		planIds.push(seededPlanId);
		const lotA = await seedCostLot(ctx.prisma, userSeeded.userId, "USD", {
			sourceType: "PURCHASE",
			quantity: "1000",
			principal: "7800",
			fee: "0",
		});
		const lotB = await seedCostLot(ctx.prisma, userSeeded.userId, "USD", {
			sourceType: "PURCHASE",
			quantity: "1000",
			principal: "8000",
			fee: null,
		});
		const lotInitial = await seedCostLot(ctx.prisma, userSeeded.userId, "USD", {
			sourceType: "INITIAL",
			quantity: "1000",
			principal: "7000",
		});
		await seedUsage(ctx.prisma, userSeeded.userId, {
			planId: seededPlanId,
			currencyCode: "USD",
			amount: "1200",
			allocations: [
				{ lotId: lotA.lotId, quantity: "1000", cost: "7800" },
				{ lotId: lotB.lotId, quantity: "200", cost: "1600" },
			],
		});
		// 使用 u2：100 来自同一初始批次（InitialHolding 每用户每币种唯一，
		// 一笔持仓一个批次；多次使用可重复消耗同一批次）
		await seedUsage(ctx.prisma, userSeeded.userId, {
			planId: seededPlanId,
			currencyCode: "USD",
			amount: "100",
			allocations: [{ lotId: lotInitial.lotId, quantity: "100", cost: "700" }],
		});

		// JPY 计划：无任何使用（M7 未上线基线形态）
		jpyPlanId = await seedPlanWithAllocation(ctx.prisma, userSeeded.userId, {
			targetCurrency: "JPY",
			targetAmount: "200000",
		});
		planIds.push(jpyPlanId);

		// 越权用户有一个同名形态的 USD 计划（仅供他人 id 枚举对照）
		const foreignPlanId = await seedPlanWithAllocation(
			ctx.prisma,
			userForeign.userId,
			{ targetCurrency: "USD", targetAmount: "500" },
		);
		planIds.push(foreignPlanId);
	});

	afterAll(async () => {
		try {
			await cleanupPlanData(ctx.prisma, planIds);
			for (const userId of userIds) {
				await cleanupUser(ctx.prisma, userId);
			}
		} finally {
			await app?.close();
		}
	});

	it("#1 未登录访问两个端点均 401（Controller 级守卫）", async () => {
		await request(app.getHttpServer()).get("/api/reports/plans").expect(401);
		await request(app.getHttpServer())
			.get("/api/reports/plans/00000000")
			.expect(401);
	});

	it("#2 新用户无计划：200 { baseCurrency: null, items: [] }", async () => {
		const res = await getPlans(userOther).expect(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data).toEqual({ baseCurrency: null, items: [] });
	});

	it("#3 列表：种子用户返回 2 计划（createdAt 倒序），字段与数值精确（doc 15 例）", async () => {
		const res = await getPlans(userSeeded).expect(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data.baseCurrency).toBe("CNY");
		const items = res.body.data.items as Record<string, unknown>[];
		expect(items).toHaveLength(2);
		// createdAt 倒序：JPY（后建）在前
		const [jpy, usd] = items;
		// JPY 计划：M7 未上线形态 —— 数量 0、成本/均价 null（尚未使用）
		expect(jpy.planId).toBe(jpyPlanId);
		expect(jpy.status).toBe("ACTIVE");
		expect(jpy.currencyCode).toBe("JPY");
		expect(jpy.targetAmount).toBe("200000.0000");
		expect(jpy.usedQuantity).toBe("0.0000");
		expect(jpy.usedTotalCost).toBeNull();
		expect(jpy.usedUnitCost).toBeNull();
		expect(jpy.hasUnknownFee).toBe(false);
		expect(jpy.updatedAt).toBeNull();
		// USD 计划：doc 15 FIFO 例扩展数值
		expect(usd.planId).toBe(seededPlanId);
		expect(usd.currencyCode).toBe("USD");
		expect(usd.targetAmount).toBe("10000.0000");
		expect(usd.usedQuantity).toBe("1300.0000");
		expect(usd.usedTotalCost).toBe("10100.0000");
		expect(usd.usedUnitCost).toBe("7.76923077"); // 10100/1300 → roundRateTo8
		expect(usd.hasUnknownFee).toBe(true); // 批次 B 手续费 NULL
		expect(typeof usd.updatedAt).toBe("string");
	});

	it("#4 状态过滤：status=ACTIVE 全量、status=COMPLETED 空集", async () => {
		const active = await getPlans(userSeeded, "?status=ACTIVE").expect(200);
		expect((active.body.data.items as unknown[]).length).toBe(2);
		const completed = await getPlans(userSeeded, "?status=COMPLETED").expect(
			200,
		);
		expect(completed.body.data.items).toEqual([]);
	});

	it("#5 币种过滤：currencyCode=usd 大小写不敏感仅 USD 计划", async () => {
		const res = await getPlans(userSeeded, "?currencyCode=usd").expect(200);
		const items = res.body.data.items as { currencyCode: string }[];
		expect(items).toHaveLength(1);
		expect(items[0].currencyCode).toBe("USD");
	});

	it("#6 非法参数：status=FOO / currencyCode=XYZ → 400 INVALID_REPORT_PARAMS", async () => {
		const badStatus = await getPlans(userSeeded, "?status=FOO").expect(400);
		expect(badStatus.body.code).toBe("INVALID_REPORT_PARAMS");
		const badCurrency = await getPlans(userSeeded, "?currencyCode=XYZ").expect(
			400,
		);
		expect(badCurrency.body.code).toBe("INVALID_REPORT_PARAMS");
	});

	it("#7 详情：种子计划逐字段断言（§4.3 数值 + 来源拆分 + 收益占位 + meta）", async () => {
		const res = await getDetail(userSeeded, seededPlanId).expect(200);
		expect(res.body.success).toBe(true);
		const data = res.body.data;
		// plan 基本信息
		expect(data.plan.id).toBe(seededPlanId);
		expect(data.plan.status).toBe("ACTIVE");
		expect(data.plan.currencyCode).toBe("USD");
		expect(data.plan.baseCurrency).toBe("CNY");
		expect(data.plan.targetAmount).toBe("10000.0000");
		expect(data.plan.usedQuantity).toBe("1300.0000");
		expect(data.plan.remainingToUseAmount).toBe("8700.0000");
		// cost
		expect(data.cost.usedTotalCost).toBe("10100.0000");
		expect(data.cost.usedUnitCost).toBe("7.76923077");
		expect(data.cost.hasUnknownFee).toBe(true);
		// 来源拆分
		expect(data.sourceSplit.initial).toEqual({
			quantity: "100.0000",
			cost: "700.0000",
		});
		expect(data.sourceSplit.purchase).toEqual({
			quantity: "1200.0000",
			cost: "9400.0000",
		});
		// 收益占位：含买入来源 → NOT_SUPPORTED_YET
		expect(data.yieldSection.displayType).toBe("NOT_SUPPORTED_YET");
		// meta
		expect(typeof data.meta.updatedAt).toBe("string");
		expect(new Date(data.meta.generatedAt).toString()).not.toBe("Invalid Date");
	});

	it("#8 详情：纯初始持仓计划 → 收益 INITIAL_ONLY_NO_COMPARISON（不显示 0%）", async () => {
		const planId = await seedPlanWithAllocation(ctx.prisma, userSeeded.userId, {
			targetCurrency: "CAD",
			targetAmount: "500",
		});
		planIds.push(planId);
		const lot = await seedCostLot(ctx.prisma, userSeeded.userId, "CAD", {
			sourceType: "INITIAL",
			quantity: "500",
			principal: "3500",
		});
		await seedUsage(ctx.prisma, userSeeded.userId, {
			planId,
			currencyCode: "CAD",
			amount: "500",
			allocations: [{ lotId: lot.lotId, quantity: "500", cost: "3500" }],
		});
		const res = await getDetail(userSeeded, planId).expect(200);
		expect(res.body.data.yieldSection.displayType).toBe(
			"INITIAL_ONLY_NO_COMPARISON",
		);
		expect(res.body.data.cost.hasUnknownFee).toBe(false);
		expect(res.body.data.plan.remainingToUseAmount).toBe("0.0000");
	});

	it("#9 越权/不存在：他人计划与随机 id 均 404 PLAN_NOT_FOUND（防枚举）", async () => {
		// userForeign 的计划 id 对 userSeeded 不可见：用 userSeeded 的 token 访问他人 id
		const foreignPlan = await ctx.prisma.plan.findFirst({
			where: { organizationId: userForeign.defaultOrganizationId },
		});
		const res = await getDetail(userSeeded, foreignPlan?.id ?? "x").expect(404);
		expect(res.body.code).toBe("PLAN_NOT_FOUND");
		const random = await getDetail(userSeeded, "nonexistent01").expect(404);
		expect(random.body.code).toBe("PLAN_NOT_FOUND");
	});

	it("#10 详情：非法 id 格式 → 400 INVALID_REPORT_PARAMS", async () => {
		const res = await getDetail(userSeeded, "短id").expect(400);
		expect(res.body.code).toBe("INVALID_REPORT_PARAMS");
	});

	it("#11 OpenAPI：两个端点注册且新 DTO 进入 components", () => {
		const document = SwaggerModule.createDocument(app, createSwaggerConfig());
		expect(document.paths["/api/reports/plans"]?.get).toBeDefined();
		expect(document.paths["/api/reports/plans/{id}"]?.get).toBeDefined();
		expect(document.components?.schemas?.["ReportPlanListDto"]).toBeDefined();
		expect(document.components?.schemas?.["PlanReportDto"]).toBeDefined();
		expect(
			document.components?.schemas?.["ReportSourceSplitDto"],
		).toBeDefined();
	});
});

/**
 * UI-P0③ 回归：plans 详情的 usedAmount（← plan_allocations.used_amount，增量维护）
 * 与 reports 的 usedQuantity（← Σ usage_records.amount，事实重算）必须一致。
 * 两源由 usage 写事务原子绑定（同事务扣分配 + 落记录），本组用例走全 API 链路
 * 锁住口径：录使用后两个读接口、单计划与列表四处同值，防未来漂移。
 */
describe("usedQuantity 双接口口径一致（UI-P0③ 回归）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let user: TestUser;
	let planId = "";
	const userIds: string[] = [];
	const planIds: string[] = [];

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		user = await createTestUser(app, "report-consistency");
		userIds.push(user.userId);
		await ensureOnboarded(ctx.prisma, user.userId);

		// 全 API 链路：买入 10,000 @1 → 建计划（分配 2,000）→ 录使用 500
		await request(app.getHttpServer())
			.post("/api/transactions")
			.set(orgBearer(user))
			.send({
				currencyCode: "USD",
				principalAmount: "5000.00",
				exchangeRate: "0.5",
				quantity: "10000.00",
				feeAmount: "0",
				transactedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
			})
			.expect(201);
		const planRes = await request(app.getHttpServer())
			.post("/api/plans")
			.set(orgBearer(user))
			.send({
				name: "口径一致性回归",
				targetCurrency: "USD",
				targetAmount: "6000",
				expectUseDate: "2030-02-15T00:00:00.000Z",
				prepLeadDays: 3,
				pacePreference: "balanced",
				allocatedAmount: "2000",
			})
			.expect(201);
		planId = planRes.body.data.id;
		planIds.push(planId);
		await request(app.getHttpServer())
			.post(`/api/plans/${planId}/usages`)
			.set(orgBearer(user))
			.send({
				amount: "500",
				usedAt: new Date().toISOString(),
			})
			.expect(201);
	}, 60_000);

	afterAll(async () => {
		try {
			await cleanupPlanData(ctx.prisma, planIds);
			for (const userId of userIds) {
				await cleanupUser(ctx.prisma, userId);
			}
		} finally {
			await app?.close();
		}
	});

	it("录使用后：plans 详情 usedAmount = reports 单计划/列表 usedQuantity = 500", async () => {
		const detail = await request(app.getHttpServer())
			.get(`/api/plans/${planId}`)
			.set(orgBearer(user))
			.expect(200);
		const report = await request(app.getHttpServer())
			.get(`/api/reports/plans/${planId}`)
			.set(orgBearer(user))
			.expect(200);
		const list = await request(app.getHttpServer())
			.get("/api/reports/plans")
			.set(orgBearer(user))
			.expect(200);

		// 四处同值：plans 详情 / reports 单计划 / reports 列表项
		expect(detail.body.data.usedAmount).toBe("500.0000");
		expect(report.body.data.plan.usedQuantity).toBe("500.0000");
		const listItem = list.body.data.items.find(
			(item: { planId: string }) => item.planId === planId,
		);
		expect(listItem?.usedQuantity).toBe("500.0000");

		// 成本同源：usage 成本（unitCost 0.5 × 500 = 250）两接口一致
		expect(detail.body.data.usedAmount).toBe("500.0000");
		expect(report.body.data.cost.usedTotalCost).toBe("250.0000");
	});

	it("未录使用前 reports 不得假 0：建账+买入但未录使用的另一计划同口径（防御录数时序）", async () => {
		// 同一用户新计划（分配 0，无使用）：两接口都应为 0，且与详情一致
		const planRes = await request(app.getHttpServer())
			.post("/api/plans")
			.set(orgBearer(user))
			.send({
				name: "未使用计划",
				targetCurrency: "USD",
				targetAmount: "1000",
				expectUseDate: "2030-02-15T00:00:00.000Z",
				prepLeadDays: 3,
				pacePreference: "balanced",
			})
			.expect(201);
		const emptyPlanId = planRes.body.data.id as string;
		planIds.push(emptyPlanId);

		const detail = await request(app.getHttpServer())
			.get(`/api/plans/${emptyPlanId}`)
			.set(orgBearer(user))
			.expect(200);
		const report = await request(app.getHttpServer())
			.get(`/api/reports/plans/${emptyPlanId}`)
			.set(orgBearer(user))
			.expect(200);
		expect(detail.body.data.usedAmount).toBe("0.0000");
		expect(report.body.data.plan.usedQuantity).toBe("0.0000");
		expect(report.body.data.cost.usedTotalCost).toBeNull(); // 无分摊不补 0
	});
});

/**
 * 报告的组织维度对称口径（Goal #3B W25；收口 W24 对抗审 N-1 / P-2）。
 *
 * 背景：W24 曾把使用记录收口到组织，但创建者仍可能有**未回填 organizationId** 的
 * 存量 Plan（及其使用记录 / 成本批次）。若报告按个人维度读计划，创建者与受邀成员
 * 会看到**不同的计划集合**：成员报告缺计划、缺 Plan 维度的成本归属。
 *
 * W30（MIG-E/F）后该形态已不存在（`organization_id` NOT NULL、无 `user_id` 列），
 * 报告一律按**纯组织作用域**读取——同组织成员的报告视图天然逐字段一致。
 *
 * 断言：同组织的 Owner 与受邀成员对同一组织得到**逐字段一致**的报告视图
 * （列表项集合一致 + 单计划详情 200 且数值一致）。
 */
describe("ReportController（成员与创建者的报告视图对称，W25）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let org: OrgLedger;
	let legacyPlanId: string;

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		org = await createOrgLedger(app, ctx.prisma, "rpt-org", ["FINANCE"]);

		// 组织维度计划（MIG-E/F：直接挂 organizationId，createdById 记录创建者）
		const plan = await ctx.prisma.plan.create({
			data: {
				createdById: org.owner.userId,
				organizationId: org.orgId,
				name: "组织协同计划",
				targetCurrency: "USD",
				targetAmount: "10000",
				expectUseDate: new Date("2026-12-01T00:00:00.000Z"),
				latestPrepDate: new Date("2026-11-01T00:00:00.000Z"),
				status: "ACTIVE",
			},
		});
		legacyPlanId = plan.id;
		await ctx.prisma.planAllocation.create({
			data: { planId: plan.id, amount: "0", usedAmount: "0" },
		});
		const lot = await seedCostLot(ctx.prisma, org.owner.userId, "USD", {
			organizationId: org.orgId,
			sourceType: "PURCHASE",
			quantity: "1000",
			principal: "7800",
			fee: "0",
			planId: plan.id,
		});
		await seedUsage(ctx.prisma, org.owner.userId, {
			organizationId: org.orgId,
			planId: plan.id,
			currencyCode: "USD",
			amount: "1000",
			allocations: [{ lotId: lot.lotId, quantity: "1000", cost: "7800" }],
		});
	});

	afterAll(async () => {
		try {
			await cleanupOrgLedgers(ctx.prisma, org);
		} finally {
			await app?.close();
		}
	});

	it("W25-RPT-1 同组织 Owner 与受邀成员的报告视图逐字段一致（同组织计划双方同样可见）", async () => {
		const ownerList = await request(app.getHttpServer())
			.get("/api/reports/plans")
			.set(orgHeaders(org.owner, org.orgId))
			.expect(200);
		const memberList = await request(app.getHttpServer())
			.get("/api/reports/plans")
			.set(orgHeaders(org.members[0], org.orgId))
			.expect(200);

		// 创建者视角：存量计划可见，且带完整成本归属
		expect(ownerList.body.data.baseCurrency).toBe("CNY");
		const ownerItems = ownerList.body.data.items as Array<{
			planId: string;
			usedQuantity: string;
			usedTotalCost: string;
			usedUnitCost: string;
		}>;
		expect(ownerItems).toHaveLength(1);
		expect(ownerItems[0].planId).toBe(legacyPlanId);
		expect(ownerItems[0].usedQuantity).toBe("1000.0000");
		expect(ownerItems[0].usedTotalCost).toBe("7800.0000");
		expect(ownerItems[0].usedUnitCost).toBe("7.80000000");

		// 受邀成员视角：与创建者**逐字段一致**（修复前此处为空集）
		expect(memberList.body.data).toEqual(ownerList.body.data);
	});

	it("W25-RPT-2 受邀成员读取存量计划详情 → 200 且数值与创建者一致（修复前 404）", async () => {
		const ownerDetail = await request(app.getHttpServer())
			.get(`/api/reports/plans/${legacyPlanId}`)
			.set(orgHeaders(org.owner, org.orgId))
			.expect(200);
		const memberDetail = await request(app.getHttpServer())
			.get(`/api/reports/plans/${legacyPlanId}`)
			.set(orgHeaders(org.members[0], org.orgId))
			.expect(200);

		// meta.generatedAt 是每次请求的生成时刻（天然不同），其余字段逐字段一致
		expect(memberDetail.body.data.plan).toEqual(ownerDetail.body.data.plan);
		expect(memberDetail.body.data.cost).toEqual(ownerDetail.body.data.cost);
		expect(memberDetail.body.data.sourceSplit).toEqual(
			ownerDetail.body.data.sourceSplit,
		);
		expect(memberDetail.body.data.yieldSection).toEqual(
			ownerDetail.body.data.yieldSection,
		);
		expect(memberDetail.body.data.meta.updatedAt).toBe(
			ownerDetail.body.data.meta.updatedAt,
		);
		expect(memberDetail.body.data.plan.usedQuantity).toBe("1000.0000");
		expect(memberDetail.body.data.cost.usedTotalCost).toBe("7800.0000");
		expect(memberDetail.body.data.sourceSplit.purchase).toEqual({
			quantity: "1000.0000",
			cost: "7800.0000",
		});
	});
});
