import {
	ConflictException,
	HttpException,
	ServiceUnavailableException,
	UnauthorizedException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../prisma/prisma.service";
import { EmailOtpChannel } from "./email-otp.channel";
import type { OtpFetch } from "./otp-channel";
import { OtpService } from "./otp.service";
import type { OtpLoginDto } from "./dto/otp-login.dto";
import type { SendOtpCodeDto } from "./dto/send-otp-code.dto";

// 技术方案 §8：OTP 新规则单测 —— 10 分钟有效期 / 1h·24h 发送上限 / 15min 输错锁定
// 注：被测对象是 OtpService，按「单测与被测文件同目录」约定落在此处。

const T0 = new Date("2026-08-01T00:00:00.000Z");
const minute = 60 * 1000;

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

/** 内存 Prisma：时钟可注入，供窗口/锁定语义断言 */
function createMemoryPrisma(getNow: () => Date) {
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
				id: `ch-${nextId++}`,
				...data,
				attempts: 0,
				consumedAt: null,
				createdAt: new Date(getNow()),
			};
			challenges.push(challenge);
			return { id: challenge.id, expiresAt: challenge.expiresAt };
		}),
		delete: vi.fn(async ({ where }: any) => {
			const index = challenges.findIndex((c) => c.id === where.id);
			if (index >= 0) challenges.splice(index, 1);
		}),
		findUnique: vi.fn(async ({ where }: any) => {
			const challenge = challenges.find((c) => c.id === where.id);
			return challenge ? { ...challenge } : null;
		}),
		updateMany: vi.fn(async ({ where, data }: any) => {
			let count = 0;
			for (const challenge of challenges) {
				if (!matches(challenge, where)) continue;
				if (data.attempts?.increment)
					challenge.attempts += data.attempts.increment;
				if (data.consumedAt) challenge.consumedAt = data.consumedAt;
				count += 1;
			}
			return { count };
		}),
		count: vi.fn(
			async ({ where }: any) =>
				challenges.filter((c) => matches(c, where)).length,
		),
		aggregate: vi.fn(async ({ where }: any) => ({
			_sum: {
				attempts: challenges
					.filter((c) => matches(c, where))
					.reduce((total, c) => total + c.attempts, 0),
			},
		})),
	};
	const prisma: Record<string, any> = {
		otpChallenge,
		challenges,
		$executeRaw: vi.fn(async () => 1),
	};
	prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));
	return prisma;
}

async function exceptionOf(action: () => Promise<unknown>) {
	try {
		await action();
	} catch (error) {
		expect(error).toBeInstanceOf(HttpException);
		const httpError = error as HttpException;
		return {
			status: httpError.getStatus(),
			body: httpError.getResponse(),
		};
	}
	throw new Error("expected HttpException but action resolved");
}

function buildHarness(
	options: ConstructorParameters<typeof OtpService>[2] = {},
) {
	let now = new Date(T0);
	const prisma = createMemoryPrisma(() => new Date(now));
	const sentCodes: string[] = [];
	const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
		const payload = JSON.parse(String(init?.body));
		sentCodes.push(payload.text.match(/\d{6}/)?.[0] ?? "");
		return new Response(JSON.stringify({ id: "email-message" }), {
			status: 200,
		});
	});
	const emailChannel = new EmailOtpChannel({
		apiKey: "resend-test-key",
		from: "no-reply@example.com",
		fetchImpl: fetchMock as unknown as OtpFetch,
	});
	const service = new OtpService(
		prisma as unknown as PrismaService,
		[emailChannel],
		{
			now: () => new Date(now),
			// 关闭 60s 频控（已有测试覆盖），聚焦新规则
			targetMaxRequests: 100,
			ipMaxRequests: 100,
			codeSecret: "otp-unit-test-secret-with-32-chars!",
			...options,
		},
	);
	const send = (target: string) =>
		service.sendCode(
			{ channel: "email", target } as SendOtpCodeDto,
			"192.0.2.9",
		);
	const verify = (challengeId: string, code: string) =>
		service.verifyCode({ challengeId, code } as OtpLoginDto);
	const lastCode = () => {
		const code = sentCodes.at(-1);
		if (!code) throw new Error("no code captured");
		return code;
	};
	return {
		challenges: prisma.challenges as Challenge[],
		service,
		send,
		verify,
		lastCode,
		advance: (ms: number) => {
			now = new Date(now.getTime() + ms);
		},
	};
}

describe("OtpService 验证码规则补全（M1.1）", () => {
	let h: ReturnType<typeof buildHarness>;

	beforeEach(() => {
		h = buildHarness();
	});

	describe("验证码有效期：10 分钟", () => {
		it("9 分 59 秒时仍可验证成功", async () => {
			const { challengeId } = await h.send("expiry@example.com");
			h.advance(9 * minute + 59 * 1000);
			const code = h.lastCode();

			const verified = await h.verify(challengeId, code);
			expect(verified.challengeId).toBe(challengeId);
		});

		it("10 分钟整（10m + 1ms）即过期 → 410", async () => {
			const { challengeId } = await h.send("expiry2@example.com");
			const code = h.lastCode();
			h.advance(10 * minute + 1);

			const { status } = await exceptionOf(() => h.verify(challengeId, code));
			expect(status).toBe(410);
		});
	});

	describe("发送上限：1h ≥5 或 24h ≥20 → 429 OTP_SEND_RATE_LIMITED", () => {
		it("1 小时内第 6 次发送被拒", async () => {
			const target = "hourly@example.com";
			for (let i = 0; i < 5; i += 1) {
				await h.send(target);
			}
			const { status, body } = await exceptionOf(() => h.send(target));
			expect(status).toBe(429);
			expect((body as { code: string }).code).toBe("OTP_SEND_RATE_LIMITED");
		});

		it("1h 窗口外、24h 窗口内的发送也计入 24h 上限（第 21 次被拒）", async () => {
			// 独立 harness：调大 1h 上限，只考察 24h 规则的窗口边界
			const day = buildHarness({ sendMaxPerHour: 100 });
			const target = "daily@example.com";

			// 16 次发送发生在 2 小时前（1h 窗口外、24h 窗口内）
			day.advance(-2 * 60 * minute);
			for (let i = 0; i < 16; i += 1) {
				await day.send(target);
			}
			// 回到现在：再发 4 次（1h 内仅 4 条）
			day.advance(2 * 60 * minute);
			for (let i = 0; i < 4; i += 1) {
				await day.send(target);
			}
			// 第 21 次：1h 计数 4 < 5，24h 计数 20 ≥ 20 → 拒绝
			const { status, body } = await exceptionOf(() => day.send(target));
			expect(status).toBe(429);
			expect((body as { code: string }).code).toBe("OTP_SEND_RATE_LIMITED");
		});
	});

	describe("15 分钟输错锁定：失败累计 ≥5 → 全部作废 + 429 OTP_VERIFY_LOCKED", () => {
		it("同一邮箱输错 5 次：全部未消费验证码立即作废，验证与发送均被拒", async () => {
			const target = "lock@example.com";
			const first = await h.send(target);
			// 模拟同邮箱另一条未被后续发送清理的遗留未消费挑战行
			h.challenges.push({ ...h.challenges[0], id: "ch-legacy" });
			// 第二次发送会按既有规则作废第一个码，后续用第二个码触发锁定
			const second = await h.send(target);

			// 输错 4 次 → 401（未达阈值）
			for (let i = 0; i < 4; i += 1) {
				const { status } = await exceptionOf(() =>
					h.verify(second.challengeId, "000000"),
				);
				expect(status).toBe(401);
			}
			// 第 5 次输错 → 触发锁定
			const { status, body } = await exceptionOf(() =>
				h.verify(second.challengeId, "000000"),
			);
			expect(status).toBe(429);
			expect((body as { code: string }).code).toBe("OTP_VERIFY_LOCKED");

			// 该邮箱全部未消费验证码已被作废（含遗留行）
			expect(
				h.challenges
					.filter((c) => c.target === target)
					.every((c) => c.consumedAt !== null),
			).toBe(true);
			// 锁定期内验证（即便换未消费过的码）被拒 → 429
			const blocked = await exceptionOf(() =>
				h.verify(first.challengeId, "000000"),
			);
			expect(blocked.status).toBe(429);
			expect((blocked.body as { code: string }).code).toBe("OTP_VERIFY_LOCKED");
			// 锁定期内发送也被拒
			const sendBlocked = await exceptionOf(() => h.send(target));
			expect(sendBlocked.status).toBe(429);
			expect((sendBlocked.body as { code: string }).code).toBe(
				"OTP_VERIFY_LOCKED",
			);
		});

		it("输错 5 次前（含 4 次）不触发锁定与作废", async () => {
			const target = "below@example.com";
			const sent = await h.send(target);
			for (let i = 0; i < 4; i += 1) {
				await exceptionOf(() => h.verify(sent.challengeId, "000000"));
			}
			expect(
				h.challenges
					.filter((c) => c.target === target)
					.every((c) => c.consumedAt === null),
			).toBe(true);
			// 第 5 次失败才进入锁定
			const { status } = await exceptionOf(() =>
				h.verify(sent.challengeId, "000000"),
			);
			expect(status).toBe(429);
		});

		it("锁定期满（超过 15 分钟）自动恢复：可重新发送并验证", async () => {
			const target = "recover@example.com";
			const sent = await h.send(target);
			for (let i = 0; i < 5; i += 1) {
				await exceptionOf(() => h.verify(sent.challengeId, "000000"));
			}
			expect(h.challenges).toHaveLength(1);

			h.advance(15 * minute + 1000);
			// 期满后重新发送成功
			const resent = await h.send(target);
			expect(resent.challengeId).toBeDefined();

			// 新码成功验证（旧失败尝试已滚出 15min 窗口）
			const code = h.lastCode();
			const verified = await h.verify(resent.challengeId, code);
			expect(verified.target).toBe(target);
		});
	});

	it("正确验证码在有效期内只能验证一次（10 分钟语义回归）", async () => {
		const { challengeId } = await h.send("happy@example.com");
		const code = h.lastCode();
		h.advance(5 * minute);

		const verified = await h.verify(challengeId, code);
		expect(verified.challengeId).toBe(challengeId);
		await expect(h.verify(challengeId, code)).rejects.toBeInstanceOf(
			ConflictException,
		);
		await expect(h.verify("missing", "000000")).rejects.toBeInstanceOf(
			UnauthorizedException,
		);
	});
});

describe("邮件 mock 模式（未接入真实邮件服务，changes/ux-improvements）", () => {
	const baseOptions = {
		now: () => new Date(T0),
		targetMaxRequests: 100,
		ipMaxRequests: 100,
		codeSecret: "otp-unit-test-secret-with-32-chars!",
	};

	function buildService(channels: EmailOtpChannel[]) {
		const prisma = createMemoryPrisma(() => new Date(T0));
		const service = new OtpService(
			prisma as unknown as PrismaService,
			channels,
			baseOptions,
		);
		return { prisma, service };
	}

	it("mock 渠道（devMode）：sendCode 响应附带 6 位 devCode，且不发网络请求", async () => {
		const mockChannel = new EmailOtpChannel({ mock: true });
		expect(mockChannel.devMode).toBe(true);
		const { prisma, service } = buildService([mockChannel]);

		const result = await service.sendCode(
			{ channel: "email", target: "mock@example.com" } as SendOtpCodeDto,
			"192.0.2.10",
		);
		expect(result.devCode).toMatch(/^\d{6}$/);
		// mock 渠道 send 不经网络：challenge 已建且未被删除
		expect(prisma.challenges).toHaveLength(1);
	});

	it("真实渠道（已配置 Resend）：响应不携带 devCode（防泄漏）", async () => {
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		const realChannel = new EmailOtpChannel({
			apiKey: "resend-test-key",
			from: "no-reply@example.com",
			fetchImpl: fetchMock as unknown as OtpFetch,
		});
		expect(realChannel.devMode).toBe(false);
		const { service } = buildService([realChannel]);

		const result = await service.sendCode(
			{ channel: "email", target: "real@example.com" } as SendOtpCodeDto,
			"192.0.2.11",
		);
		expect(result.devCode).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("显式 mock:false 且未配置供应商 → send 抛 503（保留原有行为）", async () => {
		const strictChannel = new EmailOtpChannel({ mock: false });
		expect(strictChannel.devMode).toBe(false);
		await expect(
			strictChannel.send("a@b.com", "123456"),
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
});
