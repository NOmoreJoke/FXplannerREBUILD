"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, FileCheck2 } from "lucide-react";
import { PermissionHint } from "@/components/base";
import { Button } from "@/components/ui/button";
import type { AiPlanDraft } from "@/lib/api/chat";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { useOrganizationCapabilities } from "@/lib/hooks/use-organization-capabilities";

const PACE_LABELS: Record<AiPlanDraft["pacePreference"], string> = {
	conservative: "安心 · 首批 50%",
	balanced: "均衡 · 三等分",
	aggressive: "主动 · 首批 20%",
};

function buildConfirmHref(
	draft: AiPlanDraft,
	sourceOrgId: string | null,
): string {
	const params = new URLSearchParams({
		fromDraft: "1",
		agentRunId: draft.agentRunId,
		targetCurrency: draft.targetCurrency,
		targetAmount: draft.targetAmount,
		expectUseDate: draft.expectUseDate.slice(0, 10),
		prepLeadDays: String(draft.prepLeadDays),
		pacePreference: draft.pacePreference,
		allocatedAmount: draft.allocatedAmount,
	});
	if (sourceOrgId) {
		params.set("sourceOrgId", sourceOrgId);
	}
	if (draft.name) {
		params.set("name", draft.name);
	}
	return `/plans/new?${params.toString()}`;
}

export interface PlanDraftCardProps {
	draft: AiPlanDraft;
}

/**
 * AI 计划草稿建议卡（ToB R2 P8；需求 §9.3 / §15.4 GWT-21..23）。
 *
 * 纪律：
 * - 明确标注「草稿 · 未保存」，不触发任何正式 Plan 创建；
 * - 权限显隐走 useOrganizationCapabilities().can("plan.create")（fail-closed）：
 *   有权限显示「去确认并保存」跳转 /plans/new（携带草稿参数与 agentRunId）与「暂不采用」；
 *   无权限（如 Viewer）仅渲染 PermissionHint 只读说明。
 */
export function PlanDraftCard({ draft }: PlanDraftCardProps) {
	const activeOrgId = useActiveOrgId();
	const { can, isLoading } = useOrganizationCapabilities();
	const [dismissed, setDismissed] = useState(false);

	const canSave = !isLoading && can("plan.create");

	return (
		<div
			data-testid="plan-draft-card"
			className="mt-3 rounded-xl border-proposal bg-surface-paper p-3.5 text-foreground shadow-xs"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-1.5 text-xs font-semibold text-ink-900">
					<FileCheck2 className="size-3.5 shrink-0" aria-hidden="true" />
					<span>{draft.name || `${draft.targetCurrency} 换汇计划建议`}</span>
				</div>
				<span
					data-testid="plan-draft-badge"
					className="rounded-full border border-neutral-note bg-neutral-note px-2 py-0.5 text-[11px] font-medium text-ink-700"
				>
					计划草稿 · 未保存
				</span>
			</div>

			<dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
				<div>
					<dt className="text-muted-foreground">目标金额</dt>
					<dd className="font-medium">
						{draft.targetAmount} {draft.targetCurrency}
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">用途日期</dt>
					<dd className="font-medium">{draft.expectUseDate.slice(0, 10)}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">准备节奏</dt>
					<dd className="font-medium">
						{PACE_LABELS[draft.pacePreference] ?? draft.pacePreference}
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">计入已有外币</dt>
					<dd className="font-medium">
						{draft.allocatedAmount} {draft.targetCurrency}
					</dd>
				</div>
			</dl>

			{draft.installments.length > 0 && (
				<div className="mt-2.5 rounded-lg bg-muted/50 px-2.5 py-2 text-[11px] text-muted-foreground">
					<div className="font-medium text-foreground">
						建议分 {draft.installments.length} 批准备（最晚{" "}
						{draft.latestPrepDate.slice(0, 10)}）
					</div>
					<ul className="mt-1 space-y-0.5">
						{draft.installments.map((item) => (
							<li key={item.seq} className="flex justify-between gap-2">
								<span>
									第 {item.seq} 批 · {item.scheduledAt.slice(0, 10)}
								</span>
								<span className="font-medium text-foreground">
									{item.amount} {draft.targetCurrency}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}

			<div className="mt-3">
				{!canSave ? (
					<PermissionHint testId="plan-draft-readonly-hint">
						当前只读角色仅可查看建议，无权保存为正式计划；如需创建请联系组织所有者、管理员、财务或运营。
					</PermissionHint>
				) : dismissed ? (
					<p
						data-testid="plan-draft-dismissed"
						className="rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground"
					>
						已暂不采用该草稿建议，未创建任何正式计划。
					</p>
				) : (
					<div className="flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							className="h-8 bg-ink-900 text-xs text-white hover:bg-ink-900/90"
							asChild
						>
							<Link
								href={buildConfirmHref(draft, activeOrgId)}
								data-testid="plan-draft-confirm-link"
							>
								<span>去确认并保存</span>
								<ArrowRight className="ml-1 size-3.5" aria-hidden="true" />
							</Link>
						</Button>
						<Button
							type="button"
							size="sm"
							variant="outline"
							className="h-8 bg-white text-xs"
							data-testid="plan-draft-dismiss"
							onClick={() => setDismissed(true)}
						>
							暂不采用
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
