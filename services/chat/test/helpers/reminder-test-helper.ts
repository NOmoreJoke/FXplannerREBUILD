import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { bearer, type TestUser } from "./test-app";
import { ensureAccount } from "./plan-test-helper";
import { TEST_PASSWORD } from "../fixtures/test-credentials";
import type { PrismaService } from "../../src/prisma/prisma.service";

/**
 * 提醒域测试共享工具（test/helpers，禁止 spec 间复制——AGENTS.md 测试约定）。
 *
 * 时钟策略：懒生成依赖「业务今天（UTC+8）」。接口/集成测试把 Date 冻结到
 * 「下一个工作日 D 的 00:00Z」（transaction.spec #11 的 toFake:["Date"] 局部冻结
 * 模式，禁全局 fake timers），使任意运行日下「业务今天」恒为工作日 D——
 * 建计划（startDate=D）首批节点必命中 D，R1 判定全确定，无周末 flaky。
 */

/** 从现在起（UTC 口径）首个工作日的 00:00Z（跳过周六日）；冻结时刻 = 它 */
function nextWorkdayUtcMidnight(): Date {
	const now = new Date();
	const day = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	);
	do {
		day.setUTCDate(day.getUTCDate() + 1);
	} while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
	return day;
}

/** 冻结时刻 = 下一个工作日 D 的 00:00Z（vi.useFakeTimers 的 now 入参） */
export const REMINDER_WORKDAY = nextWorkdayUtcMidnight();

/** 模块加载时刻（冻结前的真实时钟）：邮箱唯一性用它，防冻结后 Date.now() 跨次运行碰撞 409 */
const REAL_NOW_MS = Date.now();

/** 冻结时刻的 ISO（UTC 日历今天；排期/参数校验口径） */
export const REMINDER_TODAY_ISO = REMINDER_WORKDAY.toISOString();

/** from（00:00Z，须为工作日）之后第 n 个工作日的 00:00Z */
export function addWorkdays(from: Date, n: number): Date {
	const day = new Date(from);
	let left = n;
	while (left > 0) {
		day.setUTCDate(day.getUTCDate() + 1);
		if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) left--;
	}
	return day;
}

/** 注册 + 完成首次设置（reminderEnabled=true）+ USD 账户余额 10000 */
export async function onboardedUser(
	app: INestApplication,
	prisma: PrismaService,
	label: string,
): Promise<TestUser> {
	const user = await createOnboardedUser(app, label);
	await ensureAccount(prisma, user.userId, "USD", "10000");
	return user;
}

/** 注册 + 完成首次设置（不建账户；邮箱用真实时钟保证跨次运行唯一） */
export async function createOnboardedUser(
	app: INestApplication,
	label: string,
): Promise<TestUser> {
	const email = `rem-${label}-${REAL_NOW_MS}-${Math.random().toString(36).slice(2, 8)}@example.com`;
	const password = TEST_PASSWORD;
	await request(app.getHttpServer())
		.post("/api/auth/register")
		.send({ email, password, name: label })
		.expect(201);
	const res = await request(app.getHttpServer())
		.post("/api/auth/login")
		.send({ email, password })
		.expect(200);
	const user: TestUser = {
		email,
		password,
		accessToken: res.body.data.accessToken,
		userId: res.body.data.user.id,
	};
	await request(app.getHttpServer())
		.post("/api/onboarding/consents")
		.set(bearer(user.accessToken))
		.send({ age18Confirmed: true, termsConfirmed: true })
		.expect(201);
	await request(app.getHttpServer())
		.post("/api/onboarding/complete")
		.set(bearer(user.accessToken))
		.send({
			baseCurrency: "CNY",
			locale: "zh-CN",
			region: "CN",
			prepPreference: "balanced",
			reminderEnabled: true,
		})
		.expect(201);
	return user;
}

/** 建计划（startDate=业务今天 → 首批节点命中今天；分配 1000 → 缺口 9000） */
export function createPlanToday(
	app: INestApplication,
	user: TestUser,
	overrides: Record<string, unknown> = {},
) {
	return request(app.getHttpServer())
		.post("/api/plans")
		.set(bearer(user.accessToken))
		.send({
			targetCurrency: "USD",
			targetAmount: "10000",
			expectUseDate: addWorkdays(REMINDER_WORKDAY, 8).toISOString(),
			prepLeadDays: 3,
			pacePreference: "balanced",
			startDate: REMINDER_TODAY_ISO,
			allocatedAmount: "1000",
			...overrides,
		});
}

/** GET /api/reminders 快捷封装 */
export function getReminders(app: INestApplication, user: TestUser) {
	return request(app.getHttpServer())
		.get("/api/reminders")
		.set(bearer(user.accessToken));
}
