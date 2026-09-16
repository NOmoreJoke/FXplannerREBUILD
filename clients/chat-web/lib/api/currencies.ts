/**
 * 前端币种清单：15 个支持币种（与后端 packages/money/src/currencies.ts 的
 * CURRENCIES 一致，顺序 = sortOrder）。
 *
 * 前端不依赖 money 包，此处独立维护；仅含展示所需字段（code + 中文名），
 * 精度/舍入规则一律以服务端为准，前端不做金额计算。
 */
export interface CurrencyOption {
	/** ISO 4217 币种代码（3 位大写） */
	code: string;
	/** 币种中文名 */
	nameZh: string;
}

export const CURRENCY_OPTIONS: readonly CurrencyOption[] = [
	{ code: "HKD", nameZh: "港币" },
	{ code: "USD", nameZh: "美元" },
	{ code: "GBP", nameZh: "英镑" },
	{ code: "AUD", nameZh: "澳元" },
	{ code: "CAD", nameZh: "加元" },
	{ code: "CNY", nameZh: "人民币" },
	{ code: "JPY", nameZh: "日元" },
	{ code: "EUR", nameZh: "欧元" },
	{ code: "SGD", nameZh: "新加坡元" },
	{ code: "NZD", nameZh: "新西兰元" },
	{ code: "TWD", nameZh: "新台币" },
	{ code: "CHF", nameZh: "瑞士法郎" },
	{ code: "KRW", nameZh: "韩元" },
	{ code: "THB", nameZh: "泰铢" },
	{ code: "MYR", nameZh: "马来西亚林吉特" },
] as const;

/** 按 code 查询币种中文名；未知代码返回 undefined */
export function getCurrencyName(code: string): string | undefined {
	return CURRENCY_OPTIONS.find((currency) => currency.code === code)?.nameZh;
}
