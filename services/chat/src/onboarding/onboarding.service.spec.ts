import { HttpException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditService } from "../audit/audit.service";
import type { ActorContext } from "../authorization/authorization.types";
import type { PrismaService } from "../prisma/prisma.service";
import { RateSourceUnavailableException } from "../rate/rate.errors";
import type { RateService } from "../rate/rate.service";
import { utc8DayStart } from "../transaction/transaction-calculator";
import { CURRENT_TERMS_VERSION } from "./onboarding.constants";
import {
	InitialHoldingExistsException,
	InvalidAmountException,
	InvalidHoldingsException,
	OnboardingAlreadyCompletedException,
	OnboardingConsentRequiredException,
	OnboardingInvalidCurrencyException,
	OnboardingNotCompletedException,
	OnboardingService,
	RateUnavailableException,
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

const DEFAULT_ACTOR: ActorContext = {
	userId: "u1",
	organizationId: "org-default",
	membershipId: "mem-1",
	role: "OWNER",
	authMethod: "USER",
	isDefaultOrganization: true,
};

function createPrismaMock() {
	const userSettings = {
		findUnique: vi.fn().mockResolvedValue(null),
		create: vi.fn(),
		upsert: vi.fn(async ({ create }: { create: { locale: string; region: string } }) => ({
			locale: create.locale,
			region: create.region,
		})),
	};
	// 组织偏好解析（评审 I-10）：默认无 OrganizationSettings；组织活跃 Owner 与
	// 用户的默认组织都指向 u1 / org-default（单组织存量用户形态）
	const organizationSettings = {
		findUnique: vi.fn().mockResolvedValue(null),
		create: vi.fn(async ({ data }: any) => ({ ...data })),
		upsert: vi.fn(async ({ create }: any) => ({ ...create })),
	};
	const membership = {
		// 组织的活跃 Owner（resolveOrganizationPreferences）
		findFirst: vi.fn(() => Promise.resolve({ userId: "u1" })),
		// lockOrganizationForActor 锁内重读操作者成员行
		findUnique: vi.fn().mockResolvedValue({
			organizationId: "org-default",
			role: "OWNER",
			status: "ACTIVE",
		}),
	};
	// 默认组织解析 resolveDefaultOrganizationId / resolveDefaultOrganizationCreatorUserId
	// 走原生 SQL（评审 R2-I03 / I-2）：u1 创建的最早组织 = org-default
	const $queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
		const sql = strings.join(" ");
		if (sql.includes("FROM accounts")) return [];
		if (sql.includes('m.user_id AS "userId"')) {
			return [{ userId: "u1" }];
		}
		return [{ organizationId: "org-default" }];
	});
	const $executeRaw = vi.fn().mockResolvedValue(1);
	const termsConsent = {
		count: vi.fn(),
		upsert: vi.fn(),
	};
	const initialHolding = {
		findMany: vi.fn(),
		findUnique: vi.fn().mockResolvedValue(null),
		create: vi.fn(),
		updateMany: vi.fn().mockResolvedValue({ count: 0 }),
	};
	const costLot = {
		create: vi.fn(),
		aggregate: vi.fn(),
		updateMany: vi.fn().mockResolvedValue({ count: 0 }),
	};
	const transaction = {
		updateMany: vi.fn().mockResolvedValue({ count: 0 }),
	};
	const account = {
		findUnique: vi.fn().mockResolvedValue(null),
		findFirst: vi.fn().mockResolvedValue(null),
		update: vi.fn(),
		delete: vi.fn(),
		upsert: vi.fn(),
	};
	const prisma = {
		userSettings,
		organizationSettings,
		membership,
		$queryRaw,
		$executeRaw,
		termsConsent,
		initialHolding,
		costLot,
		transaction,
		account,
		$transaction: vi.fn(async (callback: (tx: typeof prisma) => unknown) =>
			callback(prisma),
		),
	};
	return prisma;
}

function createAuditServiceMock() {
	return {
		recordInTx: vi.fn().mockResolvedValue(undefined),
		recordStandalone: vi.fn().mockResolvedValue(undefined),
	} as unknown as {
		recordInTx: ReturnType<typeof vi.fn>;
		recordStandalone: ReturnType<typeof vi.fn>;
	} & AuditService;
}

function createRateServiceMock() {
	return {
		getLatestForBooking: vi.fn(),
	} as unknown as {
		getLatestForBooking: ReturnType<typeof vi.fn>;
	} & RateService;
}

function createLoggerMock() {
	return {
		log: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as unknown as {
		log: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
	} & import("@nestjs/common").Logger;
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
	let rateService: ReturnType<typeof createRateServiceMock>;
	let logger: ReturnType<typeof createLoggerMock>;
	let auditService: ReturnType<typeof createAuditServiceMock>;
	let service: OnboardingService;

	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
		prisma = createPrismaMock();
		rateService = createRateServiceMock();
		logger = createLoggerMock();
		auditService = createAuditServiceMock();
		service = new OnboardingService(
			prisma as unknown as PrismaService,
			rateService,
			logger,
			auditService,
		);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** 建账成功前置：条款齐全、无既有设置、create 原样回显 */
	function mockCompleteSuccess() {
		prisma.termsConsent.count.mockResolvedValue(2);
		prisma.organizationSettings.findUnique.mockResolvedValue(null);
		prisma.userSettings.findUnique.mockResolvedValue(null);
		prisma.organizationSettings.create.mockImplementation(async ({ data }: any) => ({
			...data,
		}));
	}

	/** 多目标组响应（1 USD = 7.26 CNY 现汇卖出价 / 1 JPY = 0.048 CNY 基准价） */
	function mockGroupQuotes() {
		rateService.getLatestForBooking.mockResolvedValue({
			base: "CNY",
			items: [
				{
					target: "USD",
					rate: "7.253100005",
					sellRate: "7.26000000",
					source: "abc",
					observedAt: T0.toISOString(),
					validUntil: new Date(T0.getTime() + 5 * 60 * 1000).toISOString(),
					fresh: true,
				},
				{
					target: "JPY",
					rate: "0.0480000000",
					source: "er-api",
					observedAt: T0.toISOString(),
					validUntil: new Date(T0.getTime() + 5 * 60 * 1000).toISOString(),
					fresh: true,
				},
			],
		});
		prisma.initialHolding.create.mockImplementation(async ({ data }: any) => ({
			id: `holding-${data.currencyCode}`,
			...data,
		}));
		prisma.costLot.create.mockResolvedValue({});
		prisma.costLot.aggregate.mockResolvedValue({
			_sum: { remainingQty: "1000" },
		});
		prisma.account.upsert.mockResolvedValue({});
	}

	describe("getStatus（按当前组织的偏好判定完成态；评审 I-10）", () => {
		/** u1 的默认组织；无 OrganizationSettings，兼容回落到 u1 的个人设置 */
		const DEFAULT_SCOPE = { userId: "u1", organizationId: "org-default" };
		const onboardedRow = {
			baseCurrency: "HKD",
			locale: "zh-CN",
			region: "CN",
			prepPreference: "balanced",
			reminderEnabled: false,
			ledgerStartedAt: T0,
		};

		it("未完成：completed=false、settings=null", async () => {
			prisma.userSettings.findUnique.mockResolvedValue(null);
			prisma.termsConsent.count.mockResolvedValue(0);

			const status = await service.getStatus(DEFAULT_SCOPE);

			expect(status.completed).toBe(false);
			expect(status.requiredConsentsMet).toBe(false);
			expect(status.settings).toBeNull();
			expect(status.currentTermsVersion).toBe(CURRENT_TERMS_VERSION);
		});

		it("已完成（兼容回落到默认组织所有者的个人设置）：返回 settings 视图，completed=true", async () => {
			prisma.userSettings.findUnique.mockResolvedValue(onboardedRow);
			prisma.termsConsent.count.mockResolvedValue(2);

			const status = await service.getStatus(DEFAULT_SCOPE);

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

		it("受邀成员（无个人设置行）在已建账的默认组织里：completed=true，不读成员本人的设置", async () => {
			// 组织所有者 u1 已建账；成员 member 没有自己的 UserSettings
			prisma.userSettings.findUnique.mockImplementation((args: { where: { userId: string } }) =>
				Promise.resolve(args.where.userId === "u1" ? onboardedRow : null),
			);
			prisma.termsConsent.count.mockResolvedValue(0);

			const status = await service.getStatus({ userId: "member", organizationId: "org-default" });

			expect(status.completed).toBe(true);
			expect(status.settings).toMatchObject({ baseCurrency: "HKD", locale: "zh-CN", region: "CN" });
			expect(status.requiredConsentsMet).toBe(false); // 条款确认仍是个人维度
		});

		it("组织设置存在时以组织设置为准，不再读任何个人设置", async () => {
			prisma.organizationSettings.findUnique.mockResolvedValue({
				baseCurrency: "USD",
				prepPreference: "cautious",
				reminderEnabled: true,
				ledgerStartedAt: T0,
			});
			prisma.userSettings.findUnique.mockResolvedValue(null);
			prisma.termsConsent.count.mockResolvedValue(2);

			const status = await service.getStatus(DEFAULT_SCOPE);

			expect(status.completed).toBe(true);
			expect(status.settings).toMatchObject({ baseCurrency: "USD", prepPreference: "cautious", locale: "zh-CN", region: "CN" });
		});

		it("已建账用户切到其新建的（未建账）组织：completed=false——不回落创建者的个人设置", async () => {
			prisma.userSettings.findUnique.mockResolvedValue(onboardedRow);
			// u1 的默认组织是 org-default（见 createPrismaMock 的 $queryRaw）；
			// 当前请求的组织 org-new 不是默认组织 → 不回落
			prisma.termsConsent.count.mockResolvedValue(2);

			const status = await service.getStatus({ userId: "u1", organizationId: "org-new" });

			expect(status.completed).toBe(false);
			expect(status.settings).toBeNull();
		});

		it("条款只差一条也算未满足（age18 + terms 须齐全）", async () => {
			prisma.userSettings.findUnique.mockResolvedValue(null);
			prisma.termsConsent.count.mockResolvedValue(1);

			const status = await service.getStatus(DEFAULT_SCOPE);

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
				() => service.complete(DEFAULT_ACTOR, { ...validWizard }),
				OnboardingConsentRequiredException,
			);

			expect(status).toBe(400);
			expect(body.code).toBe("CONSENT_REQUIRED");
			expect(prisma.organizationSettings.create).not.toHaveBeenCalled();
		});

		it("非法本位币 → 400 INVALID_BASE_CURRENCY", async () => {
			prisma.termsConsent.count.mockResolvedValue(2);

			const { body } = await errorOf(
				() => service.complete(DEFAULT_ACTOR, { ...validWizard, baseCurrency: "FOO" }),
				OnboardingInvalidCurrencyException,
			);

			expect(body.code).toBe("INVALID_BASE_CURRENCY");
			expect(prisma.organizationSettings.create).not.toHaveBeenCalled();
		});

		it("已有组织设置 → 409 ONBOARDING_ALREADY_COMPLETED，不重复创建", async () => {
			prisma.termsConsent.count.mockResolvedValue(2);
			prisma.organizationSettings.findUnique.mockResolvedValue({
				baseCurrency: "HKD",
				prepPreference: "balanced",
				reminderEnabled: true,
				ledgerStartedAt: T0,
			});

			const { status, body } = await errorOf(
				() => service.complete(DEFAULT_ACTOR, { ...validWizard }),
				OnboardingAlreadyCompletedException,
			);

			expect(status).toBe(409);
			expect(body.code).toBe("ONBOARDING_ALREADY_COMPLETED");
			expect(prisma.organizationSettings.create).not.toHaveBeenCalled();
		});

		it("多组织独立建账：本人已有 Org A UserSettings 时为新建 Org B complete 不被 409 阻塞，且不覆盖 Org A baseCurrency", async () => {
			prisma.termsConsent.count.mockResolvedValue(2);
			prisma.organizationSettings.findUnique.mockResolvedValue(null);
			// Org B 不是默认组织，即使 u1 名下已有 Org A 的 UserSettings(HKD)
			prisma.userSettings.findUnique.mockResolvedValue({
				baseCurrency: "HKD",
				locale: "zh-CN",
				region: "CN",
				prepPreference: "balanced",
				reminderEnabled: true,
				ledgerStartedAt: T0,
			});
			prisma.membership.findUnique.mockResolvedValue({
				organizationId: "org-b",
				role: "OWNER",
				status: "ACTIVE",
			});

			const result = await service.complete(
				{
					...DEFAULT_ACTOR,
					organizationId: "org-b",
					isDefaultOrganization: false,
				},
				{ ...validWizard, baseCurrency: "USD", region: "HK", locale: "en" },
				"req-org-b",
			);

			expect(result.settings.baseCurrency).toBe("USD");
			expect(prisma.organizationSettings.create).toHaveBeenCalledWith({
				data: {
					organizationId: "org-b",
					baseCurrency: "USD",
					prepPreference: "balanced",
					reminderEnabled: true,
					ledgerStartedAt: utc8DayStart(T0),
				},
			});
			const [upsertArg] = prisma.userSettings.upsert.mock.calls[0];
			expect(upsertArg.create.baseCurrency).toBe("");
			expect(upsertArg.create.ledgerStartedAt).toBeNull();
			expect(upsertArg.update).toEqual({ locale: "en", region: "HK" });
			expect("baseCurrency" in upsertArg.update).toBe(false);
			expect("ledgerStartedAt" in upsertArg.update).toBe(false);
			expect(auditService.recordInTx).toHaveBeenCalledWith(
				prisma,
				expect.objectContaining({
					organizationId: "org-b",
					actorUserId: "u1",
					action: "onboarding.complete",
					result: "SUCCESS",
					requestId: "req-org-b",
					detail: { baseCurrency: "USD", holdingsCount: 0 },
				}),
			);
		});

		it("非默认组织先建账（无 UserSettings 行）→ 仅写占位 baseCurrency=\"\"，绝不把默认组织标为已建账", async () => {
			prisma.termsConsent.count.mockResolvedValue(2);
			prisma.organizationSettings.findUnique.mockResolvedValue(null);
			prisma.userSettings.findUnique.mockResolvedValue(null);
			prisma.membership.findUnique.mockResolvedValue({
				organizationId: "org-b",
				role: "OWNER",
				status: "ACTIVE",
			});

			await service.complete(
				{
					...DEFAULT_ACTOR,
					organizationId: "org-b",
					isDefaultOrganization: false,
				},
				{ ...validWizard, baseCurrency: "USD" },
			);

			const [upsertArg] = prisma.userSettings.upsert.mock.calls[0];
			expect(upsertArg.create.baseCurrency).toBe("");
			expect(upsertArg.create.ledgerStartedAt).toBeNull();
			expect(upsertArg.update).toEqual({ locale: "zh-CN", region: "CN" });
		});

		it("锁等期间降权 → 403 PERMISSION_DENIED + recordStandalone DENIED + 事务零写入", async () => {
			prisma.termsConsent.count.mockResolvedValue(2);
			prisma.membership.findUnique.mockResolvedValue({
				organizationId: "org-default",
				role: "OPERATOR",
				status: "ACTIVE",
			});

			const { status, body } = await errorOf(() =>
				service.complete(DEFAULT_ACTOR, { ...validWizard }, "req-demoted"),
			);

			expect(status).toBe(403);
			expect(body.code).toBe("PERMISSION_DENIED");
			expect(prisma.organizationSettings.create).not.toHaveBeenCalled();
			expect(auditService.recordInTx).not.toHaveBeenCalled();
			expect(auditService.recordStandalone).toHaveBeenCalledWith({
				organizationId: "org-default",
				actorUserId: "u1",
				actorType: "USER",
				action: "permission.denied.settings.update",
				result: "DENIED",
				requestId: "req-demoted",
				detail: { required: "settings.update", role: "OPERATOR" },
			});
		});

		it("成功：事务内创建设置（ledgerStartedAt = 完成当日 UTC+8 日初）+ 同事务写审计", async () => {
			mockCompleteSuccess();

			const result = await service.complete(
				DEFAULT_ACTOR,
				{
					...validWizard,
					baseCurrency: "usd",
				},
				"req-ok",
			);

			expect(prisma.organizationSettings.create).toHaveBeenCalledWith({
				data: {
					organizationId: "org-default",
					baseCurrency: "USD", // 规范化大写
					prepPreference: "balanced",
					reminderEnabled: true,
					ledgerStartedAt: utc8DayStart(T0), // 起点对齐完成当日 UTC+8 日初
				},
			});
			expect(result.settings.baseCurrency).toBe("USD");
			expect(result.ledgerStartedAt).toEqual(utc8DayStart(T0));
			expect(auditService.recordInTx).toHaveBeenCalledWith(
				prisma,
				expect.objectContaining({
					organizationId: "org-default",
					actorUserId: "u1",
					action: "onboarding.complete",
					result: "SUCCESS",
					requestId: "req-ok",
					detail: { baseCurrency: "USD", holdingsCount: 0 },
				}),
			);
		});

		it("并发兜底：插入撞唯一约束 P2002 → 409 ONBOARDING_ALREADY_COMPLETED", async () => {
			prisma.termsConsent.count.mockResolvedValue(2);
			prisma.organizationSettings.findUnique.mockResolvedValue(null);
			prisma.organizationSettings.create.mockRejectedValue(
				Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
			);

			const { status, body } = await errorOf(
				() => service.complete(DEFAULT_ACTOR, { ...validWizard }),
				OnboardingAlreadyCompletedException,
			);

			expect(status).toBe(409);
			expect(body.code).toBe("ONBOARDING_ALREADY_COMPLETED");
		});

		it("非 P2002 的创建错误原样抛出", async () => {
			prisma.termsConsent.count.mockResolvedValue(2);
			prisma.organizationSettings.findUnique.mockResolvedValue(null);
			prisma.organizationSettings.create.mockRejectedValue(
				new Error("connection refused"),
			);

			await expect(
				service.complete(DEFAULT_ACTOR, { ...validWizard }),
			).rejects.toThrow("connection refused");
		});

		it("prepPreference / reminderEnabled 缺省：服务端兜底 balanced / true", async () => {
			mockCompleteSuccess();

			await service.complete(DEFAULT_ACTOR, {
				region: "CN",
				locale: "zh-CN",
				baseCurrency: "CNY",
			});

			const [arg] = prisma.organizationSettings.create.mock.calls[0];
			expect(arg.data.prepPreference).toBe("balanced");
			expect(arg.data.reminderEnabled).toBe(true);
		});

		it("带 2 币种 holdings 成功：先取组织账本锁、采用价 sellRate 优先、8 位舍入、成本按本位币精度、批次与组织账户重算", async () => {
			mockCompleteSuccess();
			mockGroupQuotes();

			const result = await service.complete(DEFAULT_ACTOR, {
				...validWizard,
				initialHoldings: [
					{ currencyCode: "usd", amount: "1000.00" }, // 混合大小写，规范化 USD
					{ currencyCode: "JPY", amount: "100000" },
				],
			});

			// lockOrgLedgerAccounts 在写前按 COLLATE "C" 升序取 advisory 锁（JPY < USD）
			const lockKeys = prisma.$executeRaw.mock.calls.map(
				(call) => call[1] as string,
			);
			expect(lockKeys).toContain("membership:org-default");
			expect(lockKeys).toContain("ledger-write:org:org-default:JPY");
			expect(lockKeys).toContain("ledger-write:org:org-default:USD");
			expect(lockKeys.indexOf("ledger-write:org:org-default:JPY")).toBeLessThan(
				lockKeys.indexOf("ledger-write:org:org-default:USD"),
			);

			// getLatestForBooking 以规范化后的币种代码取价（base = 本位币）
			expect(rateService.getLatestForBooking).toHaveBeenCalledWith("CNY", ["USD", "JPY"]);

			// InitialHolding × 2：带 organizationId / createdById
			const holdingCalls = prisma.initialHolding.create.mock.calls;
			expect(holdingCalls).toHaveLength(2);
			const usdData = holdingCalls[0][0].data;
			expect(usdData.organizationId).toBe("org-default");
			expect(usdData.createdById).toBe("u1");
			expect(usdData.currencyCode).toBe("USD");
			expect(usdData.amount.toFixed(4)).toBe("1000.0000");
			expect(usdData.rate.toFixed(8)).toBe("7.26000000"); // 采用现汇卖出价
			expect(usdData.rawRate.toFixed(10)).toBe("7.2600000000");
			expect(usdData.rateSource).toBe("abc");
			expect(usdData.rateObservedAt).toEqual(T0);
			expect(usdData.cost.toFixed(4)).toBe("7260.0000"); // 1000 × 7.26，CNY 2 位精度
			expect(usdData.confirmedAt).toBeInstanceOf(Date);
			const jpyData = holdingCalls[1][0].data;
			expect(jpyData.currencyCode).toBe("JPY");
			expect(jpyData.rate.toFixed(8)).toBe("0.04800000"); // 无卖出价回退基准价
			expect(jpyData.rawRate.toFixed(10)).toBe("0.0480000000");
			expect(jpyData.cost.toFixed(4)).toBe("4800.0000"); // 100000 × 0.048

			// CostLot × 2：带 organizationId
			const lotCalls = prisma.costLot.create.mock.calls;
			expect(lotCalls).toHaveLength(2);
			const usdLot = lotCalls[0][0].data;
			expect(usdLot.organizationId).toBe("org-default");
			expect(usdLot.sourceType).toBe("INITIAL");
			expect(usdLot.sourceId).toBe("holding-USD");
			expect(usdLot.quantity.toFixed(4)).toBe("1000.0000");
			expect(usdLot.remainingQty.toFixed(4)).toBe("1000.0000");
			expect(usdLot.unitCost.toFixed(8)).toBe("7.26000000");
			expect(usdLot.totalCost.toFixed(4)).toBe("7260.0000");
			expect(usdLot.acquiredAt).toEqual(utc8DayStart(T0)); // = ledgerStartedAt

			// Account 按组织批次汇总重算（costLot.aggregate → upsertOrgAccountWithLegacyMerge）
			expect(prisma.costLot.aggregate).toHaveBeenCalledWith({
				_sum: { remainingQty: true },
				where: {
					currencyCode: "USD",
					organizationId: "org-default",
				},
			});
			expect(prisma.account.upsert).toHaveBeenCalledTimes(2);
			const [upsertArg] = prisma.account.upsert.mock.calls[0];
			expect(upsertArg.where).toEqual({
				organizationId_currencyCode: {
					organizationId: "org-default",
					currencyCode: "USD",
				},
			});
			expect(upsertArg.create.organizationId).toBe("org-default");
			expect(upsertArg.create.createdById).toBe("u1");
			expect(upsertArg.create.balance.toFixed(4)).toBe("1000.0000");

			// 响应出参不变：settings + ledgerStartedAt
			expect(result.settings.baseCurrency).toBe("CNY");
			expect(result.ledgerStartedAt).toEqual(utc8DayStart(T0));
		});

		it("8 位汇率舍入：原报价 10 位小数 → rate = HALF_UP 8 位、rawRate 保留原值", async () => {
			mockCompleteSuccess();
			rateService.getLatestForBooking.mockResolvedValue({
				base: "CNY",
				items: [
					{
						target: "USD",
						rate: "7.253100005", // 第 9 位为 5 → HALF_UP 进位
						source: "er-api",
						observedAt: T0.toISOString(),
						validUntil: new Date(T0.getTime() + 5 * 60 * 1000).toISOString(),
						fresh: true,
					},
				],
			});
			prisma.initialHolding.create.mockImplementation(
				async ({ data }: any) => ({ id: "holding-1", ...data }),
			);
			prisma.costLot.create.mockResolvedValue({});
			prisma.costLot.aggregate.mockResolvedValue({
				_sum: { remainingQty: "100" },
			});
			prisma.account.upsert.mockResolvedValue({});

			await service.complete(DEFAULT_ACTOR, {
				...validWizard,
				initialHoldings: [{ currencyCode: "USD", amount: "100.00" }],
			});

			const [arg] = prisma.initialHolding.create.mock.calls[0];
			expect(arg.data.rate.toFixed(8)).toBe("7.25310001");
			expect(arg.data.rawRate.toFixed(10)).toBe("7.2531000050");
		});

		it("成本舍入为 0 拒绝（400 INVALID_AMOUNT）", async () => {
			mockCompleteSuccess();
			rateService.getLatestForBooking.mockResolvedValue({
				base: "CNY",
				items: [
					{
						target: "USD",
						rate: "0.4",
						source: "er-api",
						observedAt: T0.toISOString(),
						validUntil: new Date(T0.getTime() + 5 * 60 * 1000).toISOString(),
						fresh: true,
					},
				],
			});

			const { body } = await errorOf(
				() =>
					service.complete(DEFAULT_ACTOR, {
						...validWizard,
						initialHoldings: [{ currencyCode: "USD", amount: "0.01" }],
					}),
				InvalidAmountException,
			);

			expect(body.code).toBe("INVALID_AMOUNT");
			// 整单回滚语义：事务回调内抛出即回滚（mock 下以 create 未产生后续断言体现）
			expect(prisma.account.upsert).not.toHaveBeenCalled();
		});

		it("成本 ≥ 1e11 拒绝（400 INVALID_AMOUNT）", async () => {
			mockCompleteSuccess();
			rateService.getLatestForBooking.mockResolvedValue({
				base: "CNY",
				items: [
					{
						target: "USD",
						rate: "200", // 1e9 × 200 = 2e11 ≥ 1e11
						source: "er-api",
						observedAt: T0.toISOString(),
						validUntil: new Date(T0.getTime() + 5 * 60 * 1000).toISOString(),
						fresh: true,
					},
				],
			});

			const { body } = await errorOf(
				() =>
					service.complete(DEFAULT_ACTOR, {
						...validWizard,
						initialHoldings: [{ currencyCode: "USD", amount: "1000000000" }],
					}),
				InvalidAmountException,
			);

			expect(body.code).toBe("INVALID_AMOUNT");
		});

		it("入账取价后仍不 fresh → 400 RATE_UNAVAILABLE（MVP-F0-2：锚点为系统确认 fresh/validUntil）", async () => {
			mockCompleteSuccess();
			const staleItem = {
				target: "USD",
				rate: "7.25",
				source: "er-api",
				observedAt: T0.toISOString(),
				validUntil: new Date(T0.getTime() + 5 * 60 * 1000).toISOString(),
				fresh: false,
			};
			rateService.getLatestForBooking.mockResolvedValueOnce({ base: "CNY", items: [staleItem] });
			vi.setSystemTime(new Date(T0.getTime() + 6 * 60 * 1000));

			const { body } = await errorOf(
				() =>
					service.complete(DEFAULT_ACTOR, {
						...validWizard,
						initialHoldings: [{ currencyCode: "USD", amount: "100.00" }],
					}),
				RateUnavailableException,
			);

			expect(body.code).toBe("RATE_UNAVAILABLE");
			expect(rateService.getLatestForBooking).toHaveBeenCalledExactlyOnceWith("CNY", ["USD"]);
		});

		it("日级源 observedAt 早于 5 分钟但系统确认 fresh 且 validUntil 未过期 → 正常入账（不再以 observedAt 自设时效）", async () => {
			mockCompleteSuccess();
			mockGroupQuotes();
			rateService.getLatestForBooking.mockResolvedValue({
				base: "CNY",
				items: [
					{
						target: "USD",
						rate: "7.25",
						source: "er-api",
						// 日级源发布时间恒早于 5 分钟窗口：fresh 以系统确认为锚
						observedAt: new Date(T0.getTime() - 60 * 60 * 1000).toISOString(),
						validUntil: new Date(T0.getTime() + 30 * 60 * 1000).toISOString(),
						fresh: true,
					},
				],
			});
			vi.setSystemTime(new Date(T0.getTime() + 6 * 60 * 1000));

			await service.complete(DEFAULT_ACTOR, {
				...validWizard,
				initialHoldings: [{ currencyCode: "USD", amount: "100.00" }],
			});

			const holding = prisma.initialHolding.create.mock.calls.at(-1)![0]
				.data as { rateObservedAt: Date };
			// 发布时间原样落库（rateObservedAt），不因早于窗口被拒
			expect(holding.rateObservedAt).toEqual(
				new Date(T0.getTime() - 60 * 60 * 1000),
			);
		});

		it("系统确认 fresh 但 validUntil 已过（写账前跨过有效期）→ 400", async () => {
			mockCompleteSuccess();
			const contradictionItem = {
				target: "USD",
				rate: "7.25",
				source: "er-api",
				observedAt: T0.toISOString(),
				validUntil: new Date(T0.getTime() - 60 * 60 * 1000).toISOString(),
				fresh: true,
			};
			// fresh=true 与过期 validUntil 并存（取价与写账间隙跨过有效期）：
			// validUntil 判定过期 → 整单拒绝
			rateService.getLatestForBooking.mockResolvedValueOnce({ base: "CNY", items: [contradictionItem] });

			const { body } = await errorOf(
				() =>
					service.complete(DEFAULT_ACTOR, {
						...validWizard,
						initialHoldings: [{ currencyCode: "USD", amount: "100.00" }],
					}),
				RateUnavailableException,
			);
			expect(body.code).toBe("RATE_UNAVAILABLE");
			expect(rateService.getLatestForBooking).toHaveBeenCalledTimes(1);
		});

		it("fresh=true 但 validUntil 非法（不可解析）→ 视同不 fresh → 400（isFresh 解析防御回归）", async () => {
			mockCompleteSuccess();
			const badValidUntilItem = {
				target: "USD",
				rate: "7.25",
				source: "er-api",
				observedAt: T0.toISOString(),
				validUntil: "not-an-iso-date",
				fresh: true,
			};
			rateService.getLatestForBooking.mockResolvedValueOnce({ base: "CNY", items: [badValidUntilItem] });

			const { body } = await errorOf(
				() =>
					service.complete(DEFAULT_ACTOR, {
						...validWizard,
						initialHoldings: [{ currencyCode: "USD", amount: "100.00" }],
					}),
				RateUnavailableException,
			);
			expect(body.code).toBe("RATE_UNAVAILABLE");
			expect(rateService.getLatestForBooking).toHaveBeenCalledTimes(1);
		});

		it("固定 UTC+8 00:05 / 14:30 / 23:55 三时点：按确认时效入账（FX-04 时段覆盖）", async () => {
			// 日级源 observedAt = 2026-09-14T16:05:00Z（UTC+8 09-15 00:05）：
			// 建账发生在三个固定 UTC+8 时点，均按系统确认时效入账
			const observedAt = new Date("2026-09-14T16:05:00.000Z");
			for (const [label, instant] of [
				["00:05", "2026-09-15T16:05:00.000Z"], // = UTC+8 09-16 00:05
				["14:30", "2026-09-15T06:30:00.000Z"], // = UTC+8 09-15 14:30
				["23:55", "2026-09-15T15:55:00.000Z"], // = UTC+8 09-15 23:55
			] as const) {
				mockCompleteSuccess();
				mockGroupQuotes();
				prisma.initialHolding.create.mockClear();
				rateService.getLatestForBooking.mockClear();
				vi.setSystemTime(new Date(instant));
				const freshItem = {
					target: "TWD",
					rate: "0.0307284801",
					source: "er-api",
					observedAt: observedAt.toISOString(),
					validUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
					fresh: true,
				};
				rateService.getLatestForBooking.mockResolvedValueOnce({ base: "CNY", items: [freshItem] });

				await service.complete(
					{ ...DEFAULT_ACTOR, userId: `u1-${label}` },
					{
						...validWizard,
						initialHoldings: [{ currencyCode: "TWD", amount: "1000" }],
					},
				);

				expect(rateService.getLatestForBooking).toHaveBeenCalledExactlyOnceWith("CNY", ["TWD"]);
				const holding = prisma.initialHolding.create.mock.calls.at(-1)![0]
					.data as { rateObservedAt: Date; currencyCode: string };
				expect(holding.currencyCode).toBe("TWD");
				expect(holding.rateObservedAt).toEqual(observedAt);
			}
			vi.useRealTimers();
		});

		it("取价失败（数据源不可用）→ 400 RATE_UNAVAILABLE，事务回调内抛出即回滚", async () => {
			mockCompleteSuccess();
			rateService.getLatestForBooking.mockRejectedValue(
				new RateSourceUnavailableException(null),
			);

			const { status, body } = await errorOf(
				() =>
					service.complete(DEFAULT_ACTOR, {
						...validWizard,
						initialHoldings: [{ currencyCode: "USD", amount: "100.00" }],
					}),
				RateUnavailableException,
			);

			expect(status).toBe(400);
			expect(body.code).toBe("RATE_UNAVAILABLE");
			// settings.create 已执行（取价在其后），事务回调抛出 → 整体回滚语义
			expect(prisma.organizationSettings.create).toHaveBeenCalled();
			expect(prisma.initialHolding.create).not.toHaveBeenCalled();
		});

		it("holdings 校验：非法币种 / 含本位币 / 重复币种 → 400 INVALID_HOLDINGS", () => {
			const assertHoldings = (
				service as unknown as {
					assertHoldings: (base: string, items: unknown[]) => void;
				}
			).assertHoldings.bind(service);

			expect(() =>
				assertHoldings("CNY", [{ currencyCode: "FOO", amount: "1.00" }]),
			).toThrow(InvalidHoldingsException);
			expect(() =>
				assertHoldings("CNY", [{ currencyCode: "cny", amount: "1.00" }]),
			).toThrow(InvalidHoldingsException);
			expect(() =>
				assertHoldings("CNY", [
					{ currencyCode: "USD", amount: "1.00" },
					{ currencyCode: "USD", amount: "2.00" },
				]),
			).toThrow(InvalidHoldingsException);
		});

		it("holdings 金额校验：≤0 / ≥1e11 / JPY 带小数 → 400 INVALID_AMOUNT", () => {
			const assertHoldings = (
				service as unknown as {
					assertHoldings: (base: string, items: unknown[]) => void;
				}
			).assertHoldings.bind(service);

			expect(() =>
				assertHoldings("CNY", [{ currencyCode: "USD", amount: "0" }]),
			).toThrow(InvalidAmountException);
			expect(() =>
				assertHoldings("CNY", [{ currencyCode: "USD", amount: "-1" }]),
			).toThrow(InvalidAmountException);
			expect(() =>
				assertHoldings("CNY", [
					{ currencyCode: "USD", amount: "100000000000" },
				]),
			).toThrow(InvalidAmountException);
			expect(() =>
				assertHoldings("CNY", [{ currencyCode: "JPY", amount: "100.5" }]),
			).toThrow(InvalidAmountException);
		});

		it("成功日志不含金额与成本（可观测性：金额不落日志）", async () => {
			mockCompleteSuccess();
			mockGroupQuotes();

			await service.complete(DEFAULT_ACTOR, {
				...validWizard,
				initialHoldings: [
					{ currencyCode: "USD", amount: "1000.00" },
					{ currencyCode: "JPY", amount: "100000" },
				],
			});

			expect(logger.log).toHaveBeenCalledTimes(1);
			const serialized = JSON.stringify(logger.log.mock.calls[0]);
			expect(serialized).not.toContain("amount");
			expect(serialized).not.toContain("cost");
			expect(serialized).not.toContain("1000");
			expect(serialized).not.toContain("100000");
			expect(serialized).toContain("u1");
			expect(serialized).toContain("USD");
			expect(serialized).toContain("abc");
		});
	});

	describe("saveInitialHoldings", () => {
		const backfillDto = {
			holdings: [{ currencyCode: "EUR", amount: "500.00" }],
		};
		const settingsRow = {
			baseCurrency: "CNY",
			prepPreference: "balanced",
			reminderEnabled: true,
			ledgerStartedAt: utc8DayStart(T0),
		};

		it("未建账 → 409 ONBOARDING_NOT_COMPLETED", async () => {
			prisma.organizationSettings.findUnique.mockResolvedValue(null);
			prisma.userSettings.findUnique.mockResolvedValue(null);

			const { status, body } = await errorOf(
				() => service.saveInitialHoldings(DEFAULT_ACTOR, backfillDto),
				OnboardingNotCompletedException,
			);

			expect(status).toBe(409);
			expect(body.code).toBe("ONBOARDING_NOT_COMPLETED");
		});

		it("币种已有初始记录 → 409 INITIAL_HOLDING_EXISTS（整单拒绝）", async () => {
			prisma.organizationSettings.findUnique.mockResolvedValue(settingsRow);
			prisma.initialHolding.findMany.mockResolvedValue([
				{ currencyCode: "EUR" },
			]);

			const { body } = await errorOf(
				() => service.saveInitialHoldings(DEFAULT_ACTOR, backfillDto),
				InitialHoldingExistsException,
			);

			expect(body.code).toBe("INITIAL_HOLDING_EXISTS");
			expect(rateService.getLatestForBooking).not.toHaveBeenCalled();
		});

		it("正常补录：单目标平铺响应归一、ledgerStartedAt 取建账起点、写审计", async () => {
			prisma.organizationSettings.findUnique.mockResolvedValue(settingsRow);
			prisma.initialHolding.findMany.mockResolvedValue([]);
			// 单目标响应为平铺结构（无 items）→ 归一为单元素
			rateService.getLatestForBooking.mockResolvedValue({
				base: "CNY",
				target: "EUR",
				rate: "0.79000000",
				source: "frankfurter",
				observedAt: T0.toISOString(),
				validUntil: new Date(T0.getTime() + 5 * 60 * 1000).toISOString(),
				fresh: true,
			});
			prisma.initialHolding.create.mockImplementation(
				async ({ data }: any) => ({ id: "holding-eur", ...data }),
			);
			prisma.costLot.create.mockResolvedValue({});
			prisma.costLot.aggregate.mockResolvedValue({
				_sum: { remainingQty: "500" },
			});
			prisma.account.upsert.mockResolvedValue({});

			const result = await service.saveInitialHoldings(
				DEFAULT_ACTOR,
				backfillDto,
				"req-backfill",
			);

			expect(rateService.getLatestForBooking).toHaveBeenCalledWith("CNY", ["EUR"]);
			expect(result.created).toHaveLength(1);
			expect(result.created[0]).toMatchObject({
				currencyCode: "EUR",
				amount: "500.0000",
				rate: "0.7900000000",
				rawRate: "0.7900000000",
				rateSource: "frankfurter",
				cost: "395.0000", // 500 × 0.79
			});
			expect(result.created[0].rateObservedAt).toEqual(T0);
			expect(result.ledgerStartedAt).toEqual(utc8DayStart(T0));

			const [lotArg] = prisma.costLot.create.mock.calls[0];
			expect(lotArg.data.sourceType).toBe("INITIAL");
			expect(lotArg.data.organizationId).toBe("org-default");
			expect(lotArg.data.acquiredAt).toEqual(utc8DayStart(T0));
			expect(auditService.recordInTx).toHaveBeenCalledWith(
				prisma,
				expect.objectContaining({
					organizationId: "org-default",
					actorUserId: "u1",
					action: "onboarding.initial_holdings",
					result: "SUCCESS",
					requestId: "req-backfill",
				}),
			);
		});

		it("OWNER_LEGACY 组织补录时先固化 OrganizationSettings 并兼容升级 legacy Account", async () => {
			prisma.organizationSettings.findUnique.mockResolvedValue(null);
			prisma.userSettings.findUnique.mockResolvedValue({
				baseCurrency: "CNY",
				prepPreference: "balanced",
				reminderEnabled: true,
				ledgerStartedAt: null,
			});
			prisma.initialHolding.findMany.mockResolvedValue([]);
			prisma.account.findFirst.mockResolvedValue({
				id: "acc-legacy-eur",
				balance: new Prisma.Decimal("0"),
				createdById: null,
			});
			rateService.getLatestForBooking.mockResolvedValue({
				base: "CNY",
				target: "EUR",
				rate: "0.79000000",
				source: "frankfurter",
				observedAt: T0.toISOString(),
				validUntil: new Date(T0.getTime() + 5 * 60 * 1000).toISOString(),
				fresh: true,
			});
			prisma.initialHolding.create.mockImplementation(
				async ({ data }: any) => ({ id: "holding-eur", ...data }),
			);
			prisma.costLot.create.mockResolvedValue({});
			prisma.costLot.aggregate.mockResolvedValue({
				_sum: { remainingQty: "500" },
			});
			prisma.account.upsert.mockResolvedValue({});

			const result = await service.saveInitialHoldings(DEFAULT_ACTOR, backfillDto);

			expect(result.ledgerStartedAt).toEqual(utc8DayStart(T0));
			expect(prisma.organizationSettings.upsert).toHaveBeenCalledTimes(1);
			expect(prisma.account.update).toHaveBeenCalledWith({
				where: { id: "acc-legacy-eur" },
				data: {
					organizationId: "org-default",
					createdById: "u1",
					balance: new Prisma.Decimal("500"),
				},
			});
		});

		it("I-2 双账户行合并：同时存在组织账户与默认创建者 legacy 账户时删旧并入组织行，零 P2002", async () => {
			prisma.organizationSettings.findUnique.mockResolvedValue(settingsRow);
			prisma.initialHolding.findMany.mockResolvedValue([]);
			prisma.account.findUnique.mockResolvedValue({
				id: "acc-org-eur",
				balance: new Prisma.Decimal("300"),
			});
			prisma.account.findFirst.mockResolvedValue({
				id: "acc-legacy-eur",
				balance: new Prisma.Decimal("50"),
				createdById: null,
			});
			rateService.getLatestForBooking.mockResolvedValue({
				base: "CNY",
				target: "EUR",
				rate: "0.79000000",
				source: "frankfurter",
				observedAt: T0.toISOString(),
				validUntil: new Date(T0.getTime() + 5 * 60 * 1000).toISOString(),
				fresh: true,
			});
			prisma.initialHolding.create.mockImplementation(
				async ({ data }: any) => ({ id: "holding-eur", ...data }),
			);
			prisma.costLot.create.mockResolvedValue({});
			prisma.costLot.aggregate.mockResolvedValue({
				_sum: { remainingQty: "850" },
			});

			await service.saveInitialHoldings({
				...DEFAULT_ACTOR,
				userId: "u-admin",
				role: "ADMIN",
				isDefaultOrganization: false,
			}, backfillDto);

			expect(prisma.account.delete).toHaveBeenCalledWith({
				where: { id: "acc-legacy-eur" },
			});
			expect(prisma.account.update).toHaveBeenCalledWith({
				where: { id: "acc-org-eur" },
				data: { balance: new Prisma.Decimal("850") },
			});
			expect(prisma.account.upsert).not.toHaveBeenCalled();
		});

		it("并发兜底：InitialHolding 插入撞 P2002 → 409 INITIAL_HOLDING_EXISTS", async () => {
			prisma.organizationSettings.findUnique.mockResolvedValue(settingsRow);
			prisma.initialHolding.findMany.mockResolvedValue([]);
			// 取价需先成功（并发双请求都通过预检查与取价，插入时才分出胜负）
			rateService.getLatestForBooking.mockResolvedValue({
				base: "CNY",
				target: "EUR",
				rate: "0.79000000",
				source: "frankfurter",
				observedAt: T0.toISOString(),
				validUntil: new Date(T0.getTime() + 5 * 60 * 1000).toISOString(),
				fresh: true,
			});
			prisma.initialHolding.create.mockRejectedValue(
				Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
			);

			const { body } = await errorOf(
				() => service.saveInitialHoldings(DEFAULT_ACTOR, backfillDto),
				InitialHoldingExistsException,
			);

			expect(body.code).toBe("INITIAL_HOLDING_EXISTS");
		});
	});
});
