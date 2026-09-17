import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Prisma } from "@prisma/client";
import {
	RATE_PROVIDER_TIMEOUT_TOKEN,
	RateProvider,
} from "../../src/rate/rate.provider";
import { utc8DayStart } from "../../src/transaction/transaction-calculator";
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
 * 集成测试（真实数据库 + 真实事务链路）：初始持仓成本口径（onboarding-rework §5.3 注）
 * - 采用价 8 位 HALF_UP 舍入落库（rate）与原报价保全（rawRate）；
 * - rateSource / rateObservedAt / confirmedAt 落库；
 * - cost = amount × rate 全精度相乘后按本位币精度 HALF_UP 舍一次（JPY 整数币种取整）；
 * - 收益排除口径：INITIAL 批次的成本不计入未来收益率比较（docs 02），当前由
 *   sourceType=INITIAL 标记承载，收益模块未上线，断言验证标记存在；
 * - 本位币锁定不变式：建账后 PATCH /settings（白名单剥离）baseCurrency 与建账时一致（§6-c）。
 *
 * 报价造数：直接插 fresh ExchangeRate 行（createdAt=now、observedAt=now → getLatest
 * 缓存命中），RateProvider 注入拒绝外呼的 fetch stub，报价与外呼完全解耦。
 */
describe("初始持仓成本口径（集成）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const users: TestUser[] = [];
	const createdRateIds: string[] = [];

	const wizard = {
		region: "CN",
		locale: "zh-CN",
		prepPreference: "balanced",
		reminderEnabled: true,
	};

	/** 造 fresh 报价行（先清理币对历史行，防其他用例/回源残留的 observedAt 更晚行抢先） */
	async function seedRate(base: string, quote: string, rate: string) {
		await ctx.prisma.exchangeRate.deleteMany({ where: { base, quote } });
		const row = await ctx.prisma.exchangeRate.create({
			data: { base, quote, rate, source: "er-api", observedAt: new Date() },
		});
		createdRateIds.push(row.id);
	}

	/** 注册 + 条款 + 建账（可选初始持仓），返回用户 */
	async function setupUser(
		label: string,
		baseCurrency: string,
		holdings?: { currencyCode: string; amount: string }[],
	): Promise<TestUser> {
		const user = await createTestUser(app, label);
		users.push(user);
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(user.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);
		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(bearer(user.accessToken))
			.send({
				...wizard,
				baseCurrency,
				...(holdings ? { initialHoldings: holdings } : {}),
			});
		if (holdings) expect(res.status).toBe(201);
		return user;
	}

	beforeAll(async () => {
		// 汇率外呼一律拒绝：初始持仓取价只依赖本文件 seedRate 造的 fresh 行
		ctx = await createTestApp((builder) =>
			builder.overrideProvider(RateProvider).useFactory({
				factory: (timeoutMs: number) =>
					new RateProvider(timeoutMs, (async () => {
						throw new Error("integration: 未预期的汇率数据源外呼");
					}) as unknown as typeof fetch),
				inject: [RATE_PROVIDER_TIMEOUT_TOKEN],
			}),
		);
		app = ctx.app;
	});

	afterAll(async () => {
		for (const user of users) {
			await cleanupUser(ctx.prisma, user.userId);
		}
		if (createdRateIds.length > 0) {
			await ctx.prisma.exchangeRate
				.deleteMany({ where: { id: { in: createdRateIds } } })
				.catch(() => {});
		}
		await app.close();
	});

	it("8 位汇率舍入与 rawRate/来源/报价时间落库（超 8 位小数报价行）", async () => {
		// 10 位小数报价：第 9 位起 51 → 8 位 HALF_UP 进位 → 5.41200001
		await seedRate("CNY", "SGD", "5.4120000051");
		await seedRate("CNY", "KRW", "0.0052");
		const user = await setupUser("int-cost-a", "CNY", [
			{ currencyCode: "SGD", amount: "1000.00" },
			{ currencyCode: "KRW", amount: "100000" },
		]);

		const holdings = await ctx.prisma.initialHolding.findMany({
			where: { userId: user.userId },
		});
		const byCode = new Map(holdings.map((h) => [h.currencyCode, h]));

		// rate = roundRateTo8(源行原值 5.4120000051) = 5.41200001（HALF_UP 进位）
		const usd = byCode.get("SGD")!;
		expect(usd.rate.toFixed(8)).toBe("5.41200001");
		// rawRate = 采用价原字符串（rate-service getLatest 契约即下发 8 位值，
		// 原样保存；10 位定点呈现 "7.2531000100"，与 rate 同值属契约现状）
		expect(usd.rawRate.toFixed(10)).toBe("5.4120000100");
		expect(usd.rateSource).toBe("er-api");
		expect(usd.rateObservedAt).toBeInstanceOf(Date);
		expect(usd.confirmedAt).toBeInstanceOf(Date);
		expect(usd.amount.toFixed(4)).toBe("1000.0000");

		// cost = amount × rate（8 位采用价）全精度后按本位币精度 HALF_UP 舍一次
		// 1000 × 5.41200001 = 5412.00001 → CNY 2 位 → 5412.0000
		expect(usd.cost.toFixed(4)).toBe("5412.0000");
		const jpy = byCode.get("KRW")!;
		expect(jpy.cost.toFixed(4)).toBe("520.0000");

		// cost 精确复算：Decimal 重算 amount × rate 与落库值按位一致
		const recomputed = usd.amount
			.mul(usd.rate)
			.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
		expect(recomputed.toFixed(4)).toBe(usd.cost.toFixed(4));

		// CostLot 成本批次字段口径 + 收益排除口径标记
		const lot = await ctx.prisma.costLot.findFirst({
			where: { userId: user.userId, currencyCode: "SGD" },
		});
		expect(lot).not.toBeNull();
		expect(lot!.sourceType).toBe("INITIAL");
		expect(lot!.sourceId).toBe(usd.id);
		expect(lot!.unitCost.toFixed(8)).toBe("5.41200001");
		expect(lot!.totalCost.toFixed(4)).toBe("5412.0000");
		// acquiredAt = ledgerStartedAt（完成当日 UTC+8 日初）
		expect(lot!.acquiredAt.toISOString()).toBe(
			utc8DayStart(new Date()).toISOString(),
		);
	});

	it("JPY 本位币整数舍入：100.5 USD × 150.12345678 → cost 取整 HALF_UP = 15087", async () => {
		await seedRate("JPY", "GBP", "150.12345678");
		const user = await setupUser("int-cost-b", "JPY", [
			{ currencyCode: "GBP", amount: "100.50" },
		]);

		const holding = await ctx.prisma.initialHolding.findFirst({
			where: { userId: user.userId, currencyCode: "GBP" },
		});
		expect(holding).not.toBeNull();
		// 100.5 × 150.12345678 = 15087.40741639 → JPY 0 位 HALF_UP → 15087
		expect(holding!.cost.toFixed(0)).toBe("15087");
		expect(holding!.cost.toFixed(4)).toBe("15087.0000");

		// Decimal 精确复算
		const recomputed = holding!.amount
			.mul(holding!.rate)
			.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
		expect(recomputed.toFixed(4)).toBe(holding!.cost.toFixed(4));
	});

	it("本位币锁定不变式：建账后 PATCH /settings baseCurrency 与建账时一致（§6-c）", async () => {
		const user = await setupUser("int-cost-c", "CNY");

		// 只改 locale（含 baseCurrency 字段会被白名单剥离，见 settings.spec）
		await request(app.getHttpServer())
			.patch("/api/settings")
			.set(bearer(user.accessToken))
			.send({ locale: "en" })
			.expect(200);

		const settings = await ctx.prisma.userSettings.findUnique({
			where: { userId: user.userId },
		});
		expect(settings?.baseCurrency).toBe("CNY");
		expect(settings?.locale).toBe("en");
	});

	it("并发补录同币种双请求（P2002）：一个 201 一个 409 INITIAL_HOLDING_EXISTS，批次仅一条（§8.2 行 7）", async () => {
		await seedRate("CNY", "THB", "0.21");
		const user = await setupUser("int-cost-d", "CNY");
		const auth = bearer(user.accessToken);
		const body = { holdings: [{ currencyCode: "THB", amount: "100.00" }] };

		// 真并发：两个请求同时发出（同币种；预检查都通过，插入时分出胜负）
		const [r1, r2] = await Promise.all([
			request(app.getHttpServer())
				.post("/api/onboarding/initial-holdings")
				.set(auth)
				.send(body),
			request(app.getHttpServer())
				.post("/api/onboarding/initial-holdings")
				.set(auth)
				.send(body),
		]);
		const statuses = [r1.status, r2.status].sort();
		expect(statuses).toEqual([201, 409]);
		const conflict = r1.status === 409 ? r1 : r2;
		expect(conflict.body.code).toBe("INITIAL_HOLDING_EXISTS");

		// 批次仅一条、余额按批次汇总恰为单笔
		const lots = await ctx.prisma.costLot.findMany({
			where: { userId: user.userId, currencyCode: "THB" },
		});
		expect(lots).toHaveLength(1);
		const account = await ctx.prisma.account.findUnique({
			where: {
				userId_currencyCode: { userId: user.userId, currencyCode: "THB" },
			},
		});
		expect(account?.balance.toFixed(4)).toBe("100.0000");
	});
});

// Prisma.Decimal 即 decimal.js Decimal；ROUND_HALF_UP 常量从 Decimal 命名空间取
const Decimal = Prisma.Decimal;
