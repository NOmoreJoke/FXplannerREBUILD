"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Download, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	formatReportAmount,
	formatReportDate,
	hasUsageQuantity,
} from "@/components/business/report/plan-cost-summary-card";
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import { reportsApi } from "@/lib/api/reports";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { useOrganizationCapabilities } from "@/lib/hooks/use-organization-capabilities";
import type { ReportPlanListItem, ReportListStatus } from "@/lib/api/contract";

/**
 * 报告中心计划成本列表（reports 技术方案 §6 report-plan-list）。
 *
 * 每行：计划名称、状态、币种、目标金额、累计已使用数量、已使用成本（本位币）、
 * 使用均价、能否下载、信息更新时间（需求 5.1 条 1）。状态/币种筛选换 Key 重查
 * （react-query 按 Key 缓存互不污染，对齐 usePlanList 先例）。
 * 不同币种金额绝不合计——列表不提供任何合计行（需求 5.1 条 3）。
 */

/** 状态徽标（官方术语，对齐 plan-list 先例） */
const STATUS_BADGE: Record<string, { label: string; className: string }> = {
	ACTIVE: {
		label: "进行中",
		className: "bg-mint-50 text-mint-700 border-mint-200",
	},
	COMPLETED: {
		label: "已完成",
		className: "bg-sky-50 text-sky-700 border-sky-200",
	},
	CANCELLED: {
		label: "已取消",
		className: "bg-muted text-muted-foreground border-border",
	},
};

const STATUS_FILTERS: ReadonlyArray<{
	label: string;
	value: ReportListStatus | undefined;
}> = [
	{ label: "全部", value: undefined },
	{ label: "进行中", value: "ACTIVE" },
	{ label: "已完成", value: "COMPLETED" },
	{ label: "已取消", value: "CANCELLED" },
];

export interface ReportPlanListProps {
	/** 下载回调（行内下载按钮；仅 hasUsage 行渲染入口） */
	onDownload: (planId: string) => void;
}

export function ReportPlanList({ onDownload }: ReportPlanListProps) {
	const [status, setStatus] = useState<ReportListStatus | undefined>(undefined);
	const [currencyCode, setCurrencyCode] = useState<string | undefined>(
		undefined,
	);

	// 组织作用域缓存键 + 未选组织不发业务请求（评审 R2-I07）
	const orgId = useActiveOrgId();
	const { can } = useOrganizationCapabilities();
	const canCreatePlan = can("plan.create");
	const query = useQuery({
		// 筛选参数变化 → 换 Key 重查（方案 §6：react-query 参数变化重查）
		queryKey: withOrgScope(
			orgId,
			queryKeys.reports.plans(status, currencyCode),
		),
		queryFn: () => reportsApi.listPlans({ status, currencyCode }),
		enabled: orgId !== null,
		staleTime: 15 * 1000,
		retry: false,
	});

	const items = query.data?.items ?? [];
	// 币种筛选项从「全部列表」推导：始终用无筛选请求的第一页结果？——
	// 简化：从当前结果推导会导致筛选后选项收缩。改为恒取全量列表（一次额外缓存请求）。
	const allQuery = useQuery({
		queryKey: withOrgScope(orgId, queryKeys.reports.plans()),
		queryFn: () => reportsApi.listPlans({}),
		enabled: orgId !== null,
		staleTime: 15 * 1000,
		retry: false,
	});
	const currencyOptions = [
		...new Set((allQuery.data?.items ?? []).map((item) => item.currencyCode)),
	];

	return (
		<section className="mt-6">
			<div className="mb-4 flex flex-wrap items-center gap-4">
				{/* 状态筛选（需求 5.1 条 2） */}
				<div
					className="flex items-center gap-2"
					aria-label="按计划状态筛选报告"
				>
					{STATUS_FILTERS.map((filter) => {
						const active = status === filter.value;
						return (
							<button
								key={filter.label}
								type="button"
								aria-pressed={active}
								data-testid={`report-status-${filter.value ?? "all"}`}
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
				{/* 币种筛选（从全量列表推导选项） */}
				{currencyOptions.length > 0 ? (
					<div className="flex items-center gap-2" aria-label="按币种筛选报告">
						<button
							type="button"
							aria-pressed={currencyCode === undefined}
							data-testid="report-currency-all"
							onClick={() => setCurrencyCode(undefined)}
							className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
								currencyCode === undefined
									? "bg-mint-700 text-white"
									: "bg-muted text-ink-600 hover:bg-muted/70"
							}`}
						>
							全部币种
						</button>
						{currencyOptions.map((code) => {
							const active = currencyCode === code;
							return (
								<button
									key={code}
									type="button"
									aria-pressed={active}
									data-testid={`report-currency-${code}`}
									onClick={() => setCurrencyCode(active ? undefined : code)}
									className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
										active
											? "bg-mint-700 text-white"
											: "bg-muted text-ink-600 hover:bg-muted/70"
									}`}
								>
									{code}
								</button>
							);
						})}
					</div>
				) : null}
			</div>

			{query.isLoading || allQuery.isLoading ? (
				<div className="space-y-3">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-24 rounded-2xl" />
					))}
				</div>
			) : query.isError ? (
				<div className="flex flex-col items-center rounded-2xl border border-border bg-white px-8 py-16 text-center">
					<CircleAlert className="size-10 text-cream-300" />
					<h2 className="mt-4 text-base font-bold text-foreground">
						报告加载失败
					</h2>
					<p className="mt-2 text-sm text-muted-foreground">
						网络异常或服务暂不可用，请稍后重试。
					</p>
					<Button
						className="mt-6 bg-mint-700 text-white hover:bg-mint-700/90"
						onClick={() => {
							void query.refetch();
						}}
					>
						重试
					</Button>
				</div>
			) : items.length === 0 ? (
				<ReportEmptyState canCreatePlan={canCreatePlan} />
			) : (
				<div className="space-y-3">
					{items.map((item) => (
						<ReportPlanRow
							key={item.planId}
							item={item}
							baseCurrency={query.data?.baseCurrency ?? null}
							onDownload={onDownload}
						/>
					))}
				</div>
			)}
		</section>
	);
}

/** 无任何计划：空状态引导具备 plan.create 权限的成员创建（需求 5.1 条 4 / 验收 1 前置） */
function ReportEmptyState({ canCreatePlan }: { canCreatePlan: boolean }) {
	return (
		<div
			data-testid="reports-empty"
			className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-white px-8 py-16 text-center"
		>
			<h2 className="text-base font-bold text-foreground">
				还没有可展示的报告
			</h2>
			<p className="mt-2 max-w-md text-sm text-muted-foreground">
				{canCreatePlan
					? "创建换汇计划并记录使用后，这里会按计划汇总成本，支持一键下载报告。"
					: "当前组织还没有任何换汇计划。如需创建计划，请联系具备计划创建权限的成员。"}
			</p>
			{canCreatePlan ? (
				<Link
					href="/plans/new"
					data-testid="reports-empty-create"
					className={buttonVariants({
						className: "mt-6 bg-mint-700 text-white hover:bg-mint-700/90",
					})}
				>
					<Plus className="size-4" />
					去创建计划
				</Link>
			) : null}
		</div>
	);
}

/** 单行：计划成本摘要 + 下载入口（仅 hasUsage；无使用「尚未使用」无入口，需求 5.5 条 2） */
function ReportPlanRow({
	item,
	baseCurrency,
	onDownload,
}: {
	item: ReportPlanListItem;
	baseCurrency: string | null;
	onDownload: (planId: string) => void;
}) {
	const badge = STATUS_BADGE[item.status] ?? STATUS_BADGE.ACTIVE;
	const hasUsage = hasUsageQuantity(item.usedQuantity);
	const costCurrency = baseCurrency ?? undefined;

	return (
		<div
			data-testid="report-plan-row"
			className="rounded-2xl border border-border bg-white p-5"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<h3 className="truncate text-base font-bold text-foreground">
							<Link href={`/plans/${item.planId}`} className="hover:underline">
								{item.name ?? "未命名计划"}
							</Link>
						</h3>
						<Badge className={badge.className}>{badge.label}</Badge>
					</div>
					<p className="mt-0.5 text-xs text-muted-foreground">
						目标币种 {item.currencyCode}
						{item.updatedAt
							? ` · 更新于 ${formatReportDate(item.updatedAt)}`
							: ""}
					</p>
				</div>
				{hasUsage ? (
					<Button
						data-testid={`report-download-${item.planId}`}
						variant="outline"
						className="shrink-0 bg-white"
						onClick={() => onDownload(item.planId)}
					>
						<Download className="size-4" />
						下载
					</Button>
				) : (
					<span
						data-testid={`report-no-usage-${item.planId}`}
						className="shrink-0 text-xs text-muted-foreground"
					>
						尚未使用
					</span>
				)}
			</div>

			<dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-4">
				<div>
					<dt className="text-xs text-muted-foreground">目标金额</dt>
					<dd className="mt-0.5 font-semibold text-foreground">
						{formatReportAmount(item.targetAmount, item.currencyCode)}
						<span className="ml-1 text-xs font-normal text-muted-foreground">
							{item.currencyCode}
						</span>
					</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">累计已使用</dt>
					<dd className="mt-0.5 font-semibold text-foreground">
						{formatReportAmount(item.usedQuantity, item.currencyCode)}
						<span className="ml-1 text-xs font-normal text-muted-foreground">
							{item.currencyCode}
						</span>
					</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">已使用成本</dt>
					<dd className="mt-0.5 font-semibold text-foreground">
						{item.usedTotalCost === null ? (
							<span className="font-normal text-muted-foreground">—</span>
						) : (
							<>
								{formatReportAmount(item.usedTotalCost, costCurrency ?? "CNY")}
								<span className="ml-1 text-xs font-normal text-muted-foreground">
									{costCurrency ?? ""}
								</span>
							</>
						)}
					</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">使用均价</dt>
					<dd className="mt-0.5 font-semibold text-foreground">
						{item.usedUnitCost === null ? (
							<span className="font-normal text-muted-foreground">—</span>
						) : (
							formatReportAmount(item.usedUnitCost, costCurrency ?? "CNY")
						)}
					</dd>
				</div>
			</dl>
		</div>
	);
}
