import { CURRENCIES } from "@fxplanner-new/money";

/**
 * 支持币种清单：单一事实来源为 @fxplanner-new/money 的 CURRENCIES（15 币种），
 * 此处仅派生币种代码数组，保持原导出签名不变（数组 + 字面量联合类型 + Set）。
 */
export const SUPPORTED_CURRENCIES = CURRENCIES.map((currency) => currency.code);

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const SUPPORTED_CURRENCY_SET = new Set<string>(SUPPORTED_CURRENCIES);
export const VALID_PERIODS = [7, 30, 90, 365] as const;
export type RatePeriod = (typeof VALID_PERIODS)[number];

// ── 数据源（方案 realtime-rate §3.1：农行牌价主源 + frankfurter 补 MYR + er-api 补 TWD）──

/** ABC 农行牌价覆盖的 12 币种（15 币种清单中的 TWD 由 er-api、MYR 由 frankfurter 补齐） */
export const ABC_CURRENCIES = [
	"HKD",
	"USD",
	"GBP",
	"AUD",
	"CAD",
	"JPY",
	"EUR",
	"SGD",
	"NZD",
	"CHF",
	"THB",
	"KRW",
] as const;

/** ABC 农行牌价接口（一次全表、无认证；实测需 legacy TLS 重协商 + 桌面 UA，隔离在 ABCSource 内部） */
export const ABC_RATE_URL =
	"https://ewealth.abchina.com/app/data/api/DataService/ExchangeRateV2";

/** ABC 超时：6s（沿用旧项目取值，方案 §6） */
export const ABC_RATE_TIMEOUT_MS = 6_000;

/** ABC 防滥用：全局并发 1 + 最小外呼间隔 10s（方案 §3.4，进程内时间戳 + 复用） */
export const ABC_MIN_FETCH_INTERVAL_MS = 10_000;

/** er-api（ExchangeRate-API 免费档，日更）接口根路径 */
export const ERAPI_RATE_URL = "https://open.er-api.com/v6";

/** frankfurter（ECB 日更）接口根路径 */
export const FRANKFURTER_RATE_URL = "https://api.frankfurter.app";

/** 时钟漂移容差：报价发布时间晚于「当前时间 + 容差」视为未来报价（恰好容差值放行），按源不可用处理 */
export const RATE_CLOCK_SKEW_TOLERANCE_MS = 60_000;

/** 多源合并响应的顶层来源标识（逐项来源见 RateBatchQuote.sources，顶层值不参与落库） */
export const MULTI_RATE_SOURCE = "multi";

/** 降级开关取值：RATE_SOURCE=frankfurter 时整组走 frankfurter 单源（= M1.2 行为，原样保留） */
export const RATE_SOURCE_FALLBACK = "frankfurter";

export type RateSourceMode = "multi" | typeof RATE_SOURCE_FALLBACK;

/**
 * 解析数据源模式：缺省/其他值 → 多源路由；RATE_SOURCE=frankfurter → 整组单源降级。
 * 在 RateProvider 构造时求值（非模块加载期），便于测试按实例注入 env。
 */
export function resolveRateSourceMode(
	source: string | undefined = process.env.RATE_SOURCE,
): RateSourceMode {
	return source === RATE_SOURCE_FALLBACK ? RATE_SOURCE_FALLBACK : "multi";
}

/**
 * 报价有效期：5 分钟（doc 02/05）。
 *
 * 窗口基准 =「最后一次向数据源确认这份报价的时间」。方案 §2 原定物化为
 * ExchangeRate.updatedAt，但 schema 冻结且该列实际不存在，等价落点为 createdAt：
 * upsert 的 update 分支在回源成功时显式刷新 createdAt = now（窗口重置），
 * 缓存命中绝不触碰（不重置）——防「刷新洗白」三条规则不变。
 * 判断用严格小于：恰好满 5 分钟视为过期。
 */
export const QUOTE_TTL_MS = 5 * 60 * 1000;

/**
 * 原时点取价的来源粒度分组（MVP-F0-2，realtime-rate 底稿 §2）。
 *
 * - 实时源（abc，秒级 PublishTime）：沿用确认时点前 5 分钟窗口；
 * - 日级源（er-api，time_last_update_unix 为真实供应商发布时间）：
 *   UTC+8 同日优先 + 有限回看；
 * - frankfurter 的 date 仅解析为 UTC 零点（日期表示），无法证明原时点可用，
 *   不参与原时点入账（保留 RATE_QUOTE_UNAVAILABLE；日价冷历史入账需另行
 *   确认适用条件后按底稿 §2 增加独立验收）。
 */
export const REALTIME_QUOTE_SOURCES = ["abc"] as const;
export const DAILY_QUOTE_SOURCES = ["er-api"] as const;

/**
 * 日级报价原时点回看上限：最多 7 个 UTC+8 自然日（工作假设，底稿 §2）。
 * 覆盖节假日/供应商停更场景；最终边界由回看上限两侧测试锁定。
 */
export const DAILY_QUOTE_LOOKBACK_DAYS = 7;

/** 恒等报价（base = target）的来源标识：数学事实而非数据源报价，不外呼 */
export const IDENTITY_RATE_SOURCE = "identity";

export function normalizeCurrency(value: string): string {
	return value.trim().toUpperCase();
}

export function isSupportedCurrency(value: string): value is SupportedCurrency {
	return SUPPORTED_CURRENCY_SET.has(value);
}
