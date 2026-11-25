import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { resolveDefaultOrganizationId } from "../../src/authorization/default-organization";
import { ensureOnboarded } from "../helpers/onboarding-helper";
import {
	orderLedgerRequests,
	raceBehindAdvisoryLock,
} from "../helpers/postgres-lock-barrier";
import {
	bearer,
	cleanupUser,
	createTestApp,
	createTestUser,
	type TestContext,
} from "../helpers/test-app";

const scenarios = [
	{
		name: "先更正再下调分配",
		operations: ["correct", "adjust"],
		statuses: [201, 400],
		rejection: "PLAN_ALLOCATION_BELOW_USED",
		planStatus: "ACTIVE", allocated: "600", used: "550", balance: "450",
		usages: [["550", 2]], audits: ["APPLIED"],
	},
	{
		name: "先下调分配再更正，重新确认后按新分配补足",
		operations: ["adjust", "correct"],
		statuses: [200, 409],
		rejection: "CORRECTION_TARGET_CHANGED",
		reconfirm: true,
		planStatus: "ACTIVE", allocated: "550", used: "550", balance: "450",
		usages: [["550", 2]], audits: ["APPLIED"],
	},
	{
		name: "先取消再更正",
		operations: ["cancel", "correct"],
		statuses: [200, 409],
		rejection: "CORRECTION_TARGET_CHANGED",
		planStatus: "CANCELLED", allocated: "400", used: "400", balance: "600",
		usages: [["400", 1]], audits: [],
	},
	{
		name: "先更正再取消，保留更正后的已用",
		operations: ["correct", "cancel"],
		statuses: [201, 200],
		planStatus: "CANCELLED", allocated: "550", used: "550", balance: "450",
		usages: [["550", 2]], audits: ["APPLIED"],
	},
	{
		name: "先取消再记录使用",
		operations: ["cancel", "use"],
		statuses: [200, 409],
		rejection: "PLAN_INVALID_TRANSITION",
		planStatus: "CANCELLED", allocated: "400", used: "400", balance: "600",
		usages: [["400", 1]], audits: [],
	},
	{
		name: "先记录使用再取消，保留两笔已用",
		operations: ["use", "cancel"],
		statuses: [201, 200],
		planStatus: "CANCELLED", allocated: "500", used: "500", balance: "500",
		usages: [["400", 1], ["100", 1]], audits: [],
	},
	{
		name: "先更正再记录使用，按最新剩余分配拒绝",
		operations: ["correct", "use"],
		statuses: [201, 409],
		rejection: "INSUFFICIENT_PLAN_ALLOCATION",
		planStatus: "ACTIVE", allocated: "600", used: "550", balance: "450",
		usages: [["550", 2]], audits: ["APPLIED"],
	},
	{
		name: "先记录使用再更正，重新确认后按最新已用补分配",
		operations: ["use", "correct"],
		statuses: [201, 409],
		rejection: "CORRECTION_TARGET_CHANGED",
		reconfirm: true,
		planStatus: "ACTIVE", allocated: "650", used: "650", balance: "350",
		usages: [["550", 2], ["100", 1]], audits: ["APPLIED"],
	},
] as const;

function dateAtOffset(days: number): string {
	const date = new Date();
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString();
}

describe("计划与账本写入串行化（W6-02）", () => {
	let ctx: TestContext;
	let userId: string | undefined;

	beforeEach(async () => {
		userId = undefined;
		ctx = await createTestApp();
	});

	afterEach(async () => {
		try {
			if (!userId) return;
			// cleanupUser：裸外键派生行清理 + 回收注册兜底创建的默认组织（及其审计行）
			// + 删除用户。此前直接 user.delete：Membership 随用户级联而组织不级联，
			// 每次全量跑在共享本地库留下 8 条无成员的孤儿组织（实测定位的残留来源）。
			await cleanupUser(ctx.prisma, userId);
		} finally {
			await ctx.app.close();
		}
	});

	it.each(scenarios)("$name", async (scenario) => {
		const { app, prisma } = ctx;
		const user = await createTestUser(app, "plan-ledger-lock");
		userId = user.userId;
		await ensureOnboarded(prisma, user.userId);
		const auth = bearer(user.accessToken);
		const http = request(app.getHttpServer());
		await http.post("/api/transactions").set(auth).send({
			currencyCode: "USD",
			principalAmount: "7000",
			quantity: "1000",
			exchangeRate: "7",
			transactedAt: dateAtOffset(-3),
		}).expect(201);
		const created = await http.post("/api/plans").set(auth).send({
			targetCurrency: "USD",
			targetAmount: "1000",
			allocatedAmount: "600",
			expectUseDate: dateAtOffset(30),
			prepLeadDays: 3,
			pacePreference: "balanced",
			startDate: dateAtOffset(5),
		}).expect(201);
		const planPath = `/api/plans/${created.body.data.id}`;
		const initialUsage = await http.post(`${planPath}/usages`).set(auth).send({
			amount: "400",
			usedAt: dateAtOffset(-2),
		}).expect(201);
		const plan = await prisma.plan.findUniqueOrThrow({
			where: { id: created.body.data.id },
		});
		const correction = {
			targetType: "USAGE",
			targetId: initialUsage.body.data.usage.id,
			baseVersion: 1,
			reason: "按实际使用更正",
			changes: { amount: "550" },
		};
		const preview = () => http.post("/api/corrections/preview").set(auth).send(correction);
		const confirm = (expectedUsageImpact: string) =>
			http.post("/api/corrections").set(auth).send({ ...correction, expectedUsageImpact });
		const initial = scenario.operations.some((operation) => operation === "correct")
			? (await preview().expect(200)).body.data
			: undefined;
		const operations = {
			correct: async () => confirm(initial.expectedUsageImpact),
			adjust: async () => http.patch(planPath).set(auth).send({
				expectedUpdatedAt: plan.updatedAt.toISOString(),
				newAllocAmount: "400",
			}),
			cancel: async () => http.post(`${planPath}/cancel`).set(auth),
			use: async () => http.post(`${planPath}/usages`).set(auth).send({
				amount: "100",
				usedAt: dateAtOffset(-1),
			}),
		};

		const [first, second] = await orderLedgerRequests(
			prisma, plan.id, operations[scenario.operations[0]], operations[scenario.operations[1]],
		);
		expect(
			[first.status, second.status],
			JSON.stringify([first.body, second.body]),
		).toEqual(scenario.statuses);
		if ("rejection" in scenario) {
			expect(second.body.code).toBe(scenario.rejection);
		}
		if ("reconfirm" in scenario) {
			expect(await prisma.correction.count({ where: { userId: user.userId } })).toBe(0);
			const refreshed = (await preview().expect(200)).body.data;
			expect(refreshed.expectedUsageImpact).not.toBe(initial.expectedUsageImpact);
			await confirm(refreshed.expectedUsageImpact).expect(201);
		}
		if (scenario.name === "先取消再更正") {
			const invalid = await preview().expect(400);
			expect(invalid.body.code).toBe("CORRECTION_NOT_ALLOWED");
		}

		const [persistedPlan, allocation, account, lots, usages, corrections] = await Promise.all([
			prisma.plan.findUniqueOrThrow({ where: { id: plan.id } }),
			prisma.planAllocation.findUniqueOrThrow({ where: { planId: plan.id } }),
			prisma.account.findFirstOrThrow({
				where: { userId: user.userId, currencyCode: "USD" },
			}),
			prisma.costLot.aggregate({ where: { userId: user.userId }, _sum: { remainingQty: true } }),
			prisma.usageRecord.findMany({ where: { planId: plan.id }, orderBy: { usedAt: "asc" } }),
			prisma.correction.findMany({ where: { userId: user.userId } }),
		]);
		expect(persistedPlan.status).toBe(scenario.planStatus);
		expect(allocation.amount.toString()).toBe(scenario.allocated);
		expect(allocation.usedAmount.toString()).toBe(scenario.used);
		expect(allocation.usedAmount.lte(allocation.amount)).toBe(true);
		expect(account.balance.toString()).toBe(scenario.balance);
		expect(lots._sum.remainingQty?.toString()).toBe(scenario.balance);
		expect(usages.map((usage) => [usage.amount.toString(), usage.version])).toEqual(scenario.usages);
		expect(corrections.map((correction) => correction.status)).toEqual(scenario.audits);
	});
});

describe("ToB R1 W23：多成员并发交易与计划分配锁竞争（支持 -t 独立运行）", () => {
	let ctx: TestContext;
	const scopedUserIds: string[] = [];
	const scopedPlanIds: string[] = [];

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		try {
			if (scopedPlanIds.length > 0) {
				await ctx.prisma.planAllocation.deleteMany({
					where: { planId: { in: scopedPlanIds.splice(0) } },
				});
			}
			while (scopedUserIds.length > 0) {
				const uid = scopedUserIds.pop()!;
				await cleanupUser(ctx.prisma, uid);
			}
		} finally {
			await ctx.app.close();
		}
	});

	it("W23-CONC-1 多成员并发买入与建计划分配：余额、未分配额与同事务审计数严格一致", async () => {
		const { app, prisma } = ctx;
		const owner = await createTestUser(app, "w23-conc-owner");
		scopedUserIds.push(owner.userId);
		const finance = await createTestUser(app, "w23-conc-fin");
		scopedUserIds.push(finance.userId);
		const operatorA = await createTestUser(app, "w23-conc-opa");
		scopedUserIds.push(operatorA.userId);
		const operatorB = await createTestUser(app, "w23-conc-opb");
		scopedUserIds.push(operatorB.userId);
		await ensureOnboarded(prisma, owner.userId);
		const orgId = (await resolveDefaultOrganizationId(prisma, owner.userId))!;
		await prisma.membership.createMany({
			data: [
				{ organizationId: orgId, userId: finance.userId, role: "FINANCE", status: "ACTIVE" },
				{ organizationId: orgId, userId: operatorA.userId, role: "OPERATOR", status: "ACTIVE" },
				{ organizationId: orgId, userId: operatorB.userId, role: "OPERATOR", status: "ACTIVE" },
			],
		});

		const http = request(app.getHttpServer());
		// 初始买入 USD 500
		await http
			.post("/api/transactions")
			.set(bearer(finance.accessToken))
			.set("X-Organization-Id", orgId)
			.send({
				currencyCode: "USD",
				principalAmount: "3600.00",
				exchangeRate: "7.20000000",
				quantity: "500.00",
				transactedAt: dateAtOffset(-2),
			})
			.expect(201);

		// 竞争 1：Operator A 与 Operator B 并发分配 400（余额 500 → 恰一 201、恰一 409）
		const [resOpA, resOpB] = await raceBehindAdvisoryLock(
			prisma,
			`membership:${orgId}`,
			[
				() =>
					http
						.post("/api/plans")
						.set(bearer(operatorA.accessToken))
						.set("X-Organization-Id", orgId)
						.send({
							targetCurrency: "USD",
							targetAmount: "1000",
							allocatedAmount: "400",
							expectUseDate: dateAtOffset(30),
							prepLeadDays: 3,
							pacePreference: "balanced",
							startDate: dateAtOffset(5),
						}),
				() =>
					http
						.post("/api/plans")
						.set(bearer(operatorB.accessToken))
						.set("X-Organization-Id", orgId)
						.send({
							targetCurrency: "USD",
							targetAmount: "1000",
							allocatedAmount: "400",
							expectUseDate: dateAtOffset(30),
							prepLeadDays: 3,
							pacePreference: "balanced",
							startDate: dateAtOffset(5),
						}),
			],
		);
		const statuses = [resOpA.status, resOpB.status].sort((a, b) => a - b);
		expect(statuses).toEqual([201, 409]);
		const rejected = resOpA.status === 409 ? resOpA : resOpB;
		const winner = resOpA.status === 201 ? resOpA : resOpB;
		scopedPlanIds.push(winner.body.data.id as string);
		expect(rejected.body.code).toBe("INSUFFICIENT_ALLOCATABLE_BALANCE");
		expect(rejected.body.data.allocatableBalance).toBe("100.0000");

		// 竞争 2：Finance 买入 +300 与 Operator A 再建计划分配 100 并发
		const [resTx, resPlan2] = await raceBehindAdvisoryLock(
			prisma,
			`membership:${orgId}`,
			[
				() =>
					http
						.post("/api/transactions")
						.set(bearer(finance.accessToken))
						.set("X-Organization-Id", orgId)
						.send({
							currencyCode: "USD",
							principalAmount: "2160.00",
							exchangeRate: "7.20000000",
							quantity: "300.00",
							transactedAt: dateAtOffset(-1),
						}),
				() =>
					http
						.post("/api/plans")
						.set(bearer(operatorA.accessToken))
						.set("X-Organization-Id", orgId)
						.send({
							targetCurrency: "USD",
							targetAmount: "1000",
							allocatedAmount: "100",
							expectUseDate: dateAtOffset(30),
							prepLeadDays: 3,
							pacePreference: "balanced",
							startDate: dateAtOffset(5),
						}),
			],
		);
		expect(resTx.status).toBe(201);
		expect(resPlan2.status).toBe(201);
		scopedPlanIds.push(resPlan2.body.data.id as string);

		const [account, lotsAgg, plans, audits] = await Promise.all([
			prisma.account.findUniqueOrThrow({
				where: {
					organizationId_currencyCode: {
						organizationId: orgId,
						currencyCode: "USD",
					},
				},
			}),
			prisma.costLot.aggregate({
				where: { organizationId: orgId, currencyCode: "USD" },
				_sum: { remainingQty: true },
			}),
			prisma.plan.findMany({
				where: { organizationId: orgId },
				select: { id: true },
			}),
			prisma.auditLog.findMany({
				where: {
					organizationId: orgId,
					action: { in: ["transaction.create", "plan.create"] },
					result: "SUCCESS",
				},
			}),
		]);
		const allocations = await prisma.planAllocation.findMany({
			where: { planId: { in: plans.map((p) => p.id) } },
		});
		const totalAllocated = allocations.reduce(
			(sum, row) => sum.add(row.amount),
			new Prisma.Decimal(0),
		);
		expect(account.balance.toFixed(4)).toBe("800.0000");
		expect(lotsAgg._sum.remainingQty?.toFixed(4)).toBe("800.0000");
		expect(totalAllocated.toFixed(4)).toBe("500.0000");
		expect(account.balance.sub(totalAllocated).toFixed(4)).toBe("300.0000");
		expect(audits).toHaveLength(4); // 2 transactions + 2 plans
	});
});
