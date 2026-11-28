"use client";

import type { PlanInstallment } from "@/lib/api/contract";

/**
 * 分批排期预览卡（changes/plan-creation/技术方案.md §6③）
 *
 * 3 批列表（批次 / 日期 yyyy-MM-dd / 金额去尾零 + 币种）；
 * 加载、错误、未就绪三态的提示均为可见文案，不用原生 title。
 * 排期列表抽为 InstallmentScheduleList，供计划详情的准备节点、
 * 修改预览的新排期（plan-management §5.2）复用。
 */

/** 金额展示：去掉小数尾随零（"16666.6600" → "16666.66"，"12500.0000" → "12500"） */
export function formatDisplayAmount(amount: string): string {
	if (!/^\d+(\.\d+)?$/.test(amount)) return amount;
	const [intPart, decimalPart] = amount.split(".");
	const trimmed = decimalPart?.replace(/0+$/, "") ?? "";
	return trimmed ? `${intPart}.${trimmed}` : intPart;
}

/** ISO 8601 UTC 时间戳 → yyyy-MM-dd（服务端按日期语义生成，直接取日期部分） */
export function formatDisplayDate(isoDate: string): string {
	return isoDate.slice(0, 10);
}

export interface InstallmentScheduleListProps {
	/** 准备节点（分批排期，按批次序号升序） */
	installments: PlanInstallment[];
	/** 目标币种（金额展示用） */
	targetCurrency: string;
	/** 列表下方旁注（如「最晚准备日：…」；缺省不展示） */
	footnote?: string | null;
}

/**
 * 准备节点列表（可复用排期展示）：序号 / 日期 / 金额三列。
 * 创建预览、计划详情准备节点、修改预览新排期共用。
 */
export function InstallmentScheduleList({
	installments,
	targetCurrency,
	footnote,
}: InstallmentScheduleListProps) {
	return (
		<div>
			<ul className="divide-y divide-border">
				{installments.map((installment) => (
					<li
						key={installment.seq}
						className="flex items-center justify-between py-3 text-sm"
					>
						<span className="font-medium text-foreground">
							第 {installment.seq} 批
						</span>
						<span className="text-ink-600">
							{formatDisplayDate(installment.scheduledAt)}
						</span>
						<span className="font-semibold text-foreground">
							{formatDisplayAmount(installment.amount)}{" "}
							<span className="text-xs font-normal text-muted-foreground">
								{targetCurrency}
							</span>
						</span>
					</li>
				))}
			</ul>
			{footnote ? (
				<p className="mt-3 text-xs text-muted-foreground">{footnote}</p>
			) : null}
		</div>
	);
}

export interface SchedulePreviewCardProps {
	installments: PlanInstallment[];
	latestPrepDate: string | null;
	isPreviewing: boolean;
	previewError: string | null;
	/** 目标币种（金额展示用） */
	targetCurrency: string;
}

export function SchedulePreviewCard({
	installments,
	latestPrepDate,
	isPreviewing,
	previewError,
	targetCurrency,
}: SchedulePreviewCardProps) {
	const hasResult = installments.length > 0;
	const summaryCopy =
		installments.length >= 3
			? `按所选节奏拆分为 ${installments.length} 批，以下预览不落库，实际以创建后的计划为准。`
			: hasResult
				? `因可用准备日期不足 3 天，已按规则自动缩减为 ${installments.length} 批；以下预览不落库，实际以创建后的计划为准。`
				: "按所选节奏生成分批预览（默认最多 3 批，日期较近时自动缩批），以下预览不落库。";

	return (
		<section className="rounded-2xl border border-border bg-white p-6">
			<h2 className="text-base font-bold text-foreground">分批排期预览</h2>
			<p className="mt-1 text-xs text-muted-foreground">{summaryCopy}</p>

			{previewError ? (
				<p
					className="mt-4 rounded-lg border border-danger bg-danger px-3 py-2 text-sm text-danger"
					role="alert"
				>
					{previewError}
				</p>
			) : isPreviewing ? (
				<p className="mt-4 text-sm text-muted-foreground">正在生成排期…</p>
			) : hasResult ? (
				<div className="mt-4">
					<InstallmentScheduleList
						installments={installments}
						targetCurrency={targetCurrency}
						footnote={
							latestPrepDate
								? `最晚准备日：${formatDisplayDate(latestPrepDate)}`
								: null
						}
					/>
				</div>
			) : (
				<p className="mt-4 text-sm text-muted-foreground">
					填写完整目标信息后，将自动生成分批排期预览。
				</p>
			)}
		</section>
	);
}
