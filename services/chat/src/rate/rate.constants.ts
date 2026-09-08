import { CURRENCIES } from "@fxplanner-new/money";

/**
 * 支持币种清单：单一事实来源为 @fxplanner-new/money 的 CURRENCIES（15 币种），
 * 此处仅派生币种代码数组，保持原导出签名不变（数组 + 字面量联合类型 + Set）。
 */
export const SUPPORTED_CURRENCIES = CURRENCIES.map((currency) => currency.code);

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const SUPPORTED_CURRENCY_SET = new Set<string>(SUPPORTED_CURRENCIES);
export const VALID_PERIODS = [7, 30, 90] as const;
export type RatePeriod = (typeof VALID_PERIODS)[number];

export const RATE_SOURCE = "frankfurter";
export const RATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function normalizeCurrency(value: string): string {
	return value.trim().toUpperCase();
}

export function isSupportedCurrency(value: string): value is SupportedCurrency {
	return SUPPORTED_CURRENCY_SET.has(value);
}
