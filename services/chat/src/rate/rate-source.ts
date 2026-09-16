/**
 * 数据源策略接口与统一报价类型（realtime-rate 方案 §3.1）。
 *
 * 三个实现（abc / er-api / frankfurter）面向本接口编程，由 RateProvider 门面
 * 按 target 静态路由分组并发外呼后合并；对 RateService 完全透明。
 */

/** 单币对报价：RateBatchQuote 的逐项条目（原始值 + 解析后元数据） */
export interface RatePairQuote {
	/** 基准价字符串原值（1 单位 target 兑 X base；上游百外币单位已换算为 1 外币单位） */
	rate: string;
	/** 现汇卖出价（仅 abc 源填充；缺省 = 该源无卖出价，录入场景回退 rate） */
	sellRate?: string;
	/** 报价发布时间（abc=秒级 PublishTime；er-api/frankfurter=日精度零点，一律 UTC） */
	observedAt: Date;
	/** 数据源返回的原始报价字符串（审计用；abc 为换算前的百外币单位原值） */
	raw: string;
}

/** 一次批量外呼的整组报价 */
export interface RateBatchQuote {
	/** 数据源标识；整批同源时为该源，多源合并时为 "multi"（逐项来源见 sources） */
	source: string;
	/** 逐项数据源标识（多源合并时逐项标注；整批同源时缺省，调用方用顶层 source） */
	sources?: Record<string, string>;
	/**
	 * target -> 成功报价；
	 * 未提供且不在 failures 中的目标 = 数据源正常但无该币种（币对不支持，422 语义）
	 */
	quotes: Record<string, RatePairQuote>;
	/** target -> 源级失败错误（502 语义；仅多源部分失败时出现，单源失败直接抛出） */
	failures?: Record<string, unknown>;
}

/** 历史序列单点 */
export interface RateHistoryPoint {
	rate: string;
	observedAt: Date;
}

/** 单币对最新报价（fetchLatest 的返回；门面从批量结果中取单项目标） */
export interface RateQuote {
	base: string;
	quote: string;
	rate: string;
	/** 现汇卖出价（仅 abc 源返回） */
	sellRate?: string;
	source: string;
	observedAt: Date;
}

/** 数据源策略接口：由 RateProvider 门面按币对路由，对 RateService 透明 */
export interface RateSource {
	/** 数据源标识（"abc" | "er-api" | "frankfurter"） */
	readonly source: string;
	/** 批量最新报价：整组目标尽量共享同一报价时点（同一次外呼） */
	fetchLatestBatch(
		base: string,
		targets: string[],
	): Promise<RateBatchQuote>;
	/** 按日历史序列（start/end 为 YYYY-MM-DD；数据源无历史能力时返回空数组，由本地落库承担） */
	fetchHistory(
		base: string,
		target: string,
		start: string,
		end: string,
	): Promise<RateHistoryPoint[]>;
}
