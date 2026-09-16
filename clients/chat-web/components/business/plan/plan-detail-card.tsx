"use client";

import { CircleCheck, CircleDashed } from "lucide-react";
import type { PacePreference, PlanDetail } from "@/lib/api/contract";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
	InstallmentScheduleList,
	formatDisplayAmount,
	formatDisplayDate,
} from "@/components/business/plan/schedule-preview-card";

/**
 * 换汇计划详情卡（changes/plan-management/技术方案.md §5.2 plan-detail-card）
 *
 * 目标金额 / 累计已使用 / 分配总额 / 计划剩余分配 / 资金缺口 /
 * 最晚准备日期 + 准备节点进度展示；gap = 0 即「钱已备齐」。
 * 纯受控组件：只读展示 PlanDetail，操作按钮由页面按 canXxx 装配。
 */

/** 资金准备节奏展示文案（官方术语：安心/均衡/主动，禁用保守/平衡/激进） */
const PACE_LABEL: Record<PacePreference, string> = {
	conservative: "安心",
	balanced: "均衡",
	aggressive: "主动",
};

export function PlanDetailCard({ plan }: { plan: PlanDetail }) {
	// 准备进度 = 累计已使用 / 目标金额（服务端金额为字符串，这里仅展示层换算）
	const target = Number(plan.targetAmount);
	const used = Number(plan.usedAmount);
	const progressPercent =
		Number.isFinite(target) && target > 0 && Number.isFinite(used)
			? Math.min(100, Math.round((used / target) * 100))
			: 0;
	const isPrepared = Number(plan.gap) === 0;

	return (
		<div className="space-y-6">
			{/* 概要卡：名称/状态/进度 */}
			<section className="rounded-2xl border border-border bg-white p-6">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<h2 className="truncate text-lg font-bold text-foreground">
							{plan.name ?? "未命名计划"}
						</h2>
						<p className="mt-1 text-xs text-muted-foreground">
							目标币种 {plan.targetCurrency} · 资金准备节奏{" "}
							{PACE_LABEL[plan.pacePreference]} · 准备缓冲 {plan.prepLeadDays}{" "}
							个工作日
						</p>
					</div>
					{isPrepared && plan.status === "ACTIVE" ? (
						<Badge className="border-mint-200 bg-mint-50 text-mint-700">
							钱已备齐
						</Badge>
					) : null}
				</div>

				<div className="mt-5">
					<div className="flex items-center justify-between text-xs text-muted-foreground">
						<span>
							准备进度：已使用 {formatDisplayAmount(plan.usedAmount)} / 目标{" "}
							{formatDisplayAmount(plan.targetAmount)} {plan.targetCurrency}
						</span>
						<span>{progressPercent}%</span>
					</div>
					<Progress value={progressPercent} className="mt-2 h-2" />
				</div>

				<dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
					<AmountCell
						label="目标金额"
						value={plan.targetAmount}
						currency={plan.targetCurrency}
					/>
					<AmountCell
						label="累计已使用"
						value={plan.usedAmount}
						currency={plan.targetCurrency}
					/>
					<AmountCell
						label="分配总额"
						value={plan.allocatedAmount}
						currency={plan.targetCurrency}
					/>
					<AmountCell
						label="计划剩余分配"
						value={plan.remainingAllocation}
						currency={plan.targetCurrency}
					/>
				</dl>

				<div
					className={`mt-5 rounded-xl px-4 py-3 text-sm ${
						isPrepared
							? "bg-mint-50 text-mint-700"
							: "bg-cream-100 text-foreground"
					}`}
				>
					{isPrepared ? (
						<>钱已备齐：还需使用的资金已全部有分配。</>
					) : (
						<>
							资金缺口{" "}
							<span className="font-bold">
								{formatDisplayAmount(plan.gap)} {plan.targetCurrency}
							</span>
							，按排期分批准备即可。
						</>
					)}
				</div>

				<div className="mt-4 grid gap-2 text-xs text-muted-foreground md:grid-cols-3">
					<span>预计使用日期：{formatDisplayDate(plan.expectUseDate)}</span>
					<span>最晚准备日期：{formatDisplayDate(plan.latestPrepDate)}</span>
					<span>
						下一准备节点：
						{plan.nextInstallmentAt
							? formatDisplayDate(plan.nextInstallmentAt)
							: "无未到期节点"}
					</span>
				</div>
			</section>

			{/* 准备节点 */}
			<section className="rounded-2xl border border-border bg-white p-6">
				<h3 className="text-base font-bold text-foreground">准备节点</h3>
				<p className="mt-1 text-xs text-muted-foreground">
					按建议节奏拆分的分批准备安排，修改目标或节奏后会重新生成。
				</p>
				{plan.installments.length > 0 ? (
					<div className="mt-4">
						<InstallmentScheduleList
							installments={plan.installments}
							targetCurrency={plan.targetCurrency}
						/>
					</div>
				) : (
					<p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
						<CircleDashed className="size-4" />
						暂无准备节点
						{plan.status === "CANCELLED"
							? "（计划已取消）"
							: "（资金缺口为 0，无需排期）"}
					</p>
				)}
			</section>
		</div>
	);
}

/** 金额格：官方术语标签 + 去尾零金额 + 币种 */
function AmountCell({
	label,
	value,
	currency,
}: {
	label: string;
	value: string;
	currency: string;
}) {
	return (
		<div className="rounded-xl bg-muted/40 px-3 py-2.5">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="mt-0.5 font-bold text-foreground">
				{formatDisplayAmount(value)}
				<span className="ml-1 text-xs font-normal text-muted-foreground">
					{currency}
				</span>
			</dd>
		</div>
	);
}

/** 完成确认入口的就绪提示（详情页按 canComplete 显隐按钮时复用文案） */
export function PlanCompleteHint({ plan }: { plan: PlanDetail }) {
	if (Number(plan.gap) !== 0 || plan.usedAmount !== plan.targetAmount) {
		return null;
	}
	return (
		<p className="flex items-center gap-1.5 text-xs text-mint-700">
			<CircleCheck className="size-3.5" />
			已使用金额等于目标金额且剩余分配为 0，可进行完成确认。
		</p>
	);
}
