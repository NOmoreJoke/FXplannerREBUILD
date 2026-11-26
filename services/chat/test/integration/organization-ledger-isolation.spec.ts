/**
 * 组织账本隔离与共享（集成；技术方案 §14.3.2 / 需求 LEDGER-01、LEDGER-04 / Goal #3B W24）。
 *
 * 真实数据库 + 真实事务链路，全部写入走组织化接口（带 X-Organization-Id）：
 * 1. W24-ISO-1：同一用户同时属于 Org A 与 Org B，两组织持有完全相同币种与金额的
 *    初始持仓 / 买入 / 计划 / 使用。只在其中一个组织做更正，另一个组织的账户、批次、
 *    分摊、分配逐行不变（含行 id——批次没有被别的组织的重放重建）；带另一组织头
 *    操作本组织记录一律 404；报告与账户各出各的数。
 *    说明：两组织起始数据完全相同，光比数值发现不了串联，所以用「单边更正后另一边
 *    是否原样不动」来证零串联。
 * 2. W24-ISO-2：同组织 Finance 1 买入多个批次 → Finance 2 建计划、记使用，消耗的是
 *    Finance 1 的 FIFO 池 → Finance 2 更正该使用（改大补分配）与 Finance 1 的买入
 *    （补录手续费）：重建后的批次仍归 Finance 1，报告 / 账户余额 / 分摊三处一致。
 *
 * 断言纪律：批次、分摊按「来源记录 id」映射比对，不依赖行 id 的字典序（cuid 同毫秒内
 * 生成顺序不保证）；集合类断言先排序。
 */
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { utc8DayStart } from "../../src/transaction/transaction-calculator";
import {
	cleanupOrgLedgers,
	createOrgLedger,
	ledgerShape,
	orgHeaders,
	type OrgLedger,
	type OrgLedgerSnapshot,
	purchaseBody,
	readOrgLedgerSnapshot,
	seedOrgInitialHolding,
} from "../helpers/organization-ledger-test-helper";
import {
	PLAN_EXPECT_USE_DATE,
	PLAN_START_DATE,
} from "../helpers/plan-test-helper";
import { closeTestApps } from "../helpers/test-http";
import {
	bearer,
	createTestApp,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";

// 关闭全局接口限流（先例：transaction.spec / plan.spec——APP_GUARD token 无法 override，只能 mock 类）
vi.mock("@nestjs/throttler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nestjs/throttler")>();
	class NoopThrottlerGuard {
		async canActivate() {
			return true;
		}
	}
	return { ...actual, ThrottlerGuard: NoopThrottlerGuard };
});

/** 相对今天的过去第 n 天（固定时刻，避开 UTC+8 日界边界；与其他集成 spec 同款） */
function daysAgo(n: number): Date {
	return new Date(Date.now() - n * 86_400_000 - 2 * 3_600_000);
}

/**
 * 批次按来源记录 id 索引：[单价, 剩余数量, 所属组织]
 *
 * W30（MIG-E）：批次直连 Organization，已删除 user_id 列——「批次归谁」不再由批次
 * 自己承载，而由来源记录（Transaction.createdById）承担（见 W24-ISO-2 的断言）。
 */
function lotsBySource(snapshot: OrgLedgerSnapshot) {
	return new Map(
		snapshot.lots.map((lot) => [
			lot.sourceId,
			[lot.unitCost, lot.remainingQty, lot.organizationId] as const,
		]),
	);
}

describe("组织账本隔离与共享（ToB R1 W24 集成）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	/** 本文件每个用例自建组织，统一在 afterAll 清理（先清派生行再删用户，不留孤儿） */
	const orgs: OrgLedger[] = [];

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
	}, 30_000);

	afterAll(async () => {
		try {
			await cleanupOrgLedgers(ctx.prisma, ...orgs);
		} finally {
			await closeTestApps(app);
		}
	});

	function http() {
		return request(app.getHttpServer());
	}

	function postTx(user: TestUser, orgId: string, body: Record<string, unknown>) {
		return http()
			.post("/api/transactions")
			.set(orgHeaders(user, orgId))
			.send(body);
	}

	function postUsage(
		user: TestUser,
		orgId: string,
		planId: string,
		body: Record<string, unknown>,
		requestId?: string,
	) {
		return http()
			.post(`/api/plans/${planId}/usages`)
			.set(orgHeaders(user, orgId, requestId))
			.send(body);
	}

	/** 建计划（分配额可指定；排期日期为远期固定值，断言不依赖真实时钟） */
	function postPlan(
		user: TestUser,
		orgId: string,
		targetAmount: string,
		allocatedAmount: string,
	) {
		return http()
			.post("/api/plans")
			.set(orgHeaders(user, orgId))
			.send({
				targetCurrency: "USD",
				targetAmount,
				expectUseDate: PLAN_EXPECT_USE_DATE,
				prepLeadDays: 3,
				pacePreference: "balanced",
				startDate: PLAN_START_DATE,
				allocatedAmount,
			});
	}

	function preview(user: TestUser, orgId: string, body: Record<string, unknown>) {
		return http()
			.post("/api/corrections/preview")
			.set(orgHeaders(user, orgId))
			.send(body);
	}

	function apply(
		user: TestUser,
		orgId: string,
		body: Record<string, unknown>,
		requestId?: string,
	) {
		return http()
			.post("/api/corrections")
			.set(orgHeaders(user, orgId, requestId))
			.send(body);
	}

	function accountDetail(user: TestUser, orgId: string, currencyCode = "USD") {
		return http()
			.get(`/api/accounts/${currencyCode}`)
			.set(orgHeaders(user, orgId));
	}

	function planDetail(user: TestUser, orgId: string, planId: string) {
		return http()
			.get(`/api/plans/${planId}`)
			.set(orgHeaders(user, orgId));
	}

	function usageList(user: TestUser, orgId: string, planId: string) {
		return http()
			.get(`/api/plans/${planId}/usages`)
			.set(orgHeaders(user, orgId));
	}

	function reportList(user: TestUser, orgId: string) {
		return http()
			.get("/api/reports/plans")
			.query({ currencyCode: "USD" })
			.set(orgHeaders(user, orgId));
	}

	function reportDetail(user: TestUser, orgId: string, planId: string) {
		return http()
			.get(`/api/reports/plans/${planId}`)
			.set(orgHeaders(user, orgId));
	}

	it("W24-ISO-1 Org A 与 Org B 同币种同金额全闭环（持仓/买入/计划/使用/更正/报告）零串联", async () => {
		const orgA = await createOrgLedger(app, ctx.prisma, "w24-iso-a");
		const owner = orgA.owner;
		// Org B：同一用户经接口新建并成为 OWNER（非默认组织——存量回落分支在此关闭），单独建账
		const orgBId = (
			await http()
				.post("/api/organizations")
				.set(bearer(owner.accessToken))
				.send({ name: "W24 账本隔离 Org B" })
				.expect(201)
		).body.data.id as string;
		await ctx.prisma.organizationSettings.create({
			data: {
				organizationId: orgBId,
				baseCurrency: "CNY",
				prepPreference: "balanced",
				reminderEnabled: true,
			},
		});
		const orgB: OrgLedger = { owner, orgId: orgBId, members: [], users: [owner] };
		orgs.push(orgA, orgB);

		// 两组织共用同一组时刻：初始持仓 500@7 → 买入 1,000@7.8 → 买入 1,000@8 → 计划分配 1,200 → 使用 1,200
		// 使用成本 = 500×7 + 700×7.8 = 8,960；余额 2,500 − 1,200 = 1,300
		const clock = {
			confirmedAt: daysAgo(5),
			firstPurchaseAt: daysAgo(4),
			secondPurchaseAt: daysAgo(3),
			usedAt: utc8DayStart(new Date()).toISOString(),
		};
		async function buildClosedLoop(orgId: string) {
			const { holdingId } = await seedOrgInitialHolding(ctx.prisma, {
				organizationId: orgId,
				userId: owner.userId,
				currencyCode: "USD",
				amount: "500",
				rate: "7",
				cost: "3500",
				confirmedAt: clock.confirmedAt,
			});
			const purchaseIds: string[] = [];
			for (const [at, unitCost] of [
				[clock.firstPurchaseAt, "7.8"],
				[clock.secondPurchaseAt, "8"],
			] as const) {
				const res = await postTx(
					owner,
					orgId,
					purchaseBody("USD", "1000", unitCost, at),
				).expect(201);
				purchaseIds.push(res.body.data.id);
			}
			const planId = (
				await postPlan(owner, orgId, "2000", "1200").expect(201)
			).body.data.id as string;
			const usage = await postUsage(owner, orgId, planId, {
				amount: "1200",
				usedAt: clock.usedAt,
			}).expect(201);
			expect(usage.body.data.usage.cost).toBe("8960.0000");
			return {
				holdingId,
				purchaseIds,
				planId,
				usageId: usage.body.data.usage.id as string,
			};
		}

		const loopA = await buildClosedLoop(orgA.orgId);
		const loopB = await buildClosedLoop(orgBId);

		// ① 同币种同金额：两个组织的账本内容逐字段一致，且全部落在各自的 organizationId 下
		const baselineA = await readOrgLedgerSnapshot(ctx.prisma, orgA.orgId);
		const baselineB = await readOrgLedgerSnapshot(ctx.prisma, orgBId);
		expect(ledgerShape(baselineA)).toEqual(ledgerShape(baselineB));
		expect(baselineA.accounts).toEqual([
			expect.objectContaining({
				organizationId: orgA.orgId,
				currencyCode: "USD",
				balance: "1300.0000",
			}),
		]);
		expect(baselineB.accounts).toEqual([
			expect.objectContaining({
				organizationId: orgBId,
				currencyCode: "USD",
				balance: "1300.0000",
			}),
		]);
		expect(baselineA.usages).toEqual([
			expect.objectContaining({
				organizationId: orgA.orgId,
				createdById: owner.userId,
				amount: "1200.0000",
			}),
		]);
		expect(baselineA.lots).toHaveLength(3);
		// 剩余：初始持仓 0（500 全耗）、买入一 300（被用掉 700）、买入二 1,000（未动）。
		// 按数值升序比对（字符串字典序会把 "1000" 排在 "300" 前）
		const ascending = (a: string, b: string) =>
			new Prisma.Decimal(a).comparedTo(b);
		expect(
			baselineA.lots.map((lot) => lot.remainingQty).sort(ascending),
		).toEqual(["0.0000", "300.0000", "1000.0000"]);
		expect(baselineA.allocations).toEqual([
			{ usageId: loopA.usageId, sourceId: loopA.holdingId, quantity: "500.0000", cost: "3500.0000" },
			{ usageId: loopA.usageId, sourceId: loopA.purchaseIds[0], quantity: "700.0000", cost: "5460.0000" },
		]);
		// 两组织的行 id 两两不同：不是同一批行被两个组织头读出来
		const rowIdsB = new Set(
			[...baselineB.accounts, ...baselineB.lots, ...baselineB.usages].map((row) => row.id),
		);
		expect(
			[...baselineA.accounts, ...baselineA.lots, ...baselineA.usages].every(
				(row) => !rowIdsB.has(row.id),
			),
		).toBe(true);

		// ② 只在 Org A 更正：补录买入一手续费 20 → 使用改大到 1,500（超剩余分配 → 补分配 300）
		const correctedA = await apply(owner, orgA.orgId, {
			targetType: "TRANSACTION",
			targetId: loopA.purchaseIds[0],
			baseVersion: 1,
			reason: "买入一手续费当时漏填",
			changes: { feeAmount: "20" },
		}).expect(201);
		// 组织与操作者落在留痕上（提交响应保持原形；列表接口下发 organizationId / actorUserId）
		expect(correctedA.body.data).toMatchObject({
			status: "APPLIED",
			targetVersion: 2,
		});
		expect(
			await ctx.prisma.correction.findUniqueOrThrow({
				where: { id: correctedA.body.data.correctionId },
			}),
		).toMatchObject({
			organizationId: orgA.orgId,
			actorUserId: owner.userId,
			status: "APPLIED",
		});
		const usagePreviewA = await preview(owner, orgA.orgId, {
			targetType: "USAGE",
			targetId: loopA.usageId,
			baseVersion: 1,
			reason: "使用金额少记了 300",
			changes: { amount: "1500" },
		}).expect(200);
		expect(usagePreviewA.body.data.blockers).toEqual([]);
		expect(usagePreviewA.body.data.impacts.allocations[0]).toMatchObject({
			planId: loopA.planId,
			supplement: "300.0000",
		});
		await apply(owner, orgA.orgId, {
			targetType: "USAGE",
			targetId: loopA.usageId,
			baseVersion: 1,
			reason: "使用金额少记了 300",
			changes: { amount: "1500" },
			expectedUsageImpact: usagePreviewA.body.data.expectedUsageImpact,
		}).expect(201);

		// ③ Org A 反映两次更正：买入一单价 7.82；使用 1,500 = 初始 500 + 买入一 1,000（刚好用完，
		//    买入二原封不动）；余额 2,500 − 1,500 = 1,000
		const afterA = await readOrgLedgerSnapshot(ctx.prisma, orgA.orgId);
		const lotsA = lotsBySource(afterA);
		expect(afterA.accounts[0].balance).toBe("1000.0000");
		expect(lotsA.get(loopA.purchaseIds[0])).toEqual(["7.82000000", "0.0000", orgA.orgId]);
		expect(lotsA.get(loopA.purchaseIds[1])).toEqual(["8.00000000", "1000.0000", orgA.orgId]);
		expect(lotsA.get(loopA.holdingId)).toEqual(["7.00000000", "0.0000", orgA.orgId]);
		expect(afterA.lots).toHaveLength(3);
		expect(afterA.allocations).toEqual([
			{ usageId: loopA.usageId, sourceId: loopA.holdingId, quantity: "500.0000", cost: "3500.0000" },
			{ usageId: loopA.usageId, sourceId: loopA.purchaseIds[0], quantity: "1000.0000", cost: "7820.0000" },
		]);
		expect(afterA.usages[0]).toMatchObject({ amount: "1500.0000", version: 2 });
		expect(afterA.planAllocations).toEqual([
			{ planId: loopA.planId, amount: "1500.0000", usedAmount: "1500.0000" },
		]);
		const supplementLogA = await ctx.prisma.planChangeLog.findMany({
			where: { planId: loopA.planId },
		});
		expect(supplementLogA).toHaveLength(1);
		expect(supplementLogA[0]).toMatchObject({
			organizationId: orgA.orgId,
			actorUserId: owner.userId,
			changeType: "ALLOCATION_ADJUSTED",
		});

		// ④ 零串联：Org B 与基线逐行一致（含行 id——A 的重放没有重建 B 的批次）
		expect(await readOrgLedgerSnapshot(ctx.prisma, orgBId)).toEqual(baselineB);

		// ⑤ 跨组织不可达：带 Org B 头操作 Org A 的计划 / 记录一律 404（不泄露存在性）
		const crossUsage = await postUsage(owner, orgBId, loopA.planId, {
			amount: "1",
			usedAt: clock.usedAt,
		}).expect(404);
		expect(crossUsage.body.code).toBe("PLAN_NOT_FOUND");
		const crossCorrection = {
			targetType: "TRANSACTION",
			targetId: loopA.purchaseIds[1],
			baseVersion: 1,
			reason: "带错组织头",
			changes: { feeAmount: "1" },
		};
		const crossPreview = await preview(owner, orgBId, crossCorrection).expect(404);
		expect(crossPreview.body.code).toBe("CORRECTION_TARGET_NOT_FOUND");
		const crossApply = await apply(owner, orgBId, crossCorrection).expect(404);
		expect(crossApply.body).toEqual(crossPreview.body);
		const crossReport = await reportDetail(owner, orgBId, loopA.planId).expect(404);
		expect(crossReport.body.code).toBe("PLAN_NOT_FOUND");
		await http()
			.get(`/api/corrections?targetType=TRANSACTION&targetId=${loopA.purchaseIds[0]}`)
			.set(orgHeaders(owner, orgBId))
			.expect(404);
		// 越权请求零副作用：A 只含步骤 ② 的两次更正，B 没有留下任何更正留痕
		expect(await readOrgLedgerSnapshot(ctx.prisma, orgA.orgId)).toEqual(afterA);
		expect(await readOrgLedgerSnapshot(ctx.prisma, orgBId)).toEqual(baselineB);
		expect(
			await ctx.prisma.correction.count({ where: { organizationId: orgBId } }),
		).toBe(0);

		// ⑥ 报告与账户：各组织只出自己的数
		const reportA = await reportList(owner, orgA.orgId).expect(200);
		expect(reportA.body.data.items).toHaveLength(1);
		expect(reportA.body.data.items[0]).toMatchObject({
			planId: loopA.planId,
			usedQuantity: "1500.0000",
			usedTotalCost: "11320.0000", // 3,500 + 1,000 × 7.82
			usedUnitCost: "7.54666667", // 11,320 ÷ 1,500（8 位 HALF_UP）
		});
		const reportB = await reportList(owner, orgBId).expect(200);
		expect(reportB.body.data.items).toHaveLength(1);
		expect(reportB.body.data.items[0]).toMatchObject({
			planId: loopB.planId,
			usedQuantity: "1200.0000",
			usedTotalCost: "8960.0000",
			usedUnitCost: "7.46666667", // 8,960 ÷ 1,200
		});
		const detailA = await reportDetail(owner, orgA.orgId, loopA.planId).expect(200);
		expect(detailA.body.data.sourceSplit).toEqual({
			initial: { quantity: "500.0000", cost: "3500.0000" },
			purchase: { quantity: "1000.0000", cost: "7820.0000" },
		});
		const detailB = await reportDetail(owner, orgBId, loopB.planId).expect(200);
		expect(detailB.body.data.sourceSplit).toEqual({
			initial: { quantity: "500.0000", cost: "3500.0000" },
			purchase: { quantity: "700.0000", cost: "5460.0000" },
		});
		expect((await accountDetail(owner, orgA.orgId).expect(200)).body.data.balance).toBe(
			"1000.0000",
		);
		expect((await accountDetail(owner, orgBId).expect(200)).body.data.balance).toBe(
			"1300.0000",
		);

		// ⑦ 反向：只在 Org B 做一次不同的更正（使用改小到 800），Org A 原样不动
		const usagePreviewB = await preview(owner, orgBId, {
			targetType: "USAGE",
			targetId: loopB.usageId,
			baseVersion: 1,
			reason: "使用金额多记了 400",
			changes: { amount: "800" },
		}).expect(200);
		expect(usagePreviewB.body.data.blockers).toEqual([]);
		await apply(owner, orgBId, {
			targetType: "USAGE",
			targetId: loopB.usageId,
			baseVersion: 1,
			reason: "使用金额多记了 400",
			changes: { amount: "800" },
			expectedUsageImpact: usagePreviewB.body.data.expectedUsageImpact,
		}).expect(201);
		const afterB = await readOrgLedgerSnapshot(ctx.prisma, orgBId);
		expect(afterB.accounts[0].balance).toBe("1700.0000");
		expect(afterB.allocations).toEqual([
			{ usageId: loopB.usageId, sourceId: loopB.holdingId, quantity: "500.0000", cost: "3500.0000" },
			{ usageId: loopB.usageId, sourceId: loopB.purchaseIds[0], quantity: "300.0000", cost: "2340.0000" },
		]);
		expect(await readOrgLedgerSnapshot(ctx.prisma, orgA.orgId)).toEqual(afterA);
		const reportBAfter = await reportList(owner, orgBId).expect(200);
		expect(reportBAfter.body.data.items[0]).toMatchObject({
			usedQuantity: "800.0000",
			usedTotalCost: "5840.0000",
		});
		const reportAAfter = await reportList(owner, orgA.orgId).expect(200);
		expect(reportAAfter.body.data.items[0]).toMatchObject({
			usedQuantity: "1500.0000",
			usedTotalCost: "11320.0000",
		});

		// ⑧ 留痕与审计各归各组织：A 两条更正（买入 + 使用），B 一条（使用），互不出现对方目标
		const [correctionsA, correctionsB, auditsA, auditsB] = await Promise.all([
			ctx.prisma.correction.findMany({ where: { organizationId: orgA.orgId } }),
			ctx.prisma.correction.findMany({ where: { organizationId: orgBId } }),
			ctx.prisma.auditLog.findMany({
				where: { organizationId: orgA.orgId, action: "correction.apply" },
			}),
			ctx.prisma.auditLog.findMany({
				where: { organizationId: orgBId, action: "correction.apply" },
			}),
		]);
		expect(correctionsA.map((row) => row.targetId).sort()).toEqual(
			[loopA.purchaseIds[0], loopA.usageId].sort(),
		);
		expect(
			correctionsA.every(
				(row) => row.actorUserId === owner.userId && row.status === "APPLIED",
			),
		).toBe(true);
		expect(correctionsB.map((row) => row.targetId)).toEqual([loopB.usageId]);
		expect(
			await ctx.prisma.correction.count({
				where: { targetId: { in: [loopA.purchaseIds[0], loopA.usageId, loopB.usageId] } },
			}),
		).toBe(3);
		expect(auditsA.map((row) => row.targetId).sort()).toEqual(
			[loopA.purchaseIds[0], loopA.usageId].sort(),
		);
		expect(auditsB.map((row) => row.targetId)).toEqual([loopB.usageId]);
	}, 60_000);

	it("W24-ISO-2 同组织跨成员共享 FIFO：Finance 1 买入 → Finance 2 使用与更正，批次仍归买入人，报告与账户余额一致", async () => {
		const org = await createOrgLedger(app, ctx.prisma, "w24-shared", [
			"FINANCE",
			"FINANCE",
		]);
		orgs.push(org);
		const [finance1, finance2] = org.members;
		const usedAt = utc8DayStart(new Date()).toISOString();

		// Finance 1 买入两批；Finance 2 建计划（分配 1,200）并记使用 1,200
		const purchaseIds: string[] = [];
		for (const [at, unitCost] of [
			[daysAgo(4), "7.8"],
			[daysAgo(3), "8"],
		] as const) {
			const res = await postTx(
				finance1,
				org.orgId,
				purchaseBody("USD", "1000", unitCost, at),
			).expect(201);
			purchaseIds.push(res.body.data.id);
		}
		const planId = (await postPlan(finance2, org.orgId, "2000", "1200").expect(201))
			.body.data.id as string;
		const usageRequestId = `req-w24-shared-usage-${Date.now()}`;
		const usageRes = await postUsage(
			finance2,
			org.orgId,
			planId,
			{ amount: "1200", usedAt, remark: "Finance 2 记的使用" },
			usageRequestId,
		).expect(201);
		const usageId = usageRes.body.data.usage.id as string;
		// 跨成员 FIFO：Finance 2 的使用消耗 Finance 1 的两批 → 1,000×7.8 + 200×8 = 9,400
		expect(usageRes.body.data.usage).toMatchObject({
			id: usageId,
			cost: "9400.0000",
			createdById: finance2.userId,
		});

		const afterUsage = await readOrgLedgerSnapshot(ctx.prisma, org.orgId);
		const lotsAfterUsage = lotsBySource(afterUsage);
		expect(afterUsage.allocations).toEqual([
			{ usageId, sourceId: purchaseIds[0], quantity: "1000.0000", cost: "7800.0000" },
			{ usageId, sourceId: purchaseIds[1], quantity: "200.0000", cost: "1600.0000" },
		]);
		expect(lotsAfterUsage.get(purchaseIds[0])).toEqual([
			"7.80000000",
			"0.0000",
			org.orgId,
		]);
		expect(lotsAfterUsage.get(purchaseIds[1])).toEqual([
			"8.00000000",
			"800.0000",
			org.orgId,
		]);
		expect(afterUsage.usages[0]).toMatchObject({
			createdById: finance2.userId,
			organizationId: org.orgId,
		});
		expect(afterUsage.accounts[0]).toMatchObject({
			organizationId: org.orgId,
			balance: "800.0000",
		});
		// Finance 1 与 Owner 读到 Finance 2 记的使用（createdById 标识记录人）
		for (const viewer of [finance1, org.owner]) {
			const list = await usageList(viewer, org.orgId, planId).expect(200);
			expect(list.body.data.items).toEqual([
				expect.objectContaining({ id: usageId, cost: "9400.0000", createdById: finance2.userId }),
			]);
		}
		// usage.create 与记账同事务：带组织、记录人与 requestId
		const usageAudit = await ctx.prisma.auditLog.findMany({
			where: { organizationId: org.orgId, action: "usage.create" },
		});
		expect(usageAudit).toEqual([
			expect.objectContaining({
				actorUserId: finance2.userId,
				actorType: "USER",
				targetType: "usage_record",
				targetId: usageId,
				result: "SUCCESS",
				requestId: usageRequestId,
			}),
		]);

		// Finance 2 更正自己记的使用：改大到 1,500 → 补分配 300，日志带组织与实际操作者
		const usagePreview = await preview(finance2, org.orgId, {
			targetType: "USAGE",
			targetId: usageId,
			baseVersion: 1,
			reason: "使用金额少记了 300",
			changes: { amount: "1500" },
		}).expect(200);
		expect(usagePreview.body.data.blockers).toEqual([]);
		const usageApplyRequestId = `req-w24-shared-corr-usage-${Date.now()}`;
		const usageApplied = await apply(
			finance2,
			org.orgId,
			{
				targetType: "USAGE",
				targetId: usageId,
				baseVersion: 1,
				reason: "使用金额少记了 300",
				changes: { amount: "1500" },
				expectedUsageImpact: usagePreview.body.data.expectedUsageImpact,
			},
			usageApplyRequestId,
		).expect(201);
		expect(usageApplied.body.data).toMatchObject({
			status: "APPLIED",
			targetVersion: 2,
		});
		expect(
			await ctx.prisma.correction.findUniqueOrThrow({
				where: { id: usageApplied.body.data.correctionId },
			}),
		).toMatchObject({
			organizationId: org.orgId,
			actorUserId: finance2.userId,
		});
		const supplementLogs = await ctx.prisma.planChangeLog.findMany({
			where: { planId },
		});
		expect(supplementLogs).toEqual([
			expect.objectContaining({
				organizationId: org.orgId,
				actorUserId: finance2.userId,
				changeType: "ALLOCATION_ADJUSTED",
				afterSnapshot: expect.objectContaining({
					supplement: "300.0000",
					correctionId: usageApplied.body.data.correctionId,
				}),
			}),
		]);

		// Finance 2 更正 Finance 1 的买入一：补录手续费 20 → 单价 7.82，使用成本 7,820 + 4,000
		const txApplyRequestId = `req-w24-shared-corr-tx-${Date.now()}`;
		const txApplied = await apply(
			finance2,
			org.orgId,
			{
				targetType: "TRANSACTION",
				targetId: purchaseIds[0],
				baseVersion: 1,
				reason: "买入一手续费当时漏填",
				changes: { feeAmount: "20" },
			},
			txApplyRequestId,
		).expect(201);
		expect(txApplied.body.data).toMatchObject({
			status: "APPLIED",
			targetVersion: 2,
		});
		expect(
			await ctx.prisma.correction.findUniqueOrThrow({
				where: { id: txApplied.body.data.correctionId },
			}),
		).toMatchObject({
			organizationId: org.orgId,
			actorUserId: finance2.userId,
		});
		// 买入记录的创建者不被更正者覆写（W30 MIG-E：创建人落 Transaction.createdById）
		const correctedTransaction = await ctx.prisma.transaction.findUniqueOrThrow({
			where: { id: purchaseIds[0] },
		});
		expect(correctedTransaction).toMatchObject({
			createdById: finance1.userId,
			organizationId: org.orgId,
			version: 2,
		});

		const afterCorrections = await readOrgLedgerSnapshot(ctx.prisma, org.orgId);
		// 重建后的批次的来源记录全部归买入人 Finance 1（批次无 user_id 列，创建人落在
		// 来源 Transaction.createdById），无一归更正者 Finance 2
		expect(afterCorrections.lots).toHaveLength(2);
		const lotSourceOwners = await ctx.prisma.transaction.findMany({
			where: { id: { in: afterCorrections.lots.map((lot) => lot.sourceId) } },
			select: { createdById: true },
		});
		expect(new Set(lotSourceOwners.map((row) => row.createdById))).toEqual(
			new Set([finance1.userId]),
		);
		expect(afterCorrections.lots.every((lot) => lot.organizationId === org.orgId)).toBe(true);
		const lotsAfterCorrections = lotsBySource(afterCorrections);
		expect(lotsAfterCorrections.get(purchaseIds[0])).toEqual([
			"7.82000000",
			"0.0000",
			org.orgId,
		]);
		expect(lotsAfterCorrections.get(purchaseIds[1])).toEqual([
			"8.00000000",
			"500.0000",
			org.orgId,
		]);
		expect(afterCorrections.allocations).toEqual([
			{ usageId, sourceId: purchaseIds[0], quantity: "1000.0000", cost: "7820.0000" },
			{ usageId, sourceId: purchaseIds[1], quantity: "500.0000", cost: "4000.0000" },
		]);
		expect(afterCorrections.usages[0]).toMatchObject({
			amount: "1500.0000",
			version: 2,
			createdById: finance2.userId,
		});
		expect(afterCorrections.planAllocations).toEqual([
			{ planId, amount: "1500.0000", usedAmount: "1500.0000" },
		]);

		// 一致性：三名成员读到的账户余额、计划分配、使用成本与报告完全相同
		const balances: string[] = [];
		for (const member of [org.owner, finance1, finance2]) {
			const account = await accountDetail(member, org.orgId).expect(200);
			balances.push(account.body.data.balance);
			const plan = await planDetail(member, org.orgId, planId).expect(200);
			expect(plan.body.data).toMatchObject({
				usedAmount: "1500.0000",
				allocatedAmount: "1500.0000",
			});
			const list = await usageList(member, org.orgId, planId).expect(200);
			expect(list.body.data.items[0]).toMatchObject({ id: usageId, cost: "11820.0000" });
			const report = await reportList(member, org.orgId).expect(200);
			expect(report.body.data.items).toEqual([
				expect.objectContaining({
					planId,
					usedQuantity: "1500.0000",
					usedTotalCost: "11820.0000",
					usedUnitCost: "7.88000000",
					hasUnknownFee: false,
				}),
			]);
			const detail = await reportDetail(member, org.orgId, planId).expect(200);
			expect(detail.body.data).toMatchObject({
				cost: { usedTotalCost: "11820.0000", usedUnitCost: "7.88000000" },
				sourceSplit: {
					initial: { quantity: "0.0000", cost: "0.0000" },
					purchase: { quantity: "1500.0000", cost: "11820.0000" },
				},
			});
		}
		expect(balances).toEqual(["500.0000", "500.0000", "500.0000"]);
		// 不变式：Σ批次剩余 = 账户余额（2,000 − 1,500）；每片成本 = 数量 × 批次单价（4 位 HALF_UP）
		const lotRemainingSum = afterCorrections.lots.reduce(
			(sum, lot) => sum.add(new Prisma.Decimal(lot.remainingQty)),
			new Prisma.Decimal(0),
		);
		expect(lotRemainingSum.toFixed(4)).toBe(balances[0]);
		for (const slice of afterCorrections.allocations) {
			const unitCost = new Prisma.Decimal(
				lotsAfterCorrections.get(slice.sourceId)![0],
			);
			expect(
				new Prisma.Decimal(slice.quantity).mul(unitCost).toFixed(4),
				slice.sourceId,
			).toBe(slice.cost);
		}

		// 更正日志显示所属组织与实际操作者，同组织成员都能看到
		for (const member of [org.owner, finance1]) {
			const history = await http()
				.get(`/api/corrections?targetType=TRANSACTION&targetId=${purchaseIds[0]}`)
				.set(orgHeaders(member, org.orgId))
				.expect(200);
			expect(history.body.data).toMatchObject({
				total: 1,
				items: [
					{
						id: txApplied.body.data.correctionId,
						organizationId: org.orgId,
						actorUserId: finance2.userId,
						status: "APPLIED",
					},
				],
			});
		}
		const usageHistory = await http()
			.get(`/api/corrections?targetType=USAGE&targetId=${usageId}`)
			.set(orgHeaders(finance1, org.orgId))
			.expect(200);
		expect(usageHistory.body.data.items[0]).toMatchObject({
			id: usageApplied.body.data.correctionId,
			organizationId: org.orgId,
			actorUserId: finance2.userId,
			status: "APPLIED",
		});

		// 同事务审计：两次 correction.apply 均为 Finance 2 发起，带各自的目标与 requestId
		const audits = await ctx.prisma.auditLog.findMany({
			where: { organizationId: org.orgId, action: "correction.apply" },
		});
		expect(audits).toHaveLength(2);
		expect(audits.find((row) => row.targetType === "usage_record")).toEqual(
			expect.objectContaining({
				actorUserId: finance2.userId,
				actorType: "USER",
				targetId: usageId,
				result: "SUCCESS",
				requestId: usageApplyRequestId,
			}),
		);
		expect(audits.find((row) => row.targetType === "transaction")).toEqual(
			expect.objectContaining({
				actorUserId: finance2.userId,
				actorType: "USER",
				targetId: purchaseIds[0],
				result: "SUCCESS",
				requestId: txApplyRequestId,
			}),
		);
	}, 60_000);

	/**
	 * W24-ISO-3：受邀成员记使用与更正按**完整组织账本**进行，余额不被高估。
	 *
	 * W30（MIG-E）后账本行一律直连组织（organization_id NOT NULL），不再存在
	 * 「存量 NULL 行待收口」的兼容窗口——本用例改为直接构造「创建者的行已归口到
	 * 组织」的账本，断言成员记使用与更正时按组织完整 FIFO 池重放、余额不被高估。
	 */
	it("W24-ISO-3 组织账本已完整收口：受邀成员记使用与更正仍按完整组织账本进行，余额不被高估", async () => {
		const org = await createOrgLedger(app, ctx.prisma, "w24-legacy-adopt", ["FINANCE"]);
		orgs.push(org);
		const owner = org.owner;
		const finance = org.members[0];
		const prisma = ctx.prisma;

		// 创建者的既有账本（已归口到组织）：
		// 买入 T1 1,000@7.8 → 使用 U1 300（耗 T1 批次 300）→ 计划 P1 分配 1,000 / 已用 300 → 账户 700
		const legacyTransaction = await prisma.transaction.create({
			data: {
				organizationId: org.orgId,
				createdById: owner.userId,
				currencyCode: "USD",
				quantity: "1000",
				principalAmount: "7800",
				feeAmount: "0",
				exchangeRate: "7.8",
				rateSource: "fixture",
				rateObservedAt: daysAgo(4),
				transactedAt: daysAgo(4),
			},
		});
		const legacyLot = await prisma.costLot.create({
			data: {
				organizationId: org.orgId,
				currencyCode: "USD",
				sourceType: "PURCHASE",
				sourceId: legacyTransaction.id,
				quantity: "1000",
				remainingQty: "700",
				unitCost: "7.8",
				totalCost: "7800",
				acquiredAt: daysAgo(4),
			},
		});
		const legacyPlan = await prisma.plan.create({
			data: {
				organizationId: org.orgId,
				createdById: owner.userId,
				targetCurrency: "USD",
				targetAmount: "1000",
				expectUseDate: new Date(PLAN_EXPECT_USE_DATE),
				latestPrepDate: new Date(PLAN_EXPECT_USE_DATE),
			},
		});
		await prisma.planAllocation.create({
			data: { planId: legacyPlan.id, amount: "1000", usedAmount: "300" },
		});
		const legacyUsage = await prisma.usageRecord.create({
			data: {
				organizationId: org.orgId,
				createdById: owner.userId,
				planId: legacyPlan.id,
				currencyCode: "USD",
				amount: "300",
				usedAt: daysAgo(2),
			},
		});
		await prisma.usageLotAllocation.create({
			data: { usageId: legacyUsage.id, lotId: legacyLot.id, quantity: "300", cost: "2340" },
		});
		await prisma.account.create({
			data: {
				organizationId: org.orgId,
				createdById: owner.userId,
				currencyCode: "USD",
				balance: "700",
			},
		});

		// Finance 买入 T2 1,000@8：组织账户 = 700 + 1,000 = 1,700
		const secondPurchaseId = (
			await postTx(finance, org.orgId, purchaseBody("USD", "1000", "8", daysAgo(1)))
				.expect(201)
		).body.data.id as string;
		expect(
			(await prisma.usageRecord.findUniqueOrThrow({ where: { id: legacyUsage.id } }))
				.organizationId,
		).toBe(org.orgId);
		expect(
			(
				await prisma.account.findFirstOrThrow({
					where: { organizationId: org.orgId, currencyCode: "USD" },
				})
			).balance.toFixed(4),
		).toBe("1700.0000");

		// Finance 建计划并记使用 600：从完整的组织 FIFO 池取批次
		//（既有批次 T1 更早 → 600 全部来自 T1：600×7.8 = 4,680）
		const memberPlanId = (await postPlan(finance, org.orgId, "1000", "800").expect(201))
			.body.data.id as string;
		const usage = await postUsage(finance, org.orgId, memberPlanId, {
			amount: "600",
			usedAt: utc8DayStart(new Date()).toISOString(),
		}).expect(201);
		expect(usage.body.data.usage.cost).toBe("4680.0000");
		expect(
			await prisma.usageRecord.findUniqueOrThrow({ where: { id: legacyUsage.id } }),
		).toMatchObject({
			organizationId: org.orgId,
			createdById: owner.userId,
		});
		expect(
			(
				await prisma.account.findFirstOrThrow({
					where: { organizationId: org.orgId, currencyCode: "USD" },
				})
			).balance.toFixed(4),
		).toBe("1100.0000");

		// Finance 更正自己的买入（补录手续费 20）：重放必须把已收口的存量使用 U1 算进去
		// 余额 = 2,000 − 300 − 600 = 1,100；若漏掉 U1 会写成 1,400（余额高估）
		await apply(finance, org.orgId, {
			targetType: "TRANSACTION",
			targetId: secondPurchaseId,
			baseVersion: 1,
			reason: "手续费当时漏填",
			changes: { feeAmount: "20" },
		}).expect(201);
		const afterCorrection = await readOrgLedgerSnapshot(prisma, org.orgId);
		const lotsAfterCorrection = lotsBySource(afterCorrection);
		expect(afterCorrection.accounts[0].balance).toBe("1100.0000");
		expect(lotsAfterCorrection.get(legacyTransaction.id)).toEqual([
			"7.80000000",
			"100.0000", // 1,000 − U1 300 − 新使用 600
			org.orgId,
		]);
		expect(lotsAfterCorrection.get(secondPurchaseId)).toEqual([
			"8.02000000",
			"1000.0000",
			org.orgId,
		]);
		expect(afterCorrection.lots).toHaveLength(2);
		// 组织账本此时包含两笔使用：已收口的存量使用与新使用
		expect(
			afterCorrection.usages.map((row) => [row.id, row.amount, row.organizationId]).sort(),
		).toEqual([
			[legacyUsage.id, "300.0000", org.orgId],
			[usage.body.data.usage.id, "600.0000", org.orgId],
		].sort());
		const lotRemaining = afterCorrection.lots.reduce(
			(sum, lot) => sum.add(new Prisma.Decimal(lot.remainingQty)),
			new Prisma.Decimal(0),
		);
		expect(lotRemaining.toFixed(4)).toBe("1100.0000");

		// Finance 更正这笔既有使用（改小到 200）：按组织口径仍可读取
		const legacyUsagePreview = await preview(finance, org.orgId, {
			targetType: "USAGE",
			targetId: legacyUsage.id,
			baseVersion: 1,
			reason: "使用金额多记了 100",
			changes: { amount: "200" },
		}).expect(200);
		expect(legacyUsagePreview.body.data.blockers).toEqual([]);
		expect(legacyUsagePreview.body.data.impacts.allocations[0]).toMatchObject({
			planId: legacyPlan.id,
			amountAfter: "900.0000",
			usedAfter: "200.0000",
		});
		await apply(finance, org.orgId, {
			targetType: "USAGE",
			targetId: legacyUsage.id,
			baseVersion: 1,
			reason: "使用金额多记了 100",
			changes: { amount: "200" },
			expectedUsageImpact: legacyUsagePreview.body.data.expectedUsageImpact,
		}).expect(201);
		// 余额 = 2,000 − 200 − 600 = 1,200；创建者与成员读到同一个数
		for (const member of [owner, finance]) {
			expect((await accountDetail(member, org.orgId).expect(200)).body.data.balance).toBe(
				"1200.0000",
			);
		}
		const legacyPlanAllocation = await prisma.planAllocation.findUniqueOrThrow({
			where: { planId: legacyPlan.id },
		});
		expect(legacyPlanAllocation.amount.toFixed(4)).toBe("900.0000");
		expect(legacyPlanAllocation.usedAmount.toFixed(4)).toBe("200.0000");
		const finalSnapshot = await readOrgLedgerSnapshot(prisma, org.orgId);
		expect(lotsBySource(finalSnapshot).get(legacyTransaction.id)).toEqual([
			"7.80000000",
			"200.0000",
			org.orgId,
		]);
	}, 60_000);
});
