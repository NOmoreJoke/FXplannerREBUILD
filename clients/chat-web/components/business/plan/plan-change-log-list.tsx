"use client";

import type { PlanChangeLog } from "@/lib/api/contract";
import { Badge } from "@/components/ui/badge";
import { formatDisplayAmount } from "@/components/business/plan/schedule-preview-card";

/**
 * 修改记录列表（changes/plan-management/技术方案.md §5.2 plan-change-log-list）
 *
 * 展示「改了什么、原来多少、现在多少、释放了多少、什么时候改的」；
 * 后端按时间倒序返回，此处按原顺序渲染（最新在最上）。
 */

/** 变更主类型 → 展示文案（官方术语；六值枚举，未知值回退原文） */
const CHANGE_TYPE_LABEL: Record<string, string> = {
	TARGET_ADJUSTED: "目标金额调整",
	ALLOCATION_ADJUSTED: "分配总额调整",
	PARAMS_ADJUSTED: "节奏 / 缓冲调整",
	COMPLETED: "完成确认",
	CANCELLED: "取消计划",
	REOPENED: "重新开启",
};

/** 展示时间：ISO 8601 → yyyy-MM-dd HH:mm（本地时区） */
function formatDisplayTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function PlanChangeLogList({ logs }: { logs: PlanChangeLog[] }) {
	if (logs.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				暂无修改记录。计划后续的调整、完成、取消都会留存在这里。
			</p>
		);
	}

	return (
		<ul className="divide-y divide-border">
			{logs.map((log) => {
				const label = CHANGE_TYPE_LABEL[log.changeType] ?? log.changeType;
				const targetChanged = log.beforeTarget !== log.afterTarget;
				const allocChanged = log.beforeAlloc !== log.afterAlloc;
				const released = Number(log.releasedAmount) > 0;
				return (
					<li key={log.id} className="py-3 text-sm first:pt-0 last:pb-0">
						<div className="flex items-center justify-between gap-3">
							<Badge
								variant="outline"
								className="shrink-0 border-commit bg-commit-subtle text-commit"
							>
								{label}
							</Badge>
							<span className="text-xs text-muted-foreground">
								{formatDisplayTime(log.createdAt)}
							</span>
						</div>
						<div className="mt-1.5 text-xs text-ink-600">
							{targetChanged ? (
								<span>
									目标金额 {formatDisplayAmount(log.beforeTarget)} →{" "}
									{formatDisplayAmount(log.afterTarget)}
								</span>
							) : null}
							{targetChanged && allocChanged ? "；" : null}
							{allocChanged ? (
								<span>
									分配总额 {formatDisplayAmount(log.beforeAlloc)} →{" "}
									{formatDisplayAmount(log.afterAlloc)}
								</span>
							) : null}
							{!targetChanged && !allocChanged ? (
								<span>参数调整（详见变更前后快照）</span>
							) : null}
							{released ? (
								<span className="ml-1 text-muted-foreground">
									· 释放分配 {formatDisplayAmount(log.releasedAmount)}
								</span>
							) : null}
						</div>
					</li>
				);
			})}
		</ul>
	);
}
