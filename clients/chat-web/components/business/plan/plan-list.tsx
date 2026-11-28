"use client";

import Link from "next/link";
import { CircleAlert, Plus } from "lucide-react";
import Decimal from "decimal.js";
import type { PlanDetail, PlanListItem } from "@/lib/api/contract";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
	formatDisplayAmount,
	formatDisplayDate,
} from "@/components/business/plan/schedule-preview-card";
import { useOrganizationCapabilities } from "@/lib/hooks/use-organization-capabilities";

/**
 * 换汇计划列表卡（changes/plan-management/技术方案.md §5.2 plan-list）
 *
 * 列表卡片 + 状态徽标 + 「新建计划」按钮（plan.create 能力门控）+ 准备进度条（阶段5 §3）；
 * 金额/日期为服务端口径的展示格式化（去尾零 / 取日期部分）。数据由页面装配，
 * 入口显隐按后端 capabilities（Goal #3B W28；后端仍强制校验，这里只防误触）。
 */

/** 状态徽标文案与配色（官方术语：进行中/已完成/已取消） */
const STATUS_BADGE: Record<
	PlanListItem["status"],
	{ label: string; className: string }
> = {
	ACTIVE: {
		label: "进行中",
		className: "border-commit bg-commit-subtle text-commit",
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

/**
 * 准备进度百分比（阶段5 §3 口径，与 M7 双进度同源）：
 * （目标 − 缺口）÷ 目标 × 100。gap 由服务端 plan-calculator 唯一计算下发，
 * 前端只做一次展示除法；Decimal 字符串运算，四舍五入取整、钳位 0-100、目标 ≤ 0 → 0
 * （先例 use-home-state.ts deriveFocusPlan）。所有状态按同一公式如实展示，不做特判。
 */
function preparationPercent(plan: PlanDetail | PlanListItem): number {
	const target = new Decimal(plan.targetAmount);
	if (target.lte(0)) {
		return 0;
	}
	const prepared = target.minus(new Decimal(plan.gap));
	const percent = prepared
		.div(target)
		.mul(100)
		.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
	return Math.min(100, Math.max(0, percent.toNumber()));
}

export interface PlanListProps {
	items: PlanListItem[];
	isLoading: boolean;
	isError: boolean;
	onRetry: () => void;
}

export function PlanList({
	items,
	isLoading,
	isError,
	onRetry,
}: PlanListProps) {
	// 「新建计划」入口需 plan.create（Viewer 不显示，而不是点进去吃 403）
	const { can } = useOrganizationCapabilities();
	const canCreate = can("plan.create");

	return (
		<div className="mx-auto max-w-5xl px-8 py-6">
			<header className="mb-6 flex items-center justify-between">
				<div>
					<h1 className="text-xl font-bold text-foreground">换汇计划</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						管理分批准备外币的全部计划：查看进度、调整目标与分配。
					</p>
				</div>
				{canCreate ? (
					<Link
						href="/plans/new"
						data-testid="plan-create-entry"
						className={buttonVariants({
							className: "bg-ink-900 text-white hover:bg-ink-900/90",
						})}
					>
						<Plus className="size-4" />
						新建计划
					</Link>
				) : null}
			</header>

			{isLoading ? (
				<div className="space-y-4">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-40 rounded-2xl" />
					))}
				</div>
			) : isError ? (
				<div className="flex flex-col items-center rounded-2xl border border-border bg-white px-8 py-16 text-center">
					<CircleAlert className="size-10 text-ink-300" />
					<h2 className="mt-4 text-base font-bold text-foreground">
						计划列表加载失败
					</h2>
					<p className="mt-2 text-sm text-muted-foreground">
						网络异常或服务暂不可用，请稍后重试。
					</p>
					<Button
						className="mt-6 bg-ink-900 text-white hover:bg-ink-900/90"
						onClick={onRetry}
					>
						重试
					</Button>
				</div>
			) : items.length === 0 ? (
				<div className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-white px-8 py-16 text-center">
					<h2 className="text-base font-bold text-foreground">
						还没有换汇计划
					</h2>
					<p className="mt-2 max-w-md text-sm text-muted-foreground">
						设定一个目标金额与用途日期，系统会按你选择的节奏自动生成分批准备排期。
					</p>
					{canCreate ? (
						<Link
							href="/plans/new"
							className={buttonVariants({
								className: "mt-6 bg-ink-900 text-white hover:bg-ink-900/90",
							})}
						>
							<Plus className="size-4" />
							新建计划
						</Link>
					) : (
						<p className="mt-6 text-xs text-muted-foreground">
							当前角色无权创建换汇计划，请联系组织所有者、管理员或财务创建
						</p>
					)}
				</div>
			) : (
				<div className="grid gap-4 md:grid-cols-2">
					{items.map((plan) => (
						<PlanCard key={plan.id} plan={plan} />
					))}
				</div>
			)}
		</div>
	);
}

/** 单张计划卡：状态徽标 + 核心金额四项 + 准备节点提示，整卡进入详情 */
function PlanCard({ plan }: { plan: PlanDetail | PlanListItem }) {
	const badge = STATUS_BADGE[plan.status];
	const isPrepared = plan.status === "ACTIVE" && Number(plan.gap) === 0;

	return (
		<Link
			href={`/plans/${plan.id}`}
			className="block rounded-2xl border border-border bg-white p-5 transition-colors hover:border-ink-300"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="truncate text-base font-bold text-foreground">
						{plan.name ?? "未命名计划"}
					</h3>
					<p className="mt-0.5 text-xs text-muted-foreground">
						目标币种 {plan.targetCurrency}
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{isPrepared ? (
						<Badge className="border-neutral-note bg-neutral-note text-ink-700">
							钱已备齐
						</Badge>
					) : null}
					<Badge className={badge.className}>{badge.label}</Badge>
				</div>
			</div>

			<dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
				<AmountRow
					label="目标金额"
					value={formatDisplayAmount(plan.targetAmount)}
					currency={plan.targetCurrency}
				/>
				<AmountRow
					label="累计已使用"
					value={formatDisplayAmount(plan.usedAmount)}
					currency={plan.targetCurrency}
				/>
				<AmountRow
					label="分配总额"
					value={formatDisplayAmount(plan.allocatedAmount)}
					currency={plan.targetCurrency}
				/>
				<AmountRow
					label="资金缺口"
					value={formatDisplayAmount(plan.gap)}
					currency={plan.targetCurrency}
				/>
			</dl>

			{/* 准备进度条（阶段5 §3）：所有状态同一公式如实展示 */}
			<div className="mt-3">
				<div className="flex items-center justify-between text-xs text-ink-600">
					<span>准备进度</span>
					<span className="font-semibold tabular-nums">
						{preparationPercent(plan)}%
					</span>
				</div>
				<Progress value={preparationPercent(plan)} className="mt-1.5" />
			</div>

			<div className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
				最晚准备日期 {formatDisplayDate(plan.latestPrepDate)}
				{plan.nextInstallmentAt
					? ` · 下一准备节点 ${formatDisplayDate(plan.nextInstallmentAt)}`
					: ""}
			</div>
		</Link>
	);
}

/** 金额行：官方术语标签 + 去尾零金额 + 币种 */
function AmountRow({
	label,
	value,
	currency,
}: {
	label: string;
	value: string;
	currency: string;
}) {
	return (
		<div>
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="mt-0.5 font-semibold text-foreground">
				{value}
				<span className="ml-1 text-xs font-normal text-muted-foreground">
					{currency}
				</span>
			</dd>
		</div>
	);
}
