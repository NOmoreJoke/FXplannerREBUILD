import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import {
	Body,
	Controller,
	HttpCode,
	HttpStatus,
	Post,
	Req,
	ValidationPipe,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Request } from "express";
import request from "supertest";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../../src/prisma/prisma.service";
import {
	OTP_CHANNELS,
	OTP_OPTIONS,
	type OtpChannel,
} from "../../src/auth/otp/otp-channel";
import { OtpService } from "../../src/auth/otp/otp.service";
import { SendOtpCodeDto } from "../../src/auth/otp/dto/send-otp-code.dto";
import { OtpLoginDto } from "../../src/auth/otp/dto/otp-login.dto";
import { MOCK_OTP_ACCESS_TOKEN } from "../fixtures/test-tokens";

type Challenge = {
	id: string;
	channel: string;
	target: string;
	codeHash: string;
	expiresAt: Date;
	attempts: number;
	consumedAt: Date | null;
	requestIp: string | null;
	createdAt: Date;
};

function createMemoryPrisma(getNow: () => Date = () => new Date()) {
	const challenges: Challenge[] = [];
	let nextId = 1;
	const matches = (challenge: Challenge, where: Record<string, any>) => {
		if (where.id && challenge.id !== where.id) return false;
		if (where.channel && challenge.channel !== where.channel) return false;
		if (where.target && challenge.target !== where.target) return false;
		if (where.requestIp && challenge.requestIp !== where.requestIp)
			return false;
		if (where.consumedAt === null && challenge.consumedAt !== null)
			return false;
		if (where.createdAt?.gte && challenge.createdAt < where.createdAt.gte)
			return false;
		if (where.expiresAt?.gt && challenge.expiresAt <= where.expiresAt.gt)
			return false;
		if (where.attempts?.lt && challenge.attempts >= where.attempts.lt)
			return false;
		return true;
	};
	const otpChallenge = {
		create: vi.fn(async ({ data }: any) => {
			const challenge: Challenge = {
				id: `challenge-${nextId++}`,
				...data,
				attempts: 0,
				consumedAt: null,
				createdAt: new Date(getNow()),
			};
			challenges.push(challenge);
			return { id: challenge.id, expiresAt: challenge.expiresAt };
		}),
		delete: vi.fn(async ({ where }: any) => {
			const index = challenges.findIndex(
				(challenge) => challenge.id === where.id,
			);
			if (index >= 0) challenges.splice(index, 1);
		}),
		findUnique: vi.fn(async ({ where }: any) => {
			const challenge = challenges.find(
				(candidate) => candidate.id === where.id,
			);
			return challenge ? { ...challenge } : null;
		}),
		updateMany: vi.fn(async ({ where, data }: any) => {
			const challenge = challenges.find((candidate) =>
				matches(candidate, where),
			);
			if (!challenge) return { count: 0 };
			if (data.attempts?.increment)
				challenge.attempts += data.attempts.increment;
			if (data.consumedAt) challenge.consumedAt = data.consumedAt;
			return { count: 1 };
		}),
		count: vi.fn(
			async ({ where }: any) =>
				challenges.filter((challenge) => matches(challenge, where)).length,
		),
		aggregate: vi.fn(async ({ where }: any) => {
			const sum = challenges
				.filter((challenge) => matches(challenge, where))
				.reduce((total, challenge) => total + challenge.attempts, 0);
			return { _sum: { attempts: sum } };
		}),
	};
	const prisma: Record<string, any> = {
		otpChallenge,
		challenges,
		$executeRaw: vi.fn(async () => 1),
	};
	prisma.$transaction = vi.fn(async (callback: any) => callback(prisma));
	return prisma;
}

const fakeEmailChannel: OtpChannel = {
	channel: "email",
	send: vi.fn(async () => undefined),
};
const fakePhoneChannel: OtpChannel = {
	channel: "phone",
	send: vi.fn(async () => undefined),
};

class OtpTestController {
	constructor(private readonly otpService: OtpService) {}

	async sendCode(dto: SendOtpCodeDto, req: Request) {
		const forwardedFor = req.headers["x-forwarded-for"]
			?.toString()
			.split(",")[0]
			?.trim();
		return {
			success: true,
			data: await this.otpService.sendCode(
				dto,
				forwardedFor || req.ip || "127.0.0.1",
			),
		};
	}

	async login(dto: OtpLoginDto) {
		const verification = await this.otpService.verifyCode(dto);
		return {
			success: true,
			data: {
				accessToken: MOCK_OTP_ACCESS_TOKEN,
				user: {
					id: "otp-user",
					email: null,
					name: null,
					avatar: null,
					createdAt: new Date("2026-08-04T00:00:00.000Z").toISOString(),
				},
				identity: {
					channel: verification.channel,
					target: verification.target,
				},
			},
		};
	}
}

const applyDecorator = (
	decorator: (...args: any[]) => unknown,
	...args: any[]
) => {
	decorator(...args);
};
const controllerPrototype = OtpTestController.prototype;
applyDecorator(Controller("auth/otp"), OtpTestController);
applyDecorator(
	Post("send-code"),
	controllerPrototype,
	"sendCode",
	Object.getOwnPropertyDescriptor(controllerPrototype, "sendCode"),
);
applyDecorator(
	HttpCode(HttpStatus.OK),
	controllerPrototype,
	"sendCode",
	Object.getOwnPropertyDescriptor(controllerPrototype, "sendCode"),
);
applyDecorator(Body(), controllerPrototype, "sendCode", 0);
applyDecorator(Req(), controllerPrototype, "sendCode", 1);
applyDecorator(
	Post("login"),
	controllerPrototype,
	"login",
	Object.getOwnPropertyDescriptor(controllerPrototype, "login"),
);
applyDecorator(
	HttpCode(HttpStatus.OK),
	controllerPrototype,
	"login",
	Object.getOwnPropertyDescriptor(controllerPrototype, "login"),
);
applyDecorator(Body(), controllerPrototype, "login", 0);
Reflect.defineMetadata("design:paramtypes", [OtpService], OtpTestController);
Reflect.defineMetadata(
	"design:paramtypes",
	[SendOtpCodeDto, Object],
	controllerPrototype,
	"sendCode",
);
Reflect.defineMetadata(
	"design:paramtypes",
	[OtpLoginDto],
	controllerPrototype,
	"login",
);

describe("OTP API", () => {
	let app: INestApplication;
	const prisma = createMemoryPrisma();

	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [OtpTestController],
			providers: [
				OtpService,
				{ provide: PrismaService, useValue: prisma },
				{
					provide: OTP_CHANNELS,
					useValue: [fakeEmailChannel, fakePhoneChannel],
				},
				{
					provide: OTP_OPTIONS,
					useValue: { ipMaxRequests: 1, codeSecret: "otp-api-test-secret" },
				},
			],
		}).compile();
		app = module.createNestApplication();
		app.setGlobalPrefix("api");
		app.useGlobalPipes(new ValidationPipe({ transform: true }));
		await app.init();
	});

	afterAll(async () => {
		await app.close();
	});

	it("应该规范化邮箱、发送 OTP，并允许成功验证一次", async () => {
		const requested = await request(app.getHttpServer())
			.post("/api/auth/otp/send-code")
			.set("X-Forwarded-For", "10.0.0.1")
			.send({ channel: "email", target: " User@Example.COM " })
			.expect(200);

		expect(requested.body.data.challengeId).toBeDefined();
		expect(fakeEmailChannel.send).toHaveBeenCalledWith(
			"user@example.com",
			expect.stringMatching(/^\d{6}$/),
		);
		const code = (
			fakeEmailChannel.send as ReturnType<typeof vi.fn>
		).mock.calls.at(-1)?.[1];

		const loggedIn = await request(app.getHttpServer())
			.post("/api/auth/otp/login")
			.send({ challengeId: requested.body.data.challengeId, code })
			.expect(200);

		expect(loggedIn.body.data.accessToken).toBe(MOCK_OTP_ACCESS_TOKEN);
		expect(loggedIn.body.data.identity).toEqual({
			channel: "email",
			target: "user@example.com",
		});

		await request(app.getHttpServer())
			.post("/api/auth/otp/login")
			.send({ challengeId: requested.body.data.challengeId, code })
			.expect(409);
	});

	it("应该同时限制目标和 requestIp 的发送频率", async () => {
		await request(app.getHttpServer())
			.post("/api/auth/otp/send-code")
			.set("X-Forwarded-For", "10.0.0.2")
			.send({ channel: "phone", target: "+8613800138000" })
			.expect(200);

		await request(app.getHttpServer())
			.post("/api/auth/otp/send-code")
			.set("X-Forwarded-For", "10.0.0.2")
			.send({ channel: "phone", target: "+8613800138001" })
			.expect(429);

		await request(app.getHttpServer())
			.post("/api/auth/otp/send-code")
			.set("X-Forwarded-For", "10.0.0.3")
			.send({ channel: "phone", target: "+8613800138000" })
			.expect(429);
	});

	it("非法 channel 或验证码格式应该返回 400", async () => {
		await request(app.getHttpServer())
			.post("/api/auth/otp/send-code")
			.send({ channel: "fax", target: "someone@example.com" })
			.expect(400);

		await request(app.getHttpServer())
			.post("/api/auth/otp/login")
			.send({ challengeId: "missing", code: "12345" })
			.expect(400);
	});
});

/**
 * M1.1 新规则接口测试（技术方案 §5/§8）：
 * 1h/24h 发送上限、15 分钟输错锁定。独立 module + 可注入时钟，避免与上方用例共享计数。
 */
describe("OTP API（M1.1 发送上限与输错锁定）", () => {
	let app: INestApplication;
	let now = new Date("2026-08-01T00:00:00.000Z");
	const prisma = createMemoryPrisma(() => new Date(now));
	const sentCodes: string[] = [];
	const captureChannel: OtpChannel = {
		channel: "email",
		send: vi.fn(async (_target: string, code: string) => {
			sentCodes.push(code);
		}),
	};

	const post = (target: string) =>
		request(app.getHttpServer())
			.post("/api/auth/otp/send-code")
			.send({ channel: "email", target });

	const login = (challengeId: string, code: string) =>
		request(app.getHttpServer())
			.post("/api/auth/otp/login")
			.send({ challengeId, code });

	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [OtpTestController],
			providers: [
				OtpService,
				{ provide: PrismaService, useValue: prisma },
				{ provide: OTP_CHANNELS, useValue: [captureChannel] },
				{
					provide: OTP_OPTIONS,
					useValue: {
						now: () => new Date(now),
						// 关闭 60s 频控（上方用例已覆盖），聚焦 1h/24h 与锁定规则
						targetMaxRequests: 100,
						ipMaxRequests: 100,
						codeSecret: "otp-api-newrules-secret-32-chars!",
					},
				},
			],
		}).compile();
		app = module.createNestApplication();
		app.setGlobalPrefix("api");
		app.useGlobalPipes(new ValidationPipe({ transform: true }));
		await app.init();
	});

	afterAll(async () => {
		await app.close();
	});

	const wrongCode = () => (sentCodes.at(-1) === "000000" ? "000001" : "000000");

	it("1 小时内发满 5 次后，第 6 次发送 429 OTP_SEND_RATE_LIMITED", async () => {
		const target = "rate-1h@example.com";
		for (let i = 0; i < 5; i += 1) {
			await post(target).expect(200);
		}
		const res = await post(target).expect(429);
		expect(res.body.code).toBe("OTP_SEND_RATE_LIMITED");
	});

	it("15 分钟内输错 5 次：全部未消费验证码作废，锁定期内验证与发送均 429 OTP_VERIFY_LOCKED", async () => {
		const target = "lock-api@example.com";
		const sent = await post(target).expect(200);
		const challengeId = sent.body.data.challengeId as string;
		const code = sentCodes.at(-1)!;

		for (let i = 0; i < 4; i += 1) {
			await login(challengeId, wrongCode()).expect(401);
		}
		const locked = await login(challengeId, wrongCode()).expect(429);
		expect(locked.body.code).toBe("OTP_VERIFY_LOCKED");

		// 该邮箱全部未消费验证码已作废（不依赖验证码内容）
		const challenges = prisma.challenges as Array<{
			target: string;
			consumedAt: Date | null;
		}>;
		expect(
			challenges
				.filter((challenge) => challenge.target === target)
				.every((challenge) => challenge.consumedAt !== null),
		).toBe(true);

		// 锁定期内：验证与发送均拒绝
		await login(challengeId, code).expect(429);
		const resend = await post(target).expect(429);
		expect(resend.body.code).toBe("OTP_VERIFY_LOCKED");
	});

	it("锁定期满（超过 15 分钟）自动恢复：发送与验证均可用", async () => {
		const target = "recover-api@example.com";
		const sent = await post(target).expect(200);
		const challengeId = sent.body.data.challengeId as string;

		for (let i = 0; i < 4; i += 1) {
			await login(challengeId, wrongCode()).expect(401);
		}
		// 第 5 次输错触发锁定
		await login(challengeId, wrongCode()).expect(429);

		// 推进时钟滚出 15 分钟锁定窗口
		now = new Date(now.getTime() + 15 * 60 * 1000 + 1000);

		const resent = await post(target).expect(200);
		const newChallengeId = resent.body.data.challengeId as string;
		const newCode = sentCodes.at(-1)!;
		expect(newChallengeId).not.toBe(challengeId);

		await login(newChallengeId, newCode).expect(200);
	});
});
