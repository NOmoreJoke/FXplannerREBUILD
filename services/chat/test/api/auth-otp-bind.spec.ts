import type { INestApplication } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OTP_CHANNELS, OTP_OPTIONS } from "../../src/auth/otp/otp-channel";
import { createCapturingEmailOtpChannel } from "../helpers/capturing-email-otp-channel";
import {
	bearer,
	cleanupUser,
	createTestApp,
	type TestContext,
} from "../helpers/test-app";

/**
 * 接口测试 ↔ src/auth/auth.service.ts loginWithOtp
 * OTP 登录绑定语义（changes/auth-otp-bind，仅绑定不迁移）：
 * 密码账号 + 同邮箱 → 绑定原账号；纯 OTP 账号复用；全新邮箱新建；绑定后密码登录回归。
 */
describe("AuthController OTP 绑定语义（e2e）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const otpChannel = createCapturingEmailOtpChannel();
	const userIds: string[] = [];

	const sendCode = (target: string) =>
		request(app.getHttpServer())
			.post("/api/auth/otp/send-code")
			.send({ channel: "email", target })
			.expect(200);

	const otpLogin = async (target: string) => {
		const sent = await sendCode(target);
		const code = otpChannel.lastCode();
		expect(code).toBeDefined();
		return request(app.getHttpServer())
			.post("/api/auth/otp/login")
			.send({ challengeId: sent.body.data.challengeId, code })
			.expect(200);
	};

	beforeAll(async () => {
		ctx = await createTestApp((builder) =>
			builder
				// 关闭全局接口限流；注入捕获验证码的 fake 渠道并放开 OTP 60s 目标/IP 频控
				.overrideGuard(ThrottlerGuard)
				.useValue({ canActivate: () => true })
				.overrideProvider(OTP_CHANNELS)
				.useValue([otpChannel])
				.overrideProvider(OTP_OPTIONS)
				.useValue({ targetMaxRequests: 100, ipMaxRequests: 100 }),
		);
		app = ctx.app;
	});

	afterAll(async () => {
		for (const userId of userIds) {
			await cleanupUser(ctx.prisma, userId);
		}
		await app.close();
	});

	describe("同邮箱密码账号 + OTP 登录 → 绑定原账号", () => {
		const EMAIL = `otp-bind-${Date.now()}@example.com`;
		const PASSWORD = ["Bind", "Pass", "123"].join("");
		let registeredUserId = "";

		it("密码注册后，同邮箱 OTP 登录应登录原账号并绑定 OTP 标识", async () => {
			const registered = await request(app.getHttpServer())
				.post("/api/auth/register")
				.send({ email: EMAIL, password: PASSWORD })
				.expect(201);
			registeredUserId = registered.body.data.user.id;
			userIds.push(registeredUserId);

			const res = await otpLogin(EMAIL);

			// 登录的是原账号，且响应结构向后兼容
			expect(res.body.data.user.id).toBe(registeredUserId);
			expect(res.body.data.user.email).toBe(EMAIL);
			expect(res.body.data.identity).toEqual({
				channel: "email",
				target: EMAIL,
			});

			// 不创建新 User：该邮箱仍只对应一个账号
			const users = await ctx.prisma.user.findMany({ where: { email: EMAIL } });
			expect(users).toHaveLength(1);

			// OTP 标识已绑定到原账号
			const identity = await ctx.prisma.otpIdentity.findUnique({
				where: { channel_target: { channel: "email", target: EMAIL } },
			});
			expect(identity?.userId).toBe(registeredUserId);
		});

		it("绑定后密码登录仍正常且指向同一账号", async () => {
			const res = await request(app.getHttpServer())
				.post("/api/auth/login")
				.send({ email: EMAIL, password: PASSWORD })
				.expect(200);

			expect(res.body.data.user.id).toBe(registeredUserId);

			const me = await request(app.getHttpServer())
				.get("/api/auth/me")
				.set(bearer(res.body.data.accessToken))
				.expect(200);
			expect(me.body.data.id).toBe(registeredUserId);
			expect(me.body.data.email).toBe(EMAIL);
		});
	});

	describe("纯 OTP 账号与全新邮箱（回归）", () => {
		it("全新邮箱 OTP 登录创建独立 OTP 账号（email 为空）", async () => {
			const EMAIL = `otp-fresh-${Date.now()}@example.com`;

			const res = await otpLogin(EMAIL);
			const userId = res.body.data.user.id;
			userIds.push(userId);

			expect(res.body.data.user.email).toBeNull();
			expect(res.body.data.identity).toEqual({
				channel: "email",
				target: EMAIL,
			});

			const user = await ctx.prisma.user.findUnique({ where: { id: userId } });
			expect(user?.email).toBeNull();
			expect(user?.passwordHash).toBeNull();
		});

		it("纯 OTP 账号再次 OTP 登录复用同一账号，不新建 User", async () => {
			const EMAIL = `otp-reuse-${Date.now()}@example.com`;

			const first = await otpLogin(EMAIL);
			const firstUserId = first.body.data.user.id;
			userIds.push(firstUserId);

			const second = await otpLogin(EMAIL);

			expect(second.body.data.user.id).toBe(firstUserId);
			expect(second.body.data.user.email).toBeNull();

			// 仍然只有一条 OTP 标识、一个关联账号
			const identities = await ctx.prisma.otpIdentity.findMany({
				where: { channel: "email", target: EMAIL },
			});
			expect(identities).toHaveLength(1);
			const otpUsers = await ctx.prisma.user.findMany({
				where: { otpIdentities: { some: { channel: "email", target: EMAIL } } },
			});
			expect(otpUsers).toHaveLength(1);
		});
	});
});
