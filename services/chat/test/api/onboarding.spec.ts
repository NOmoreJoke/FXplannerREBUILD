import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { utc8DayStart } from "../../src/transaction/transaction-calculator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import {
	RATE_PROVIDER_TIMEOUT_TOKEN,
	RateProvider,
} from "../../src/rate/rate.provider";
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
		// 汇率外呼一律拒绝（初始持仓取价只依赖本文件 seedRate 造的 fresh 行，
		// 防止并行 spec 的真实回源行与网络抖动污染断言）
		ctx = await createTestApp((builder) =>
			builder.overrideProvider(RateProvider).useFactory({
				factory: (timeoutMs: number) =>
					new RateProvider(
						timeoutMs,
						(async () => {
							throw new Error("onboarding.spec: 未预期的汇率数据源外呼");
						}) as unknown as typeof fetch,
					),
				inject: [RATE_PROVIDER_TIMEOUT_TOKEN],
			}),
		);
		app = ctx.app;
		// 注册 + 密码登录取登录凭证（OTP 登录链路已由 test/api/otp.spec.ts 覆盖）
		user = await createTestUser(app, "onboarding");
	});

	// 本文件新增：初始持仓/补录用例的测试用户与手工造数汇率行
	const extraUserIds: string[] = [];
	let createdRateIds: string[] = [];

	afterAll(async () => {
		for (const id of extraUserIds) {
			await cleanupUser(ctx.prisma, id);
		}
		if (createdRateIds.length > 0) {
			await ctx.prisma.exchangeRate
				.deleteMany({ where: { id: { in: createdRateIds } } })
				.catch(() => {});
		}
		if (user) await cleanupUser(ctx.prisma, user.userId);
		await app.close();
	});

	/**
	 * 造 fresh 报价行（createdAt=now、observedAt=now → getLatest 走缓存命中，无需外呼）。
	 * 先清理该币对历史行（其他用例/回源可能留有 observedAt 更晚的行，
	 * findLatestRows 按 observedAt desc 取最新——不清理会被旧行抢先导致真实回源）。
	 */
	async function seedRate(base: string, quote: string, rate: string) {
		await ctx.prisma.exchangeRate.deleteMany({ where: { base, quote } });
		const row = await ctx.prisma.exchangeRate.create({
			data: { base, quote, rate, source: "er-api", observedAt: new Date() },
		});
		createdRateIds.push(row.id);
		return row;
	}

	/** 注册 + 条款确认 + 可选建账（含可选初始持仓），返回 userId */
	async function setupUser(
		label: string,
		options: {
			baseCurrency?: string;
			holdings?: { currencyCode: string; amount: string }[];
		} = {},
	): Promise<string> {
		const created = await createTestUser(app, label);
		extraUserIds.push(created.userId);
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(created.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);
		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(bearer(created.accessToken))
			.send({
				...wizard,
				baseCurrency: options.baseCurrency ?? "CNY",
				...(options.holdings ? { initialHoldings: options.holdings } : {}),
			});
		return created.userId;
	}

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
	it("POST initial-holdings 无 token 应该 401", () => {
		return request(app.getHttpServer())
			.post("/api/onboarding/initial-holdings")
			.send({ holdings: [{ currencyCode: "USD", amount: "100" }] })
			.expect(401);
	});

	it("complete 带 2 币种 holdings 正常建账：InitialHolding×2 + CostLot×2 + Account 按批次汇总 + ledgerStartedAt=当日日初", async () => {
		await seedRate("CNY", "SGD", "5.4120");
		await seedRate("CNY", "KRW", "0.0052");
		const before = Date.now();
		const created = await createTestUser(app, "onb-holdings-ok");
		extraUserIds.push(created.userId);
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(created.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);

		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(bearer(created.accessToken))
			.send({
				...wizard,
				initialHoldings: [
					{ currencyCode: "SGD", amount: "1000.00" },
					{ currencyCode: "KRW", amount: "100000" },
				],
			})
			.expect(201);

		expect(res.body.data.settings.baseCurrency).toBe("CNY");
		const ledgerStartedAt = res.body.data.ledgerStartedAt;
		expect(new Date(ledgerStartedAt).getTime()).toBe(
			utc8DayStart(new Date(before)).getTime(),
		);

		// InitialHolding×2：rawRate/rateSource/rateObservedAt 落库
		const holdings = await ctx.prisma.initialHolding.findMany({
			where: { userId: created.userId },
			orderBy: { currencyCode: "asc" },
		});
		expect(holdings).toHaveLength(2);
		const byCode = new Map(holdings.map((h) => [h.currencyCode, h]));
		const usd = byCode.get("SGD")!;
		expect(usd.amount.toFixed(4)).toBe("1000.0000");
		expect(usd.rate.toFixed(8)).toBe("5.41200000");
		expect(usd.rawRate.toFixed(10)).toBe("5.4120000000");
		expect(usd.rateSource).toBe("er-api");
		expect(usd.rateObservedAt).toBeInstanceOf(Date);
		expect(usd.cost.toFixed(4)).toBe("5412.0000");
		expect(usd.confirmedAt).toBeInstanceOf(Date);
		const jpy = byCode.get("KRW")!;
		expect(jpy.cost.toFixed(4)).toBe("520.0000");

		// CostLot×2：sourceType=INITIAL、sourceId 指向 InitialHolding、acquiredAt=ledgerStartedAt
		const lots = await ctx.prisma.costLot.findMany({
			where: { userId: created.userId },
		});
		expect(lots).toHaveLength(2);
		for (const lot of lots) {
			expect(lot.sourceType).toBe("INITIAL");
			expect(lot.sourceId).toBe(byCode.get(lot.currencyCode)!.id);
			expect(lot.acquiredAt.toISOString()).toBe(ledgerStartedAt);
			expect(lot.remainingQty.toFixed(4)).toBe(lot.quantity.toFixed(4));
		}

		// Account 余额按批次 remainingQty 汇总（非成本）
		const accounts = await ctx.prisma.account.findMany({
			where: { userId: created.userId },
		});
		const balanceByCode = new Map(
			accounts.map((a) => [a.currencyCode, a.balance.toFixed(4)]),
		);
		expect(balanceByCode.get("SGD")).toBe("1000.0000");
		expect(balanceByCode.get("KRW")).toBe("100000.0000");
	});

	it("holdings 含本位币 → 400 INVALID_HOLDINGS，整单回滚（UserSettings 不存在）", async () => {
		await seedRate("CNY", "SGD", "5.4120");
		const created = await createTestUser(app, "onb-holdings-base");
		extraUserIds.push(created.userId);
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(created.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);

		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(bearer(created.accessToken))
			.send({
				...wizard,
				initialHoldings: [{ currencyCode: "CNY", amount: "100.00" }],
			})
			.expect(400);

		expect(res.body.code).toBe("INVALID_HOLDINGS");
		const settings = await ctx.prisma.userSettings.findUnique({
			where: { userId: created.userId },
		});
		expect(settings).toBeNull(); // 整单回滚：settings 与持仓同事务
	});

	it("金额 ≥ 1e11 → 400 INVALID_AMOUNT，整单回滚", async () => {
		await seedRate("CNY", "SGD", "5.4120");
		const created = await createTestUser(app, "onb-holdings-cap");
		extraUserIds.push(created.userId);
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(created.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);

		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(bearer(created.accessToken))
			.send({
				...wizard,
				initialHoldings: [
					{ currencyCode: "USD", amount: "100000000000" },
				],
			})
			.expect(400);

		expect(res.body.code).toBe("INVALID_AMOUNT");
		const settings = await ctx.prisma.userSettings.findUnique({
			where: { userId: created.userId },
		});
		expect(settings).toBeNull();
		const holdings = await ctx.prisma.initialHolding.findMany({
			where: { userId: created.userId },
		});
		expect(holdings).toHaveLength(0);
	});

	it("成本舍入为 0 → 400 INVALID_AMOUNT，整单回滚（0.01 × 0.0004 舍为 0 日元）", async () => {
		await seedRate("JPY", "USD", "0.0004");
		const created = await createTestUser(app, "onb-holdings-zero");
		extraUserIds.push(created.userId);
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(created.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);

		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(bearer(created.accessToken))
			.send({
				...wizard,
				baseCurrency: "JPY",
				initialHoldings: [{ currencyCode: "USD", amount: "0.01" }],
			})
			.expect(400);

		expect(res.body.code).toBe("INVALID_AMOUNT");
		const settings = await ctx.prisma.userSettings.findUnique({
			where: { userId: created.userId },
		});
		expect(settings).toBeNull();
	});

	it("补录：未建账调用 → 409 ONBOARDING_NOT_COMPLETED", async () => {
		const created = await createTestUser(app, "onb-backfill-none");
		extraUserIds.push(created.userId);

		const res = await request(app.getHttpServer())
			.post("/api/onboarding/initial-holdings")
			.set(bearer(created.accessToken))
			.send({ holdings: [{ currencyCode: "EUR", amount: "100.00" }] })
			.expect(409);

		expect(res.body.code).toBe("ONBOARDING_NOT_COMPLETED");
	});

	it("补录正常：201；CostLot.acquiredAt=ledgerStartedAt、余额增加、baseCurrency 不变", async () => {
		await seedRate("HKD", "EUR", "0.9");
		// user 在本文件 beforeAll 已建账（CNY，无持仓）——首用户直接补录
		const res = await request(app.getHttpServer())
			.post("/api/onboarding/initial-holdings")
			.set(bearer(user.accessToken))
			.send({ holdings: [{ currencyCode: "EUR", amount: "500.00" }] })
			.expect(201);

		expect(res.body.success).toBe(true);
		const created = res.body.data.created;
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({
			currencyCode: "EUR",
			amount: "500.0000",
			rate: "0.9000000000",
			rawRate: "0.9000000000",
			rateSource: "er-api",
			cost: "450.0000",
		});
		expect(created[0].rateObservedAt).toBeTruthy();

		const settings = await ctx.prisma.userSettings.findUnique({
			where: { userId: user.userId },
		});
		// baseCurrency 不变（本文件现有用例中该用户建账为 HKD）
			expect(settings?.baseCurrency).toBe("HKD");
		const ledgerStartedAt = settings?.ledgerStartedAt?.toISOString();
		expect(res.body.data.ledgerStartedAt).toBe(ledgerStartedAt);

		const lot = await ctx.prisma.costLot.findFirst({
			where: { userId: user.userId, sourceType: "INITIAL" },
		});
		expect(lot?.acquiredAt.toISOString()).toBe(ledgerStartedAt);
		const account = await ctx.prisma.account.findUnique({
			where: { userId_currencyCode: { userId: user.userId, currencyCode: "EUR" } },
		});
		expect(account?.balance.toFixed(4)).toBe("500.0000");

		// home/state 联动：hasInitialHoldings false→true（§8.2 末行）
		const home = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(bearer(user.accessToken))
			.expect(200);
		expect(home.body.data.hasInitialHoldings).toBe(true);
	});

	it("补录币种已有初始记录 → 409 INITIAL_HOLDING_EXISTS，无部分成功（新币种也未入账）", async () => {
		// 上一用例已为 user 补录 EUR；本轮 [EUR(已有), CAD(新)] 整单拒绝
		const res = await request(app.getHttpServer())
			.post("/api/onboarding/initial-holdings")
			.set(bearer(user.accessToken))
			.send({
				holdings: [
					{ currencyCode: "EUR", amount: "100.00" },
					{ currencyCode: "CAD", amount: "200.00" },
				],
			})
			.expect(409);

		expect(res.body.code).toBe("INITIAL_HOLDING_EXISTS");
		const cadLot = await ctx.prisma.costLot.findFirst({
			where: { userId: user.userId, currencyCode: "CAD" },
		});
		expect(cadLot).toBeNull(); // 无部分成功
		const cadAccount = await ctx.prisma.account.findUnique({
			where: { userId_currencyCode: { userId: user.userId, currencyCode: "CAD" } },
		});
		expect(cadAccount).toBeNull();
	});
});
