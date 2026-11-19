import { BadGatewayException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RatePairUnsupportedException } from "../../src/rate/rate.errors";
import { RateProvider } from "../../src/rate/rate.provider";

// 本文件验证 frankfurter 行为（= M1.2 语义回归）：门面构造时读取 env，
// 切到降级单源模式避免多源路由将 CAD/USD 等币对指向农行真实接口；断言不变。
process.env.RATE_SOURCE = "frankfurter";

function response(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: vi.fn().mockResolvedValue(body),
	} as unknown as Response;
}

describe("RateProvider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("调用 Frankfurter 最新接口：上游「1 base = raw target」取倒数为「1 target = X base」", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				response({ date: "2026-08-03", rates: { USD: "0.7300123456" } }),
			);
		vi.stubGlobal("fetch", fetchMock);

		const result = await new RateProvider().fetchLatest("CAD", "USD");

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.frankfurter.app/latest?from=CAD&to=USD",
			expect.objectContaining({
				signal: expect.any(AbortSignal),
			}),
		);
		expect(result).toEqual({
			base: "CAD",
			quote: "USD",
			rate: "1.3698398473",
			source: "frankfurter",
			observedAt: new Date("2026-08-03T00:00:00.000Z"),
		});
	});

	it("获取历史数据：取倒数后按日期升序返回", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					rates: {
						"2026-08-03": { CNY: "7.2500" },
						"2026-08-01": { CNY: "7.2000" },
					},
				}),
			),
		);

		const result = await new RateProvider().fetchHistory(
			"USD",
			"CNY",
			"2026-08-01",
			"2026-08-03",
		);

		expect(result.map((point) => point.rate)).toEqual([
			"0.1388888889",
			"0.1379310345",
		]);
		expect(result[0].observedAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
	});

	it("数据源 404 → RatePairUnsupportedException（422 语义）", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(response({ message: "not found" }, 404)),
		);

		await expect(
			new RateProvider().fetchLatest("USD", "TWD"),
		).rejects.toBeInstanceOf(RatePairUnsupportedException);
		await expect(
			new RateProvider().fetchLatestBatch("USD", ["CNY", "TWD"]),
		).rejects.toBeInstanceOf(RatePairUnsupportedException);
	});

	it("批量请求一次外呼、URL 携带全部目标且共享同一报价时点", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			response({
				date: "2026-08-03",
				rates: { CNY: "0.1391", JPY: "0.0067" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await new RateProvider().fetchLatestBatch("USD", [
			"CNY",
			"JPY",
		]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.frankfurter.app/latest?from=USD&to=CNY%2CJPY",
			expect.objectContaining({
				signal: expect.any(AbortSignal),
			}),
		);
		// 整组共享同一报价时点（逐项访问路径对应新 RateBatchQuote 契约，预期值不变）
		expect(result.quotes.CNY.observedAt).toEqual(
			new Date("2026-08-03T00:00:00.000Z"),
		);
		expect(result.quotes.JPY.observedAt).toEqual(
			new Date("2026-08-03T00:00:00.000Z"),
		);
		// 上游 1 USD = 0.1391 CNY / 0.0067 JPY → 取倒数后方向统一
		expect(result.quotes.CNY.rate).toBe("7.1890726096");
		expect(result.quotes.JPY.rate).toBe("149.2537313433");
	});

	it("批量响应缺失某目标币种时：该目标不在 rates 映射，其余照常返回", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					date: "2026-08-03",
					rates: { CNY: "0.1391" }, // 无 TWD：ECB 不提供新台币
				}),
			),
		);

		const result = await new RateProvider().fetchLatestBatch("USD", [
			"CNY",
			"TWD",
		]);

		expect(result.quotes.CNY.rate).toBe("7.1890726096");
		expect(result.quotes.TWD).toBeUndefined();
	});

	it("供应商非 2xx 响应统一转为 BadGatewayException（单目标与批量同语义）", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 503)));

		await expect(
			new RateProvider().fetchLatest("EUR", "USD"),
		).rejects.toBeInstanceOf(BadGatewayException);
		await expect(
			new RateProvider().fetchLatestBatch("EUR", ["USD", "CNY"]),
		).rejects.toBeInstanceOf(BadGatewayException);
	});

	it("超时统一转为 BadGatewayException", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, options: RequestInit) =>
					new Promise((_, reject) => {
						options.signal?.addEventListener("abort", () =>
							reject(new Error("aborted")),
						);
					}),
			),
		);

		await expect(
			new RateProvider(5).fetchLatest("EUR", "USD"),
		).rejects.toBeInstanceOf(BadGatewayException);
	});
});
