/**
 * 币种清单：全系统唯一定义（单一事实来源）。
 *
 * - 顺序即 sortOrder（1-15），接口下发与 Currency 表 seed 均以此为准；
 * - decimalPlaces 仅允许 0（JPY/KRW，整数）或 2（其余币种）；
 * - 本包为零 IO 纯函数库，此处只放常量与派生索引，禁止引入任何运行时环境依赖。
 */

/** 单个币种的元信息 */
export interface CurrencyInfo {
	/** ISO 4217 币种代码（3 位大写） */
	code: string;
	/** 币种中文名 */
	nameZh: string;
	/** 币种英文名 */
	nameEn: string;
	/** 金额小数位：0 表示整数币种，2 表示两位小数 */
	decimalPlaces: 0 | 2;
	/** 展示顺序（1 起，严格递增） */
	sortOrder: number;
}

/** 15 个支持币种（readonly，顺序即 sortOrder） */
export const CURRENCIES = [
	{
		code: "HKD",
		nameZh: "港币",
		nameEn: "Hong Kong Dollar",
		decimalPlaces: 2,
		sortOrder: 1,
	},
	{
		code: "USD",
		nameZh: "美元",
		nameEn: "US Dollar",
		decimalPlaces: 2,
		sortOrder: 2,
	},
	{
		code: "GBP",
		nameZh: "英镑",
		nameEn: "British Pound",
		decimalPlaces: 2,
		sortOrder: 3,
	},
	{
		code: "AUD",
		nameZh: "澳元",
		nameEn: "Australian Dollar",
		decimalPlaces: 2,
		sortOrder: 4,
	},
	{
		code: "CAD",
		nameZh: "加元",
		nameEn: "Canadian Dollar",
		decimalPlaces: 2,
		sortOrder: 5,
	},
	{
		code: "CNY",
		nameZh: "人民币",
		nameEn: "Chinese Yuan",
		decimalPlaces: 2,
		sortOrder: 6,
	},
	{
		code: "JPY",
		nameZh: "日元",
		nameEn: "Japanese Yen",
		decimalPlaces: 0,
		sortOrder: 7,
	},
	{
		code: "EUR",
		nameZh: "欧元",
		nameEn: "Euro",
		decimalPlaces: 2,
		sortOrder: 8,
	},
	{
		code: "SGD",
		nameZh: "新加坡元",
		nameEn: "Singapore Dollar",
		decimalPlaces: 2,
		sortOrder: 9,
	},
	{
		code: "NZD",
		nameZh: "新西兰元",
		nameEn: "New Zealand Dollar",
		decimalPlaces: 2,
		sortOrder: 10,
	},
	{
		code: "TWD",
		nameZh: "新台币",
		nameEn: "New Taiwan Dollar",
		decimalPlaces: 2,
		sortOrder: 11,
	},
	{
		code: "CHF",
		nameZh: "瑞士法郎",
		nameEn: "Swiss Franc",
		decimalPlaces: 2,
		sortOrder: 12,
	},
	{
		code: "KRW",
		nameZh: "韩元",
		nameEn: "South Korean Won",
		decimalPlaces: 0,
		sortOrder: 13,
	},
	{
		code: "THB",
		nameZh: "泰铢",
		nameEn: "Thai Baht",
		decimalPlaces: 2,
		sortOrder: 14,
	},
	{
		code: "MYR",
		nameZh: "马来西亚林吉特",
		nameEn: "Malaysian Ringgit",
		decimalPlaces: 2,
		sortOrder: 15,
	},
] as const satisfies readonly CurrencyInfo[];

/** 全部币种代码的字面量联合类型 */
export type CurrencyCode = (typeof CURRENCIES)[number]["code"];

/**
 * 按 code 索引的只读映射（O(1) 查币种元信息）。
 * 完整性由 round.spec/calc.spec 的「15 个 code 全部可查」断言兜底
 * （Object.fromEntries 无法向编译器证明键完整，此处做窄化断言）。
 */
export const CURRENCY_BY_CODE: Readonly<Record<CurrencyCode, CurrencyInfo>> =
	Object.fromEntries(
		CURRENCIES.map((currency) => [currency.code, currency]),
	) as Readonly<Record<CurrencyCode, CurrencyInfo>>;

/** 按代码查询币种元信息；未知代码返回 undefined */
export function getCurrency(code: string): CurrencyInfo | undefined {
	return CURRENCY_BY_CODE[code.trim().toUpperCase() as CurrencyCode];
}
