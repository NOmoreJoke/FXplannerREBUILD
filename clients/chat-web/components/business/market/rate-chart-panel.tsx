"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Loader2, RotateCcw, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartTooltip,
	type ChartConfig,
} from "@/components/ui/chart";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { getCurrencyName } from "@/lib/api/currencies";
import type {
	MarketPeriod,
	UseRateHistoryResult,
} from "@/lib/hooks/use-rate-history";
import type { MergedRateRow } from "@/components/business/market/merge-series";

/** 曲线调色板（≤5 条曲线一一对应，可区分；与主题变量 --color-<code> 同源注入） */
const LINE_COLORS = [
	"#0f766e",
	"#7c3aed",
	"#ea580c",
	"#2563eb",
	"#db2777",
] as const;

interface RateChartPanelProps {
	base: string;
	period: MarketPeriod;
	/** 合并后的图表行数据（null = 无任何可用序列） */
	rows: MergedRateRow[] | null;
	/** 各币种序列状态（参与成图与失败摘要） */
	series: UseRateHistoryResult["series"];
	isLoading: boolean;
	isAllUnavailable: boolean;
	onRetry: () => void;
}

/** X 轴刻度：YYYY-MM-DD → MM-DD（年跨档位由 tooltip 展示完整日期） */
const formatTick = (value: string): string =>
	typeof value === "string" && value.length >= 10
		? value.slice(5)
		: String(value);

/** Y 轴刻度：汇率量级差异大（0.00x~百位），按量级取小数位 */
const formatAxisRate = (value: number): string => {
	if (!Number.isFinite(value)) return "";
	return Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(4);
};

/** 浮层数值：原精度透传（number → string，不二次舍入，方案 §3.3） */
const formatRateValue = (value: unknown): string => {
	if (typeof value !== "number" || !Number.isFinite(value)) return "—";
	return String(value);
};

interface TooltipEntry {
	dataKey?: string | number;
	value?: unknown;
	color?: string;
}

/** 自定义浮层：日期 + 各币种当日汇率（保留数据源精度；缺口不参与 payload） */
function RateTooltip({
	active,
	payload,
	label,
}: {
	active?: boolean;
	payload?: TooltipEntry[];
	label?: string | number;
}) {
	if (!active || !payload || payload.length === 0) {
		return null;
	}
	return (
		<div className="grid gap-1.5 rounded-lg border border-border/50 bg-background px-3 py-2 text-xs shadow-xl">
			<p className="font-medium text-foreground">{String(label ?? "")}</p>
			{payload.map((entry) => (
				<div
					key={String(entry.dataKey)}
					className="flex items-center gap-2 whitespace-nowrap"
				>
					<span
						aria-hidden
						className="size-2 shrink-0 rounded-[2px]"
						style={{ backgroundColor: entry.color }}
					/>
					<span className="text-muted-foreground">{String(entry.dataKey)}</span>
					<span className="ml-auto pl-4 font-mono font-medium tabular-nums text-foreground">
						{formatRateValue(entry.value)}
					</span>
				</div>
			))}
		</div>
	);
}

/** 部分序列判定：首日明显晚于「今天 − period − 富余 3 天」即视为积累中的部分数据 */
function isPartialRange(firstDate: string, period: number, now: Date): boolean {
	const floor = new Date(now.getTime() - (period + 3) * 86_400_000);
	const floorDate = floor.toISOString().slice(0, 10);
	return firstDate > floorDate;
}

/**
 * 行情折线图面板（方案 §3.3/§6）：多币种叠加 LineChart + 三态兜底——
 * 加载态（整幅）；空态（全部失败/全部无数据 → 摘要 + 重试）；
 * 部分数据（无回源能力币对的积累序列 → 正常渲染 + 起始日标注）。
 * 单币种失败不进此层兜底（标签在币种选择器置灰），仅出提示行。
 */
export function RateChartPanel({
	base,
	period,
	rows,
	series,
	isLoading,
	isAllUnavailable,
	onRetry,
}: RateChartPanelProps) {
	const chartCurrencies =
		rows === null ? [] : Object.keys(rows[0]).filter((key) => key !== "date");
	const chartConfig: ChartConfig = Object.fromEntries(
		chartCurrencies.map((code, index) => [
			code,
			{
				label: (
					<span>
						{code}
						{getCurrencyName(code) ? ` · ${getCurrencyName(code)}` : ""}
					</span>
				),
				color: LINE_COLORS[index % LINE_COLORS.length],
			},
		]),
	);

	// 失败/空数据币种摘要（整图空态时作为原因清单，部分成功时作为提示行）
	const unavailable = series.filter(
		(item) => item.status === "error" || item.status === "empty",
	);

	if (isLoading && rows === null) {
		return (
			<div
				data-testid="market-chart-loading"
				className="flex h-80 flex-col items-center justify-center gap-3 rounded-xl border border-border bg-background text-sm text-muted-foreground"
			>
				<Spinner className="size-6 text-mint-700" />
				正在加载历史数据…
			</div>
		);
	}

	if (rows === null) {
		return (
			<div
				data-testid="market-chart-empty"
				className="rounded-xl border border-border bg-background"
			>
				<Empty className="rounded-xl">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<TrendingUp />
						</EmptyMedia>
						<EmptyTitle>暂无行情数据</EmptyTitle>
						<EmptyDescription>
							{unavailable.length > 0
								? unavailable
										.map(
											(item) =>
												`${item.currency}：${
													item.status === "error"
														? (item.errorMessage ?? "查询失败")
														: "暂无积累序列"
												}`,
										)
										.join("；")
								: `暂无可展示的 ${base} 汇率序列`}
						</EmptyDescription>
					</EmptyHeader>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={onRetry}
						data-testid="market-chart-retry"
					>
						<RotateCcw />
						重试
					</Button>
				</Empty>
			</div>
		);
	}

	const firstDate = rows[0].date;
	const partial = isPartialRange(firstDate, period, new Date());
	const pendingCount = series.filter(
		(item) => item.status === "loading",
	).length;

	return (
		<div
			data-testid="market-chart-panel"
			className="rounded-xl border border-border bg-background p-4"
		>
			<ChartContainer
				config={chartConfig}
				className="h-80 w-full"
				data-testid="market-chart"
			>
				<LineChart
					data={rows}
					margin={{ top: 12, right: 12, bottom: 0, left: 4 }}
				>
					<CartesianGrid vertical={false} />
					<XAxis
						dataKey="date"
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						minTickGap={32}
						tickFormatter={formatTick}
					/>
					<YAxis
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						domain={["auto", "auto"]}
						tickFormatter={formatAxisRate}
						width={64}
					/>
					<ChartTooltip
						content={<RateTooltip />}
						cursor={{ strokeDasharray: "4 4" }}
					/>
					<ChartLegend content={<ChartLegendContent />} />
					{chartCurrencies.map((code) => (
						<Line
							key={code}
							type="monotone"
							dataKey={code}
							name={code}
							stroke={`var(--color-${code})`}
							strokeWidth={2}
							dot={false}
							activeDot={{ r: 3 }}
							connectNulls={false}
							isAnimationActive={false}
						/>
					))}
				</LineChart>
			</ChartContainer>

			{/* 部分数据起始日标注（无回源能力币对的积累序列，方案 §3.3） */}
			{partial && (
				<p
					data-testid="market-chart-partial"
					className="mt-2 text-xs text-muted-foreground"
				>
					数据自 {firstDate} 起（更早历史暂无积累）
				</p>
			)}

			{/* 单币种失败/空提示行：不拖垮整页（方案 §3.3） */}
			{unavailable.length > 0 && (
				<p className="mt-2 text-xs text-muted-foreground">
					{unavailable.map((item) => `${item.currency} 暂无数据`).join("、")}
				</p>
			)}

			{/* 后到币种仍在加载（rows 已可渲染既有币种） */}
			{isLoading && pendingCount > 0 && (
				<p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
					<Loader2 className="size-3 animate-spin" />
					{pendingCount} 个币种加载中…
				</p>
			)}
		</div>
	);
}
