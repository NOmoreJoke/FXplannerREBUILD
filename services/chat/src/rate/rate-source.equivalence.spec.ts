/**
 * 三源同币对方向等价测试（MVP-F0-1 / FX-01「ABC 直接价与跨源取倒数统一口径」）。
 *
 * 同一市场事实「1 USD = 8 CNY」按各源原生格式投喂：
 * - ABC：BenchMarkPrice 百外币单位 800.00 → 原生方向即「1 quote = X base」，定点 ÷100；
 * - ErApi：rates.USD = 0.125（1 base = raw target）→ invertQuoteRate 取倒数；
 * - Frankfurter：from=CNY rates.USD = 0.125 → invertQuoteRate 取倒数。
 * 三源必须产出完全一致的「1 USD = 8.0000000000 CNY」——漏倒数（0.125）、
 * 二次取倒数（0.015625）或方向翻转（0.125）在此断言下全部暴露。
 */
import { describe, expect, it } from "vitest";
import {
	erApiLatestBody,
	frankfurterLatestBody,
	jsonResponse,
} from "../../test/helpers/rate-source-fixtures";
import { AbcSource } from "./rate-source.abc";
import { ErApiSource } from "./rate-source.erapi";
import { FrankfurterSource } from "./rate-source.frankfurter";

const okFetch = (body: unknown, status = 200) =>
	(async () => jsonResponse(body, status)) as unknown as typeof fetch;

/** 同一市场事实在各源原生格式下的夹具 */
const ABC_FIXTURE = {
	ErrorCode: "0",
	ErrorMsg: "",
	Data: {
		Table: [
			{
				CurrName: "美元(USD)",
				CurrId: "14",
				BenchMarkPrice: "800.00000000",
				SellPrice: "801.00000000",
				PublishTime: "2026-09-15T10:26:54+08:00",
			},
		],
	},
};
const ERAPI_RAW = "0.125"; // 1 CNY = 0.125 USD
const FRANKFURTER_RAW = "0.125"; // 1 CNY = 0.125 USD
const EXPECTED_RATE = "8.0000000000"; // 1 USD = 8 CNY（定点 10 位）

describe("三源同币对方向等价（MVP-F0-1 统一口径）", () => {
	it("同一市场事实（1 USD = 8 CNY）：ABC 直接价 / ErApi·Frankfurter 取倒数，三源同向同值", async () => {
		const abc = new AbcSource({
			transport: async () => JSON.stringify(ABC_FIXTURE),
		});
		const erApi = new ErApiSource({
			fetchImpl: okFetch(erApiLatestBody({ USD: ERAPI_RAW })),
		});
		const frankfurter = new FrankfurterSource({
			fetchImpl: okFetch(
				frankfurterLatestBody("2026-09-15", { USD: FRANKFURTER_RAW }),
			),
		});

		const [abcBatch, erApiBatch, frankfurterBatch] = await Promise.all([
			abc.fetchLatestBatch("CNY", ["USD"]),
			erApi.fetchLatestBatch("CNY", ["USD"]),
			frankfurter.fetchLatestBatch("CNY", ["USD"]),
		]);

		expect(abcBatch.quotes.USD.rate).toBe(EXPECTED_RATE);
		expect(erApiBatch.quotes.USD.rate).toBe(EXPECTED_RATE);
		expect(frankfurterBatch.quotes.USD.rate).toBe(EXPECTED_RATE);
		// raw 字段保留各源上游原值（审计口径不变）
		expect(erApiBatch.quotes.USD.raw).toBe(ERAPI_RAW);
		expect(frankfurterBatch.quotes.USD.raw).toBe(FRANKFURTER_RAW);
	});
});
