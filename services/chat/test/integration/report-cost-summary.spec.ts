/**
 * 报告集成测试（reports 技术方案 §10.3）：一个业务流一个文件。
 *
 * 流：初始持仓 → 买入（含一笔未知手续费）→ 建计划 → 两次使用（分摊跨
 * INITIAL/PURCHASE 批次）→ 模拟 M8 更正（改写分摊行 + Correction 留痕）→
 * 断言摘要与列表联动更新、updatedAt 前移、读侧无缓存；另覆盖「完成计划
 * 调小使用金额后仍显示已完成且差额正确」（需求 5.2 条 6 / 验收 9）。
 *
 * M7/M8 写侧未上线，分摊事实经 report-test-helper 直插 DB（方案 §10 前言）；
 * FIFO 正确性由 M7 集成测试锁定，本文件只验证「读分摊求和 + 更正联动」。
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
import {
	ensureSettings,
	SEED_ACQUIRED_AT,
	SEED_CORRECTED_AT,
	SEED_USED_AT,
	seedCostLot,
	seedCorrection,
	seedUsage,
	setPlanStatus,
} from "../helpers/report-test-helper";
import {
	cleanupPlanData,
	seedPlanWithAllocation,
} from "../helpers/plan-test-helper";

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

describe("报告成本摘要联动（集成）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let user: TestUser;
	let userAdjusted: TestUser;
	const userIds: string[] = [];
	const planIds: string[] = [];

	/** 主流程计划：USD 10,000；初始 1,000@7.0 + 买入 A 1,000@7.8（fee 0）+ 买入 B 1,000@8.0（fee NULL） */
	let planId: string;
	let usage1Id: string;
	let usage2Id: string;
	let lotATransactionId: string;
	let lotInitialId: string;
	let lotBId: string;

	/** 调小场景计划：CAD 500，完成后更正把使用 500 调小为 400 */
	let adjustedPlanId: string;

	function getPlans(query = "") {
		return request(app.getHttpServer())
			.get(`/api/reports/plans${query}`)
			.set(bearer(user.accessToken));
	}

	function getDetail(id: string) {
		return request(app.getHttpServer())
			.get(`/api/reports/plans/${id}`)
			.set(bearer(user.accessToken));
	}

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		user = await createTestUser(app, "rpt-int");
		userAdjusted = await createTestUser(app, "rpt-int-adj");
		userIds.push(user.userId, userAdjusted.userId);
		await ensureSettings(ctx.prisma, user.userId, "CNY");
		await ensureSettings(ctx.prisma, userAdjusted.userId, "CNY");

		// ── 主流程种子 ──
		planId = await seedPlanWithAllocation(ctx.prisma, user.userId, {
			targetCurrency: "USD",
			targetAmount: "10000",
		});
		planIds.push(planId);
		const lotInitial = await seedCostLot(ctx.prisma, user.userId, "USD", {
			sourceType: "INITIAL",
			quantity: "1000",
			principal: "7000",
		});
		const lotA = await seedCostLot(ctx.prisma, user.userId, "USD", {
			sourceType: "PURCHASE",
			quantity: "1000",
			principal: "7800",
			fee: "0",
			planId, // 交易关联计划（TRANSACTION 更正参与 updatedAt 的口径域）
		});
		const lotB = await seedCostLot(ctx.prisma, user.userId, "USD", {
			sourceType: "PURCHASE",
			quantity: "1000",
			principal: "8000",
			fee: null,
		});
		lotInitialId = lotInitial.lotId;
		lotBId = lotB.lotId;
		lotATransactionId = lotA.sourceId; // 批次 A 交易 planId=计划（TRANSACTION 更正口径域）

		// 使用 u1：400 = 初始 100×7.0 (700) + A 300×7.8 (2,340) —— 分摊跨来源
		usage1Id = await seedUsage(ctx.prisma, user.userId, {
			planId,
			currencyCode: "USD",
			amount: "400",
			allocations: [
				{ lotId: lotInitial.lotId, quantity: "100", cost: "700" },
				{ lotId: lotA.lotId, quantity: "300", cost: "2340" },
			],
		});
		// 使用 u2：600 = B 600×8.0 (4,800) —— 涉及未知手续费批次
		usage2Id = await seedUsage(ctx.prisma, user.userId, {
			planId,
			currencyCode: "USD",
			amount: "600",
			allocations: [{ lotId: lotB.lotId, quantity: "600", cost: "4800" }],
		});

		// ── 调小场景种子：CAD 500 计划 → COMPLETED → 更正调小为 400 ──
		adjustedPlanId = await seedPlanWithAllocation(
			ctx.prisma,
			userAdjusted.userId,
			{ targetCurrency: "CAD", targetAmount: "500" },
		);
		planIds.push(adjustedPlanId);
		const lotCad = await seedCostLot(ctx.prisma, userAdjusted.userId, "CAD", {
			sourceType: "PURCHASE",
			quantity: "500",
			principal: "3500",
			fee: "0",
		});
		const cadUsageId = await seedUsage(ctx.prisma, userAdjusted.userId, {
			planId: adjustedPlanId,
			currencyCode: "CAD",
			amount: "500",
			allocations: [{ lotId: lotCad.lotId, quantity: "500", cost: "3500" }],
		});
		await setPlanStatus(ctx.prisma, adjustedPlanId, "COMPLETED");
		// 更正成功：使用 500 → 400（改 UsageRecord.amount + 分摊行），状态仍 COMPLETED
		await ctx.prisma.usageRecord.update({
			where: { id: cadUsageId },
			data: { amount: "400", version: 2 },
		});
		await ctx.prisma.usageLotAllocation.updateMany({
			where: { usageId: cadUsageId },
			data: { quantity: "400", cost: "2800" },
		});
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

	it("#1 更正前：两次使用跨来源分摊聚合正确（来源拆分 + hasUnknownFee + 均价）", async () => {
		const res = await getDetail(planId).expect(200);
		const data = res.body.data;
		expect(data.plan.usedQuantity).toBe("1000.0000"); // 400 + 600
		expect(data.cost.usedTotalCost).toBe("7840.0000"); // 700+2340+4800
		expect(data.cost.usedUnitCost).toBe("7.84000000"); // 7840/1000
		expect(data.sourceSplit.initial).toEqual({
			quantity: "100.0000",
			cost: "700.0000",
		});
		expect(data.sourceSplit.purchase).toEqual({
			quantity: "900.0000",
			cost: "7140.0000",
		});
		expect(data.cost.hasUnknownFee).toBe(true); // u2 分摊涉及 fee NULL 批次
		expect(data.yieldSection.displayType).toBe("NOT_SUPPORTED_YET");
		// updatedAt 基线：仅使用记录（无更正）→ max(使用 updatedAt)
		expect(data.meta.updatedAt).toBe(SEED_USED_AT.toISOString());
		// 列表与详情同源
		const list = await getPlans("?currencyCode=USD").expect(200);
		expect(list.body.data.items).toHaveLength(1);
		expect(list.body.data.items[0].usedTotalCost).toBe("7840.0000");
	});

	it("#2 模拟 M8 更正（改写分摊行 + USAGE/TRANSACTION Correction）→ 摘要联动、updatedAt 前移", async () => {
		// 更正 u2 的 B 批次分摊行（唯一键 usageId+lotId，精确改写）：成本 4,800 → 4,900；更正时间 2026-02-01
		await ctx.prisma.usageLotAllocation.update({
			where: { usageId_lotId: { usageId: usage2Id, lotId: lotBId } },
			data: { cost: "4900" },
		});
		await seedCorrection(ctx.prisma, user.userId, "USAGE", usage2Id);
		// 计划关联交易（批次 A，planId=计划）的更正留痕：时间更晚 2026-03-01
		await seedCorrection(
			ctx.prisma,
			user.userId,
			"TRANSACTION",
			lotATransactionId,
			new Date("2026-03-01T00:00:00.000Z"),
		);

		const res = await getDetail(planId).expect(200);
		const data = res.body.data;
		// 数量不变（更正的是成本），总成本联动 +100
		expect(data.plan.usedQuantity).toBe("1000.0000");
		expect(data.cost.usedTotalCost).toBe("7940.0000");
		expect(data.cost.usedUnitCost).toBe("7.94000000");
		expect(data.sourceSplit.purchase.cost).toBe("7240.0000");
		// updatedAt 前移到 TRANSACTION 更正时间（§4.2 口径 3 取 max）
		expect(data.meta.updatedAt).toBe("2026-03-01T00:00:00.000Z");
		// 列表同步反映
		const list = await getPlans("?currencyCode=USD").expect(200);
		expect(list.body.data.items[0].usedTotalCost).toBe("7940.0000");
		expect(list.body.data.items[0].updatedAt).toBe("2026-03-01T00:00:00.000Z");
	});

	it("#3 读侧无缓存：同一请求两次均直读已落库事实（第二次反映改写后数据）", async () => {
		const first = await getDetail(planId).expect(200);
		const second = await getDetail(planId).expect(200);
		expect(second.body.data.cost.usedTotalCost).toBe("7940.0000");
		expect(second.body.data.cost.usedTotalCost).toBe(
			first.body.data.cost.usedTotalCost,
		);
		// 再改写一次，新请求立即反映（无内存/查询缓存）：仅 u1 的初始批次分摊行 700 → 800
		await ctx.prisma.usageLotAllocation.update({
			where: { usageId_lotId: { usageId: usage1Id, lotId: lotInitialId } },
			data: { cost: "800" },
		});
		const third = await getDetail(planId).expect(200);
		expect(third.body.data.cost.usedTotalCost).toBe("8040.0000"); // 7940 + 100
		// 还原（后续用例基线）
		await ctx.prisma.usageLotAllocation.update({
			where: { usageId_lotId: { usageId: usage1Id, lotId: lotInitialId } },
			data: { cost: "700" },
		});
	});

	it("#4 完成计划调小使用金额：status 仍 COMPLETED、差额 = 目标 − 调整后使用（验收 9）", async () => {
		// userAdjusted 的 token 访问自己（独立用户隔离主流程断言）
		const res = await request(app.getHttpServer())
			.get(`/api/reports/plans/${adjustedPlanId}`)
			.set(bearer(userAdjusted.accessToken))
			.expect(200);
		const data = res.body.data;
		expect(data.plan.status).toBe("COMPLETED"); // 调小后不回退状态、无补足提醒语义
		expect(data.plan.targetAmount).toBe("500.0000");
		expect(data.plan.usedQuantity).toBe("400.0000"); // 调整后使用金额
		expect(data.plan.remainingToUseAmount).toBe("100.0000"); // 差额
		expect(data.cost.usedTotalCost).toBe("2800.0000");
		// 版本前移后仍按当前版本唯一行聚合（M8 改写式更正）
		const usageRows = await ctx.prisma.usageRecord.findMany({
			where: { planId: adjustedPlanId },
		});
		expect(usageRows).toHaveLength(1);
		expect(usageRows[0].version).toBe(2);
	});

	it("#5 锚定时间不漂移：分摊事实早于真实时钟（SEED_* 常量显式锚定）", () => {
		expect(SEED_ACQUIRED_AT.getTime()).toBeLessThan(Date.now());
		expect(SEED_CORRECTED_AT.getTime()).toBeLessThan(Date.now());
	});
});
