"use client";

import { useState } from "react";
import { PlanList } from "@/components/business/plan";
import { usePlanList } from "@/lib/hooks/use-plan-list";
import type { PlanListStatus } from "@/lib/api/contract";
/**
 * 换汇计划列表页（changes/plan-management/技术方案.md §5.2）
 *
 * 瘦壳：usePlanList（status 筛选换 Key 重查）+ PlanList 卡片。
 * 修复 home-dashboard 的 /plans 死链入口。
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。
 */

/** 状态筛选项（value 传给 GET /plans?status=；undefined 查全部） */
const STATUS_FILTERS: ReadonlyArray<{
	label: string;
	value: PlanListStatus | undefined;
}> = [
	{ label: "全部", value: undefined },
	{ label: "进行中", value: "ACTIVE" },
	{ label: "已完成", value: "COMPLETED" },
	{ label: "已取消", value: "CANCELLED" },
];

export default function PlansPage() {
	const [status, setStatus] = useState<PlanListStatus | undefined>(undefined);
	const { items, isLoading, isError, refetch } = usePlanList(status);

	return (
		<div>
			{/* 状态筛选：换 Key 重查，react-query 按 Key 缓存互不污染 */}
			<div
				className="mx-auto flex max-w-5xl items-center gap-2 px-8 pt-6"
				aria-label="按状态筛选换汇计划"
			>
				{STATUS_FILTERS.map((filter) => {
					const active = status === filter.value;
					return (
						<button
							key={filter.label}
							type="button"
							aria-pressed={active}
							onClick={() => setStatus(filter.value)}
							className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
								active
									? "bg-mint-700 text-white"
									: "bg-muted text-ink-600 hover:bg-muted/70"
							}`}
						>
							{filter.label}
						</button>
					);
				})}
			</div>
			<PlanList
				items={items}
				isLoading={isLoading}
				isError={isError}
				onRetry={refetch}
			/>
		</div>
	);
}
