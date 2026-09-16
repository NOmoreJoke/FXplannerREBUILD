import "reflect-metadata";
import {
	BadGatewayException,
	HttpException,
	ServiceUnavailableException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../../src/prisma/prisma.service";
import { EmailOtpChannel } from "../../src/auth/otp/email-otp.channel";
import { SmsOtpChannel } from "../../src/auth/otp/sms-otp.channel";
import {
	OTP_CHANNELS,
	OTP_OPTIONS,
	type OtpFetch,
} from "../../src/auth/otp/otp-channel";
import { OtpService } from "../../src/auth/otp/otp.service";
import type { SendOtpCodeDto } from "../../src/auth/otp/dto/send-otp-code.dto";
import type { OtpLoginDto } from "../../src/auth/otp/dto/otp-login.dto";

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

function createMemoryPrisma() {
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
				id: `integration-${nextId++}`,
				...data,
				attempts: 0,
				consumedAt: null,
				createdAt: new Date(),
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

async function expectStatus(action: () => Promise<unknown>, status: number) {
	try {
		await action();
		throw new Error(`expected HTTP ${status}`);
	} catch (error) {
		expect(error).toBeInstanceOf(HttpException);
		expect((error as HttpException).getStatus()).toBe(status);
	}
}

describe("OTP auth integration", () => {
	let now = new Date("2026-08-01T00:00:00.000Z");
	const prisma = createMemoryPrisma();
	const sentCodes: string[] = [];
	const fetchMock = vi.fn(
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			if (init?.method === "POST") {
				const payload = JSON.parse(String(init.body));
				sentCodes.push(payload.text.match(/\d{6}/)?.[0] ?? "");
				return new Response(JSON.stringify({ id: "email-message" }), {
					status: 200,
				});
			}
			expect(String(input)).toContain("Action=SendSms");
			return new Response(
				JSON.stringify({ Code: "OK", RequestId: "sms-request" }),
				{ status: 200 },
			);
		},
	);

	const emailChannel = new EmailOtpChannel({
		apiKey: "resend-test-key",
		from: "no-reply@example.com",
		endpoint: "https://resend.test/emails",
		fetchImpl: fetchMock as unknown as OtpFetch,
	});
	const smsChannel = new SmsOtpChannel({
		accessKeyId: "aliyun-id",
		accessKeySecret: "aliyun-secret",
		signName: "FXPlanner",
		templateCode: "SMS_123456",
		endpoint: "https://aliyun.test/",
		fetchImpl: fetchMock as unknown as OtpFetch,
	});
	let service: OtpService;

	beforeAll(async () => {
		const module = await Test.createTestingModule({
			providers: [
				OtpService,
				{ provide: PrismaService, useValue: prisma },
				{ provide: OTP_CHANNELS, useValue: [emailChannel, smsChannel] },
				{
					provide: OTP_OPTIONS,
					useValue: {
						now: () => new Date(now),
						maxAttempts: 3,
						targetMaxRequests: 100,
						ipMaxRequests: 100,
						codeSecret: "otp-integration-test-secret",
					},
				},
			],
		}).compile();
		service = module.get(OtpService);
	});

	afterAll(() => {
		vi.restoreAllMocks();
	});

	it("应该通过注入的 email/phone Channel 发送，并且数据库只保存哈希", async () => {
		const emailResult = await service.sendCode(
			{ channel: "email", target: " USER@EXAMPLE.COM " } as SendOtpCodeDto,
			"192.0.2.1",
		);
		const phoneResult = await service.sendCode(
			{ channel: "phone", target: " +86 138-0013-8000 " } as SendOtpCodeDto,
			"192.0.2.2",
		);

		expect(emailResult.challengeId).toBeDefined();
		expect(phoneResult.challengeId).toBeDefined();
		expect(prisma.challenges[0].target).toBe("user@example.com");
		expect(prisma.challenges[1].target).toBe("+8613800138000");
		expect(prisma.challenges[0].codeHash).toMatch(/^[0-9a-f]{64}$/);
		expect(prisma.challenges[0].codeHash).not.toMatch(/^\d{6}$/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[1][0])).toContain(
			"PhoneNumbers=%2B8613800138000",
		);
	});

	it("验证码应该在十分钟后过期，错误次数达到上限后不能继续尝试", async () => {
		const expiring = await service.sendCode(
			{ channel: "email", target: "expiry@example.com" } as SendOtpCodeDto,
			"192.0.2.3",
		);
		now = new Date(now.getTime() + 10 * 60 * 1000 + 1);
		await expectStatus(
			() =>
				service.verifyCode({
					challengeId: expiring.challengeId,
					code: "000000",
				} as OtpLoginDto),
			410,
		);

		now = new Date("2026-08-01T00:00:00.000Z");
		const attempts = await service.sendCode(
			{ channel: "email", target: "attempts@example.com" } as SendOtpCodeDto,
			"192.0.2.4",
		);
		await expectStatus(
			() =>
				service.verifyCode({
					challengeId: attempts.challengeId,
					code: "000000",
				} as OtpLoginDto),
			401,
		);
		await expectStatus(
			() =>
				service.verifyCode({
					challengeId: attempts.challengeId,
					code: "000000",
				} as OtpLoginDto),
			401,
		);
		await expectStatus(
			() =>
				service.verifyCode({
					challengeId: attempts.challengeId,
					code: "000000",
				} as OtpLoginDto),
			429,
		);
	});

	it("新验证码发出后，同一目标的旧验证码不能继续使用", async () => {
		const first = await service.sendCode(
			{ channel: "email", target: "resend@example.com" } as SendOtpCodeDto,
			"192.0.2.5",
		);
		const second = await service.sendCode(
			{ channel: "email", target: "resend@example.com" } as SendOtpCodeDto,
			"192.0.2.5",
		);
		const [oldCode, newCode] = sentCodes.slice(-2);

		await expectStatus(
			() =>
				service.verifyCode({
					challengeId: first.challengeId,
					code: oldCode,
				} as OtpLoginDto),
			409,
		);

		const verified = await service.verifyCode({
			challengeId: second.challengeId,
			code: newCode,
		} as OtpLoginDto);
		expect(verified.target).toBe("resend@example.com");
	});

	it("供应商 HTTP 异常应该转为 BadGateway，超时应该转为 ServiceUnavailable", async () => {
		const failedEmail = new EmailOtpChannel({
			apiKey: "key",
			from: "from@example.com",
			fetchImpl: vi.fn(
				async () => new Response("failed", { status: 503 }),
			) as unknown as OtpFetch,
		});
		await expect(
			failedEmail.send("user@example.com", "123456"),
		).rejects.toBeInstanceOf(BadGatewayException);

		const timeoutEmail = new EmailOtpChannel({
			apiKey: "key",
			from: "from@example.com",
			timeoutMs: 1,
			fetchImpl: (async (_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new Error("aborted")),
					);
				})) as OtpFetch,
		});
		await expect(
			timeoutEmail.send("user@example.com", "123456"),
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
});
