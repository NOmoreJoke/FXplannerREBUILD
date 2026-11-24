import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureOnboarded } from "../helpers/onboarding-helper";
import { orderLedgerRequests } from "../helpers/postgres-lock-barrier";
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
			prisma.account.findUniqueOrThrow({
				where: { userId_currencyCode: { userId: user.userId, currencyCode: "USD" } },
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
