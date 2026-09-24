import { vi } from "vitest";
import {
	ABC_RATE_URL,
	ERAPI_RATE_URL,
	FRANKFURTER_RATE_URL,
} from "../../src/rate/rate.constants";

/**
 * 三数据源测试夹具与 fetch stub（realtime-rate 方案 §8.2 装配说明）：
 * 门面把注入的 fetchImpl 适配为 ABC 传输并透传给 er-api/frankfurter，
 * 测试按 URL 路由返回实测归档样本，不发真实网络请求。
 * 多个 spec（abc 单测 / api 契约 / integration 路由）共享本文件，禁止复制。
 */

/** ABC 农行牌价实测归档样本（方案 §6 实测记录，唯一真实样本；价格为百外币单位对 CNY） */
export const ABC_SAMPLE_FIXTURE = {
	ErrorCode: "0",
	ErrorMsg: "",
	Data: {
		Table: [
			{
				BenchMarkPrice: "671.05500000",
				BuyingPrice: "669.71300000",
				CurrName: "美元(USD)",
				CurrId: "14",
				SellPrice: "672.53100000",
				PublishTime: "2026-09-15T10:26:54+08:00",
				Id: "1",
				CashBuyingPrice: "669.71300000",
			},
			{
				BenchMarkPrice: "85.53400000",
				BuyingPrice: "85.36300000",
				CurrName: "港元(HKD)",
				CurrId: "13",
				SellPrice: "85.70500000",
				PublishTime: "2026-09-15T10:26:54+08:00",
				Id: "2",
				CashBuyingPrice: "85.36300000",
			},
			{
				BenchMarkPrice: "4.33600000",
				BuyingPrice: "4.32100000",
				CurrName: "日元(JPY)",
				CurrId: "27",
				SellPrice: "4.35100000",
				PublishTime: "2026-09-15T10:26:54+08:00",
				Id: "3",
				CashBuyingPrice: "4.32100000",
			},
		],
	},
} as const;

/** 实测样本 PublishTime 的 UTC 时刻（2026-09-15T10:26:54+08:00 → 02:26:54.000Z） */
export const ABC_PUBLISH_TIME = new Date("2026-09-15T02:26:54.000Z");

/** 实测样本解析后的期望值（百外币单位 ÷ 100 的定点运算产物，10 位定点字符串） */
export const ABC_SAMPLE_ROWS = {
	USD: { rate: "6.7105500000", sellRate: "6.7253100000" },
	HKD: { rate: "0.8553400000", sellRate: "0.8570500000" },
	JPY: { rate: "0.0433600000", sellRate: "0.0435100000" },
} as const;

/** er-api 样本更新时间（日更语义：UTC 日零点 2026-09-15T00:00:00Z 对应的 Unix 秒） */
export const ERAPI_SAMPLE_UNIX = Math.floor(
	new Date("2026-09-15T00:00:00.000Z").getTime() / 1000,
);

/** er-api latest 响应体（免费档：result=success + time_last_update_unix + rates） */
export function erApiLatestBody(
	rates: Record<string, string>,
	timeLastUpdateUnix: number = ERAPI_SAMPLE_UNIX,
) {
	return {
		result: "success",
		time_last_update_unix: timeLastUpdateUnix,
		rates,
	};
}

/** frankfurter latest 响应体（date 日精度） */
export function frankfurterLatestBody(
	date: string,
	rates: Record<string, string>,
) {
	return { date, rates };
}

/** frankfurter time-series 响应体（/{start}..{end}?from=&to= 应答：rates 按日期 → 币种价） */
export function frankfurterTimeSeriesBody(
	rates: Record<string, Record<string, string | number>>,
) {
	return { rates };
}

/** 解析 frankfurter time-series URL 的 [start, end] 区间；latest 等 URL 返回 null */
export function parseFrankfurterTimeSeriesRange(
	href: string,
): { start: string; end: string } | null {
	const match = href.match(
		/\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})(?:\?|$)/,
	);
	return match ? { start: match[1], end: match[2] } : null;
}

/**
 * 生成 [start, end] 工作日全序列的 time-series rates（ECB 语义：周末无报价）。
 * skipTailBusinessDays > 0 时去掉尾部 N 个工作日（构造「缺尾部」部分序列，负缓存用例）。
 */
export function frankfurterBusinessDaySeries(
	start: string,
	end: string,
	target: string,
	rate: string | number,
	skipTailBusinessDays = 0,
): Record<string, Record<string, string | number>> {
	const days: string[] = [];
	const cursor = new Date(`${start}T00:00:00.000Z`);
	const last = new Date(`${end}T00:00:00.000Z`);
	while (cursor <= last) {
		const weekday = cursor.getUTCDay();
		if (weekday !== 0 && weekday !== 6) {
			days.push(cursor.toISOString().slice(0, 10));
		}
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	const rates: Record<string, Record<string, string | number>> = {};
	for (const date of days.slice(0, days.length - skipTailBusinessDays)) {
		rates[date] = { [target]: rate };
	}
	return rates;
}

/**
 * frankfurter 路由工厂：latest URL 按 latestBody 应答；time-series URL（/{start}..{end}）
 * 按 [start, end] 工作日序列（恒定汇率，可选缺尾部）应答。historyDelayMs 用于单飞用例
 * 放慢回源应答，保证并发请求都在首次回源 resolve 前进入单飞判定（否则 stub 过快
 * 会在后续请求到达前清除 in-flight，导致重复外呼）。
 */
export function frankfurterRouteWithHistory(options: {
	latestBody: ReturnType<typeof frankfurterLatestBody>;
	target: string;
	rate: string | number;
	skipTailBusinessDays?: number;
	historyDelayMs?: number;
}): (href: string) => Promise<Response> {
	return async (href) => {
		const range = parseFrankfurterTimeSeriesRange(href);
		if (range) {
			if (options.historyDelayMs) {
				await new Promise((resolve) =>
					setTimeout(resolve, options.historyDelayMs),
				);
			}
			return jsonResponse(
				frankfurterTimeSeriesBody(
					frankfurterBusinessDaySeries(
						range.start,
						range.end,
						options.target,
						options.rate,
						options.skipTailBusinessDays ?? 0,
					),
				),
			);
		}
		return jsonResponse(options.latestBody);
	};
}

/** JSON Response 构造（fetch stub 用） */
export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** 数据源路由覆写：某源置为函数即接管该源（可热切换，用于失败场景）；缺省按实测样本应答 */
export interface RateSourceRoutes {
	abc?: (url: string) => Response | Promise<Response>;
	erApi?: (url: string) => Response | Promise<Response>;
	frankfurter?: (url: string) => Response | Promise<Response>;
}

/**
 * 按数据源 URL 路由的 fetch stub。返回 vi.fn 便于断言外呼次数与 URL；
 * 传入的 routes 对象按引用读取，可在用例内热切换各源行为。
 */
export function createRateSourceFetchStub(
	routes: RateSourceRoutes = {},
): ReturnType<typeof vi.fn> {
	return vi.fn(async (url: string | URL | Request): Promise<Response> => {
		const href = String(url);
		if (href.startsWith(ABC_RATE_URL)) {
			return routes.abc ? routes.abc(href) : jsonResponse(ABC_SAMPLE_FIXTURE);
		}
		if (href.startsWith(ERAPI_RATE_URL)) {
			return routes.erApi
				? routes.erApi(href)
				: jsonResponse(erApiLatestBody({ TWD: "4.5023" }));
		}
		if (href.startsWith(FRANKFURTER_RATE_URL)) {
			return routes.frankfurter
				? routes.frankfurter(href)
				: jsonResponse(frankfurterLatestBody("2026-09-15", { MYR: "0.6102" }));
		}
		throw new Error(`rate-source-fetch-stub 捕获未预期的外呼: ${href}`);
	});
}
