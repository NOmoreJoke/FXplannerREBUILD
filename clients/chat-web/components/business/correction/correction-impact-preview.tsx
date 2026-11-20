"use client";

import { CircleAlert, Info } from "lucide-react";
import type { CorrectionPreview } from "@/lib/api/contract";

/**
 * 影响预览段（corrections 技术方案 §6「correction-impact-preview」）
 *
 * 展示逐字段变更、余额、资金来源、成本和拦截原因。
 */

export interface CorrectionImpactPreviewProps {
	preview: CorrectionPreview;
}

export function CorrectionImpactPreview({
	preview,
}: CorrectionImpactPreviewProps) {
	const hasBlockers = preview.blockers.length > 0;
	const quote = preview.holdingQuote;
	return (
		<section className="space-y-4 rounded-2xl border border-border bg-white p-6">
			<h2 className="text-base font-bold text-foreground">影响预览</h2>

			{hasBlockers ? (
				<div className="space-y-3" role="alert">
					{preview.blockers.map((blocker, index) => (
						<div
							key={`${blocker.code}-${index}`}
							className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
						>
							<p className="flex items-start gap-2 text-sm font-semibold text-destructive">
								<CircleAlert className="mt-0.5 size-4 shrink-0" />
								不能提交：{blocker.message}
							</p>
							{blocker.details.length > 0 ? (
								<ul className="mt-2 space-y-1 pl-6 text-xs text-ink-600">
									{blocker.details.map((detail, detailIndex) => (
										<li key={detailIndex}>
											{detail.currencyCode ? `${detail.currencyCode} · ` : ""}
											{detail.usedAt ? `${detail.usedAt.slice(0, 10)} ` : ""}
											{detail.shortfall ? `缺口 ${detail.shortfall}` : ""}
											{detail.planId ? `受影响计划：${detail.planId}` : ""}
										</li>
									))}
								</ul>
							) : null}
						</div>
					))}
				</div>
			) : null}

			{preview.diff.length > 0 && (
				<div>
					<h3 className="text-sm font-semibold text-foreground">
						修改前后对比
					</h3>
					<dl className="mt-2 divide-y divide-border rounded-xl border border-border">
						{preview.diff.map((item) => (
							<div
								key={item.field}
								className="flex items-center justify-between px-4 py-2.5 text-sm"
							>
								<dt className="text-muted-foreground">{item.field}</dt>
								<dd
									className={
										hasBlockers
											? "font-medium text-ink-500"
											: "font-semibold text-foreground tabular-nums"
									}
								>
									{item.display}
								</dd>
							</div>
						))}
					</dl>
				</div>
			)}

			{quote && (
				<div>
					<h3 className="text-sm font-semibold text-foreground">采用的历史报价</h3>
					<p className="mt-2 text-sm text-ink-600 tabular-nums">
						{quote.rate}
						{quote.rawRate !== `${quote.rate}00` && `（原始报价 ${quote.rawRate}）`}
						{" · 来源 "}{quote.source}{" · "}
						<time dateTime={quote.observedAt}>
							{new Date(quote.observedAt).toLocaleString("zh-CN", {
								timeZone: "Asia/Shanghai",
								hour12: false,
							})}（UTC+8）
						</time>
					</p>
				</div>
			)}

			{preview.impacts.balances.length > 0 && (
				<div>
					<h3 className="text-sm font-semibold text-foreground">余额变化</h3>
					<ul className="mt-2 space-y-1 text-sm text-ink-600">
						{preview.impacts.balances.map((balance) => (
							<li key={balance.currencyCode} className="tabular-nums">
								{balance.currencyCode}：{balance.before} → {balance.after}
							</li>
						))}
					</ul>
				</div>
			)}

			{preview.impacts.allocations.length > 0 && (
				<div>
					<h3 className="text-sm font-semibold text-foreground">
						本计划与资金来源
					</h3>
					{preview.impacts.allocations.map((allocation) => {
						const { currencyCode, unallocatedDelta } = allocation;
						const isSupplement = unallocatedDelta.startsWith("-");
						const isReturn = !isSupplement && unallocatedDelta !== "0.0000";
						return (
							<ul
								key={allocation.planId}
								className="mt-2 space-y-1 text-sm text-ink-600 tabular-nums"
							>
								<li>
									本计划分配总额 {allocation.amountBefore} →{" "}
									{allocation.amountAfter} {currencyCode}
								</li>
								<li>
									本计划累计已使用 {allocation.usedBefore} →{" "}
									{allocation.usedAfter} {currencyCode}
								</li>
								<li>
									本计划剩余分配 {allocation.remainingBefore} →{" "}
									{allocation.remainingAfter} {currencyCode}
								</li>
								{allocation.usedFromRemaining !== "0.0000" && (
									<li>
										从本计划剩余分配使用 {allocation.usedFromRemaining} {currencyCode}
									</li>
								)}
								<li>
									未分配余额 {isReturn ? "+" : ""}{unallocatedDelta} {currencyCode}
									{isSupplement && "（补入本计划并使用）"}
									{isReturn && "（收到返还）"}
								</li>
							</ul>
						);
					})}
				</div>
			)}

			{preview.impacts.costs.length > 0 && (
				<div>
					<h3 className="text-sm font-semibold text-foreground">成本影响</h3>
					<ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs text-ink-600">
						{preview.impacts.costs.map((cost) => (
							<li key={cost.usageId} className="tabular-nums">
								使用 {cost.usageId.slice(-8)}：{cost.costBefore ?? "—"} →{" "}
								{cost.costAfter ?? "—"}
							</li>
						))}
					</ul>
				</div>
			)}

			{preview.impacts.warnings.map((warning) => (
				<p
					key={warning}
					className="flex items-start gap-2 rounded-xl bg-cream-100 px-4 py-3 text-xs leading-5 text-ink-600"
				>
					<Info className="mt-0.5 size-4 shrink-0 text-cream-300" />
					{warning}
				</p>
			))}

			{!hasBlockers && preview.diff.length === 0 ? (
				<p className="text-sm text-muted-foreground">内容一致，无变化。</p>
			) : null}
		</section>
	);
}
