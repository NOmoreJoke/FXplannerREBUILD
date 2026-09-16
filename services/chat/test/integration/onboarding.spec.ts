import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
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
 * 集成测试（真实数据库）：首次设置完整业务流
 * 登录 → 条款 → 设置（草稿+完成）→ 本位币锁定 → 重复设置被拒
 */
describe("Onboarding 集成：登录 → 设置 → 锁定 → 重复设置被拒", () => {
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
		user = await createTestUser(app, "onb-int");
	});

	afterAll(async () => {
		if (user) await cleanupUser(ctx.prisma, user.userId);
		await app.close();
	});

	it("登录后未设置：status.completed=false，settings 表无行", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/onboarding/status")
			.set(bearer(user.accessToken))
			.expect(200);

		expect(res.body.data.completed).toBe(false);
		const rows = await ctx.prisma.userSettings.findMany({
			where: { userId: user.userId },
		});
		expect(rows).toHaveLength(0);
	});

	it("完成设置：条款 + complete 事务落库（ledgerStartedAt = 完成时刻）", async () => {
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(user.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);

		const done = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(bearer(user.accessToken))
			.send(wizard)
			.expect(201);

		expect(done.body.data.settings.baseCurrency).toBe("CNY");

		// 事务证据：UserSettings 唯一行，ledgerStartedAt = 完成时刻
		const settings = await ctx.prisma.userSettings.findUnique({
			where: { userId: user.userId },
		});
		expect(settings?.baseCurrency).toBe("CNY");
		expect(settings?.ledgerStartedAt).toBeInstanceOf(Date);
		expect(done.body.data.ledgerStartedAt).toBe(
			settings?.ledgerStartedAt?.toISOString(),
		);
	});

	it("锁定：本位币设置完成后重复提交被拒且数据不被覆盖", async () => {
		// 用不同本位币再次 complete → 409
		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(bearer(user.accessToken))
			.send({ ...wizard, baseCurrency: "USD" })
			.expect(409);
		expect(res.body.code).toBe("ONBOARDING_ALREADY_COMPLETED");

		// 落库证据：仍是首次提交的 CNY（不存在任何更新写路径）
		const settings = await ctx.prisma.userSettings.findUnique({
			where: { userId: user.userId },
		});
		expect(settings?.baseCurrency).toBe("CNY");

		// status 已完成（前端据此跳过向导）
		const status = await request(app.getHttpServer())
			.get("/api/onboarding/status")
			.set(bearer(user.accessToken))
			.expect(200);
		expect(status.body.data.completed).toBe(true);
		expect(status.body.data.settings?.baseCurrency).toBe("CNY");
	});
});
