import { useQuery } from "@tanstack/react-query";
import { plansApi } from "@/lib/api/plans";
import type { PlanListItem, PlanListStatus } from "@/lib/api/contract";

/**
 * 计划列表查询（changes/plan-management/技术方案.md §4.1）
 *
 * GET /plans?status=（本人全部计划，updatedAt 倒序，limit 100 兑底）；
 * status 传 undefined 查全部。列表页状态筛选（全部/进行中/已完成/已取消）
 * 换 Key 重查，react-query 按 Key 缓存互不污染。
 */

/** 查询 Key 词根（[domain, action] 约定；完整 Key 由 buildPlanListQueryKey 组装） */
export const PLAN_LIST_QUERY_STEM = ["plans", "list"] as const;

/** 组装完整查询 Key：词根 + status（undefined 归一为 "all"，保证 Key 稳定可序列化） */
export function buildPlanListQueryKey(
	status: PlanListStatus | undefined,
): readonly unknown[] {
	return [...PLAN_LIST_QUERY_STEM, status ?? "all"];
}

export interface UsePlanListResult {
	/** 计划列表（updatedAt 倒序；无数据为空数组） */
	items: PlanListItem[];
	/** 首次请求进行中 */
	isLoading: boolean;
	/** 请求失败（401 由 apiClient 统一跳登录，其余交给页面错误态） */
	isError: boolean;
	/** 重试（页面错误态按钮） */
	refetch: () => void;
}

/**
 * 计划列表消费层：status 筛选 + 加载/错误态归一（风格对齐 use-home-state）。
 */
export function usePlanList(status?: PlanListStatus): UsePlanListResult {
	const query = useQuery({
		queryKey: buildPlanListQueryKey(status),
		queryFn: () => plansApi.list(status),
		staleTime: 30 * 1000, // 列表容忍秒级陈旧；写操作后由提交方 invalidate 精确刷新
		retry: false, // 401 由 apiClient 统一跳登录，其余失败直接交给页面错误态
	});

	return {
		items: query.data?.items ?? [],
		isLoading: query.isLoading,
		isError: query.isError,
		refetch: () => {
			void query.refetch();
		},
	};
}
