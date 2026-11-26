import { randomUUID } from "node:crypto";
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { utc8DayStart } from "../../src/transaction/transaction-calculator";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import request from "supertest";
import { AuditService } from "../../src/audit/audit.service";
import { resolveDefaultOrganizationId } from "../../src/authorization/default-organization";
import { ensureAccount } from "../helpers/plan-test-helper";
import { runBehindAdvisoryLock } from "../helpers/postgres-lock-barrier";
import {
	RATE_PROVIDER_TIMEOUT_TOKEN,
	RateProvider,
} from "../../src/rate/rate.provider";
import {
	ERAPI_RATE_URL,
	FRANKFURTER_RATE_URL,
	QUOTE_TTL_MS,
} from "../../src/rate/rate.constants";
import {
	bearer,
	cleanupUser,
	createTestApp,
	createTestUser,
	orgBearer,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";
import {
	erApiLatestBody,
	frankfurterLatestBody,
	frankfurterTimeSeriesBody,
	jsonResponse,
	parseFrankfurterTimeSeriesRange,
} from "../helpers/rate-source-fixtures";

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
	const erApiLatest = vi.fn(async (_url: string) =>
		jsonResponse(erApiLatestBody({ TWD: "32.5431" })),
	);
	const frankfurterHistory = vi.fn<(url: string) => Promise<Response>>();
	const frankfurterLatest = vi.fn(async (_url: string) =>
		jsonResponse(frankfurterLatestBody("2026-09-15", { MYR: "0.6102" })),
	);

	beforeAll(async () => {
		// 汇率外呼使用已知来源夹具，避免真实回源和网络抖动污染断言。
		ctx = await createTestApp((builder) =>
			builder.overrideProvider(RateProvider).useFactory({
				factory: (timeoutMs: number) =>
					new RateProvider(timeoutMs, (async (url: string) => {
						if (String(url).startsWith(ERAPI_RATE_URL)) {
							return erApiLatest(url);
						}
						if (String(url).startsWith(FRANKFURTER_RATE_URL)) {
							return parseFrankfurterTimeSeriesRange(url)
								? frankfurterHistory(url)
								: frankfurterLatest(url);
						}
						throw new Error("onboarding.spec: 未预期的汇率数据源外呼");
					}) as unknown as typeof fetch),
				inject: [RATE_PROVIDER_TIMEOUT_TOKEN],
			}),
		);
		app = ctx.app;
		// 注册 + 密码登录取登录凭证（OTP 登录链路已由 test/api/otp.spec.ts 覆盖）
		user = await createTestUser(app, "onboarding");
	});

	// 本文件新增：初始持仓/补录用例的测试用户与手工造数汇率行
	const extraUserIds: string[] = [];
	const createdRateIds: string[] = [];

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
	 * 造刚经 latest 确认的报价行，getLatest 走缓存命中。
	 * 先清理该币对历史行（其他用例/回源可能留有 observedAt 更晚的行，
	 * findLatestPublishableQuotes 优先取 observedAt 最新的已确认行）。
	 */
	async function seedRate(
		base: string,
		quote: string,
		rate: string,
		latestConfirmedAt?: Date,
	) {
		await ctx.prisma.exchangeRate.deleteMany({ where: { base, quote } });
		const now = new Date();
		const row = await ctx.prisma.exchangeRate.create({
			data: {
				base,
				quote,
				rate,
				source: "er-api",
				canonicalWriteId: randomUUID(),
				observedAt: now,
				latestConfirmedAt: latestConfirmedAt ?? now,
			},
		});
		createdRateIds.push(row.id);
		return row;
	}

	/**
	 * 造过期报价行：最新确认时间已过 5 分钟 validUntil 窗口，
	 * observedAt 保留来源的日级发布时间。
	 */
	async function seedStaleRate(
		base: string,
		quote: string,
		rate: string,
		observedAt = new Date("2026-09-15T00:00:00.000Z"),
		ageMs = 10 * 60_000,
	) {
		await ctx.prisma.exchangeRate.deleteMany({ where: { base, quote } });
		const row = await ctx.prisma.exchangeRate.create({
			data: {
				base,
				quote,
				rate,
				source: "er-api",
				canonicalWriteId: randomUUID(),
				observedAt,
				latestConfirmedAt: new Date(Date.now() - ageMs),
			},
		});
		createdRateIds.push(row.id);
		return row;
	}

	it("未登录访问 status 应该 401", () => {
		return request(app.getHttpServer())
			.get("/api/onboarding/status")
			.expect(401);
	});

	it("未确认条款时 complete 应该 400 CONSENT_REQUIRED", async () => {
		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(orgBearer(user))
			.send(wizard)
			.expect(400);

		expect(res.body.code).toBe("CONSENT_REQUIRED");
	});

	it("GET status 初始为未完成", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/onboarding/status")
			.set(orgBearer(user))
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
			.set(orgBearer(user))
			.expect(200);
		expect(status.body.data.requiredConsentsMet).toBe(true);
	});

	it("POST complete 成功：创建设置 + ledgerStartedAt", async () => {
		const before = Date.now();
		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(orgBearer(user))
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
			.set(orgBearer(user))
			.expect(200);
		expect(status.body.data.completed).toBe(true);
		expect(status.body.data.settings.baseCurrency).toBe("HKD");
	});

	it("重复 complete 应该 409 ONBOARDING_ALREADY_COMPLETED（不同币种也不得覆盖）", async () => {
		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(orgBearer(user))
			.send({ ...wizard, baseCurrency: "USD" })
			.expect(409);

		expect(res.body.code).toBe("ONBOARDING_ALREADY_COMPLETED");

		// 本位币锁定的落库证据：仍是首次提交的 HKD
		const status = await request(app.getHttpServer())
			.get("/api/onboarding/status")
			.set(orgBearer(user))
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
			.set(orgBearer(created))
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
			where: { organizationId: created.defaultOrganizationId },
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
			where: { organizationId: created.defaultOrganizationId },
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
			where: { organizationId: created.defaultOrganizationId },
		});
		const balanceByCode = new Map(
			accounts.map((a) => [a.currencyCode, a.balance.toFixed(4)]),
		);
		expect(balanceByCode.get("SGD")).toBe("1000.0000");
		expect(balanceByCode.get("KRW")).toBe("100000.0000");
	});

	it("日级报价已过期 → 一次同步回源后入账（FX-04：刚获系统确认可入账）", async () => {
		await seedStaleRate("CNY", "TWD", "32.0000000000");
		erApiLatest.mockClear();
		const created = await createTestUser(app, "onb-stale-refresh");
		extraUserIds.push(created.userId);
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(created.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);

		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(orgBearer(created))
			.send({
				...wizard,
				initialHoldings: [{ currencyCode: "TWD", amount: "1000" }],
			})
			.expect(201);
		expect(res.body.data.settings.baseCurrency).toBe("CNY");
		expect(erApiLatest).toHaveBeenCalledTimes(1);

		// 采用夹具新报价（上游 1 CNY = 32.5431 TWD → 取倒数 1 TWD = 0.0307284801 CNY，
		// 入账 8 位 0.03072848）；rateObservedAt 保留真实日级发布时间
		const holding = await ctx.prisma.initialHolding.findFirstOrThrow({
			where: { organizationId: created.defaultOrganizationId },
		});
		expect(holding.currencyCode).toBe("TWD");
		expect(holding.rate.toFixed(8)).toBe("0.03072848");
		expect(holding.rawRate.toFixed(10)).toBe("0.0307284800");
		expect(holding.rateSource).toBe("er-api");
		expect(holding.rateObservedAt.toISOString()).toBe(
			"2026-09-15T00:00:00.000Z",
		);
		// 同步回源刷新系统确认时间。
		const row = await ctx.prisma.exchangeRate.findFirstOrThrow({
			where: { base: "CNY", quote: "TWD" },
		});
		expect(row.latestConfirmedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
	});

	it.each(["立即", "延迟"] as const)("恰过 validUntil，供应商%s返回首个 503 → 只请求一次且整单回滚", async (timing) => {
		const stale = await seedStaleRate("CNY", "TWD", "0.03000000", new Date("2026-09-15T00:00:00.000Z"), 5 * 60_000 + 1_000);
		const created = await createTestUser(app, "onb-stale-fail");
		extraUserIds.push(created.userId);
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(created.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);

		let resolveStarted!: () => void;
		const upstreamStarted = new Promise<void>((r) => (resolveStarted = r));
		let resolveRelease!: () => void;
		const upstreamRelease = new Promise<void>((r) => (resolveRelease = r));
		// 仅首个请求失败。错误重试若发出，默认夹具会成功并暴露错误入账。
		erApiLatest.mockClear().mockImplementationOnce(async () => {
			resolveStarted();
			if (timing === "延迟") await upstreamRelease;
			return jsonResponse({ message: "latest unavailable" }, 503);
		});
		const response = request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(orgBearer(created))
			.send({
				...wizard,
				initialHoldings: [{ currencyCode: "TWD", amount: "1000" }],
			})
			.then((res) => res);
		if (timing === "延迟") {
			try {
				await Promise.race([upstreamStarted, response]);
			} finally {
				resolveRelease();
			}
		}
		const res = await response;
		expect(erApiLatest).toHaveBeenCalledTimes(1);
		expect(res).toMatchObject({ status: 400, body: { code: "RATE_UNAVAILABLE" } });
		const rate = await ctx.prisma.exchangeRate.findUniqueOrThrow({ where: { id: stale.id } });
		expect(rate.latestConfirmedAt).toEqual(stale.latestConfirmedAt);

		// 整单回滚：无设置、无持仓、无批次、无账户
		const settings = await ctx.prisma.organizationSettings.findUnique({
			where: { organizationId: created.defaultOrganizationId },
		});
		expect(settings).toBeNull();
		const holdings = await ctx.prisma.initialHolding.findMany({
			where: { organizationId: created.defaultOrganizationId },
		});
		expect(holdings).toHaveLength(0);
		const lots = await ctx.prisma.costLot.findMany({
			where: { organizationId: created.defaultOrganizationId },
		});
		expect(lots).toHaveLength(0);
		const accounts = await ctx.prisma.account.findMany({
			where: { organizationId: created.defaultOrganizationId },
		});
		expect(accounts).toHaveLength(0);
	});

	it("多币种组单项失效 → 整单拒绝零业务写入（FX-04：组内一项超窗即拒绝）", async () => {
		// TWD fresh 命中；USD 陈旧且回源失败（abc stub 拒绝）→ 组级拒绝
		await seedRate("CNY", "TWD", "32.0000000000");
		await seedStaleRate("CNY", "USD", "7.2480000000");
		const created = await createTestUser(app, "onb-group-partial");
		extraUserIds.push(created.userId);
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(created.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);

		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(orgBearer(created))
			.send({
				...wizard,
				initialHoldings: [
					{ currencyCode: "TWD", amount: "1000" },
					{ currencyCode: "USD", amount: "500" },
				],
			})
			.expect(400);
		expect(res.body.code).toBe("RATE_UNAVAILABLE");

		// 零业务写入：设置、持仓、批次、账户全部不存在（事务整体回滚）
		const settings = await ctx.prisma.organizationSettings.findUnique({
			where: { organizationId: created.defaultOrganizationId },
		});
		expect(settings).toBeNull();
		const holdings = await ctx.prisma.initialHolding.count({
			where: { organizationId: created.defaultOrganizationId },
		});
		expect(holdings).toBe(0);
		const lots = await ctx.prisma.costLot.count({
			where: { organizationId: created.defaultOrganizationId },
		});
		expect(lots).toBe(0);
		const accounts = await ctx.prisma.account.count({
			where: { organizationId: created.defaultOrganizationId },
		});
		expect(accounts).toBe(0);
	});

	it.each(["complete", "initial-holdings"] as const)(
		"%s：第一币种写入期间第二币种恰到 validUntil → 整单回滚",
		async (endpoint) => {
			const created = await createTestUser(app, `onb-write-expiry-${endpoint}`);
			extraUserIds.push(created.userId);
			const headers = orgBearer(created);
			const where = { organizationId: created.defaultOrganizationId };
			await request(app.getHttpServer())
				.post("/api/onboarding/consents")
				.set(bearer(created.accessToken))
				.send({ age18Confirmed: true, termsConfirmed: true })
				.expect(201);
			if (endpoint === "initial-holdings") {
				await request(app.getHttpServer())
					.post("/api/onboarding/complete")
					.set(headers)
					.send(wizard)
					.expect(201);
			}
			const settingsBefore = await ctx.prisma.organizationSettings.findUnique({ where });
			expect(settingsBefore !== null).toBe(endpoint === "initial-holdings");

			const now = Date.now();
			const expiresAt = now + 1;
			await seedRate("CNY", "SGD", "5.4120", new Date(now));
			await seedRate("CNY", "KRW", "0.0052", new Date(expiresAt - QUOTE_TTL_MS));
			const holdings = [
				{ currencyCode: "SGD", amount: "1000" },
				{ currencyCode: "KRW", amount: "100000" },
			];

			const attemptedHoldings: string[] = [];
			let crossedWriteBarrier = false;
			let observeWrites = true;
			ctx.prisma.$use(async (params, next) => {
				if (
					observeWrites &&
					params.runInTransaction &&
					params.model === "InitialHolding" &&
					params.action === "create" &&
					params.args.data.organizationId === where.organizationId
				) {
					attemptedHoldings.push(params.args.data.currencyCode);
				}
				const result = await next(params);
				if (
					observeWrites &&
					params.runInTransaction &&
					params.model === "Account" &&
					params.action === "upsert" &&
					params.args.create.organizationId === where.organizationId &&
					params.args.create.currencyCode === "SGD"
				) {
					// 第一笔持仓、批次和账户已写入事务，账户写入尚未返回调用方。
					crossedWriteBarrier = true;
					vi.setSystemTime(expiresAt);
				}
				return result;
			});

			vi.useFakeTimers({ toFake: ["Date"], now });
			try {
				const res = await request(app.getHttpServer())
					.post(`/api/onboarding/${endpoint}`)
					.set(headers)
					.send(
						endpoint === "complete"
							? { ...wizard, initialHoldings: holdings }
							: { holdings },
					)
					.expect(400);
				expect(res.body.code).toBe("RATE_UNAVAILABLE");
			} finally {
				observeWrites = false;
				vi.useRealTimers();
			}

			expect(crossedWriteBarrier).toBe(true);
			expect(attemptedHoldings).toEqual(["SGD"]);
			expect(await ctx.prisma.organizationSettings.findUnique({ where })).toEqual(settingsBefore);
			expect(await ctx.prisma.initialHolding.count({ where })).toBe(0);
			expect(await ctx.prisma.costLot.count({ where })).toBe(0);
			expect(await ctx.prisma.account.count({ where })).toBe(0);
		},
	);

	it("HKD/TWD 组合：本位币 HKD 下 TWD 报价过期 → 同步回源后入账（FX-04 币对覆盖）", async () => {
		await seedStaleRate("HKD", "TWD", "32.0000000000");
		const created = await createTestUser(app, "onb-hkd-twd");
		extraUserIds.push(created.userId);
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(created.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);

		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(orgBearer(created))
			.send({
				...wizard,
				baseCurrency: "HKD",
				initialHoldings: [{ currencyCode: "TWD", amount: "2000" }],
			})
			.expect(201);
		expect(res.body.data.settings.baseCurrency).toBe("HKD");

		const holding = await ctx.prisma.initialHolding.findFirstOrThrow({
			where: { organizationId: created.defaultOrganizationId },
		});
		expect(holding.currencyCode).toBe("TWD");
		// 1 TWD = 0.0307284801 HKD（er-api 夹具取倒数，8 位入账）
		expect(holding.rate.toFixed(8)).toBe("0.03072848");
		expect(holding.rateSource).toBe("er-api");
	});

	it("CNY/MYR 组合：frankfurter 日级源陈旧回显 → 同步回源后入账（FX-04 币对覆盖）", async () => {
		await seedStaleRate("CNY", "MYR", "1.5000000000");
		const created = await createTestUser(app, "onb-cny-myr");
		extraUserIds.push(created.userId);
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(created.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);

		await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(orgBearer(created))
			.send({
				...wizard,
				initialHoldings: [{ currencyCode: "MYR", amount: "1000" }],
			})
			.expect(201);

		const holding = await ctx.prisma.initialHolding.findFirstOrThrow({
			where: { organizationId: created.defaultOrganizationId },
		});
		expect(holding.currencyCode).toBe("MYR");
		// frankfurter 夹具 1 CNY = 0.6102 MYR → 取倒数 1 MYR = 1.6388069485 CNY（8 位展示）
		expect(holding.rate.toFixed(8)).toBe("1.63880695");
		expect(holding.rateSource).toBe("frankfurter");
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
			.set(orgBearer(created))
			.send({
				...wizard,
				initialHoldings: [{ currencyCode: "CNY", amount: "100.00" }],
			})
			.expect(400);

		expect(res.body.code).toBe("INVALID_HOLDINGS");
		const settings = await ctx.prisma.organizationSettings.findUnique({
			where: { organizationId: created.defaultOrganizationId },
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
			.set(orgBearer(created))
			.send({
				...wizard,
				initialHoldings: [{ currencyCode: "USD", amount: "100000000000" }],
			})
			.expect(400);

		expect(res.body.code).toBe("INVALID_AMOUNT");
		const settings = await ctx.prisma.organizationSettings.findUnique({
			where: { organizationId: created.defaultOrganizationId },
		});
		expect(settings).toBeNull();
		const holdings = await ctx.prisma.initialHolding.findMany({
			where: { organizationId: created.defaultOrganizationId },
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
			.set(orgBearer(created))
			.send({
				...wizard,
				baseCurrency: "JPY",
				initialHoldings: [{ currencyCode: "USD", amount: "0.01" }],
			})
			.expect(400);

		expect(res.body.code).toBe("INVALID_AMOUNT");
		const settings = await ctx.prisma.organizationSettings.findUnique({
			where: { organizationId: created.defaultOrganizationId },
		});
		expect(settings).toBeNull();
	});

	it("补录：未建账调用 → 409 ONBOARDING_NOT_COMPLETED", async () => {
		const created = await createTestUser(app, "onb-backfill-none");
		extraUserIds.push(created.userId);

		const res = await request(app.getHttpServer())
			.post("/api/onboarding/initial-holdings")
			.set(orgBearer(created))
			.send({ holdings: [{ currencyCode: "EUR", amount: "100.00" }] })
			.expect(409);

		expect(res.body.code).toBe("ONBOARDING_NOT_COMPLETED");
	});

	it("补录正常：201；CostLot.acquiredAt=ledgerStartedAt、余额增加、baseCurrency 不变", async () => {
		await seedRate("HKD", "EUR", "0.9");
		// user 在本文件 beforeAll 已建账（CNY，无持仓）——首用户直接补录
		const res = await request(app.getHttpServer())
			.post("/api/onboarding/initial-holdings")
			.set(orgBearer(user))
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

		const settings = await ctx.prisma.organizationSettings.findUnique({
			where: { organizationId: user.defaultOrganizationId },
		});
		// baseCurrency 不变（本文件现有用例中该用户建账为 HKD）
		expect(settings?.baseCurrency).toBe("HKD");
		const ledgerStartedAt = settings?.ledgerStartedAt?.toISOString();
		expect(res.body.data.ledgerStartedAt).toBe(ledgerStartedAt);

		const lot = await ctx.prisma.costLot.findFirst({
			where: { organizationId: user.defaultOrganizationId, sourceType: "INITIAL" },
		});
		expect(lot?.acquiredAt.toISOString()).toBe(ledgerStartedAt);
		const account = await ctx.prisma.account.findFirst({
			where: { organizationId: user.defaultOrganizationId, currencyCode: "EUR" },
		});
		expect(account?.balance.toFixed(4)).toBe("500.0000");

		// home/state 联动：hasInitialHoldings false→true（§8.2 末行）
		const home = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(orgBearer(user))
			.expect(200);
		expect(home.body.data.hasInitialHoldings).toBe(true);
	});

	it("补录币种已有初始记录 → 409 INITIAL_HOLDING_EXISTS，无部分成功（新币种也未入账）", async () => {
		// 上一用例已为 user 补录 EUR；本轮 [EUR(已有), CAD(新)] 整单拒绝
		const res = await request(app.getHttpServer())
			.post("/api/onboarding/initial-holdings")
			.set(orgBearer(user))
			.send({
				holdings: [
					{ currencyCode: "EUR", amount: "100.00" },
					{ currencyCode: "CAD", amount: "200.00" },
				],
			})
			.expect(409);

		expect(res.body.code).toBe("INITIAL_HOLDING_EXISTS");
		const cadLot = await ctx.prisma.costLot.findFirst({
			where: { organizationId: user.defaultOrganizationId, currencyCode: "CAD" },
		});
		expect(cadLot).toBeNull(); // 无部分成功
		const cadAccount = await ctx.prisma.account.findFirst({
			where: { organizationId: user.defaultOrganizationId, currencyCode: "CAD" },
		});
		expect(cadAccount).toBeNull();
	});

	it("冷查 MYR 历史后补录：latest 失败时拒绝入账，确认同日新报价后采用 latest 价", async () => {
		const pair = { base: "CNY", quote: "MYR" };
		await ctx.prisma.exchangeRate.deleteMany({ where: pair });
		const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
		const observedAt = `${day}T00:00:00.000Z`;
		const created = await createTestUser(app, "onb-history-myr");
		extraUserIds.push(created.userId);
		const auth = orgBearer(created);
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(auth)
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);
		await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(auth)
			.send(wizard)
			.expect(201);

		const backfill = () =>
			request(app.getHttpServer())
				.post("/api/onboarding/initial-holdings")
				.set(auth)
				.send({ holdings: [{ currencyCode: "MYR", amount: "100" }] });
		frankfurterHistory
			.mockClear()
			.mockResolvedValueOnce(
				jsonResponse(frankfurterTimeSeriesBody({ [day]: { MYR: "0.5" } })),
			);
		frankfurterLatest.mockClear();
		try {
			await request(app.getHttpServer())
				.get("/api/rates/history?base=CNY&target=MYR&period=7")
				.expect(200);
			expect(frankfurterHistory).toHaveBeenCalledTimes(1);
			expect(frankfurterLatest).not.toHaveBeenCalled();
			const historyRow = await ctx.prisma.exchangeRate.findFirstOrThrow({
				where: pair,
			});
			expect(historyRow.observedAt.toISOString()).toBe(observedAt);
			expect(historyRow.rate.toFixed(8)).toBe("2.00000000");
			expect(historyRow.latestConfirmedAt).toBeNull();

			await frankfurterLatest.withImplementation(
				async () => jsonResponse({ message: "latest unavailable" }, 503),
				async () => {
					const rejected = await backfill().expect(400);
					expect(rejected.body.code).toBe("RATE_UNAVAILABLE");
					expect(frankfurterLatest).toHaveBeenCalledExactlyOnceWith(
						`${FRANKFURTER_RATE_URL}/latest?from=CNY&to=MYR`,
					);
				},
			);
			const where = {
				organizationId: created.defaultOrganizationId,
				currencyCode: "MYR",
			};
			expect(await ctx.prisma.initialHolding.count({ where })).toBe(0);
			expect(await ctx.prisma.costLot.count({ where })).toBe(0);
			expect(await ctx.prisma.account.count({ where })).toBe(0);
			const exchangeRateKey = { where: { id: historyRow.id } };
			const failedRow = await ctx.prisma.exchangeRate.findUniqueOrThrow(exchangeRateKey);
			expect(failedRow.latestConfirmedAt).toBeNull();

			frankfurterLatest.mockClear();
			await frankfurterLatest.withImplementation(
				async () => jsonResponse(frankfurterLatestBody(day, { MYR: "0.8" })),
				async () => {
					await backfill().expect(201);
					expect(frankfurterLatest).toHaveBeenCalledTimes(1);
				},
			);
			const holding = await ctx.prisma.initialHolding.findFirstOrThrow({ where });
			expect(holding.rate.toFixed(8)).toBe("1.25000000");
			expect(holding.rateSource).toBe("frankfurter");
			expect(holding.rateObservedAt.toISOString()).toBe(observedAt);
			expect(await ctx.prisma.exchangeRate.count({ where: pair })).toBe(1);
			const confirmedRow = await ctx.prisma.exchangeRate.findUniqueOrThrow(exchangeRateKey);
			expect(confirmedRow.createdAt).toEqual(historyRow.createdAt);
			expect(confirmedRow.latestConfirmedAt).toBeInstanceOf(Date);

			frankfurterLatest.mockClear();
			const cached = await request(app.getHttpServer())
				.get("/api/rates/latest/CNY?targets=MYR")
				.expect(200);
			expect(cached.body.data).toMatchObject({ rate: "1.25", observedAt, fresh: true });
			expect(frankfurterLatest).not.toHaveBeenCalled();
		} finally {
			await ctx.prisma.exchangeRate.deleteMany({ where: pair });
		}
	});

	it("prepPreference 非法枚举 → 400 @IsIn（与 settings PATCH 同字段校验对称，N5 回归）", async () => {
		const created = await createTestUser(app, "onb-prep-enum");
		extraUserIds.push(created.userId);
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(created.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);

		// 非法值（settings 侧枚举外）：拒绝且不落 settings
		const bad = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(orgBearer(created))
			.send({ ...wizard, prepPreference: "aggressive" })
			.expect(400);
		// DTO 层 ValidationPipe 拒绝（class-validator 格式，无业务 code）
		expect(bad.body.statusCode).toBe(400);
		expect(JSON.stringify(bad.body.message)).toMatch(
			/cautious \/ balanced \/ proactive/,
		);
		const settingsAfterBad = await ctx.prisma.organizationSettings.findUnique({
			where: { organizationId: created.defaultOrganizationId },
		});
		expect(settingsAfterBad).toBeNull();

		// 合法值放行且落库为传入值
		const ok = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(orgBearer(created))
			.send({ ...wizard, prepPreference: "cautious" })
			.expect(201);
		expect(ok.body.data.settings.prepPreference).toBe("cautious");
	});

	describe("ToB R1 W22：多组织独立建账 + 权限拒绝 + 审计回滚 + 锁内降权（支持 -t 独立运行）", () => {
		const scopedUserIds: string[] = [];

		afterEach(async () => {
			vi.restoreAllMocks();
			while (scopedUserIds.length > 0) {
				const uid = scopedUserIds.pop()!;
				await cleanupUser(ctx.prisma, uid);
			}
		});

		it("多组织独立建账：Org A 已建账（含 USD 初始持仓）后为 Org B 独立建账（同持 USD）成功且零串台", async () => {
			await seedRate("CNY", "USD", "7.2000");
			const multiUser = await createTestUser(app, "onb-multi-org");
			scopedUserIds.push(multiUser.userId);
			const orgAId = (await resolveDefaultOrganizationId(ctx.prisma, multiUser.userId))!;
			const orgBRes = await request(app.getHttpServer())
				.post("/api/organizations")
				.set(bearer(multiUser.accessToken))
				.send({ name: "第二组织 Org B" })
				.expect(201);
			const orgBId = orgBRes.body.data.id as string;

			await request(app.getHttpServer())
				.post("/api/onboarding/consents")
				.set(bearer(multiUser.accessToken))
				.send({ age18Confirmed: true, termsConfirmed: true })
				.expect(201);

			// Org A 建账 + USD 1000
			await request(app.getHttpServer())
				.post("/api/onboarding/complete")
				.set(orgBearer(multiUser))
				.set("X-Organization-Id", orgAId)
				.send({
					...wizard,
					baseCurrency: "CNY",
					initialHoldings: [{ currencyCode: "USD", amount: "1000.00" }],
				})
				.expect(201);

			// Org B 独立建账 + 同持 USD 500（不因 UserSettings 存在被 409 阻塞，且不覆盖 Org A）
			const orgBComplete = await request(app.getHttpServer())
				.post("/api/onboarding/complete")
				.set(orgBearer(multiUser))
				.set("X-Organization-Id", orgBId)
				.send({
					...wizard,
					baseCurrency: "CNY",
					prepPreference: "proactive",
					reminderEnabled: false,
					initialHoldings: [{ currencyCode: "USD", amount: "500.00" }],
				})
				.expect(201);
			expect(orgBComplete.body.data.settings.prepPreference).toBe("proactive");

			const [orgASettings, orgBSettings] = await Promise.all([
				ctx.prisma.organizationSettings.findUniqueOrThrow({
					where: { organizationId: orgAId },
				}),
				ctx.prisma.organizationSettings.findUniqueOrThrow({
					where: { organizationId: orgBId },
				}),
			]);
			expect(orgASettings.prepPreference).toBe("balanced");
			expect(orgBSettings.prepPreference).toBe("proactive");

			const [accA, accB] = await Promise.all([
				ctx.prisma.account.findUniqueOrThrow({
					where: {
						organizationId_currencyCode: {
							organizationId: orgAId,
							currencyCode: "USD",
						},
					},
				}),
				ctx.prisma.account.findUniqueOrThrow({
					where: {
						organizationId_currencyCode: {
							organizationId: orgBId,
							currencyCode: "USD",
						},
					},
				}),
			]);
			expect(accA.balance.toFixed(4)).toBe("1000.0000");
			expect(accB.balance.toFixed(4)).toBe("500.0000");
			expect(accA.createdById).toBe(multiUser.userId);
			expect(accB.createdById).toBe(multiUser.userId);
		});

		it.each(["VIEWER", "OPERATOR"] as const)(
			"%s 调用 complete 与 initial-holdings → 403 PERMISSION_DENIED + DENIED 审计",
			async (role) => {
				const owner = await createTestUser(app, `onb-rbac-owner-${role}`);
				scopedUserIds.push(owner.userId);
				const orgId = (await resolveDefaultOrganizationId(ctx.prisma, owner.userId))!;
				const member = await createTestUser(app, `onb-rbac-member-${role}`);
				scopedUserIds.push(member.userId);
				await ctx.prisma.membership.create({
					data: {
						organizationId: orgId,
						userId: member.userId,
						role,
						status: "ACTIVE",
					},
				});

				const resComplete = await request(app.getHttpServer())
					.post("/api/onboarding/complete")
					.set(orgBearer(member))
					.set("X-Organization-Id", orgId)
					.send(wizard)
					.expect(403);
				expect(resComplete.body.code).toBe("PERMISSION_DENIED");

				const resHoldings = await request(app.getHttpServer())
					.post("/api/onboarding/initial-holdings")
					.set(orgBearer(member))
					.set("X-Organization-Id", orgId)
					.send({ holdings: [{ currencyCode: "USD", amount: "100.00" }] })
					.expect(403);
				expect(resHoldings.body.code).toBe("PERMISSION_DENIED");

				const deniedCount = await ctx.prisma.auditLog.count({
					where: {
						organizationId: orgId,
						actorUserId: member.userId,
						action: "permission.denied.settings.update",
						result: "DENIED",
					},
				});
				expect(deniedCount).toBe(2);
			},
		);

		it("AuditService.recordInTx 故障注入：complete（含初始持仓）整单回滚", async () => {
			await seedRate("CNY", "USD", "7.2000");
			const created = await createTestUser(app, "onb-audit-fault");
			scopedUserIds.push(created.userId);
			const orgId = (await resolveDefaultOrganizationId(ctx.prisma, created.userId))!;
			await request(app.getHttpServer())
				.post("/api/onboarding/consents")
				.set(bearer(created.accessToken))
				.send({ age18Confirmed: true, termsConfirmed: true })
				.expect(201);

			vi.spyOn(app.get(AuditService), "recordInTx").mockRejectedValueOnce(
				new Error("injected audit failure"),
			);

			await request(app.getHttpServer())
				.post("/api/onboarding/complete")
				.set(orgBearer(created))
				.set("X-Organization-Id", orgId)
				.send({
					...wizard,
					initialHoldings: [{ currencyCode: "USD", amount: "200.00" }],
				})
				.expect(500);

			expect(
				await ctx.prisma.organizationSettings.findUnique({
					where: { organizationId: orgId },
				}),
			).toBeNull();
			expect(
				await ctx.prisma.userSettings.findUnique({
					where: { userId: created.userId },
				}),
			).toBeNull();
			expect(
				await ctx.prisma.initialHolding.count({
					where: { organizationId: orgId },
				}),
			).toBe(0);
			expect(
				await ctx.prisma.costLot.count({
					where: { organizationId: orgId },
				}),
			).toBe(0);
			expect(
				await ctx.prisma.account.count({
					where: { organizationId: orgId },
				}),
			).toBe(0);
		});

		it("锁等期间降权（ADMIN → VIEWER）：complete 阻塞在组织锁后醒来复验 → 403 + DENIED 审计 + 零写入", async () => {
			const owner = await createTestUser(app, "onb-demote-owner");
			scopedUserIds.push(owner.userId);
			const orgId = (await resolveDefaultOrganizationId(ctx.prisma, owner.userId))!;
			const admin = await createTestUser(app, "onb-demote-admin");
			scopedUserIds.push(admin.userId);
			await ctx.prisma.membership.create({
				data: {
					organizationId: orgId,
					userId: admin.userId,
					role: "ADMIN",
					status: "ACTIVE",
				},
			});
			await request(app.getHttpServer())
				.post("/api/onboarding/consents")
				.set(bearer(admin.accessToken))
				.send({ age18Confirmed: true, termsConfirmed: true })
				.expect(201);

			const reqId = `req-onb-demote-${Date.now()}`;
			const res = await runBehindAdvisoryLock(
				ctx.prisma,
				`membership:${orgId}`,
				() =>
					request(app.getHttpServer())
						.post("/api/onboarding/complete")
						.set(orgBearer(admin))
						.set("X-Organization-Id", orgId)
						.set("X-Request-Id", reqId)
						.send(wizard),
				async () => {
					await ctx.prisma.membership.update({
						where: {
							organizationId_userId: {
								organizationId: orgId,
								userId: admin.userId,
							},
						},
						data: { role: "VIEWER" },
					});
				},
			);

			expect(res.status).toBe(403);
			expect(res.body.code).toBe("PERMISSION_DENIED");
			expect(
				await ctx.prisma.organizationSettings.findUnique({
					where: { organizationId: orgId },
				}),
			).toBeNull();
			expect(
				await ctx.prisma.auditLog.findFirst({
					where: {
						organizationId: orgId,
						actorUserId: admin.userId,
						action: "permission.denied.settings.update",
						result: "DENIED",
						requestId: reqId,
					},
				}),
			).not.toBeNull();
		});

		it("反序建账（先建 Org B 再建默认 Org A）：Org B 完成不污染 Org A 未建账态，Org A 可用不同本位币独立建账（Important #1 回归）", async () => {
			const reverseUser = await createTestUser(app, "onb-reverse-order");
			scopedUserIds.push(reverseUser.userId);
			const orgAId = (await resolveDefaultOrganizationId(
				ctx.prisma,
				reverseUser.userId,
			))!;
			const orgBRes = await request(app.getHttpServer())
				.post("/api/organizations")
				.set(bearer(reverseUser.accessToken))
				.send({ name: "先建账组织 B" })
				.expect(201);
			const orgBId = orgBRes.body.data.id as string;

			await request(app.getHttpServer())
				.post("/api/onboarding/consents")
				.set(bearer(reverseUser.accessToken))
				.send({ age18Confirmed: true, termsConfirmed: true })
				.expect(201);

			// 先为非默认组织 Org B 建账（USD）
			await request(app.getHttpServer())
				.post("/api/onboarding/complete")
				.set(orgBearer(reverseUser))
				.set("X-Organization-Id", orgBId)
				.send({ ...wizard, baseCurrency: "USD" })
				.expect(201);

			// 默认组织 Org A 仍必须处于未建账态
			const statusA = await request(app.getHttpServer())
				.get("/api/onboarding/status")
				.set(orgBearer(reverseUser))
				.set("X-Organization-Id", orgAId)
				.expect(200);
			expect(statusA.body.data.completed).toBe(false);

			// Org A 使用不同本位币 HKD 独立建账成功
			const completeA = await request(app.getHttpServer())
				.post("/api/onboarding/complete")
				.set(orgBearer(reverseUser))
				.set("X-Organization-Id", orgAId)
				.send({ ...wizard, baseCurrency: "HKD" })
				.expect(201);
			expect(completeA.body.data.settings.baseCurrency).toBe("HKD");

			const [orgASettings, orgBSettings, personal] = await Promise.all([
				ctx.prisma.organizationSettings.findUniqueOrThrow({
					where: { organizationId: orgAId },
				}),
				ctx.prisma.organizationSettings.findUniqueOrThrow({
					where: { organizationId: orgBId },
				}),
				ctx.prisma.userSettings.findUniqueOrThrow({
					where: { userId: reverseUser.userId },
				}),
			]);
			expect(orgASettings.baseCurrency).toBe("HKD");
			expect(orgBSettings.baseCurrency).toBe("USD");
			expect(personal.locale).toBe("zh-CN");
		});

		it("I-2 回归：Owner 组织 USD(50) → 受邀 FINANCE 买入 USD(30) → Owner 补录初始持仓 USD(20) 201 且单行余额 100.0000 双方视图一致", async () => {
			await seedRate("CNY", "USD", "7.2000");
			const owner = await createTestUser(app, "onb-i2-owner");
			scopedUserIds.push(owner.userId);
			const orgId = (await resolveDefaultOrganizationId(ctx.prisma, owner.userId))!;
			const finance = await createTestUser(app, "onb-i2-finance");
			scopedUserIds.push(finance.userId);
			await ctx.prisma.membership.create({
				data: {
					organizationId: orgId,
					userId: finance.userId,
					role: "FINANCE",
					status: "ACTIVE",
				},
			});

			await request(app.getHttpServer())
				.post("/api/onboarding/consents")
				.set(bearer(owner.accessToken))
				.send({ age18Confirmed: true, termsConfirmed: true })
				.expect(201);
			await request(app.getHttpServer())
				.post("/api/onboarding/complete")
				.set(orgBearer(owner))
				.set("X-Organization-Id", orgId)
				.send({ ...wizard, baseCurrency: "CNY" })
				.expect(201);
			// 清除当日起点限制以便用昨日日期造交易，或用今日时间
			await ensureAccount(ctx.prisma, owner.userId, "USD", "50");

			// 受邀 FINANCE 买入 USD 30（使用当天时间，不早于 utc8DayStart）
			await request(app.getHttpServer())
				.post("/api/transactions")
				.set(orgBearer(finance))
				.set("X-Organization-Id", orgId)
				.send({
					currencyCode: "USD",
					principalAmount: "216.00",
					exchangeRate: "7.20000000",
					quantity: "30.00",
					transactedAt: new Date().toISOString(),
				})
				.expect(201);

			// Owner 再补录 USD 20 初始持仓：必须 201（不得 500 P2002），合并后余额 = 50 + 30 + 20 = 100
			await request(app.getHttpServer())
				.post("/api/onboarding/initial-holdings")
				.set(orgBearer(owner))
				.set("X-Organization-Id", orgId)
				.send({ holdings: [{ currencyCode: "USD", amount: "20.00" }] })
				.expect(201);

			const orgAccounts = await ctx.prisma.account.findMany({
				where: { organizationId: orgId, currencyCode: "USD" },
			});
			expect(orgAccounts).toHaveLength(1);
			expect(orgAccounts[0].balance.toFixed(4)).toBe("100.0000");

			const [ownerView, memberView] = await Promise.all([
				request(app.getHttpServer())
					.get("/api/accounts/USD")
					.set(orgBearer(owner))
					.set("X-Organization-Id", orgId)
					.expect(200),
				request(app.getHttpServer())
					.get("/api/accounts/USD")
					.set(orgBearer(finance))
					.set("X-Organization-Id", orgId)
					.expect(200),
			]);
			expect(ownerView.body.data.balance).toBe("100.0000");
			expect(memberView.body.data.balance).toBe("100.0000");
		});
	});
});
