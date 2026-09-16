import { HttpException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { utc8DayStart } from "../transaction/transaction-calculator";
import { CURRENT_TERMS_VERSION } from "./onboarding.constants";
import {
	OnboardingAlreadyCompletedException,
	OnboardingConsentRequiredException,
	OnboardingInvalidCurrencyException,
	OnboardingService,
} from "./onboarding.service";

// 固定时钟：T0 = 2026-08-01 08:00 UTC
const T0 = new Date("2026-08-01T08:00:00.000Z");

const validWizard = {
	region: "CN",
	locale: "zh-CN",
	baseCurrency: "CNY",
	prepPreference: "balanced",
	reminderEnabled: true,
};

function createPrismaMock() {
	const userSettings = {
		findUnique: vi.fn(),
		create: vi.fn(),
	};
	const termsConsent = {
		count: vi.fn(),
		upsert: vi.fn(),
	};
	const prisma = {
		userSettings,
		termsConsent,
		$transaction: vi.fn(async (callback: (tx: typeof prisma) => unknown) =>
			callback(prisma),
		),
	};
	return prisma;
}

/** 抛出时返回 HttpException 的状态码与错误体（{ code, message }）；未抛则失败。可传异常类做类型断言 */
async function errorOf(
	action: () => Promise<unknown>,
	expected?: new (...args: never[]) => HttpException,
) {
	try {
		await action();
	} catch (error) {
		expect(error).toBeInstanceOf(HttpException);
		if (expected) expect(error).toBeInstanceOf(expected);
		const httpError = error as HttpException;
		return {
			status: httpError.getStatus(),
			body: httpError.getResponse() as { code: string; message: string },
		};
	}
	throw new Error("expected HttpException but action resolved");
}

describe("OnboardingService", () => {
	let prisma: ReturnType<typeof createPrismaMock>;
	let service: OnboardingService;

	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
		prisma = createPrismaMock();
		service = new OnboardingService(prisma as unknown as PrismaService);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("getStatus", () => {
		it("未完成：completed=false、settings=null", async () => {
			prisma.userSettings.findUnique.mockResolvedValue(null);
			prisma.termsConsent.count.mockResolvedValue(0);

			const status = await service.getStatus("u1");

			expect(status.completed).toBe(false);
			expect(status.requiredConsentsMet).toBe(false);
			expect(status.settings).toBeNull();
			expect(status.currentTermsVersion).toBe(CURRENT_TERMS_VERSION);
		});

		it("已完成：返回 settings 视图，completed=true", async () => {
			prisma.userSettings.findUnique.mockResolvedValue({
				baseCurrency: "HKD",
				locale: "zh-CN",
				region: "CN",
				prepPreference: "balanced",
				reminderEnabled: false,
				ledgerStartedAt: T0,
			});
			prisma.termsConsent.count.mockResolvedValue(2);

			const status = await service.getStatus("u1");

			expect(status.completed).toBe(true);
			expect(status.requiredConsentsMet).toBe(true);
			expect(status.settings).toEqual({
				baseCurrency: "HKD",
				locale: "zh-CN",
				region: "CN",
				prepPreference: "balanced",
				reminderEnabled: false,
				ledgerStartedAt: T0,
			});
		});

		it("条款只差一条也算未满足（age18 + terms 须齐全）", async () => {
			prisma.userSettings.findUnique.mockResolvedValue(null);
			prisma.termsConsent.count.mockResolvedValue(1);

			const status = await service.getStatus("u1");

			expect(status.requiredConsentsMet).toBe(false);
		});
	});

	describe("saveConsents", () => {
		it("未全部确认（false）→ 400 CONSENT_REQUIRED", async () => {
			await errorOf(() =>
				service.saveConsents("u1", {
					age18Confirmed: true,
					termsConfirmed: false,
				}),
			).then(({ body }) => expect(body.code).toBe("CONSENT_REQUIRED"));
			expect(prisma.termsConsent.upsert).not.toHaveBeenCalled();
		});

		it("成功：age18 与 terms 两条 upsert（当前版本），update 为空保留首次 consentedAt", async () => {
			const first = new Date("2026-01-01T00:00:00.000Z");
			prisma.$transaction.mockImplementation(
				async (cb: (tx: typeof prisma) => unknown) => cb(prisma),
			);
			prisma.termsConsent.upsert.mockImplementation(
				async ({ where: { userId_termsVersion_consentType: key } }: any) => ({
					consentType: key.consentType,
					consentedAt: key.consentType === "age18" ? first : new Date(),
				}),
			);

			const result = await service.saveConsents("u1", {
				age18Confirmed: true,
				termsConfirmed: true,
			});

			expect(result.termsVersion).toBe(CURRENT_TERMS_VERSION);
			expect(result.age18ConsentedAt).toBe(first);
			for (const call of prisma.termsConsent.upsert.mock.calls) {
				const [arg] = call;
				expect(arg.where.userId_termsVersion_consentType.userId).toBe("u1");
				expect(arg.where.userId_termsVersion_consentType.termsVersion).toBe(
					CURRENT_TERMS_VERSION,
				);
				// 幂等：重复确认不覆盖 consentedAt
				expect(arg.update).toEqual({});
			}
		});
	});

	describe("complete", () => {
		it("条款缺失 → 400 CONSENT_REQUIRED，不创建设置", async () => {
			prisma.termsConsent.count.mockResolvedValue(1);

			const { status, body } = await errorOf(
				() => service.complete("u1", { ...validWizard }),
				OnboardingConsentRequiredException,
			);

			expect(status).toBe(400);
			expect(body.code).toBe("CONSENT_REQUIRED");
			expect(prisma.userSettings.create).not.toHaveBeenCalled();
		});

		it("非法本位币 → 400 INVALID_BASE_CURRENCY", async () => {
			prisma.termsConsent.count.mockResolvedValue(2);

			const { body } = await errorOf(
				() => service.complete("u1", { ...validWizard, baseCurrency: "FOO" }),
				OnboardingInvalidCurrencyException,
			);

			expect(body.code).toBe("INVALID_BASE_CURRENCY");
			expect(prisma.userSettings.create).not.toHaveBeenCalled();
		});

		it("已有设置 → 409 ONBOARDING_ALREADY_COMPLETED，不重复创建", async () => {
			prisma.termsConsent.count.mockResolvedValue(2);
			prisma.userSettings.findUnique.mockResolvedValue({
				baseCurrency: "HKD",
				locale: "zh-CN",
				region: "CN",
				prepPreference: "balanced",
				reminderEnabled: true,
				ledgerStartedAt: T0,
			});

			const { status, body } = await errorOf(
				() => service.complete("u1", { ...validWizard }),
				OnboardingAlreadyCompletedException,
			);

			expect(status).toBe(409);
			expect(body.code).toBe("ONBOARDING_ALREADY_COMPLETED");
			expect(prisma.userSettings.create).not.toHaveBeenCalled();
		});

		it("成功：事务内创建设置（ledgerStartedAt = 完成当日 UTC+8 日初）", async () => {
			prisma.termsConsent.count.mockResolvedValue(2);
			prisma.userSettings.findUnique.mockResolvedValue(null);
			prisma.userSettings.create.mockImplementation(async ({ data }: any) => ({
				...data,
			}));

			const result = await service.complete("u1", {
				...validWizard,
				baseCurrency: "usd",
			});

			expect(prisma.userSettings.create).toHaveBeenCalledWith({
				data: {
					userId: "u1",
					baseCurrency: "USD", // 规范化大写
					locale: "zh-CN",
					region: "CN",
					prepPreference: "balanced",
					reminderEnabled: true,
					ledgerStartedAt: utc8DayStart(T0), // 起点对齐完成当日 UTC+8 日初
				},
			});
			expect(result.settings.baseCurrency).toBe("USD");
			expect(result.ledgerStartedAt).toEqual(utc8DayStart(T0));
		});

		it("并发兜底：插入撞唯一约束 P2002 → 409 ONBOARDING_ALREADY_COMPLETED", async () => {
			prisma.termsConsent.count.mockResolvedValue(2);
			prisma.userSettings.findUnique.mockResolvedValue(null);
			prisma.userSettings.create.mockRejectedValue(
				Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
			);

			const { status, body } = await errorOf(
				() => service.complete("u1", { ...validWizard }),
				OnboardingAlreadyCompletedException,
			);

			expect(status).toBe(409);
			expect(body.code).toBe("ONBOARDING_ALREADY_COMPLETED");
		});

		it("非 P2002 的创建错误原样抛出", async () => {
			prisma.termsConsent.count.mockResolvedValue(2);
			prisma.userSettings.findUnique.mockResolvedValue(null);
			prisma.userSettings.create.mockRejectedValue(
				new Error("connection refused"),
			);

			await expect(service.complete("u1", { ...validWizard })).rejects.toThrow(
				"connection refused",
			);
		});
	});
});
