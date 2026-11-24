"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { COMPLIANCE_DISCLAIMER_TEXT } from "@/components/base/compliance-disclaimer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	PlanCostSummaryCard,
	UNKNOWN_FEE_NOTE,
	formatReportAmount,
	formatReportDate,
	hasUsageQuantity,
} from "@/components/business/report/plan-cost-summary-card";
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import { reportsApi } from "@/lib/api/reports";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";

/**
 * 单计划报告打印视图（reports 技术方案 §6/§7 方案 A：前端打印，零新增依赖）。
 *
 * - PlanReportPrintView：A4 纵向版式内容（数据与摘要同源 = GET /reports/plans/:id，
 *   可替换渲染器边界：未来切 @react-pdf/renderer 只动本文件）；
 * - PlanReportPrintDialog：屏幕浮层 + 自动 window.print()（用户在浏览器打印对话框
 *   「另存为 PDF」）；afterprint / 取消 / 关闭 → 回调 onClose，页面原样（需求六：用户取消打印无影响）。
 *
 * 已保存的 PDF 为静态快照（需求 5.5 条 7）；更正后重新打开打印视图得到新数据。
 * 页脚注明舍入口径（待确认点 11：全精度计算、展示单次舍入，合计与逐项舍入值
 * 之和可能存在 ≤1 最小单位显示差）。
 */

/** 打印版式内容（A4 纵向；print-root 配合 globals.css 的 @media print 规则） */
export function PlanReportPrintView({
	report,
}: {
	report: Awaited<ReturnType<typeof reportsApi.getPlanReport>>;
}) {
	const { plan, meta } = report;
	const hasUsage = hasUsageQuantity(plan.usedQuantity);
	const costCurrency = plan.baseCurrency;

	return (
		<div className="print-root space-y-5 bg-white p-8 text-ink-900">
			<header className="border-b border-border pb-4">
				<h1 className="text-xl font-bold">
					{plan.name ?? "未命名计划"} · 成本报告
				</h1>
				<p className="mt-1 text-xs text-gray-500">
					状态 {plan.status} · 目标币种 {plan.currencyCode}
					{costCurrency ? ` · 成本币种 ${costCurrency}` : ""}
				</p>
			</header>

			<section>
				<h2 className="text-sm font-bold">基本信息与进度</h2>
				<dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
					<div>
						<dt className="text-xs text-gray-500">目标金额</dt>
						<dd className="font-semibold">
							{formatReportAmount(plan.targetAmount, plan.currencyCode)}{" "}
							{plan.currencyCode}
						</dd>
					</div>
					<div>
						<dt className="text-xs text-gray-500">累计已使用</dt>
						<dd className="font-semibold">
							{formatReportAmount(plan.usedQuantity, plan.currencyCode)}{" "}
							{plan.currencyCode}
						</dd>
					</div>
					<div>
						<dt className="text-xs text-gray-500">剩余待使用（差额）</dt>
						<dd className="font-semibold">
							{formatReportAmount(plan.remainingToUseAmount, plan.currencyCode)}{" "}
							{plan.currencyCode}
						</dd>
					</div>
				</dl>
			</section>

			{hasUsage ? (
				<>
					<PlanCostSummaryCard report={report} variant="print" />
					{report.cost.hasUnknownFee ? (
						<p className="text-xs text-gray-500">{UNKNOWN_FEE_NOTE}</p>
					) : null}
				</>
			) : (
				<p className="text-sm text-gray-500">尚未使用（未生成使用成本报告）</p>
			)}

			<footer className="border-t border-border pt-3 text-xs text-gray-500">
				<p>
					信息更新时间：
					{meta.updatedAt ? formatReportDate(meta.updatedAt) : "暂无记录"} ·
					报告生成时间：{formatReportDate(meta.generatedAt)}
				</p>
				<p className="mt-1">
					金额按币种精度展示（日元、韩元整数，其余最多 2
					位小数）；成本按全精度计算后一次舍入，分项与合计可能存在极小显示差。
				</p>
				<p className="mt-1 break-inside-avoid">{COMPLIANCE_DISCLAIMER_TEXT}</p>
			</footer>
		</div>
	);
}

export interface PlanReportPrintDialogProps {
	planId: string;
	open: boolean;
	onClose: () => void;
}

/**
 * 打印浮层：open 时拉取报告 → 渲染完成后自动触发 window.print()；
 * afterprint（保存/取消）与手动关闭都回调 onClose。屏幕上可预览，打印时
 * 仅 .print-root 可见（globals.css @media print 规则）。
 */
export function PlanReportPrintDialog({
	planId,
	open,
	onClose,
}: PlanReportPrintDialogProps) {
	// 组织作用域缓存键 + 未选组织不发业务请求（评审 R2-I07）
	const orgId = useActiveOrgId();
	const query = useQuery({
		queryKey: withOrgScope(orgId, queryKeys.reports.plan(planId)),
		queryFn: () => reportsApi.getPlanReport(planId),
		enabled: orgId !== null && open,
		retry: false,
	});

	// 数据就绪后自动触发打印（一次性；用户取消打印 → afterprint 关闭浮层，页面原样）
	useEffect(() => {
		if (!open || !query.data) return;
		const timer = window.setTimeout(() => window.print(), 100);
		const handleAfter = () => onClose();
		window.addEventListener("afterprint", handleAfter);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener("afterprint", handleAfter);
		};
	}, [open, query.data, onClose]);

	if (!open) return null;

	return (
		<div className="fixed inset-0 z-50 overflow-auto bg-white">
			<div className="mx-auto max-w-3xl px-4 py-6 print:hidden">
				<div className="mb-4 flex items-center justify-between">
					<h2 className="text-sm font-semibold text-foreground">
						报告打印预览（在打印对话框中选择「另存为 PDF」）
					</h2>
					<Button
						variant="outline"
						className="bg-white"
						data-testid="print-dialog-close"
						onClick={onClose}
					>
						<X className="size-4" />
						关闭
					</Button>
				</div>
			</div>
			{query.isLoading ? (
				<div className="mx-auto max-w-3xl px-8 print:hidden">
					<Skeleton className="h-96 w-full rounded-2xl" />
				</div>
			) : query.isError || !query.data ? (
				<div className="mx-auto max-w-3xl px-8 py-16 text-center text-sm text-muted-foreground print:hidden">
					报告加载失败，请关闭后重试。
				</div>
			) : (
				<PlanReportPrintView report={query.data} />
			)}
		</div>
	);
}
