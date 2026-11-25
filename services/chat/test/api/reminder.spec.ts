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
	createPlanToday,
	getReminders,
	onboardedUser,
	REMINDER_WORKDAY,
} from "../helpers/reminder-test-helper";
import {
	cleanupOrgLedgers,
	createOrgLedger,
	createSecondOrg,
	orgHeaders,
	type OrgLedger,
} from "../helpers/organization-ledger-test-helper";
import { ensureAccount } from "../helpers/plan-test-helper";
import { utcPlus8Midnight } from "../../src/reminder/reminder-rules";

// 关闭全局接口限流（先例：transaction.spec/plan.spec——APP_GUARD token 被 scanner 改写，只能 mock 类）
vi.mock("@nestjs/throttler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nestjs/throttler")>();
	class NoopThrottlerGuard {
		async canActivate() {
			return true;
		}
	}
	return { ...actual, ThrottlerGuard: NoopThrottlerGuard };
});

/**
 * 提醒接口测试（reminders 技术方案 §10.2）：GET /reminders（内置懒生成）、
 * POST /reminders/:id/read、POST /reminders/read-all 的契约/鉴权/越权/幂等/开关。
 *
 * 时钟策略：懒生成依赖「业务今天（UTC+8）」。把 Date 冻结到「下一个工作日 D 的
 * UTC 0 点」（transaction.spec #11 的 toFake:["Date"] 局部冻结模式，禁全局 fake
 * timers），使任意运行日下「业务今天」恒为工作日 D——建计划（startDate=D）首批
 * 节点必命中 D，R1 判定全确定，无周末 flaky。
 */

describe("ReminderController（接口）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let user: TestUser; // 主用户（建计划触发 PREP_DUE）
	let other: TestUser; // 第二用户（越权用例）
	const userIds: string[] = [];

	beforeAll(async () => {
		// 冻结「今天」为工作日 D 的 00:00Z（仅冻结流逝，先例 transaction.spec #11）
		vi.useFakeTimers({ toFake: ["Date"], now: REMINDER_WORKDAY.getTime() });
		ctx = await createTestApp();
		app = ctx.app;
		user = await onboardedUser(app, ctx.prisma, "rem-main");
		other = await onboardedUser(app, ctx.prisma, "rem-other");
		userIds.push(user.userId, other.userId);
		// USD 账户余额（建计划分配校验的前置；plan-test-helper 造数先例）
		await ensureAccount(ctx.prisma, user.userId, "USD", "10000");
		await ensureAccount(ctx.prisma, other.userId, "USD", "10000");
	});

	afterAll(async () => {
		vi.useRealTimers();
		for (const id of userIds) {
			await cleanupUser(ctx.prisma, id);
		}
		await app.close();
	});

	it("#1 未登录 GET /reminders → 401", async () => {
		await request(app.getHttpServer()).get("/api/reminders").expect(401);
	});

	it("#2 未建账 GET /reminders → 409 ONBOARDING_NOT_COMPLETED", async () => {
		const fresh = await createTestUser(app, "rem-fresh");
		userIds.push(fresh.userId);
		const res = await request(app.getHttpServer())
			.get("/api/reminders")
			.set(bearer(fresh.accessToken))
			.expect(409);
		expect(res.body.code).toBe("ONBOARDING_NOT_COMPLETED");
	});

	it("#3 建计划（构造今天为节点日）后 GET → 1 行 PREP_DUE，unreadCount=1，字段契约完整", async () => {
		const created = await createPlanToday(app, user).expect(201);
		const planId = created.body.data.id;

		const res = await getReminders(app, user);
		expect(res.body.success).toBe(true);
		expect(res.body.data.items).toHaveLength(1);
		expect(res.body.data.unreadCount).toBe(1);

		const item = res.body.data.items[0];
		expect(item.planId).toBe(planId);
		expect(item.planName).toBeNull();
		expect(item.targetCurrency).toBe("USD");
		expect(item.scheduledFor).toBe(
			utcPlus8Midnight(REMINDER_WORKDAY).toISOString(),
		);
		expect(item.readAt).toBeNull();
		expect(item.recordedType).toBe("PREP_DUE");
		expect(item.matters).toHaveLength(1);
		expect(item.matters[0]).toEqual({
			kind: "PREP_DUE",
			installmentAmount: "3000.0000",
			gapAmount: "9000.0000",
			isFundsReady: false,
			daysOverdue: null,
		});
	});

	it("#4 连续两次 GET → items 数量与 id 不变（幂等），金额固定 4 位小数", async () => {
		const first = await getReminders(app, user);
		const second = await getReminders(app, user);
		expect(second.body.data.items).toHaveLength(first.body.data.items.length);
		expect(second.body.data.items[0].id).toBe(first.body.data.items[0].id);
		expect(second.body.data.unreadCount).toBe(first.body.data.unreadCount);
		for (const key of ["installmentAmount", "gapAmount"] as const) {
			expect(second.body.data.items[0].matters[0][key]).toMatch(/^\d+\.\d{4}$/);
		}
	});

	it("#5 POST /:id/read 本人行 → 200 返回 readAt；重复调用幂等", async () => {
		const list = await getReminders(app, user);
		const id = list.body.data.items[0].id;

		const first = await request(app.getHttpServer())
			.post(`/api/reminders/${id}/read`)
			.set(bearer(user.accessToken))
			.expect(200);
		expect(first.body.data.id).toBe(id);
		expect(typeof first.body.data.readAt).toBe("string");

		const second = await request(app.getHttpServer())
			.post(`/api/reminders/${id}/read`)
			.set(bearer(user.accessToken))
			.expect(200);
		expect(second.body.data.readAt).toBe(first.body.data.readAt);

		// 已读后 unreadCount 归零，条目仍返回（readAt 非空）
		const after = await getReminders(app, user);
		expect(after.body.data.unreadCount).toBe(0);
		expect(after.body.data.items[0].readAt).toBe(first.body.data.readAt);
	});

	it("#6 POST 他人 reminder id → 404 REMINDER_NOT_FOUND（不泄露存在性）", async () => {
		const list = await getReminders(app, user);
		const id = list.body.data.items[0].id;
		const res = await request(app.getHttpServer())
			.post(`/api/reminders/${id}/read`)
			.set(bearer(other.accessToken))
			.expect(404);
		expect(res.body.code).toBe("REMINDER_NOT_FOUND");
		// 本人行未被他人标读
		const after = await getReminders(app, user);
		expect(after.body.data.unreadCount).toBe(0); // #5 已读
		expect(after.body.data.items[0].readAt).not.toBeNull();
	});

	it("#7 POST /read-all → updatedCount=未读数；再调 updatedCount=0（幂等）", async () => {
		// other 用户建计划触发自己的未读行
		await createPlanToday(app, other).expect(201);
		const before = await getReminders(app, other);
		expect(before.body.data.unreadCount).toBe(1);

		const first = await request(app.getHttpServer())
			.post("/api/reminders/read-all")
			.set(bearer(other.accessToken))
			.expect(200);
		expect(first.body.data.updatedCount).toBe(1);

		const second = await request(app.getHttpServer())
			.post("/api/reminders/read-all")
			.set(bearer(other.accessToken))
			.expect(200);
		expect(second.body.data.updatedCount).toBe(0);
	});

	it("#8 PATCH /settings reminderEnabled=false → 不再生成新行；既有行仍返回", async () => {
		await request(app.getHttpServer())
			.patch("/api/settings")
			.set(bearer(other.accessToken))
			.send({ reminderEnabled: false })
			.expect(200);

		// 删除既有行模拟「行消失」；开关关闭下 GET 不得重新生成
		await ctx.prisma.reminder.deleteMany({ where: { userId: other.userId } });
		const closed = await getReminders(app, other);
		expect(closed.body.data.items).toHaveLength(0);

		// 既有行保留时照常返回（开关只关「生成」，不关「展示」）
		const otherPlan = await ctx.prisma.plan.findFirstOrThrow({
			where: { userId: other.userId },
		});
		const kept = await ctx.prisma.reminder.create({
			data: {
				userId: other.userId,
				type: "PREP_DUE",
				planId: otherPlan.id,
				dedupKey: `PLAN:${otherPlan.id}`,
				scheduledFor: utcPlus8Midnight(REMINDER_WORKDAY),
			},
		});
		const shown = await getReminders(app, other);
		expect(
			shown.body.data.items.map((item: { id: string }) => item.id),
		).toContain(kept.id);

		// 重新开启 → 恢复生成（同日已有行仍幂等，不新增）
		await request(app.getHttpServer())
			.patch("/api/settings")
			.set(bearer(other.accessToken))
			.send({ reminderEnabled: true })
			.expect(200);
		const reopened = await getReminders(app, other);
		expect(reopened.body.data.items).toHaveLength(1);
	});

	it("#9 GET 返回的 matters 不含非 ACTIVE 计划 → 取消后行不可见", async () => {
		const plans = await ctx.prisma.plan.findMany({
			where: { userId: user.userId },
		});
		expect(plans.length).toBeGreaterThan(0);
		await request(app.getHttpServer())
			.post(`/api/plans/${plans[0].id}/cancel`)
			.set(bearer(user.accessToken))
			.expect(200);

		const res = await getReminders(app, user);
		expect(res.body.data.items).toHaveLength(0);
		// 行未删（DB 保留；重开后按规则自然恢复）
		const remaining = await ctx.prisma.reminder.findMany({
			where: { userId: user.userId },
		});
		expect(remaining.length).toBeGreaterThan(0);
	});
});

/**
 * 成员级已读与组织隔离（Goal #3B W25；LEDGER-03，收口 Goal #3A §6.3 遗留）。
 *
 * 断言要点：
 * - 受邀成员（VIEWER / OPERATOR / FINANCE）标已读 200，数据库**只写该成员自己的**
 *   ReminderRead；共享的 Reminder.readAt 保持 null（行主一读不替他人清除未读）；
 * - 同组织成员 A 标已读不影响成员 B 与行主的未读态；
 * - 跨组织（另一个组织的组织头）与已被移除（DISABLED）成员一律 404，且无写入副作用。
 *
 * 组织与成员经 test/helpers/organization-ledger-test-helper.ts 造数（成员直插
 * Membership，角色即权限真源）；计划直插并带 organizationId = 组织（模拟 W23
 * Actor 化写路径），懒生成时行归属当前组织。
 */
describe("ReminderController（成员级已读与组织隔离）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const orgs: OrgLedger[] = [];

	/**
	 * 每个用例一套**独立**组织与组织内计划 + 提醒行：保证新增用例支持 -t 单用例
	 * 独立运行（不依赖前序用例的已读态与计数）。
	 */
	async function setupOrgReminder(
		label: string,
		roles: Array<"VIEWER" | "OPERATOR" | "FINANCE">,
	): Promise<{ org: OrgLedger; reminderId: string }> {
		const org = await createOrgLedger(app, ctx.prisma, label, roles);
		orgs.push(org);
		// 组织内计划（预计使用日 = 业务今天 → R3 USE_DUE 事项）
		const plan = await ctx.prisma.plan.create({
			data: {
				userId: org.owner.userId,
				organizationId: org.orgId,
				createdById: org.owner.userId,
				targetCurrency: "USD",
				targetAmount: "10000",
				expectUseDate: REMINDER_WORKDAY,
				latestPrepDate: REMINDER_WORKDAY,
				planStartDate: REMINDER_WORKDAY,
				status: "ACTIVE",
			},
		});
		await ctx.prisma.planAllocation.create({
			data: { planId: plan.id, amount: "0", usedAmount: "0" },
		});
		// 行主先读一次 → 懒生成组织内提醒行（行归属当前组织）
		const list = await request(app.getHttpServer())
			.get("/api/reminders")
			.set(orgHeaders(org.owner, org.orgId))
			.expect(200);
		expect(list.body.data.items).toHaveLength(1);
		return { org, reminderId: list.body.data.items[0].id };
	}

	/** 组织内提醒列表（按当前成员视角） */
	function listReminders(user: TestUser, orgId: string) {
		return request(app.getHttpServer())
			.get("/api/reminders")
			.set(orgHeaders(user, orgId));
	}

	/** 已读行 id 列表（成员级 ReminderRead） */
	async function readUserIds(reminderId: string): Promise<string[]> {
		const reads = await ctx.prisma.reminderRead.findMany({
			where: { reminderId },
			select: { userId: true },
		});
		return reads.map((read) => read.userId);
	}

	beforeAll(async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: REMINDER_WORKDAY.getTime() });
		ctx = await createTestApp();
		app = ctx.app;
	});

	afterAll(async () => {
		vi.useRealTimers();
		for (const org of orgs) {
			await cleanupOrgLedgers(ctx.prisma, org);
		}
		await app.close();
	});

	it("W25-1 受邀成员（VIEWER）单条标已读 → 200；只写该成员的 ReminderRead，Reminder.readAt 保持 null", async () => {
		const { org, reminderId } = await setupOrgReminder("rem-w25-1", [
			"VIEWER",
		]);
		const member = org.members[0];
		const res = await request(app.getHttpServer())
			.post(`/api/reminders/${reminderId}/read`)
			.set(orgHeaders(member, org.orgId))
			.expect(200);
		expect(res.body.data.id).toBe(reminderId);
		expect(typeof res.body.data.readAt).toBe("string");

		// 数据库只写该成员自己的成员级已读行
		expect(await readUserIds(reminderId)).toEqual([member.userId]);
		const row = await ctx.prisma.reminder.findUniqueOrThrow({
			where: { id: reminderId },
		});
		expect(row.readAt).toBeNull(); // 共享 readAt 未被写入
	});

	it("W25-2 成员 A 标已读不影响成员 B 与行主的未读态", async () => {
		const { org, reminderId } = await setupOrgReminder("rem-w25-2", [
			"VIEWER",
			"OPERATOR",
		]);
		const [memberA, memberB] = org.members;

		await request(app.getHttpServer())
			.post(`/api/reminders/${reminderId}/read`)
			.set(orgHeaders(memberA, org.orgId))
			.expect(200);

		// 行主视角：仍未读
		const ownerList = await listReminders(org.owner, org.orgId).expect(200);
		const ownerItem = ownerList.body.data.items.find(
			(item: { id: string }) => item.id === reminderId,
		);
		expect(ownerItem.readAt).toBeNull();
		expect(ownerList.body.data.unreadCount).toBe(1);

		// 其他受邀成员视角：仍未读
		const otherList = await listReminders(memberB, org.orgId).expect(200);
		const otherItem = otherList.body.data.items.find(
			(item: { id: string }) => item.id === reminderId,
		);
		expect(otherItem.readAt).toBeNull();

		// 标已读的成员视角：已读
		const memberList = await listReminders(memberA, org.orgId).expect(200);
		const memberItem = memberList.body.data.items.find(
			(item: { id: string }) => item.id === reminderId,
		);
		expect(memberItem.readAt).not.toBeNull();
		expect(memberList.body.data.unreadCount).toBe(0);
	});

	it("W25-3 受邀成员（OPERATOR）全部已读 → 200 updatedCount=1；再调为 0（幂等）；只写自己的 ReminderRead", async () => {
		const { org, reminderId } = await setupOrgReminder("rem-w25-3", [
			"OPERATOR",
		]);
		const member = org.members[0];
		const first = await request(app.getHttpServer())
			.post("/api/reminders/read-all")
			.set(orgHeaders(member, org.orgId))
			.expect(200);
		expect(first.body.data.updatedCount).toBe(1);

		const second = await request(app.getHttpServer())
			.post("/api/reminders/read-all")
			.set(orgHeaders(member, org.orgId))
			.expect(200);
		expect(second.body.data.updatedCount).toBe(0);

		// 只写当前成员自己的成员级已读行
		expect(await readUserIds(reminderId)).toEqual([member.userId]);
		const row = await ctx.prisma.reminder.findUniqueOrThrow({
			where: { id: reminderId },
		});
		expect(row.readAt).toBeNull(); // 共享 readAt 仍未被写入
	});

	it("W25-4 受邀成员（FINANCE）单条标已读 → 200（三个受邀角色均可标已读）", async () => {
		const { org, reminderId } = await setupOrgReminder("rem-w25-4", [
			"FINANCE",
		]);
		const member = org.members[0];
		const res = await request(app.getHttpServer())
			.post(`/api/reminders/${reminderId}/read`)
			.set(orgHeaders(member, org.orgId))
			.expect(200);
		expect(res.body.data.id).toBe(reminderId);
		expect(await readUserIds(reminderId)).toEqual([member.userId]);
	});

	it("W25-5 跨组织（另一个组织的组织头）标已读 → 404 REMINDER_NOT_FOUND，且无写入副作用", async () => {
		const { org, reminderId } = await setupOrgReminder("rem-w25-5", []);
		// owner 另建的空组织（非默认组织）：组织头指向它，目标提醒不可见
		const otherOrg = await createSecondOrg(
			ctx.prisma,
			org.owner,
			"rem-w25-5-b",
		);
		orgs.push(otherOrg);

		const res = await request(app.getHttpServer())
			.post(`/api/reminders/${reminderId}/read`)
			.set(orgHeaders(org.owner, otherOrg.orgId))
			.expect(404);
		expect(res.body.code).toBe("REMINDER_NOT_FOUND");
		expect(await readUserIds(reminderId)).not.toContain(org.owner.userId);

		// 全部已读在另一个组织作用域内没有目标行：200 且 updatedCount = 0（不误标他组织）
		const all = await request(app.getHttpServer())
			.post("/api/reminders/read-all")
			.set(orgHeaders(org.owner, otherOrg.orgId))
			.expect(200);
		expect(all.body.data.updatedCount).toBe(0);
		expect(await readUserIds(reminderId)).not.toContain(org.owner.userId);
	});

	it("W25-6 已被移除（DISABLED）的成员标已读 / 全部已读 → 404，且无写入副作用", async () => {
		const { org, reminderId } = await setupOrgReminder("rem-w25-6", [
			"FINANCE",
		]);
		const member = org.members[0];
		await ctx.prisma.membership.update({
			where: {
				organizationId_userId: {
					organizationId: org.orgId,
					userId: member.userId,
				},
			},
			data: { status: "DISABLED" },
		});

		const single = await request(app.getHttpServer())
			.post(`/api/reminders/${reminderId}/read`)
			.set(orgHeaders(member, org.orgId))
			.expect(404);
		expect(single.body.code).toBe("ORGANIZATION_NOT_FOUND");

		const all = await request(app.getHttpServer())
			.post("/api/reminders/read-all")
			.set(orgHeaders(member, org.orgId))
			.expect(404);
		expect(all.body.code).toBe("ORGANIZATION_NOT_FOUND");

		// 无写入副作用：已读行集合为空
		expect(await readUserIds(reminderId)).toEqual([]);
	});
});
