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
	REMINDER_TODAY_ISO,
	REMINDER_WORKDAY,
} from "../helpers/reminder-test-helper";
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
