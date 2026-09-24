/**
 * 行情页业务组件桶（components/business/market）：
 * - RateChartPanel：折线图面板（三态兜底 + 部分数据标注）
 * - PeriodTabs：7/30/90/365 档位切换
 * - CurrencyMultiSelect：对比币种多选（1~5）
 * - mergeSeries：多序列按 date 对齐合并（纯函数，图表数据加工唯一入口）
 */
export { RateChartPanel } from "./rate-chart-panel";
export { PeriodTabs } from "./period-tabs";
export {
	CurrencyMultiSelect,
	MAX_COMPARE_CURRENCIES,
} from "./currency-multi-select";
export { mergeSeries } from "./merge-series";
export type {
	MergedRateRow,
	RateSeriesInput,
	RateSeriesPoint,
} from "./merge-series";
