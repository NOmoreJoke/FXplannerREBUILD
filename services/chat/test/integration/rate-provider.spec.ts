import { BadGatewayException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RateProvider } from "../../src/rate/rate.provider";

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

	it("调用 Frankfurter 最新接口并保留报价字符串", async () => {
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
			rate: "0.7300123456",
			source: "frankfurter",
			observedAt: new Date("2026-08-03T00:00:00.000Z"),
		});
	});

	it("获取历史数据后按日期升序返回", async () => {
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

		expect(result.map((point) => point.rate)).toEqual(["7.2000", "7.2500"]);
		expect(result[0].observedAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
	});

	it("供应商非 2xx 响应统一转为 BadGatewayException", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 503)));

		await expect(
			new RateProvider().fetchLatest("EUR", "USD"),
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
