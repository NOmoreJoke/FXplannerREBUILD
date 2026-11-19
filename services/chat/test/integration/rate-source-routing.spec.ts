import { BadGatewayException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ABC_SAMPLE_FIXTURE,
	ABC_SAMPLE_ROWS,
	createRateSourceFetchStub,
	erApiLatestBody,
	frankfurterLatestBody,
	jsonResponse,
	type RateSourceRoutes,
} from "../helpers/rate-source-fixtures";
import { ABC_RATE_URL, ERAPI_RATE_URL } from "../../src/rate/rate.constants";
import { RateProvider } from "../../src/rate/rate.provider";

// 本文件专测多源路由：显式声明模式，防 worker 环境变量串扰（门面构造时读取 env）
process.env.RATE_SOURCE = "multi";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 统计 stub 外呼中命中某源的次数 */
const countCalls = (stub: ReturnType<typeof vi.fn>, prefix: string) =>
	stub.mock.calls.filter(([url]) => String(url).startsWith(prefix)).length;

describe("RateProvider 门面多源路由（realtime-rate §3.1）", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("混合组并发路由：USD→abc / TWD→er-api / MYR→frankfurter，三组并发外呼后合并", async () => {
		const routes: RateSourceRoutes = {};
		const stub = createRateSourceFetchStub(routes);
		// 并发度量：三组路由应同时在外（顺序等待则 max 恒为 1）
		let inFlight = 0;
		let maxInFlight = 0;
		const track =
			(
				route: (url: string) => Response | Promise<Response>,
			): ((url: string) => Response | Promise<Response>) =>
			async (url) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await delay(20);
				inFlight -= 1;
				return route(url);
			};
		routes.abc = track(
			routes.abc ?? (async () => jsonResponse(ABC_SAMPLE_FIXTURE)),
		);
		routes.erApi = track(
			routes.erApi ??
				(async () => jsonResponse(erApiLatestBody({ TWD: "4.5023" }))),
		);
		routes.frankfurter = track(
			routes.frankfurter ??
				(async () =>
					jsonResponse(frankfurterLatestBody("2026-09-15", { MYR: "0.6102" }))),
		);

		const result = await new RateProvider(
			5_000,
			stub as unknown as typeof fetch,
		).fetchLatestBatch("CNY", ["USD", "TWD", "MYR"]);

		// 每源一次外呼，URL 各归其位
		expect(stub).toHaveBeenCalledTimes(3);
		expect(countCalls(stub, ABC_RATE_URL)).toBe(1);
		expect(countCalls(stub, ERAPI_RATE_URL)).toBe(1);
		expect(stub.mock.calls.map(([url]) => String(url))).toEqual(
			expect.arrayContaining([
				ABC_RATE_URL,
				`${ERAPI_RATE_URL}/latest/CNY`,
				"https://api.frankfurter.app/latest?from=CNY&to=MYR",
			]),
		);
		// 顶层 multi，逐项 sources 标注
		expect(result.source).toBe("multi");
		expect(result.sources).toEqual({
			USD: "abc",
			TWD: "er-api",
			MYR: "frankfurter",
		});
		// abc 项：百单位换算 + 双价（方向本就正确）；er-api/frankfurter 项：上游取倒数（MVP-F0-1）
		expect(result.quotes.USD.rate).toBe(ABC_SAMPLE_ROWS.USD.rate);
		expect(result.quotes.USD.sellRate).toBe(ABC_SAMPLE_ROWS.USD.sellRate);
		expect(result.quotes.TWD.rate).toBe("0.2221087000");
		expect(result.quotes.MYR.rate).toBe("1.6388069485");
		// 三组并发外呼（max 在途 = 3）
		expect(maxInFlight).toBe(3);
	});

	it("单组（仅 ABC 币种）直接透传：顶层 source=abc 而非 multi，一次外呼", async () => {
		const stub = createRateSourceFetchStub();

		const result = await new RateProvider(
			5_000,
			stub as unknown as typeof fetch,
		).fetchLatestBatch("CNY", ["USD", "HKD"]);

		expect(stub).toHaveBeenCalledTimes(1);
		expect(result.source).toBe("abc");
		expect(result.sources).toBeUndefined();
		expect(result.quotes.USD.rate).toBe(ABC_SAMPLE_ROWS.USD.rate);
		expect(result.quotes.HKD.rate).toBe(ABC_SAMPLE_ROWS.HKD.rate);
	});

	it("失败源下沉进 batch.failures：abc 失败 USD 进 failures，TWD/MYR 照常返回", async () => {
		const routes: RateSourceRoutes = {
			abc: async () => jsonResponse({ message: "abc down" }, 500),
		};
		const stub = createRateSourceFetchStub(routes);

		const result = await new RateProvider(
			5_000,
			stub as unknown as typeof fetch,
		).fetchLatestBatch("CNY", ["USD", "TWD", "MYR"]);

		expect(result.quotes.TWD.rate).toBe("0.2221087000");
		expect(result.quotes.MYR.rate).toBe("1.6388069485");
		expect(result.sources).toEqual({ TWD: "er-api", MYR: "frankfurter" });
		expect(result.failures?.USD).toBeInstanceOf(BadGatewayException);
		expect(result.quotes.USD).toBeUndefined();
	});

	it("fetchHistory 按币对路由：MYR 走 frankfurter 序列；TWD 走 er-api 返回空数组（本地落库承担）", async () => {
		const routes: RateSourceRoutes = {};
		const stub = createRateSourceFetchStub(routes);
		routes.frankfurter = async () =>
			jsonResponse({
				rates: {
					"2026-09-03": { MYR: "0.6102" },
					"2026-09-01": { MYR: "0.6088" },
				},
			});
		const provider = new RateProvider(5_000, stub as unknown as typeof fetch);

		const myrHistory = await provider.fetchHistory(
			"CNY",
			"MYR",
			"2026-09-01",
			"2026-09-03",
		);
		// 上游 1 CNY = 0.6088/0.6102 MYR → 取倒数后 1 MYR = X CNY（方向统一）
		expect(myrHistory.map((point) => point.rate)).toEqual([
			"1.6425755585",
			"1.6388069485",
		]);
		expect(countCalls(stub, "https://api.frankfurter.app")).toBe(1);

		const twdHistory = await provider.fetchHistory(
			"CNY",
			"TWD",
			"2026-09-01",
			"2026-09-03",
		);
		expect(twdHistory).toEqual([]);
		// er-api 免费档无历史接口：直接返回空数组，无外呼
		expect(countCalls(stub, ERAPI_RATE_URL)).toBe(0);
	});

	it("sourceForPair 路由标识：USD=abc / TWD=er-api / MYR=frankfurter", () => {
		const provider = new RateProvider(
			5_000,
			createRateSourceFetchStub() as unknown as typeof fetch,
		);

		expect(provider.sourceForPair("CNY", "USD")).toBe("abc");
		expect(provider.sourceForPair("CNY", "TWD")).toBe("er-api");
		expect(provider.sourceForPair("CNY", "MYR")).toBe("frankfurter");
	});

	it("降级开关：RATE_SOURCE=frankfurter 整组单源（USD/TWD 都走 frankfurter，ABC/er-api 零外呼）", async () => {
		const routes: RateSourceRoutes = {};
		const stub = createRateSourceFetchStub(routes);
		routes.abc = async () => {
			throw new Error("降级模式不应外呼 ABC");
		};
		routes.erApi = async () => {
			throw new Error("降级模式不应外呼 er-api");
		};
		routes.frankfurter = async () =>
			jsonResponse(frankfurterLatestBody("2026-09-15", { USD: "0.1391" }));

		const previous = process.env.RATE_SOURCE;
		process.env.RATE_SOURCE = "frankfurter";
		let provider: RateProvider;
		try {
			provider = new RateProvider(5_000, stub as unknown as typeof fetch);
		} finally {
			process.env.RATE_SOURCE = previous;
		}

		const result = await provider.fetchLatestBatch("CNY", ["USD", "TWD"]);

		expect(result.source).toBe("frankfurter");
		expect(result.quotes.USD.rate).toBe("7.1890726096");
		// ECB 无 TWD：该目标不在 quotes（由调用方标记 422 语义）
		expect(result.quotes.TWD).toBeUndefined();
		expect(countCalls(stub, ABC_RATE_URL)).toBe(0);
		expect(countCalls(stub, ERAPI_RATE_URL)).toBe(0);
		expect(provider.sourceForPair("CNY", "TWD")).toBe("frankfurter");
	});
});
