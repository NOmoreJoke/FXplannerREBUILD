import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { utc8DayStart } from "../../src/transaction/transaction-calculator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import {
	bearer,
	cleanupUser,
	createTestApp,
	createTestUser,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";

/**
 * 接口测试 ↔ src/onboarding/onboarding.controller.ts
 * 首次设置全流程：登录 → status → 条款 → complete → 锁定
 */
describe("OnboardingController（e2e）", () => {
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
		// 注册 + 密码登录取登录凭证（OTP 登录链路已由 test/api/otp.spec.ts 覆盖）
		user = await createTestUser(app, "onboarding");
	});

	afterAll(async () => {
		if (user) await cleanupUser(ctx.prisma, user.userId);
		await app.close();
	});

	it("未登录访问 status 应该 401", () => {
		return request(app.getHttpServer())
			.get("/api/onboarding/status")
			.expect(401);
	});

	it("未确认条款时 complete 应该 400 CONSENT_REQUIRED", async () => {
		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(bearer(user.accessToken))
			.send(wizard)
			.expect(400);

		expect(res.body.code).toBe("CONSENT_REQUIRED");
	});

	it("GET status 初始为未完成", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/onboarding/status")
			.set(bearer(user.accessToken))
			.expect(200);

		expect(res.body.data).toMatchObject({
			completed: false,
			requiredConsentsMet: false,
			settings: null,
			currentTermsVersion: "2026-01",
		});
	});

	it("POST consents 记录两条确认后 requiredConsentsMet=true", async () => {
		const first = await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(user.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);

		expect(first.body.data.termsVersion).toBe("2026-01");
		expect(first.body.data.age18ConsentedAt).toBeDefined();
		expect(first.body.data.termsConsentedAt).toBeDefined();

		// 重复确认幂等：保留首次 consentedAt
		const repeat = await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(user.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);
		expect(repeat.body.data.age18ConsentedAt).toBe(
			first.body.data.age18ConsentedAt,
		);

		const status = await request(app.getHttpServer())
			.get("/api/onboarding/status")
			.set(bearer(user.accessToken))
			.expect(200);
		expect(status.body.data.requiredConsentsMet).toBe(true);
	});

	it("POST complete 成功：创建设置 + ledgerStartedAt", async () => {
		const before = Date.now();
		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(bearer(user.accessToken))
			.send({ ...wizard, baseCurrency: "HKD" })
			.expect(201);

		expect(res.body.data.settings).toMatchObject({
			baseCurrency: "HKD",
			locale: "zh-CN",
			region: "CN",
			prepPreference: "balanced",
			reminderEnabled: true,
		});
		const ledgerStartedAt = new Date(res.body.data.ledgerStartedAt).getTime();
		// 起点对齐完成当日 UTC+8 日初（当天 UI 录入不被「早于账本起点」拒绝）
		expect(ledgerStartedAt).toBe(utc8DayStart(new Date(before)).getTime());

		// status 已完成
		const status = await request(app.getHttpServer())
			.get("/api/onboarding/status")
			.set(bearer(user.accessToken))
			.expect(200);
		expect(status.body.data.completed).toBe(true);
		expect(status.body.data.settings.baseCurrency).toBe("HKD");
	});

	it("重复 complete 应该 409 ONBOARDING_ALREADY_COMPLETED（不同币种也不得覆盖）", async () => {
		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(bearer(user.accessToken))
			.send({ ...wizard, baseCurrency: "USD" })
			.expect(409);

		expect(res.body.code).toBe("ONBOARDING_ALREADY_COMPLETED");

		// 本位币锁定的落库证据：仍是首次提交的 HKD
		const status = await request(app.getHttpServer())
			.get("/api/onboarding/status")
			.set(bearer(user.accessToken))
			.expect(200);
		expect(status.body.data.settings.baseCurrency).toBe("HKD");
	});
});
