"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Decimal } from "decimal.js";
import { getCurrency, roundToCurrency } from "@fxplanner-new/money";
import { FileDown, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PlanReportPrintDialog } from "@/components/business/report/plan-report-print-view";
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import { reportsApi } from "@/lib/api/reports";
import type { PlanReport } from "@/lib/api/contract";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";

/**
 * 计划成本摘要卡（reports 技术方案 §6 plan-cost-summary-card）。
 *
 * 计划详情页与打印视图复用同一数据 DTO（GET /reports/plans/:id）：
 * - variant="page"：详情页区块，含修改记录入口与下载按钮（有有效使用才显示下载）；
 * - variant="print"：打印版式内容（无交互控件），配合 PlanReportPrintDialog 使用。
 *
 * 展示口径（需求 5.2 / 验收 4/7/8）：
 * - 从未使用 → 「尚未使用」，不显示使用均价（绝不显示 0）；
 * - 成本缺失 → 「暂无法计算」（缺成本不按零，需求 5.3 条 3）；
 * - hasUnknownFee → 固定说明「按已录入金额计算，部分交易费用未明确，实际成本可能有所不同。」；
 * - 收益占位：纯初始持仓 → 「不计算收益比较」（绝不显示 0%）；含买入 → 「收益比较将在后续版本提供」。
 */

/** 手续费未明确固定说明（需求 5.2 条 5，摘要与报告同文案） */
export const UNKNOWN_FEE_NOTE =
	"按已录入金额计算，部分交易费用未明确，实际成本可能有所不同。";

/** 收益占位文案（需求 5.4 条 2：算法定稿前不出数值） */
const YIELD_TEXT = {
	INITIAL_ONLY_NO_COMPARISON: "不计算收益比较",
	NOT_SUPPORTED_YET: "收益比较将在后续版本提供",
} as const;

/** 「金额/数量字符串 + 币种」→ 按币种精度一次舍入后去尾零（JPY/KRW 整数、其余 ≤2 位） */
export function formatReportAmount(
	value: string,
	currencyCode: string,
): string {
	const currency = getCurrency(currencyCode);
	const places = currency?.decimalPlaces ?? 2;
	const rounded = roundToCurrency(value, places);
	// 去尾零（对齐 formatDisplayAmount 先例：展示最短形态）
	const [intPart, decimalPart] = rounded.toFixed(places).split(".");
	const trimmed = decimalPart?.replace(/0+$/, "") ?? "";
	return trimmed ? `${intPart}.${trimmed}` : intPart;
}

/** ISO 8601 → yyyy-MM-dd（时间戳展示日期部分，对齐 formatDisplayDate 先例） */
export function formatReportDate(iso: string): string {
	return iso.slice(0, 10);
}

/** 金额格（标签 + 值 + 币种角标）；value null 显示占位文案 */
function AmountCell({
	label,
	value,
	currency,
	fallback = "暂无法计算",
}: {
	label: string;
	value: string | null;
	currency?: string;
	fallback?: string;
}) {
	return (
		<div>
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="mt-0.5 font-semibold text-foreground">
				{value === null ? (
					<span className="font-normal text-muted-foreground">{fallback}</span>
				) : (
					<>
						{formatReportAmount(value, currency ?? "CNY")}
						{currency ? (
							<span className="ml-1 text-xs font-normal text-muted-foreground">
								{currency}
							</span>
						) : null}
					</>
				)}
			</dd>
		</div>
	);
}

/** 有无有效使用（usedQuantity > 0；4 位字符串直接数值比较） */
export function hasUsageQuantity(usedQuantity: string): boolean {
	return new Decimal(usedQuantity).gt(0);
}

export interface PlanCostSummaryCardProps {
	report: PlanReport;
	/** page = 详情页区块（含交互）；print = 打印版式内容（纯展示） */
	variant?: "page" | "print";
	/** 下载回调（page 模式且 hasUsage 时渲染下载按钮；print 模式忽略） */
	onDownload?: () => void;
}

export function PlanCostSummaryCard({
	report,
	variant = "page",
	onDownload,
}: PlanCostSummaryCardProps) {
	const { plan, cost, sourceSplit, yieldSection, meta } = report;
	const isPrint = variant === "print";
	const hasUsage = hasUsageQuantity(plan.usedQuantity);
	const costCurrency = plan.baseCurrency; // 成本币种 = 本位币；null 退化为纯金额
	const hasInitialSource = new Decimal(sourceSplit.initial.quantity).gt(0);

	return (
		<section
			data-testid="plan-cost-summary"
			className="rounded-2xl border border-border bg-white p-6"
		>
			<div className="flex items-center justify-between gap-3">
				<div>
					<h3 className="text-base font-bold text-foreground">成本摘要</h3>
					<p className="mt-1 text-xs text-muted-foreground">
						只统计已实际使用的部分；分配给计划但还没使用的钱不计入。
					</p>
				</div>
				{!isPrint && hasUsage && onDownload ? (
					<Button
						data-testid="plan-report-download"
						variant="outline"
						className="shrink-0 bg-white"
						onClick={onDownload}
					>
						<FileDown className="size-4" />
						下载报告
					</Button>
				) : null}
			</div>

			{hasUsage ? (
				<>
					<dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
						<AmountCell
							label="已使用成本"
							value={cost.usedTotalCost}
							currency={costCurrency ?? undefined}
						/>
						<AmountCell
							label="使用均价"
							value={cost.usedUnitCost ? cost.usedUnitCost : null}
							fallback="暂无法计算"
						/>
					</dl>
					{cost.usedUnitCost ? (
						<p className="mt-1 text-xs text-muted-foreground">
							使用均价 = 已使用成本 ÷ 已使用数量（每单位外币成本）
						</p>
					) : null}

					{/* 来源拆分（需求 5.2 条 4）：初始持仓 / 后续买入分别展示 */}
					<div className="mt-4 rounded-xl bg-muted/50 p-4">
						<p className="text-xs font-semibold text-foreground">来源拆分</p>
						<dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
							<AmountCell
								label="初始持仓来源数量"
								value={sourceSplit.initial.quantity}
								currency={plan.currencyCode}
							/>
							<AmountCell
								label="初始持仓来源成本"
								value={hasInitialSource ? sourceSplit.initial.cost : null}
								currency={costCurrency ?? undefined}
								fallback="—"
							/>
							<AmountCell
								label="买入来源数量"
								value={sourceSplit.purchase.quantity}
								currency={plan.currencyCode}
							/>
							<AmountCell
								label="买入来源成本"
								value={
									new Decimal(sourceSplit.purchase.quantity).gt(0)
										? sourceSplit.purchase.cost
										: null
								}
								currency={costCurrency ?? undefined}
								fallback="—"
							/>
						</dl>
						{hasInitialSource ? (
							<p className="mt-2 text-xs text-muted-foreground">
								初始成本为记账起点，不代表当年实际买入花费。
							</p>
						) : null}
					</div>

					{cost.hasUnknownFee ? (
						<p
							data-testid="unknown-fee-note"
							className="mt-3 text-xs text-muted-foreground"
						>
							{UNKNOWN_FEE_NOTE}
						</p>
					) : null}

					{/* 收益占位（需求 5.4）：算法定稿前不出数值 */}
					<div
						data-testid="yield-section"
						className="mt-4 flex items-center justify-between rounded-xl border border-dashed border-border px-4 py-3"
					>
						<span className="text-xs font-semibold text-foreground">
							收益比较{/* compliance-allow: 需求 5.4 收益比较占位标题（算法定稿前不出数值） */}
						</span>
						<span className="text-xs text-muted-foreground">
							{YIELD_TEXT[yieldSection.displayType]}
						</span>
					</div>
				</>
			) : (
				<p
					data-testid="usage-empty"
					className="mt-4 text-sm text-muted-foreground"
				>
					尚未使用
				</p>
			)}

			{/* 信息更新时间 + 修改记录入口（需求 5.2 条 7；print 模式只展示时间不放链接） */}
			<div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
				<span>
					信息更新时间：
					{meta.updatedAt ? formatReportDate(meta.updatedAt) : "暂无记录"}
				</span>
				{!isPrint ? (
					<Link
						href={`/plans/${plan.id}`}
						className="inline-flex items-center gap-1 hover:text-foreground"
					>
						<FileText className="size-3.5" />
						修改记录
					</Link>
				) : null}
			</div>
		</section>
	);
}

/**
 * 计划详情页的成本摘要区块：拉取单计划报告，无使用显示「尚未使用」，
 * 有使用显示摘要卡与下载入口（打开打印浮层，内聚管理）；
 * 404（理论不可达——详情页已确认计划存在）静默隐藏。
 */
export function PlanReportSection({ planId }: { planId: string }) {
	// 组织作用域缓存键 + 未选组织不发业务请求（评审 R2-I07）
	const orgId = useActiveOrgId();
	const query = useQuery({
		queryKey: withOrgScope(orgId, queryKeys.reports.plan(planId)),
		queryFn: () => reportsApi.getPlanReport(planId),
		enabled: orgId !== null,
		retry: false,
	});
	const [printOpen, setPrintOpen] = useState(false);

	if (query.isLoading) {
		return <Skeleton className="mt-6 h-48 w-full rounded-2xl" />;
	}
	if (query.isError || !query.data) {
		// 摘要加载失败不打断计划详情主流程（成本区为增强区块）
		return null;
	}
	const report = query.data;
	const hasUsage = hasUsageQuantity(report.plan.usedQuantity);

	return (
		<section className="mt-6">
			{hasUsage ? (
				<p
					className="mb-2 text-xs text-muted-foreground"
					data-testid="report-ready-note"
				>
					该计划已有使用记录，可下载成本报告留存。
				</p>
			) : null}
			<PlanCostSummaryCard
				report={report}
				variant="page"
				onDownload={() => setPrintOpen(true)}
			/>
			<PlanReportPrintDialog
				planId={planId}
				open={printOpen}
				onClose={() => setPrintOpen(false)}
			/>
		</section>
	);
}
