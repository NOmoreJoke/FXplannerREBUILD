import { BadRequestException } from "@nestjs/common";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { utc8DayStart } from "../transaction/transaction-calculator";
import { QUOTE_TTL_MS, SUPPORTED_CURRENCIES } from "./rate.constants";
import {
	RatePairUnsupportedException,
	RateSourceUnavailableException,
} from "./rate.errors";
import type {
	LatestRateGroupResponse,
	LatestRateItemSuccess,
	LatestRateResponse,
} from "./rate.service";
import { RateService } from "./rate.service";

const decimal = (value: string) => ({ toString: () => value });

// 固定时钟：T0 = 2026-02-16（周一）08:00 UTC；数据源最近报价日 = 上周五
const T0 = new Date("2026-02-16T08:00:00.000Z");
const LAST_FRIDAY = new Date("2026-02-13T00:00:00.000Z");
const minutesBefore = (n: number) => new Date(T0.getTime() - n * 60_000);
const minutesAfter = (n: number) => new Date(T0.getTime() + n * 60_000);

/** 构造 ExchangeRate 行 mock（rate 用 fake decimal，行为与 Prisma Decimal.toString 一致） */
const mkRow = (quote: string, overrides: Record<string, unknown> = {}) => ({
	id: `row-${quote}`,
	base: "CAD",
	quote,
	rate: decimal("0.7300000000"),
	source: "frankfurter",
	observedAt: LAST_FRIDAY,
	latestConfirmedAt: minutesBefore(1),
	...overrides,
});

// ── realtime-rate 多源升级追加用例的固定时点（秒级 abc / 日更 er-api·frankfurter 并存）──
const ABC_OBSERVED_AT = new Date("2026-02-13T02:26:54.000Z");
const DAY_OBSERVED_AT = LAST_FRIDAY;

describe("RateService", () => {
	let service: RateService;
	let prisma: {
		$transaction: ReturnType<typeof vi.fn>;
		exchangeRate: {
			findFirst: ReturnType<typeof vi.fn>;
			findMany: ReturnType<typeof vi.fn>;
			findUniqueOrThrow: ReturnType<typeof vi.fn>;
			upsert: ReturnType<typeof vi.fn>;
			createMany: ReturnType<typeof vi.fn>;
		};
	};
	let provider: {
		fetchLatest: ReturnType<typeof vi.fn>;
		fetchLatestBatch: ReturnType<typeof vi.fn>;
		fetchHistory: ReturnType<typeof vi.fn>;
		fetchReferenceSeries: ReturnType<typeof vi.fn>;
		sourceForPair: ReturnType<typeof vi.fn>;
	};

	/**
	 * 构造 RateBatchQuote mock（门面新契约：逐项携带 observedAt/source；
	 * 仅装配形状对齐，断言预期值与多源改造前一致）。
	 */
	const mkBatch = (
		rates: Record<string, string>,
		source = "frankfurter",
		observedAt: Date = LAST_FRIDAY,
	) => ({
		source,
		quotes: Object.fromEntries(
			Object.entries(rates).map(([target, rate]) => [
				target,
				{ rate, observedAt, raw: rate },
			]),
		),
	});

	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
		prisma = {
			$transaction: vi.fn((write: (db: typeof prisma) => Promise<unknown>) =>
				write(prisma),
			),
			exchangeRate: {
				findFirst: vi.fn(),
				findMany: vi.fn(),
				findUniqueOrThrow: vi.fn(),
				upsert: vi.fn(),
				createMany: vi.fn(),
			},
		};
		// 默认 upsert 行为：按 create 数据返回落库后的行（确认时间 = now，模拟 DB 更新）
		prisma.exchangeRate.upsert.mockImplementation(
			({
				where,
				create,
			}: {
				where: { base_quote_observedAt: { quote: string } };
				create: {
					rate: string;
					source: string;
					observedAt: Date;
					latestConfirmedAt: Date;
				};
			}) =>
				Promise.resolve({
					id: `row-${where.base_quote_observedAt.quote}`,
					base: "BASE",
					quote: where.base_quote_observedAt.quote,
					rate: decimal(create.rate),
					source: create.source,
					observedAt: create.observedAt,
					latestConfirmedAt: create.latestConfirmedAt,
				}),
		);
		provider = {
			fetchLatest: vi.fn(),
			fetchLatestBatch: vi.fn(),
			fetchHistory: vi.fn(),
			sourceForPair: vi.fn(() => "frankfurter"),
		};
		service = new RateService(
			prisma as unknown as PrismaService,
			provider as never,
		);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("返回固定支持币种且不暴露内部 Set", () => {
		const supported = service.getSupported();

		// 15 币种，顺序来自 @fxplanner-new/money 的 CURRENCIES（sortOrder 1-15）
		expect(supported).toEqual([
			"HKD",
			"USD",
			"GBP",
			"AUD",
			"CAD",
			"CNY",
			"JPY",
			"EUR",
			"SGD",
			"NZD",
			"TWD",
			"CHF",
			"KRW",
			"THB",
			"MYR",
		]);
		supported.push("TEST");
		expect(service.getSupported()).not.toContain("TEST");
	});

	it("窗口内命中数据库报价：不外呼、不落库，validUntil = 确认时间 + 5 分钟", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", { latestConfirmedAt: minutesBefore(1) }),
		]);

		const result = (await service.getLatest("CAD")) as LatestRateResponse;

		expect(provider.fetchLatestBatch).not.toHaveBeenCalled();
		expect(provider.fetchLatest).not.toHaveBeenCalled();
		expect(prisma.exchangeRate.upsert).not.toHaveBeenCalled();
		expect(result).toEqual({
			base: "CAD",
			target: "USD",
			rate: "0.73",
			source: "frankfurter",
			observedAt: LAST_FRIDAY.toISOString(),
			validUntil: minutesAfter(4).toISOString(),
			fresh: true,
		});
	});

	it("恰好满 5 分钟视为过期（严格小于）：立即回显旧值（fresh=false），后台异步回源", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", { latestConfirmedAt: minutesBefore(5) }),
		]);
		provider.fetchLatestBatch.mockResolvedValue(
			mkBatch({ USD: "0.7300000000" }),
		);

		// SWR：响应不等待外呼结果，旧值先行 + fresh=false 如实标注
		const result = (await service.getLatest("CAD")) as LatestRateResponse;

		expect(result.rate).toBe("0.73");
		expect(result.fresh).toBe(false);
		// 后台异步回源被触发（与响应并发，不阻塞）
		await vi.waitFor(() => {
			expect(provider.fetchLatestBatch).toHaveBeenCalledTimes(1);
		});
	});

	it("refresh=true 过期缓存同步回源：observedAt 不变，update 分支刷新 latestConfirmedAt 重置窗口", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", {
				latestConfirmedAt: minutesBefore(6),
				observedAt: LAST_FRIDAY,
			}),
		]);
		provider.fetchLatestBatch.mockResolvedValue(
			mkBatch({ USD: "0.7300000000" }),
		);

		const result = (await service.getLatest(
			"CAD",
			undefined,
			true,
		)) as LatestRateResponse;

		expect(prisma.exchangeRate.upsert).toHaveBeenCalledWith({
			where: {
				base_quote_observedAt: {
					base: "CAD",
					quote: "USD",
					observedAt: LAST_FRIDAY,
				},
			},
			create: {
				base: "CAD",
				quote: "USD",
				rate: "0.7300000000",
				source: "frankfurter",
				observedAt: LAST_FRIDAY,
				latestConfirmedAt: new Date(T0),
				canonicalWriteId: expect.any(String),
			},
			update: {
				rate: "0.7300000000",
				source: "frankfurter",
				latestConfirmedAt: new Date(T0),
				canonicalWriteId: expect.any(String),
				sellRate: null,
			},
		});
		// observedAt 保持报价所属日（不因确认变为今天），窗口却已重置
		expect(result.observedAt).toBe(LAST_FRIDAY.toISOString());
		expect(result.fresh).toBe(true);
		expect(result.validUntil).toBe(minutesAfter(5).toISOString());
	});

	it("refresh=true 忽略新鲜缓存强制回源", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", { latestConfirmedAt: minutesBefore(0.1) }),
		]);
		provider.fetchLatestBatch.mockResolvedValue(
			mkBatch({ USD: "0.7400000000" }),
		);

		const result = (await service.getLatest(
			"CAD",
			undefined,
			true,
		)) as LatestRateResponse;

		expect(provider.fetchLatestBatch).toHaveBeenCalledTimes(1);
		expect(result.rate).toBe("0.74");
	});

	it("入账取价直接复用仍在确认窗口内的报价", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([mkRow("USD")]);

		await expect(service.getLatestForBooking("CAD", ["USD"])).resolves.toMatchObject({
			rate: "0.73",
			fresh: true,
			validUntil: minutesAfter(4).toISOString(),
		});
		expect(provider.fetchLatestBatch).not.toHaveBeenCalled();
	});

	it("SWR 陈旧回显：后台回源落库重置窗口，二次查询命中新窗口不再外呼", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", { latestConfirmedAt: minutesBefore(30) }),
		]);
		provider.fetchLatestBatch.mockResolvedValue(
			mkBatch({ USD: "0.7400000000" }),
		);

		const stale = (await service.getLatest("CAD")) as LatestRateResponse;
		expect(stale.rate).toBe("0.73");
		expect(stale.fresh).toBe(false);

		// 后台回源完成：upsert 落库且 latestConfirmedAt = now（窗口重置）
		await vi.waitFor(() => {
			expect(prisma.exchangeRate.upsert).toHaveBeenCalledTimes(1);
		});
		const upsertArg = prisma.exchangeRate.upsert.mock.calls[0][0] as {
			update: { latestConfirmedAt: Date };
		};
		expect(upsertArg.update.latestConfirmedAt).toEqual(new Date(T0));

		// 二次查询：窗口已重置 → 命中缓存拿新值，不再外呼
		provider.fetchLatestBatch.mockClear();
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", {
				latestConfirmedAt: new Date(T0),
				rate: decimal("0.7400000000"),
			}),
		]);
		const fresh = (await service.getLatest("CAD")) as LatestRateResponse;
		expect(provider.fetchLatestBatch).not.toHaveBeenCalled();
		expect(fresh.rate).toBe("0.74");
		expect(fresh.fresh).toBe(true);
	});

	it("SWR 后台刷新失败：响应不受影响（旧值已返回），失败被吞掉不产生 unhandled rejection", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", { latestConfirmedAt: minutesBefore(30) }),
		]);
		provider.fetchLatestBatch.mockRejectedValue(new Error("源超时"));

		const result = (await service.getLatest("CAD")) as LatestRateResponse;
		expect(result.rate).toBe("0.73");
		expect(result.fresh).toBe(false);

		// 后台 promise 完成且异常被 kickBackgroundRefresh 捕获（vitest 会将
		// unhandled rejection 判为用例失败，能走到这里即证明吞错生效）
		await vi.waitFor(() => {
			expect(provider.fetchLatestBatch).toHaveBeenCalledTimes(1);
		});
	});

	it("刚写入的历史行只作 SWR 陈旧回显，报价有效期已经结束", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", { createdAt: T0, latestConfirmedAt: null }),
		]);
		provider.fetchLatestBatch.mockRejectedValue(new Error("provider unavailable"));

		const result = (await service.getLatest("CAD")) as LatestRateResponse;

		expect(result).toMatchObject({ rate: "0.73", fresh: false });
		expect(Date.parse(result.validUntil)).toBeLessThanOrEqual(T0.getTime());
		expect(provider.fetchLatestBatch).toHaveBeenCalledTimes(1);
		expect(prisma.exchangeRate.upsert).not.toHaveBeenCalled();
	});

	it("较新的历史观测不会挡住仍在窗口内的已确认报价", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", {
				observedAt: T0,
				rate: decimal("0.80"),
				latestConfirmedAt: null,
			}),
			mkRow("USD"),
		]);

		const result = (await service.getLatest("CAD")) as LatestRateResponse;

		expect(result).toMatchObject({
			rate: "0.73",
			observedAt: LAST_FRIDAY.toISOString(),
			fresh: true,
		});
		expect(provider.fetchLatestBatch).not.toHaveBeenCalled();
	});

	it("超窗且库内缺目标（冷启动）：同步回源等待，不回显不完整组", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([]);
		provider.fetchLatestBatch.mockResolvedValue(
			mkBatch({ USD: "0.7400000000" }),
		);

		const result = (await service.getLatest("CAD")) as LatestRateResponse;

		// 同步路径：await 返回时外呼已完成且拿到新值（现状语义锚定）
		expect(provider.fetchLatestBatch).toHaveBeenCalledTimes(1);
		expect(result.rate).toBe("0.74");
		expect(result.fresh).toBe(true);
	});

	it("多目标超窗回显：组内全部返回旧值（保序、fresh=false），后台一次批量外呼", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", { latestConfirmedAt: minutesBefore(30) }),
			mkRow("JPY", { latestConfirmedAt: minutesBefore(30) }),
		]);
		provider.fetchLatestBatch.mockResolvedValue(
			mkBatch({ USD: "0.7400000000", JPY: "0.0480000000" }),
		);

		const result = (await service.getLatest("CAD", [
			"USD",
			"JPY",
		])) as LatestRateGroupResponse;

		expect(
			result.items.map((item) => (item as LatestRateItemSuccess).target),
		).toEqual(["USD", "JPY"]);
		expect(
			result.items.map((item) => (item as LatestRateItemSuccess).fresh),
		).toEqual([false, false]);

		await vi.waitFor(() => {
			expect(provider.fetchLatestBatch).toHaveBeenCalledTimes(1);
		});
	});

	it("同币种恒等报价 rate=1 本地生成，不外呼；落库方式与普通报价一致", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([]);

		const result = await service.getLatest("USD");

		expect(provider.fetchLatestBatch).not.toHaveBeenCalled();
		expect(provider.fetchLatest).not.toHaveBeenCalled();
		expect(prisma.exchangeRate.upsert).toHaveBeenCalledWith({
			where: {
				base_quote_observedAt: {
					base: "USD",
					quote: "USD",
					observedAt: new Date(T0),
				},
			},
			create: {
				base: "USD",
				quote: "USD",
				rate: "1",
				source: "identity",
				observedAt: new Date(T0),
				latestConfirmedAt: new Date(T0),
				canonicalWriteId: expect.any(String),
			},
			update: {
				rate: "1",
				source: "identity",
				latestConfirmedAt: new Date(T0),
				canonicalWriteId: expect.any(String),
				sellRate: null,
			},
		});
		expect(result).toMatchObject({
			base: "USD",
			target: "USD",
			rate: "1",
			source: "identity",
			fresh: true,
		});
	});

	it("批量 targets 一次外呼且目标保序去重，组内共享同一报价时点", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([]);
		provider.fetchLatestBatch.mockResolvedValue(
			mkBatch({ JPY: "0.0067000000", CNY: "0.1391000000" }),
		);

		const result = (await service.getLatest("CAD", [
			"JPY",
			"CNY",
			"JPY",
		])) as LatestRateGroupResponse;

		expect(provider.fetchLatestBatch).toHaveBeenCalledTimes(1);
		expect(provider.fetchLatestBatch).toHaveBeenCalledWith("CAD", [
			"JPY",
			"CNY",
		]);
		expect(result.items).toHaveLength(2);
		expect(
			(result.items as LatestRateItemSuccess[]).map((item) => item.observedAt),
		).toEqual([LAST_FRIDAY.toISOString(), LAST_FRIDAY.toISOString()]);
	});

	it("混合组：base 自身恒等项随组返回，外部币种才参与外呼", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([]);
		provider.fetchLatestBatch.mockResolvedValue(
			mkBatch({ CNY: "0.1391000000" }),
		);

		const result = (await service.getLatest("USD", [
			"USD",
			"CNY",
		])) as LatestRateGroupResponse;

		// 恒等项不进外呼参数
		expect(provider.fetchLatestBatch).toHaveBeenCalledWith("USD", ["CNY"]);
		expect(result.items[0]).toMatchObject({
			target: "USD",
			rate: "1",
			source: "identity",
		});
		expect(result.items[1]).toMatchObject({
			target: "CNY",
			source: "frankfurter",
		});
	});

	it("响应缺目标币种：该项标记 RATE_PAIR_UNSUPPORTED，其余币种照常返回", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([]);
		// frankfurter 语义：200 但 rates 缺 TWD（ECB 无新台币）
		provider.fetchLatestBatch.mockResolvedValue(
			mkBatch({ CNY: "0.1391000000" }),
		);

		const result = (await service.getLatest("USD", [
			"CNY",
			"TWD",
		])) as LatestRateGroupResponse;

		expect(result.items[0]).toMatchObject({ target: "CNY", rate: "0.1391" });
		expect(result.items[1]).toMatchObject({
			target: "TWD",
			error: {
				code: "RATE_PAIR_UNSUPPORTED",
				lastObservedAt: null,
			},
		});
	});

	it("批量 404（含未知币种整批拒绝）：降级逐个单查，坏币种 422 不拖垮同组", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([]);
		provider.fetchLatestBatch.mockRejectedValue(
			new RatePairUnsupportedException("USD", "CNY,TWD"),
		);
		provider.fetchLatest.mockImplementation(
			async (_base: string, target: string) => {
				if (target === "TWD") {
					throw new RatePairUnsupportedException("USD", "TWD");
				}
				return {
					base: "USD",
					quote: target,
					rate: "0.1391000000",
					source: "frankfurter",
					observedAt: LAST_FRIDAY,
				};
			},
		);

		const result = (await service.getLatest("USD", [
			"CNY",
			"TWD",
		])) as LatestRateGroupResponse;

		expect(provider.fetchLatestBatch).toHaveBeenCalledTimes(1);
		expect(provider.fetchLatest).toHaveBeenCalledTimes(2);
		expect(result.items[0]).toMatchObject({ target: "CNY", rate: "0.1391" });
		expect(result.items[1]).toMatchObject({
			target: "TWD",
			error: { code: "RATE_PAIR_UNSUPPORTED" },
		});
	});

	it("单目标币对不支持：直接上抛 422 语义异常", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([]);
		provider.fetchLatestBatch.mockRejectedValue(
			new RatePairUnsupportedException("USD", "TWD"),
		);

		await expect(service.getLatest("USD", ["TWD"])).rejects.toBeInstanceOf(
			RatePairUnsupportedException,
		);
	});

	it("响应报价按 money 包规则四舍五入保留 8 位；库中原值保留", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([]);
		provider.fetchLatestBatch.mockResolvedValue(
			mkBatch({ USD: "0.730012345678" }),
		);

		const result = (await service.getLatest("CAD")) as LatestRateResponse;

		expect(prisma.exchangeRate.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ rate: "0.730012345678" }),
			}),
		);
		expect(result.rate).toBe("0.73001235");
	});

	it("refresh=true 回源失败且库中有旧值：单目标抛 502 + 库中最后报价时间", async () => {
		// SWR 后：refresh=false 超窗回显旧值不再上抱 502；502+lastObservedAt 语义
		// 收窄至强制回源路径（确认页锁数/手动刷新）
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", { latestConfirmedAt: minutesBefore(6) }),
		]);
		provider.fetchLatestBatch.mockRejectedValue(new Error("upstream 500"));

		const error = await service
			.getLatest("CAD", undefined, true)
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RateSourceUnavailableException);
		const response = (error as RateSourceUnavailableException).getResponse();
		expect(response).toMatchObject({
			code: "RATE_SOURCE_UNAVAILABLE",
			lastObservedAt: LAST_FRIDAY.toISOString(),
		});
		expect(prisma.exchangeRate.upsert).not.toHaveBeenCalled();
	});

	it("数据源不可用且库中无历史报价：502 + lastObservedAt 为 null", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([]);
		provider.fetchLatestBatch.mockRejectedValue(new Error("timeout"));

		const error = await service.getLatest("CAD").catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RateSourceUnavailableException);
		expect(
			(error as RateSourceUnavailableException).getResponse(),
		).toMatchObject({
			lastObservedAt: null,
		});
	});

	it("八位报价门槛遵守 HALF_UP 的半单位边界（基准价和卖出价）", async () => {
		const boundaryTicks = fc.oneof(
			fc.constantFrom(0, 1, 49, 50, 51, 99, 100),
			fc.integer({ min: 0, max: 149 }),
		);
		const storagePrice = (ticks: number) =>
			`0.${String(ticks).padStart(10, "0")}`;
		// 每个八位单位对应 100 个十位单位，正数在第 50 个十位单位向上进位。
		const publishedUnits = (ticks: number) => Math.floor((ticks + 50) / 100);
		prisma.exchangeRate.findMany.mockResolvedValue([]);

		await fc.assert(
			fc.asyncProperty(
				boundaryTicks,
				fc.option(boundaryTicks, { nil: undefined }),
				async (rateTicks, sellTicks) => {
					const rate = storagePrice(rateTicks);
					const sellRate = sellTicks === undefined ? undefined : storagePrice(sellTicks);
					const row = mkRow("USD", {
						rate: decimal(rate),
						sellRate: sellRate === undefined ? null : decimal(sellRate),
					});
					prisma.exchangeRate.upsert.mockClear();
					prisma.exchangeRate.createMany
						.mockClear()
						.mockResolvedValue({ count: 1 });
					prisma.exchangeRate.findUniqueOrThrow.mockResolvedValue(row);
					prisma.exchangeRate.upsert.mockResolvedValue(row);
					provider.fetchLatestBatch.mockResolvedValue({
						source: "abc",
						quotes: { USD: { rate, sellRate, observedAt: LAST_FRIDAY } },
					});

					const rateUnits = publishedUnits(rateTicks);
					const sellUnits = sellTicks === undefined ? undefined : publishedUnits(sellTicks);
					const result = service.getLatest("CNY", ["USD"], true);
					if (rateUnits === 0 || sellUnits === 0) {
						await expect(result).rejects.toBeInstanceOf(RateSourceUnavailableException);
						expect(prisma.exchangeRate.upsert).not.toHaveBeenCalled();
						expect(prisma.exchangeRate.createMany).not.toHaveBeenCalled();
					} else {
						await expect(result).resolves.toMatchObject({
							rate: `${rateUnits}e-8`,
							...(sellUnits === undefined ? {} : { sellRate: `${sellUnits}e-8` }),
							fresh: true,
						});
						expect(prisma.exchangeRate.upsert).toHaveBeenCalledTimes(
							sellRate === undefined ? 0 : 1,
						);
						expect(prisma.exchangeRate.createMany).toHaveBeenCalledTimes(
							sellRate === undefined ? 1 : 0,
						);
					}
				},
			),
			{ seed: 204, numRuns: 150 },
		);
	});

	it("跳过较新的无效缓存，保留最近可发布的报价及其时间", async () => {
		const latestValid = mkRow("USD");
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", { observedAt: T0, sellRate: decimal("0.0000000049") }),
			latestValid,
		]);
		await expect(service.getLatest("CAD")).resolves.toMatchObject({
			rate: "0.73",
			observedAt: latestValid.observedAt.toISOString(),
			fresh: true,
		});
		expect(provider.fetchLatestBatch).not.toHaveBeenCalled();

		provider.fetchLatestBatch.mockResolvedValue(mkBatch({ USD: "0.0000000049" }));
		const error = await service.getLatest("CAD", ["USD"], true).catch((err) => err);
		expect(error).toBeInstanceOf(RateSourceUnavailableException);
		expect(error.getResponse()).toMatchObject({
			lastObservedAt: latestValid.observedAt.toISOString(),
		});
		expect(prisma.exchangeRate.upsert).not.toHaveBeenCalled();
	});

	it("多目标数据源不可用：错误逐项下沉（各自 lastObservedAt），HTTP 整体 200", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("CNY", { latestConfirmedAt: minutesBefore(6) }), // CNY 有历史报价
		]);
		provider.fetchLatestBatch.mockRejectedValue(new Error("upstream 500"));

		const result = (await service.getLatest("CAD", [
			"CNY",
			"JPY",
		])) as LatestRateGroupResponse;

		expect(result.items[0]).toMatchObject({
			target: "CNY",
			error: {
				code: "RATE_SOURCE_UNAVAILABLE",
				lastObservedAt: LAST_FRIDAY.toISOString(),
			},
		});
		expect(result.items[1]).toMatchObject({
			target: "JPY",
			error: {
				code: "RATE_SOURCE_UNAVAILABLE",
				lastObservedAt: null,
			},
		});
	});

	it("并发同键请求单飞：provider 只被调用一次，落库每组目标各一次", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", { latestConfirmedAt: minutesBefore(6) }),
		]);
		let resolveBatch!: (value: unknown) => void;
		provider.fetchLatestBatch.mockReturnValue(
			new Promise((resolve) => {
				resolveBatch = resolve;
			}),
		);

		const resultsPromise = Promise.all([
			service.getLatest("CAD"),
			service.getLatest("CAD"),
			service.getLatest("CAD"),
			service.getLatest("CAD"),
			service.getLatest("CAD"),
		]);
		await vi.advanceTimersByTimeAsync(0);
		resolveBatch(mkBatch({ USD: "0.7300000000" }));
		const results = (await resultsPromise) as LatestRateResponse[];

		expect(provider.fetchLatestBatch).toHaveBeenCalledTimes(1);
		expect(prisma.exchangeRate.upsert).toHaveBeenCalledTimes(1);
		expect(results).toHaveLength(5);
		for (const result of results) {
			expect(result.rate).toBe("0.73");
		}
	});

	it("不同目标组合不复用单飞：各自外呼", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([]);
		provider.fetchLatestBatch.mockImplementation(
			async (_base: string, targets: string[]) =>
				mkBatch(
					Object.fromEntries(targets.map((target) => [target, "0.5000000000"])),
				),
		);

		await Promise.all([
			service.getLatest("CAD", ["CNY"]),
			service.getLatest("CAD", ["JPY"]),
		]);

		expect(provider.fetchLatestBatch).toHaveBeenCalledTimes(2);
		expect(provider.fetchLatestBatch).toHaveBeenCalledWith("CAD", ["CNY"]);
		expect(provider.fetchLatestBatch).toHaveBeenCalledWith("CAD", ["JPY"]);
	});

	it("非法参数一律 400：币种不在清单、targets 超量", async () => {
		await expect(service.getLatest("XYZ")).rejects.toBeInstanceOf(
			BadRequestException,
		);
		await expect(
			service.getLatest("USD", ["CNY", "BAD"]),
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			service.getLatest("USD", [...SUPPORTED_CURRENCIES, "CNY"]),
		).rejects.toBeInstanceOf(BadRequestException);
		expect(provider.fetchLatestBatch).not.toHaveBeenCalled();
	});

	it("查询历史时缓存未命中则获取并保存时间序列", async () => {
		const firstObservedAt = new Date(T0.getTime() - 86_400_000);
		const secondObservedAt = new Date(T0.getTime() - 43_200_000);
		prisma.exchangeRate.findMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{
					rate: decimal("7.2000000000"),
					observedAt: firstObservedAt,
				},
				{
					rate: decimal("7.2500000000"),
					observedAt: secondObservedAt,
				},
			]);
		provider.fetchHistory.mockResolvedValue([
			{ rate: "7.2000000000", observedAt: firstObservedAt },
			{ rate: "7.2500000000", observedAt: secondObservedAt },
		]);
		prisma.exchangeRate.createMany.mockResolvedValue({ count: 2 });

		const result = await service.getHistory("usd", "cny", 7);

		expect(provider.fetchHistory).toHaveBeenCalledWith(
			"USD",
			"CNY",
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
		);
		expect(prisma.exchangeRate.createMany).toHaveBeenCalledWith({
			data: [
				{
					base: "USD",
					quote: "CNY",
					rate: "7.2000000000",
					source: "frankfurter",
					observedAt: firstObservedAt,
					canonicalWriteId: expect.any(String),
				},
				{
					base: "USD",
					quote: "CNY",
					rate: "7.2500000000",
					source: "frankfurter",
					observedAt: secondObservedAt,
					canonicalWriteId: expect.any(String),
				},
			],
			skipDuplicates: true,
		});
		expect(result).toMatchObject({
			base: "USD",
			target: "CNY",
			period: 7,
			current_rate: "7.2500000000",
		});
		expect(result.data_points).toHaveLength(2);
	});

	it("部分历史缓存不会直接返回，而是继续从 Provider 补齐", async () => {
		const partialObservedAt = new Date(T0.getTime() - 3 * 86_400_000);
		prisma.exchangeRate.findMany
			.mockResolvedValueOnce([
				{ rate: decimal("7.2000000000"), observedAt: partialObservedAt },
			])
			.mockResolvedValueOnce([
				{ rate: decimal("7.2000000000"), observedAt: partialObservedAt },
			]);
		provider.fetchHistory.mockResolvedValue([]);

		await service.getHistory("USD", "CNY", 7);

		expect(provider.fetchHistory).toHaveBeenCalledWith(
			"USD",
			"CNY",
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
		);
	});

	it("拒绝不支持的币种和周期", async () => {
		await expect(service.getLatest("XYZ")).rejects.toBeInstanceOf(
			BadRequestException,
		);
		await expect(service.getHistory("USD", "CNY", 15)).rejects.toBeInstanceOf(
			BadRequestException,
		);
		expect(provider.fetchLatestBatch).not.toHaveBeenCalled();
	});

	it("5 分钟有效期常量为 300_000ms（doc 02/05）", () => {
		expect(QUOTE_TTL_MS).toBe(5 * 60 * 1000);
	});

	// ── 以下为 realtime-rate 多源升级追加用例（方案 §8.1）：仅追加，既有用例断言不动 ──

	/** 多源门面合并后的 RateBatchQuote mock（§4.1：逐项 sources 标注，顶层 multi） */
	const mkMultiBatch = () => ({
		source: "multi",
		sources: { USD: "abc", TWD: "er-api", MYR: "frankfurter" },
		quotes: {
			USD: {
				rate: "6.7105500000",
				sellRate: "6.7253100000",
				observedAt: ABC_OBSERVED_AT,
				raw: "671.05500000",
			},
			TWD: { rate: "4.5023", observedAt: DAY_OBSERVED_AT, raw: "4.5023" },
			MYR: { rate: "0.6102", observedAt: DAY_OBSERVED_AT, raw: "0.6102" },
		},
	});

	/** 追加用例专用：带卖出价的 abc 批量报价 mock（不改动既有 mkBatch） */
	const mkAbcBatch = (
		rates: Record<string, { rate: string; sellRate?: string }>,
		observedAt: Date = ABC_OBSERVED_AT,
	) => ({
		source: "abc",
		quotes: Object.fromEntries(
			Object.entries(rates).map(([target, value]) => [
				target,
				{ ...value, observedAt, raw: value.rate },
			]),
		),
	});

	/** 追加用例专用：upsert 回显 create 全量（含 sellRate），模拟 Prisma 落库后行（不改动共享装配） */
	type UpsertArgs = {
		where: { base_quote_observedAt: { base: string; quote: string } };
		create: {
			rate: string;
			sellRate?: string;
			source: string;
			observedAt: Date;
			latestConfirmedAt: Date;
		};
	};
	const mockUpsertEchoesCreate = () => {
		prisma.exchangeRate.upsert.mockImplementation((args: UpsertArgs) =>
			Promise.resolve({
				id: `row-${args.where.base_quote_observedAt.quote}`,
				base: args.where.base_quote_observedAt.base,
				quote: args.where.base_quote_observedAt.quote,
				rate: decimal(args.create.rate),
				...(args.create.sellRate !== undefined
					? { sellRate: decimal(args.create.sellRate) }
					: {}),
				source: args.create.source,
				observedAt: args.create.observedAt,
				latestConfirmedAt: args.create.latestConfirmedAt,
			}),
		);
	};

	it("混合组（ABC+er-api+frankfurter）：逐项 source/observedAt/sellRate 透传，落库 source 用逐项标识", async () => {
		mockUpsertEchoesCreate();
		prisma.exchangeRate.findMany.mockResolvedValue([]);
		provider.fetchLatestBatch.mockResolvedValue(mkMultiBatch());

		const result = (await service.getLatest("CNY", [
			"USD",
			"TWD",
			"MYR",
		])) as LatestRateGroupResponse;
		const items = result.items as LatestRateItemSuccess[];

		// abc 项：秒级 observedAt + sellRate 透传
		expect(items[0]).toMatchObject({
			target: "USD",
			source: "abc",
			sellRate: "6.72531",
			observedAt: ABC_OBSERVED_AT.toISOString(),
		});
		// er-api 项：日精度 observedAt，无 sellRate 键
		expect(items[1]).toMatchObject({
			target: "TWD",
			source: "er-api",
			observedAt: DAY_OBSERVED_AT.toISOString(),
		});
		expect("sellRate" in items[1]).toBe(false);
		// frankfurter 项：日精度 observedAt，无 sellRate 键
		expect(items[2]).toMatchObject({
			target: "MYR",
			source: "frankfurter",
			observedAt: DAY_OBSERVED_AT.toISOString(),
		});
		expect("sellRate" in items[2]).toBe(false);

		// 落库逐项用 sources 标识（而非顶层 multi），且仅 abc 项写 sell_rate
		const createArgs = (
			prisma.exchangeRate.upsert.mock.calls as Array<
				[{ create: Record<string, unknown> }]
			>
		).map((call) => call[0].create);
		expect(createArgs.map((create) => create.source)).toEqual([
			"abc",
			"er-api",
			"frankfurter",
		]);
		expect(createArgs[0]).toMatchObject({ sellRate: "6.7253100000" });
		expect(createArgs[1]).not.toHaveProperty("sellRate");
		expect(createArgs[2]).not.toHaveProperty("sellRate");
	});

	it("sell_rate 落库：create 与 update 分支都写入 sellRate，响应含 8 位 sellRate", async () => {
		mockUpsertEchoesCreate();
		prisma.exchangeRate.findMany.mockResolvedValue([]);
		provider.fetchLatestBatch.mockResolvedValue(
			mkAbcBatch({ USD: { rate: "6.7105500000", sellRate: "6.7253100000" } }),
		);

		const result = (await service.getLatest("CNY")) as LatestRateResponse;

		expect(prisma.exchangeRate.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ sellRate: "6.7253100000" }),
				update: expect.objectContaining({ sellRate: "6.7253100000" }),
			}),
		);
		expect(result.sellRate).toBe("6.72531");
	});

it("首次写入缺省卖出价的 ABC 报价，落库和响应均无卖出价", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([]);
		provider.fetchLatestBatch.mockResolvedValue(
			mkBatch({ USD: "6.7105500000" }, "abc", ABC_OBSERVED_AT),
		);
	prisma.exchangeRate.createMany.mockResolvedValue({ count: 1 });
	prisma.exchangeRate.findUniqueOrThrow.mockResolvedValue(mkRow("USD", {
		base: "CNY", source: "abc", rate: decimal("6.7105500000"), sellRate: null,
	}));

		const result = (await service.getLatest("CNY")) as LatestRateResponse;

	const { data } = prisma.exchangeRate.createMany.mock.calls[0][0];
	expect(data).not.toHaveProperty("sellRate");
	expect(data).toMatchObject({ source: "abc", canonicalWriteId: expect.any(String) });
		expect("sellRate" in result).toBe(false);
	});

	it("多源部分失败：失败源币对 502 项级下沉（带库中 lastObservedAt），成功源照常落库", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("TWD", { source: "er-api" }),
		]);
		provider.fetchLatestBatch.mockResolvedValue({
			source: "multi",
			sources: { USD: "abc", MYR: "frankfurter" },
			quotes: {
				USD: {
					rate: "6.7105500000",
					sellRate: "6.7253100000",
					observedAt: ABC_OBSERVED_AT,
					raw: "671.05500000",
				},
				MYR: { rate: "0.6102", observedAt: DAY_OBSERVED_AT, raw: "0.6102" },
			},
			failures: { TWD: new Error("er-api down") },
		});

		const result = (await service.getLatest("CNY", [
			"USD",
			"TWD",
			"MYR",
		])) as LatestRateGroupResponse;
		const items = result.items as LatestRateItemSuccess[];

		expect(items[0]).toMatchObject({ target: "USD", source: "abc" });
		expect(items[1]).toMatchObject({
			target: "TWD",
			error: {
				code: "RATE_SOURCE_UNAVAILABLE",
				lastObservedAt: LAST_FRIDAY.toISOString(),
			},
		});
		expect(items[2]).toMatchObject({ target: "MYR", source: "frankfurter" });
		// 失败项不落库：仅 USD/MYR 两次 upsert
		expect(prisma.exchangeRate.upsert).toHaveBeenCalledTimes(2);
	});

	it("单目标源失败（failures 下沉语义）：以 502 上抛", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([]);
		provider.fetchLatestBatch.mockResolvedValue({
			source: "abc",
			quotes: {},
			failures: { USD: new Error("abc down") },
		});

		await expect(service.getLatest("CNY")).rejects.toBeInstanceOf(
			RateSourceUnavailableException,
		);
	});
});

// ────────────────────────── findQuoteAt（corrections M8，方案 §5.3；MVP-F0-2 按源粒度）──────────────────────────

describe("RateService.findQuoteAt 原时点取价（MVP-F0-2 按源粒度）", () => {
	const AT = new Date("2026-09-10T02:00:00.000Z"); // 原确认时点 = UTC+8 2026-09-10 10:00
	const inWindow = (minutesAgo: number) =>
		new Date(AT.getTime() - minutesAgo * 60_000);
	// UTC+8 当日零点 = 2026-09-09T16:00Z；日级回看窗口起点 = 再前推 7 个自然日
	const LOOKBACK_START = new Date(
		utc8DayStart(AT).getTime() - 7 * 86_400_000,
	);

	function build() {
		const exchangeRate = {
			findFirst: vi.fn(),
			findMany: vi.fn(),
			upsert: vi.fn(),
			createMany: vi.fn(({ data }: { data: unknown[] }) => ({ count: data.length })),
		};
		const prisma = {
			exchangeRate,
			$transaction: (run: (tx: { exchangeRate: typeof exchangeRate }) => unknown) => run({ exchangeRate }),
		};
		const provider = {
			fetchLatest: vi.fn(),
			fetchLatestBatch: vi.fn(),
			fetchHistory: vi.fn(),
			fetchReferenceSeries: vi.fn(),
			sourceForPair: vi.fn(() => "frankfurter"),
		};
		const service = new RateService(
			prisma as unknown as PrismaService,
			provider as never,
		);
		return { service, prisma, provider };
	}

	const mkQuoteRow = (overrides: Record<string, unknown> = {}) => ({
		base: "CNY",
		quote: "USD",
		rate: decimal("7.2480000000"),
		sellRate: null,
		source: "er-api",
		observedAt: inWindow(3),
		...overrides,
	});

	it("实时源（abc）：窗口 (at−5min, at] 命中即返回；sellRate 优先于 rate；不再触发日级查询与回补", async () => {
		const { service, prisma } = build();
		prisma.exchangeRate.findFirst.mockResolvedValueOnce(
			mkQuoteRow({
				source: "abc",
				rate: decimal("7.2400000000"),
				sellRate: decimal("7.2512300000"),
				observedAt: inWindow(1),
			}),
		);

		const quote = await service.findQuoteAt("CNY", "USD", AT);
		expect(quote).not.toBeNull();
		expect(quote!.rate).toBe("7.2400000000");
		expect(quote!.sellRate).toBe("7.2512300000");
		expect(quote!.observedAt).toEqual(inWindow(1));
		// 首次查询即实时窗口：source 限定 abc、(at−5min, at]
		expect(prisma.exchangeRate.findFirst).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: expect.objectContaining({
					base: "CNY",
					quote: "USD",
					source: { in: ["abc"] },
					observedAt: {
						gt: new Date(AT.getTime() - 5 * 60_000),
						lte: AT,
					},
				}),
				orderBy: { observedAt: "desc" },
			}),
		);
		// 窗口内命中：不进入日级查询、不回补历史
		expect(prisma.exchangeRate.findFirst).toHaveBeenCalledTimes(1);
		expect(prisma.exchangeRate.createMany).not.toHaveBeenCalled();
	});

	it("实时窗口无行 → 日级查询（er-api）：UTC+8 同日 + 7 自然日回看 + 未来点排除，命中返回", async () => {
		const { service, prisma } = build();
		// 同日但早于窗口的日级点（如 08:02 UTC+8 发布）：实时查不到、日级命中
		const dailyPoint = new Date("2026-09-10T00:02:00.000Z"); // UTC+8 08:02
		prisma.exchangeRate.findFirst
			.mockResolvedValueOnce(null) // 实时窗口无 abc 行
			.mockResolvedValueOnce(mkQuoteRow({ source: "er-api", observedAt: dailyPoint }));

		const quote = await service.findQuoteAt("CNY", "USD", AT);
		expect(quote).not.toBeNull();
		expect(quote!.source).toBe("er-api");
		expect(quote!.observedAt).toEqual(dailyPoint);
		// 日级查询形状：source 限定 er-api、窗口 [UTC+8 当日零点 − 7 天, at]（未来点由 lte 排除）
		expect(prisma.exchangeRate.findFirst).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				where: expect.objectContaining({
					base: "CNY",
					quote: "USD",
					source: { in: ["er-api"] },
					observedAt: { gte: LOOKBACK_START, lte: AT },
				}),
				orderBy: { observedAt: "desc" },
			}),
		);
		expect(prisma.exchangeRate.createMany).not.toHaveBeenCalled();
	});

	it("仅日期源（frankfurter）不参与原时点取价：两路查询皆空 → 回补后仍空 → null（上层 400 RATE_QUOTE_UNAVAILABLE）", async () => {
		const { service, prisma, provider } = build();
		// 实时/日级/回补后重查/重查 全部空（date-only 行不可作原时点证据）
		prisma.exchangeRate.findFirst.mockResolvedValue(null);
		provider.fetchHistory.mockResolvedValue([
			// frankfurter 历史点（date 零点）：回补落库但不可用于原时点
			{ rate: "7.25", observedAt: new Date("2026-09-07T00:00:00.000Z") },
		]);

		const quote = await service.findQuoteAt("CNY", "USD", AT);
		expect(quote).toBeNull();
		// 回补通道保留（落库行供图表与后续语义使用）
		expect(prisma.exchangeRate.createMany).toHaveBeenCalledWith(
			expect.objectContaining({ skipDuplicates: true }),
		);
	});

	it("回补外呼失败不阻断失败路径：按「无合格报价」返回 null", async () => {
		const { service, prisma, provider } = build();
		prisma.exchangeRate.findFirst.mockResolvedValue(null);
		provider.fetchHistory.mockRejectedValue(new Error("source down"));

		const quote = await service.findQuoteAt("CNY", "USD", AT);
		expect(quote).toBeNull();
	});

	it("仅查缓存未命中时，不请求数据源或回补落库", async () => {
		const { service, prisma, provider } = build();
		prisma.exchangeRate.findFirst.mockResolvedValue(null);

		expect(await service.findQuoteAt("CNY", "USD", AT, { backfill: false })).toBeNull();
		expect(provider.fetchHistory).not.toHaveBeenCalled();
		expect(prisma.exchangeRate.createMany).not.toHaveBeenCalled();
	});

	it("回补行为与结果一致：frankfurter 历史点以 sourceForPair 来源落库（供图表），但原时点重查仍为 null——回补不伪造原时点可用性", async () => {
		const { service, prisma, provider } = build();
		prisma.exchangeRate.findFirst.mockResolvedValue(null);
		provider.fetchHistory.mockResolvedValue([
			{ rate: "7.25", observedAt: new Date("2026-09-10T00:00:00.000Z") },
		]);

		const quote = await service.findQuoteAt("CNY", "USD", AT);
		// er-api 免费档无历史端点、frankfurter 仅日期点不可作原时点证据：
		// 回补只落库（图表用），原时点取价如实返回 null
		expect(quote).toBeNull();
		expect(provider.fetchHistory).toHaveBeenCalledWith(
			"CNY",
			"USD",
			"2026-09-09", // 回补区间起点 = UTC+8 当日零点
			"2026-09-10",
		);
		expect(prisma.exchangeRate.createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				skipDuplicates: true,
				data: [expect.objectContaining({ source: "frankfurter" })],
			}),
		);
	});
});

// ────────── getHistory TWD 参考层（MVP-F0-2 C2·图表冷缺口补点，frankfurter v2 隔离）──────────

describe("RateService.getHistory 参考层合并（er-api 路由币对）", () => {
	const NOW = new Date("2026-11-19T02:00:00.000Z"); // 周四

	function build() {
		const prisma = {
			exchangeRate: {
				findFirst: vi.fn(),
				findMany: vi.fn(),
				upsert: vi.fn(),
				createMany: vi.fn(),
			},
		};
		const provider = {
			fetchLatest: vi.fn(),
			fetchLatestBatch: vi.fn(),
			fetchHistory: vi.fn(),
			fetchReferenceSeries: vi.fn(),
			sourceForPair: vi.fn(() => "er-api"),
		};
		const service = new RateService(
			prisma as unknown as PrismaService,
			provider as never,
		);
		return { service, prisma, provider };
	}

	const rowAt = (date: string, rate = "32.0000000000") => ({
		rate: decimal(rate),
		observedAt: new Date(`${date}T00:00:00.000Z`),
		source: "er-api",
	});

	beforeEach(() => {
		vi.useFakeTimers({ now: NOW });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("本地序列不完整 → v2 参考补点合并：本地行按日期优先，参考点仅补缺，逐点 source 标注", async () => {
		const { service, prisma, provider } = build();
		// 本地仅有一个 er-api 快照（2026-11-13）；v2 补 11-12 缺口、11-13 同日被本地优先
		const localRow = rowAt("2026-11-13");
		prisma.exchangeRate.findMany
			.mockResolvedValueOnce([localRow])
			.mockResolvedValueOnce([localRow]);
		provider.fetchHistory.mockResolvedValue([]); // er-api 无历史端点
		provider.fetchReferenceSeries.mockResolvedValue([
			{ rate: "0.2102297812", observedAt: new Date("2026-11-12T00:00:00.000Z") },
			{ rate: "0.2102297900", observedAt: new Date("2026-11-13T00:00:00.000Z") },
		]);

		const result = await service.getHistory("CNY", "TWD", 7);

		expect(provider.fetchReferenceSeries).toHaveBeenCalledWith(
			"CNY",
			"TWD",
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
		);
		// 本地行 source=er-api；参考点 source=frankfurter-v2-reference；同日本地优先
		expect(result.data_points).toEqual([
			{
				date: "2026-11-12",
				rate: "0.2102297812",
				source: "frankfurter-v2-reference",
			},
			{ date: "2026-11-13", rate: "32.0000000000", source: "er-api" },
		]);
		// current_rate 为合并序列末点（本地行）
		expect(result.current_rate).toBe("32.0000000000");
		// 参考点严禁回写：本次无 v1 回补行 → createMany 零调用
		expect(prisma.exchangeRate.createMany).not.toHaveBeenCalled();
	});

	it("本地缓存完整时直接返回每日最新快照，不取参考序列", async () => {
		const { service, prisma, provider } = build();
		const complete = [
			rowAt("2026-11-12", "32.0000000000"),
			rowAt("2026-11-13", "32.0100000000"),
			rowAt("2026-11-16", "32.0200000000"),
			rowAt("2026-11-17", "32.0300000000"),
			rowAt("2026-11-18", "32.0400000000"),
			rowAt("2026-11-19", "32.0500000000"),
			{
				...rowAt("2026-11-19", "32.0600000000"),
				observedAt: new Date("2026-11-19T00:02:31.000Z"),
			},
		];
		prisma.exchangeRate.findMany.mockResolvedValueOnce(complete);

		const result = await service.getHistory("CNY", "TWD", 7);

		expect(provider.fetchReferenceSeries).not.toHaveBeenCalled();
		expect(provider.fetchHistory).not.toHaveBeenCalled();
		expect(result.data_points.filter((point) => point.date === "2026-11-19")).toEqual([
			{ date: "2026-11-19", rate: "32.0600000000", source: "er-api" },
		]);
		expect(result.current_rate).toBe("32.0600000000");
	});

	it.each([false, true])("W4-07 同日参考价取精确较小值（反转上游顺序=%s）", async (reverse) => {
		const { service, prisma, provider } = build();
		prisma.exchangeRate.findMany.mockResolvedValue([]);
		provider.fetchHistory.mockResolvedValue([]);
		const reference = [
			{ rate: "9999999999.1234567890", observedAt: new Date("2026-11-15") },
			{ rate: "10.0000000000", observedAt: new Date("2026-11-12") },
			{ rate: "9999999999.1234567891", observedAt: new Date("2026-11-15") },
			{ rate: "2.0000000000", observedAt: new Date("2026-11-12") },
			{ rate: "2.0000000000", observedAt: new Date("2026-11-12") },
		];
		provider.fetchReferenceSeries.mockResolvedValue(
			reverse ? reference.toReversed() : reference,
		);

		const result = await service.getHistory("CNY", "TWD", 7);

		expect(result.data_points).toEqual([
			{ date: "2026-11-12", rate: "2.0000000000", source: "frankfurter-v2-reference" },
			{ date: "2026-11-15", rate: "9999999999.1234567890", source: "frankfurter-v2-reference" },
		]);
		expect(result.current_rate).toBe("9999999999.1234567890");
	});

	it("非 er-api 路由（frankfurter/abc）→ 不取参考序列（v1-only 回归保留）", async () => {
		const { service, prisma, provider } = build();
		provider.sourceForPair.mockReturnValue("frankfurter");
		prisma.exchangeRate.findMany
			.mockResolvedValueOnce([rowAt("2026-11-13", "7.2500000000")])
			.mockResolvedValueOnce([rowAt("2026-11-13", "7.2500000000")]);
		provider.fetchHistory.mockResolvedValue([]);

		await service.getHistory("CNY", "MYR", 7);

		expect(provider.fetchReferenceSeries).not.toHaveBeenCalled();
	});

		it("参考源失败 → 本地序列照常返回，区间缓存登记后 TTL 内第二次零外呼（防外呼放大）", async () => {
			const { service, prisma, provider } = build();
			const localRow = rowAt("2026-11-13");
			prisma.exchangeRate.findMany.mockResolvedValue([localRow]);
			provider.fetchHistory.mockResolvedValue([]);
			provider.fetchReferenceSeries.mockRejectedValue(
				new Error("reference down"),
			);

			const first = await service.getHistory("CNY", "TWD", 7);
			expect(first.data_points).toHaveLength(1);
			expect(first.data_points[0].source).toBe("er-api");
			expect(provider.fetchReferenceSeries).toHaveBeenCalledTimes(1);

			// 第二次（同区间）：参考缓存命中 → 不再外呼（v1 负缓存也命中，无 fetchHistory）
			const second = await service.getHistory("CNY", "TWD", 7);
			expect(provider.fetchReferenceSeries).toHaveBeenCalledTimes(1);
			expect(second.data_points).toHaveLength(1);
		});

		it("成功结果同样登记区间缓存：第二次同区间零外呼且合并结果一致", async () => {
			const { service, prisma, provider } = build();
			const localRow = rowAt("2026-11-13");
			prisma.exchangeRate.findMany.mockResolvedValue([localRow]);
			provider.fetchHistory.mockResolvedValue([]);
			provider.fetchReferenceSeries.mockResolvedValue([
				{ rate: "0.2102297812", observedAt: new Date("2026-11-12T00:00:00.000Z") },
			]);

			const first = await service.getHistory("CNY", "TWD", 7);
			expect(first.data_points).toHaveLength(2);
			expect(provider.fetchReferenceSeries).toHaveBeenCalledTimes(1);

			// 第二次：成功缓存命中（不外呼），合并结果与首次一致
			const second = await service.getHistory("CNY", "TWD", 7);
			expect(provider.fetchReferenceSeries).toHaveBeenCalledTimes(1);
			expect(second.data_points).toEqual(first.data_points);
		});

	it("跨 UTC 日在 TTL 边界清除过期区间，保留新窗口缓存和单飞", async () => {
		const { service, prisma, provider } = build();
		prisma.exchangeRate.findMany.mockResolvedValue([rowAt("2026-11-18")]);
		provider.fetchHistory.mockResolvedValue([]);
		provider.fetchReferenceSeries
			.mockResolvedValue([
				{ rate: "0.21", observedAt: new Date("2026-11-17T00:00:00.000Z") },
			])
			.mockRejectedValueOnce(new Error("reference down"));

		vi.setSystemTime(new Date("2026-11-19T23:55:00.000Z"));
		await service.getHistory("CNY", "TWD", 30);
		await service.getHistory("CNY", "TWD", 7);
		const priorDayKeys = [
			"CNY|TWD|2026-10-20|2026-11-19",
			"CNY|TWD|2026-11-12|2026-11-19",
		];
		const currentKey = "CNY|TWD|2026-11-13|2026-11-20";

		vi.setSystemTime(new Date("2026-11-20T00:04:59.999Z"));
		const [first, joined] = await Promise.all([
			service.getHistory("CNY", "TWD", 7),
			service.getHistory("CNY", "TWD", 7),
		]);
		expect(joined).toEqual(first);
		expect(first.data_points).toContainEqual({
			date: "2026-11-17",
			rate: "0.21",
			source: "frankfurter-v2-reference",
		});
		expect(provider.fetchReferenceSeries).toHaveBeenCalledTimes(3);
		expect(provider.fetchReferenceSeries).toHaveBeenLastCalledWith(
			"CNY",
			"TWD",
			"2026-11-13",
			"2026-11-20",
		);
		expect([...service["referenceCache"].keys()]).toEqual([
			...priorDayKeys,
			currentKey,
		]);

		vi.setSystemTime(new Date("2026-11-20T00:05:00.000Z"));
		expect(await service.getHistory("CNY", "TWD", 7)).toEqual(first);
		expect(provider.fetchReferenceSeries).toHaveBeenCalledTimes(3);
		expect([...service["referenceCache"].keys()]).toEqual([currentKey]);
	});

		it("同区间并发 3 请求：参考序列单飞合并为 1 次外呼", async () => {
			const { service, prisma, provider } = build();
			const localRow = rowAt("2026-11-13");
			prisma.exchangeRate.findMany.mockResolvedValue([localRow]);
			provider.fetchHistory.mockResolvedValue([]);
			// 微任务延迟（不用 setTimeout：本 describe 为 fake timers 环境）；
			// 单飞注册在首个请求的同步段完成，后续请求复用同一 promise
			provider.fetchReferenceSeries.mockImplementation(async () => {
				await Promise.resolve();
				return [
					{
						rate: "0.2102297812",
						observedAt: new Date("2026-11-12T00:00:00.000Z"),
					},
				];
			});

			const results = await Promise.all([
				service.getHistory("CNY", "TWD", 7),
				service.getHistory("CNY", "TWD", 7),
				service.getHistory("CNY", "TWD", 7),
			]);

			expect(provider.fetchReferenceSeries).toHaveBeenCalledTimes(1);
			for (const result of results) {
				expect(result.data_points).toHaveLength(2);
			}
		});

		it("参考序列回源交接（W4-03）：交错请求复用成功结果，后续缓存命中", async () => {
			const { service, prisma, provider } = build();
			const localRows = [rowAt("2026-11-13")];
			const referencePoints = [
				{
					rate: "0.2102297812",
					observedAt: new Date("2026-11-12T00:00:00.000Z"),
				},
			];
			let resolveReference!: (points: typeof referencePoints) => void;
			const reference = new Promise<typeof referencePoints>((resolve) => {
				resolveReference = resolve;
			});
			let resolveSavedRows!: (rows: typeof localRows) => void;
			const savedRows = new Promise<typeof localRows>((resolve) => {
				resolveSavedRows = resolve;
			});
			prisma.exchangeRate.findMany.mockResolvedValue(localRows);
			provider.fetchHistory.mockResolvedValue([]);
			provider.fetchReferenceSeries
				.mockReturnValueOnce(reference)
				.mockResolvedValue([]);

			const first = service.getHistory("CNY", "TWD", 7);
			await vi.advanceTimersByTimeAsync(0);
			expect(provider.fetchReferenceSeries).toHaveBeenCalledTimes(1);

			prisma.exchangeRate.findMany
				.mockResolvedValueOnce(localRows)
				.mockReturnValueOnce(savedRows);
			const second = service.getHistory("CNY", "TWD", 7);
			await vi.advanceTimersByTimeAsync(0);
			expect(prisma.exchangeRate.findMany).toHaveBeenCalledTimes(4);

			// 同步释放两个 Promise：第二次请求的查库续体紧跟首次回源的收尾微任务。
			resolveReference(referencePoints);
			resolveSavedRows(localRows);
			const [firstResult, secondResult] = await Promise.all([first, second]);
			const cachedResult = await service.getHistory("CNY", "TWD", 7);

			expect(provider.fetchReferenceSeries).toHaveBeenCalledTimes(1);
			expect(firstResult.data_points).toEqual([
				{
					date: "2026-11-12",
					rate: "0.2102297812",
					source: "frankfurter-v2-reference",
				},
				{ date: "2026-11-13", rate: "32.0000000000", source: "er-api" },
			]);
			expect(secondResult).toEqual(firstResult);
			expect(cachedResult).toEqual(firstResult);
		});

		it("同币对不同区间（7 与 365）并发：按范围隔离，各自外呼（FX-03 并发区间）", async () => {
			const { service, prisma, provider } = build();
			const localRow = rowAt("2026-11-13");
			prisma.exchangeRate.findMany.mockResolvedValue([localRow]);
			provider.fetchHistory.mockResolvedValue([]);
			provider.fetchReferenceSeries.mockResolvedValue([
				{ rate: "0.2102297812", observedAt: new Date("2026-11-12T00:00:00.000Z") },
			]);

			await Promise.all([
				service.getHistory("CNY", "TWD", 7),
				service.getHistory("CNY", "TWD", 365),
			]);

			// 区间入键：7 天与 365 天各得一次外呼（互不合并、互不污染）
			expect(provider.fetchReferenceSeries).toHaveBeenCalledTimes(2);
			const ranges = provider.fetchReferenceSeries.mock.calls.map(
				(call) => call[2] as string,
			);
			expect(new Set(ranges).size).toBe(2);
		});
});
