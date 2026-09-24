/**
 * 多币种汇率序列合并（纯函数，行情页图表数据加工唯一入口）。
 *
 * 技术方案 changes/rate-chart/技术方案.md §3.3：以各序列日期的并集为时间轴，
 * 把每个币种的日级序列对齐为 recharts 多列行数据；某币种在某日无数据时该格
 * 取 null（折线断点），严禁把缺口补成 0（汇率 0 是语义错误）。
 * 展示值把 rate 字符串转 number，不做二次舍入（展示不参与计算，不进 money 包）。
 */

/** history 单点（GET /rates/history 的 data_points 项；rate 为数据源原始精度字符串） */
export interface RateSeriesPoint {
	/** 观测日（YYYY-MM-DD） */
	date: string;
	/** 汇率（数据源原始精度字符串） */
	rate: string;
}

/** 待合并的单币种序列 */
export interface RateSeriesInput {
	/** ISO 4217 币种代码（同时是 recharts 行数据的列名 / dataKey） */
	currency: string;
	points: RateSeriesPoint[];
}

/** 合并后的一行：date + 各币种当日汇率（number，缺口为 null） */
export interface MergedRateRow {
	date: string;
	[currencyCode: string]: string | number | null;
}

/**
 * 合并多币种序列：
 * - 日期取并集并升序排列（ISO 日期字典序即时间序）；
 * - 同币种重复日期取最后一项（后到覆盖）；
 * - 缺口为 null（断点），非法 rate（NaN）按缺口处理；
 * - 空输入返回空数组；单序列自然退化。
 */
export function mergeSeries(series: RateSeriesInput[]): MergedRateRow[] {
	const dateSet = new Set<string>();
	const ratesByCurrency = new Map<string, Map<string, number>>();

	for (const { currency, points } of series) {
		const rates = new Map<string, number>();
		for (const point of points) {
			dateSet.add(point.date);
			const value = Number(point.rate);
			// 非法数值按缺口处理（同 set 覆盖语义：后到的合法值可修复前面的 NaN）
			rates.set(point.date, Number.isFinite(value) ? value : Number.NaN);
		}
		ratesByCurrency.set(currency, rates);
	}

	const dates = [...dateSet].sort();

	return dates.map((date) => {
		const row: MergedRateRow = { date };
		for (const [currency, rates] of ratesByCurrency) {
			const value = rates.get(date);
			row[currency] =
				value !== undefined && Number.isFinite(value) ? value : null;
		}
		return row;
	});
}
