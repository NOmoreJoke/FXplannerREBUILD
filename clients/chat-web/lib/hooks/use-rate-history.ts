"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import { ratesApi } from "@/lib/api/rates";
import {
	mergeSeries,
	type MergedRateRow,
	type RateSeriesPoint,
} from "@/components/business/market/merge-series";

/** 行情页时间档位（后端 VALID_PERIODS 对齐；非法值后端 400，前端不发送非法值） */
export type MarketPeriod = 7 | 30 | 90 | 365;

/** 查询 Key 词根（[domain, action] 约定，与 use-latest-rates 同风格） */
export const RATE_HISTORY_QUERY_STEM = ["rates", "history"] as const;

/** 组装完整查询 Key（base + target + period 各占一位） */
export function buildRateHistoryQueryKey(
	base: string,
	target: string,
	period: MarketPeriod,
): readonly unknown[] {
	return [...RATE_HISTORY_QUERY_STEM, base, target, period];
}

/** 缓存保鲜期（§3.3/§5.2：staleTime 10min，窗口内切档位/币种秒回本地缓存） */
export const RATE_HISTORY_STALE_TIME_MS = 10 * 60_000;

/** 请求超时（§6：7/30/90 档 10s；365 档首次可能回源，放宽 15s） */
const TIMEOUT_MS = { normal: 10_000, long: 15_000 } as const;

/** 单币种序列状态（UI 据此置灰标签/标注起始日） */
export interface CurrencySeriesState {
	/** loading=请求中；success=有数据；empty=请求成功但序列为空；error=请求失败 */
	status: "loading" | "success" | "empty" | "error";
	/** 部分序列起始日（success 时取 data_points 首日；其余 null） */
	startDate: string | null;
	/** 失败摘要（error 时提供，供空态聚合展示） */
	errorMessage: string | null;
}

/** 单币种序列状态（含币种代码） */
export type CurrencySeriesEntry = CurrencySeriesState & { currency: string };

export interface UseRateHistoryParams {
	/** 本位币（基准；空串表示尚未就绪，全部查询停用） */
	base: string;
	/** 对比币种（1~5 个，由页面约束；空数组时全部查询停用） */
	targets: string[];
	period: MarketPeriod;
}

export interface UseRateHistoryResult {
	/** 各币种状态（顺序与入参 targets 一致） */
	series: CurrencySeriesEntry[];
	/** 合并后的图表行数据（仅成功且非空币种参与；无任何可用序列时 null） */
	rows: MergedRateRow[] | null;
	/** 任一币种首次加载中（rows 为 null 时面板显示整幅加载态） */
	isLoading: boolean;
	/** 全部结束但无任何可用序列（全部失败/全部空 → 空态 + 重试） */
	isAllUnavailable: boolean;
	/** 手动重查（空态重试按钮；只重查未成功有数据的查询） */
	refetch: () => void;
}

/** 请求超时包装：到时抛 ApiError（408），底层响应到达后丢弃（不 abort，泄漏可忽略） */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new ApiError("请求超时", 408, "RATE_HISTORY_TIMEOUT")),
			ms,
		);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** ApiError/未知错误 → 展示摘要（code 有则带 code 前缀） */
function toErrorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		return error.code ? `${error.message}（${error.code}）` : error.message;
	}
	return error instanceof Error ? error.message : "历史汇率查询失败";
}

/**
 * 行情页历史数据消费层（changes/rate-chart/技术方案.md §3.3/§5.2）：
 * 多币种并行拉取（每币种一个独立 query，天然隔离单币种失败）+ 按 date 对齐
 * 合并为图表行。缓存与 Key 按 [rates, history, base, target, period] 粒度，
 * staleTime 10min；365 档不自动重试（首次回源慢，重试只会加剧回源放大），
 * 其余档位重试 1 次。
 */
export function useRateHistory(
	params: UseRateHistoryParams,
): UseRateHistoryResult {
	const { base, targets, period } = params;
	const targetsKey = targets.join(",");
	const enabled = base !== "" && targets.length > 0;

	const queries = useQueries({
		queries: (enabled ? targets : []).map((target) => ({
			queryKey: buildRateHistoryQueryKey(base, target, period),
			queryFn: () =>
				withTimeout(
					ratesApi.history(base, target, period),
					period >= 365 ? TIMEOUT_MS.long : TIMEOUT_MS.normal,
				),
			enabled,
			staleTime: RATE_HISTORY_STALE_TIME_MS,
			retry: period >= 365 ? 0 : 1,
		})),
	});

	const series = useMemo<CurrencySeriesEntry[]>(() => {
		return targets.map((currency, index) => {
			const query = queries[index];
			if (!query || query.isLoading) {
				return {
					currency,
					status: "loading",
					startDate: null,
					errorMessage: null,
				};
			}
			if (query.error) {
				return {
					currency,
					status: "error",
					startDate: null,
					errorMessage: toErrorMessage(query.error),
				};
			}
			const points = query.data?.data_points ?? [];
			if (points.length === 0) {
				return {
					currency,
					status: "empty",
					startDate: null,
					errorMessage: null,
				};
			}
			return {
				currency,
				status: "success",
				startDate: points[0].date,
				errorMessage: null,
			};
		});
		// queries 数组元素引用稳定；targetsKey 表达 targets 依赖（数组字面量每次 render 新建）
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [queries, targetsKey]);

	const rows = useMemo<MergedRateRow[] | null>(() => {
		const ok: Array<{ currency: string; points: RateSeriesPoint[] }> = [];
		for (let index = 0; index < targets.length; index += 1) {
			const query = queries[index];
			const points = query?.data?.data_points;
			if (points && points.length > 0) {
				ok.push({ currency: targets[index], points });
			}
		}
		return ok.length > 0 ? mergeSeries(ok) : null;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [queries, targetsKey]);

	const isLoading = enabled && queries.some((query) => query.isLoading);
	const isAllUnavailable =
		enabled && !isLoading && queries.length > 0 && rows === null;

	/** 手动重查（空态重试按钮；只重查非 success 的查询——失败与空序列均可重试） */
	const refetch = () => {
		for (let index = 0; index < queries.length; index += 1) {
			if (series[index]?.status !== "success") {
				void queries[index]?.refetch();
			}
		}
	};

	return { series, rows, isLoading, isAllUnavailable, refetch };
}
