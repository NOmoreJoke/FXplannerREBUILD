import { BadRequestException } from "@nestjs/common";
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
	createdAt: minutesBefore(1),
	...overrides,
});

// ── realtime-rate 多源升级追加用例的固定时点（秒级 abc / 日更 er-api·frankfurter 并存）──
const ABC_OBSERVED_AT = new Date("2026-02-13T02:26:54.000Z");
const DAY_OBSERVED_AT = LAST_FRIDAY;

describe("RateService", () => {
	let service: RateService;
	let prisma: {
		exchangeRate: {
			findFirst: ReturnType<typeof vi.fn>;
			findMany: ReturnType<typeof vi.fn>;
			upsert: ReturnType<typeof vi.fn>;
			createMany: ReturnType<typeof vi.fn>;
		};
	};
	let provider: {
		fetchLatest: ReturnType<typeof vi.fn>;
		fetchLatestBatch: ReturnType<typeof vi.fn>;
		fetchHistory: ReturnType<typeof vi.fn>;
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
			exchangeRate: {
				findFirst: vi.fn(),
				findMany: vi.fn(),
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
				};
			}) =>
				Promise.resolve({
					id: `row-${where.base_quote_observedAt.quote}`,
					base: "BASE",
					quote: where.base_quote_observedAt.quote,
					rate: decimal(create.rate),
					source: create.source,
					observedAt: create.observedAt,
					createdAt: new Date(T0),
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
			mkRow("USD", { createdAt: minutesBefore(1) }),
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
			mkRow("USD", { createdAt: minutesBefore(5) }),
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

	it("refresh=true 过期缓存同步回源：observedAt 不变，update 分支刷新 createdAt 重置窗口", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", {
				createdAt: minutesBefore(6),
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
			},
			update: {
				rate: "0.7300000000",
				source: "frankfurter",
				createdAt: new Date(T0), // 最后确认时间物化为 createdAt，窗口重置
			},
		});
		// observedAt 保持报价所属日（不因确认变为今天），窗口却已重置
		expect(result.observedAt).toBe(LAST_FRIDAY.toISOString());
		expect(result.fresh).toBe(true);
		expect(result.validUntil).toBe(minutesAfter(5).toISOString());
	});

	it("refresh=true 忽略新鲜缓存强制回源", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", { createdAt: minutesBefore(0.1) }),
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

	it("SWR 陈旧回显：后台回源落库重置窗口，二次查询命中新窗口不再外呼", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", { createdAt: minutesBefore(30) }),
		]);
		provider.fetchLatestBatch.mockResolvedValue(
			mkBatch({ USD: "0.7400000000" }),
		);

		const stale = (await service.getLatest("CAD")) as LatestRateResponse;
		expect(stale.rate).toBe("0.73");
		expect(stale.fresh).toBe(false);

		// 后台回源完成：upsert 落库且 createdAt = now（窗口重置）
		await vi.waitFor(() => {
			expect(prisma.exchangeRate.upsert).toHaveBeenCalledTimes(1);
		});
		const upsertArg = prisma.exchangeRate.upsert.mock.calls[0][0] as {
			update: { createdAt: Date };
		};
		expect(upsertArg.update.createdAt).toEqual(new Date(T0));

		// 二次查询：窗口已重置 → 命中缓存拿新值，不再外呼
		provider.fetchLatestBatch.mockClear();
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("USD", {
				createdAt: new Date(T0),
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
			mkRow("USD", { createdAt: minutesBefore(30) }),
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
			mkRow("USD", { createdAt: minutesBefore(30) }),
			mkRow("JPY", { createdAt: minutesBefore(30) }),
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
			},
			update: {
				rate: "1",
				source: "identity",
				createdAt: new Date(T0),
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
			mkRow("USD", { createdAt: minutesBefore(6) }),
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

	it("多目标数据源不可用：错误逐项下沉（各自 lastObservedAt），HTTP 整体 200", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([
			mkRow("CNY", { createdAt: minutesBefore(6) }), // CNY 有历史报价
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
			mkRow("USD", { createdAt: minutesBefore(6) }),
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
				},
				{
					base: "USD",
					quote: "CNY",
					rate: "7.2500000000",
					source: "frankfurter",
					observedAt: secondObservedAt,
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
		};
		update?: { createdAt?: Date };
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
				createdAt: args.update?.createdAt ?? new Date(T0),
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

	it("无卖出价的报价不触碰 sell_rate 列：upsert 不含 sellRate 键，响应不含 sellRate 键", async () => {
		prisma.exchangeRate.findMany.mockResolvedValue([]);
		provider.fetchLatestBatch.mockResolvedValue(
			mkBatch({ USD: "6.7105500000" }, "abc", ABC_OBSERVED_AT),
		);

		const result = (await service.getLatest("CNY")) as LatestRateResponse;

		const upsertArg = prisma.exchangeRate.upsert.mock.calls[0][0] as {
			create: Record<string, unknown>;
			update: Record<string, unknown>;
		};
		expect(upsertArg.create).not.toHaveProperty("sellRate");
		expect(upsertArg.update).not.toHaveProperty("sellRate");
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
