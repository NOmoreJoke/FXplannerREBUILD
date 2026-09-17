import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import {
	bearer,
	cleanupUser,
	createTestApp,
	createTestUser,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";

// 关闭全局接口限流（先例：transaction.spec/plan.spec——APP_GUARD token 无法 override，只能 mock 类）
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
 * 接口测试 ↔ src/settings/settings.controller.ts
 * GET / PATCH /api/settings：完整视图、白名单更新、本位币只读（无更新通道）
 *
 * 注（§8.2 行 11 的豁免说明）：「PATCH 改偏好后 home/state 同步反映」——
 * home/state 只返回分流布尔与摘要、不承载偏好字段（后端数据中立约定），
 * 偏好同步以 GET /settings 断言为准，home/state 部分豁免。
 */
describe("SettingsController（e2e）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let user: TestUser;

	const wizard = {
		region: "CN",
		locale: "zh-CN",
		baseCurrency: "CNY",
		prepPreference: "balanced",
		reminderEnabled: true,
	};

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		user = await createTestUser(app, "settings");
	});

	afterAll(async () => {
		if (user) await cleanupUser(ctx.prisma, user.userId);
		await app.close();
	});

	it("GET /settings 无 token 应该 401", () => {
		return request(app.getHttpServer()).get("/api/settings").expect(401);
	});

	it("PATCH /settings 无 token 应该 401", () => {
		return request(app.getHttpServer())
			.patch("/api/settings")
			.send({ locale: "en" })
			.expect(401);
	});

	it("未建账 GET → 409 ONBOARDING_NOT_COMPLETED", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/settings")
			.set(bearer(user.accessToken))
			.expect(409);

		expect(res.body.code).toBe("ONBOARDING_NOT_COMPLETED");
	});

	it("未建账 PATCH → 409 ONBOARDING_NOT_COMPLETED", async () => {
		const res = await request(app.getHttpServer())
			.patch("/api/settings")
			.set(bearer(user.accessToken))
			.send({ locale: "en" })
			.expect(409);

		expect(res.body.code).toBe("ONBOARDING_NOT_COMPLETED");
	});

	it("建账后 GET → 200 完整视图（email/本位币/偏好/记账起点）", async () => {
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(user.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);
		await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(bearer(user.accessToken))
			.send(wizard)
			.expect(201);

		const res = await request(app.getHttpServer())
			.get("/api/settings")
			.set(bearer(user.accessToken))
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.message).toBe("设置查询成功");
		expect(res.body.data).toEqual({
			email: user.email,
			region: "CN",
			locale: "zh-CN",
			baseCurrency: "CNY",
			prepPreference: "balanced",
			reminderEnabled: true,
			ledgerStartedAt: expect.any(String),
		});
	});

	it("PATCH 改 locale+prepPreference+reminderEnabled → 200；TermsConsent 数不变、baseCurrency 不变", async () => {
		const consentsBefore = await ctx.prisma.termsConsent.count({
			where: { userId: user.userId },
		});

		const res = await request(app.getHttpServer())
			.patch("/api/settings")
			.set(bearer(user.accessToken))
			.send({
				locale: "en",
				prepPreference: "cautious",
				reminderEnabled: false,
			})
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.message).toBe("设置已更新");
		expect(res.body.data).toMatchObject({
			locale: "en",
			prepPreference: "cautious",
			reminderEnabled: false,
			baseCurrency: "CNY", // baseCurrency 不变
			region: "CN", // 未提交字段不被覆盖
		});

		// 同版本条款不重签
		const consentsAfter = await ctx.prisma.termsConsent.count({
			where: { userId: user.userId },
		});
		expect(consentsAfter).toBe(consentsBefore);

		// GET /settings 同步反映（§8.2 行 11：home/state 不承载偏好字段，以 GET /settings 为准）
		const get = await request(app.getHttpServer())
			.get("/api/settings")
			.set(bearer(user.accessToken))
			.expect(200);
		expect(get.body.data.locale).toBe("en");
		expect(get.body.data.prepPreference).toBe("cautious");
		expect(get.body.data.reminderEnabled).toBe(false);
	});

	it("PATCH 空 body → 400 SETTINGS_UPDATE_EMPTY", async () => {
		const res = await request(app.getHttpServer())
			.patch("/api/settings")
			.set(bearer(user.accessToken))
			.send({})
			.expect(400);

		expect(res.body.code).toBe("SETTINGS_UPDATE_EMPTY");
	});

	it("PATCH 只含 baseCurrency → 400（白名单剥离后为空，本位币无更新通道）", async () => {
		const res = await request(app.getHttpServer())
			.patch("/api/settings")
			.set(bearer(user.accessToken))
			.send({ baseCurrency: "USD" })
			.expect(400);

		expect(res.body.code).toBe("SETTINGS_UPDATE_EMPTY");

		const settings = await ctx.prisma.userSettings.findUnique({
			where: { userId: user.userId },
		});
		expect(settings?.baseCurrency).toBe("CNY");
	});

	it("PATCH 含 baseCurrency+region → 200 但 baseCurrency 不变（剥离语义）", async () => {
		const res = await request(app.getHttpServer())
			.patch("/api/settings")
			.set(bearer(user.accessToken))
			.send({ baseCurrency: "USD", region: "HK" })
			.expect(200);

		expect(res.body.data.region).toBe("HK");
		expect(res.body.data.baseCurrency).toBe("CNY");
	});

	it("PATCH 枚举非法 → 400", async () => {
		const res = await request(app.getHttpServer())
			.patch("/api/settings")
			.set(bearer(user.accessToken))
			.send({ prepPreference: "aggressive" })
			.expect(400);
		// 枚举非法来自全局 ValidationPipe：标准 400 结构（statusCode），非模块错误体
		expect(res.body.statusCode).toBe(400);
	});
});
