import { BadGatewayException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../../test/helpers/rate-source-fixtures";
import { FRANKFURTER_RATE_URL } from "./rate.constants";
import { RatePairUnsupportedException } from "./rate.errors";
import { FrankfurterSource } from "./rate-source.frankfurter";

const okFetch = (body: unknown, status = 200) =>
	vi.fn(async () => jsonResponse(body, status)) as unknown as typeof fetch;

/**
 * FrankfurterSource 单测：现 rate.provider.ts 逻辑原样迁入后的回归
 * （断言移植自 test/integration/rate-provider.spec.ts 的 M1.2 语义，仅改为构造注入 fetchImpl）。
 */
describe("FrankfurterSource（MYR + 整体降级单源）", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("latest 上游「1 base = raw target」取倒数（raw 保留源字符串）；observedAt 日精度", async () => {
		const fetchImpl = okFetch({
			date: "2026-08-03",
			rates: { USD: "0.7300123456" },
		});
		const batch = await new FrankfurterSource({ fetchImpl }).fetchLatestBatch(
			"CAD",
			["USD"],
		);

		expect(fetchImpl).toHaveBeenCalledWith(
			`${FRANKFURTER_RATE_URL}/latest?from=CAD&to=USD`,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(batch.source).toBe("frankfurter");
		// 1 CAD = 0.7300123456 USD → 1 USD = 1.3698398473 CAD（HALF_UP 10 位）
		expect(batch.quotes.USD.rate).toBe("1.3698398473");
		expect(batch.quotes.USD.raw).toBe("0.7300123456");
		expect(batch.quotes.USD.observedAt.toISOString()).toBe(
			"2026-08-03T00:00:00.000Z",
		);
	});

	it("history 上游取倒数后按日期升序返回，observedAt 日精度", async () => {
		const fetchImpl = okFetch({
			rates: {
				"2026-08-03": { CNY: "7.2500" },
				"2026-08-01": { CNY: "7.2000" },
			},
		});
		const points = await new FrankfurterSource({ fetchImpl }).fetchHistory(
			"USD",
			"CNY",
			"2026-08-01",
			"2026-08-03",
		);

		// 1 USD = 7.20/7.25 CNY → 1 CNY = 0.1388888889 / 0.1379310345 USD
		expect(points.map((point) => point.rate)).toEqual([
			"0.1388888889",
			"0.1379310345",
		]);
		expect(points[0].observedAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
	});

	it("date 缺失 / 非法日期 / 不存在的日历日期 → 502（不得回落系统时间或静默归一化，FX-01）", async () => {
		const missing = okFetch({ rates: { USD: "0.7300123456" } });
		await expect(
			new FrankfurterSource({ fetchImpl: missing }).fetchLatestBatch("CAD", [
				"USD",
			]),
		).rejects.toThrow("缺少报价日期");
		for (const badDate of ["not-a-date", "2026-02-29", "2026-13-01"]) {
			const invalid = okFetch({
				date: badDate,
				rates: { USD: "0.7300123456" },
			});
			await expect(
				new FrankfurterSource({ fetchImpl: invalid }).fetchLatestBatch("CAD", [
					"USD",
				]),
			).rejects.toThrow("无效日期");
		}
		// 非字符串 date（null / 数字 / 对象）→ 502 缺少报价日期（不裸抛 TypeError）
		for (const nonString of [null, 17_350_000_000, { raw: "2026-08-03" }]) {
			const invalid = okFetch({
				date: nonString,
				rates: { USD: "0.7300123456" },
			});
			await expect(
				new FrankfurterSource({ fetchImpl: invalid }).fetchLatestBatch("CAD", [
					"USD",
				]),
			).rejects.toThrow("缺少报价日期");
		}
	});

	it("404 → RatePairUnsupportedException（币对不支持，单目标与批量同语义）", async () => {
		const fetchImpl = okFetch({ message: "not found" }, 404);
		const source = new FrankfurterSource({ fetchImpl });

		await expect(source.fetchLatestBatch("USD", ["TWD"])).rejects.toThrowError(
			RatePairUnsupportedException,
		);
		await expect(
			source.fetchLatestBatch("USD", ["CNY", "TWD"]),
		).rejects.toThrowError(RatePairUnsupportedException);
	});

	it("批量一次外呼：URL 携带全部目标且共享同一 observedAt", async () => {
		const fetchImpl = okFetch({
			date: "2026-08-03",
			rates: { CNY: "0.1391", JPY: "0.0067" },
		});
		const batch = await new FrankfurterSource({ fetchImpl }).fetchLatestBatch(
			"USD",
			["CNY", "JPY"],
		);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledWith(
			`${FRANKFURTER_RATE_URL}/latest?from=USD&to=CNY%2CJPY`,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		// 1 USD = 0.1391 CNY / 0.0067 JPY → 取倒数后 1 CNY = 7.1890726096 USD、1 JPY = 149.2537313433 USD
		expect(batch.quotes.CNY.rate).toBe("7.1890726096");
		expect(batch.quotes.JPY.rate).toBe("149.2537313433");
		expect(batch.quotes.CNY.observedAt).toEqual(batch.quotes.JPY.observedAt);
		expect(batch.quotes.CNY.observedAt.toISOString()).toBe(
			"2026-08-03T00:00:00.000Z",
		);
	});

	it("批量响应缺某目标：该目标不在 quotes，其余照常", async () => {
		const fetchImpl = okFetch({
			date: "2026-08-03",
			rates: { CNY: "0.1391" }, // 无 TWD：ECB 不提供新台币
		});
		const batch = await new FrankfurterSource({ fetchImpl }).fetchLatestBatch(
			"USD",
			["CNY", "TWD"],
		);

		expect(batch.quotes.CNY.rate).toBe("7.1890726096");
		expect(batch.quotes.TWD).toBeUndefined();
	});

	it("非 2xx → BadGatewayException（502 语义）", async () => {
		const fetchImpl = okFetch({ message: "upstream broken" }, 503);

		await expect(
			new FrankfurterSource({ fetchImpl }).fetchLatestBatch("EUR", ["USD"]),
		).rejects.toThrowError(BadGatewayException);
	});

	it("超时 → BadGatewayException（abort 信号触发）", async () => {
		const fetchImpl = vi.fn(
			(_url: string, options: RequestInit) =>
				new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () =>
						reject(new Error("aborted")),
					);
				}),
		) as unknown as typeof fetch;

		await expect(
			new FrankfurterSource({ timeoutMs: 5, fetchImpl }).fetchLatestBatch(
				"EUR",
				["USD"],
			),
		).rejects.toThrowError(BadGatewayException);
	});
});
