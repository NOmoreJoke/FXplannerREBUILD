"use client";

import Link from "next/link";
import type {
	AccountDetail,
	AccountPlanAllocation,
} from "@/lib/api/accounts";
import { Badge } from "@/components/ui/badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

/**
 * 账户按计划分配只读表（阶段5 §2 功能 13 收尾；规格 04 硬约束）
 *
 * 纯只读事实展示：计划名 + 状态徽标 / 分配总额 / 累计已使用 / 剩余分配，
 * 底部合计行展示未分配余额（直接取 AccountDetailDto.unallocatedAmount，
 * 禁止前端重算）。分配与调整操作只在计划中，本组件不放任何操作按钮。
 * 金额原样渲染接口字符串（对齐同页流水表/摘要卡先例，禁止千分位/精度裁剪）。
 * CANCELLED 计划剩余 0 仍如实列出（与 allocatedAmount 汇总口径一致）。
 */

/** 计划状态 → 徽标（文案与配色对齐 plan-list.tsx STATUS_BADGE） */
const STATUS_BADGE: Record<
	AccountPlanAllocation["planStatus"],
	{ label: string; className: string }
> = {
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

export interface PlanAllocationTableProps {
	/** 按计划分配明细（GET /accounts/:currencyCode/allocations 的 data） */
	allocation: AccountPlanAllocation[];
	/** 账户详情（合计行取 unallocatedAmount，禁止前端重算） */
	detail: AccountDetail;
}

export function PlanAllocationTable({
	allocation,
	detail,
}: PlanAllocationTableProps) {
	const currency = detail.currencyCode;
	const empty = allocation.length === 0;

	return (
		<div className="overflow-hidden rounded-2xl border border-border bg-white">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>计划</TableHead>
						<TableHead>分配总额</TableHead>
						<TableHead>累计已使用</TableHead>
						<TableHead>剩余分配</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{empty ? (
						<TableRow>
							<TableCell
								colSpan={4}
								className="h-32 text-center text-sm text-muted-foreground"
							>
								暂无计划分配该币种
							</TableCell>
						</TableRow>
					) : (
						<>
							{allocation.map((item) => (
								<AllocationRow key={item.planId} item={item} />
							))}
							{/* 合计行：未分配余额直接取详情接口值（服务端口径唯一） */}
							<TableRow className="bg-muted/30 font-semibold">
								<TableCell>未分配余额</TableCell>
								<TableCell
									colSpan={2}
									className="text-xs font-normal text-muted-foreground"
								>
									余额 − Σ全部计划剩余分配
								</TableCell>
								<TableCell className="tabular-nums">
									{detail.unallocatedAmount} {currency}
								</TableCell>
							</TableRow>
						</>
					)}
				</TableBody>
			</Table>
		</div>
	);
}

/** 明细行：计划名（可跳计划详情）+ 状态徽标 + 三金额列（原样渲染，tabular-nums） */
function AllocationRow({ item }: { item: AccountPlanAllocation }) {
	const badge = STATUS_BADGE[item.planStatus] ?? {
		label: item.planStatus,
		className: "bg-muted text-muted-foreground border-border",
	};

	return (
		<TableRow>
			<TableCell>
				<div className="flex items-center gap-2">
					<Link
						href={`/plans/${item.planId}`}
						className="text-sm font-medium text-foreground hover:text-mint-700 hover:underline"
					>
						{item.planName ?? "未命名计划"}
					</Link>
					<Badge className={badge.className}>{badge.label}</Badge>
				</div>
			</TableCell>
			<TableCell className="font-medium text-foreground tabular-nums">
				{item.amount}
			</TableCell>
			<TableCell className="font-medium text-foreground tabular-nums">
				{item.usedAmount}
			</TableCell>
			<TableCell className="font-medium text-foreground tabular-nums">
				{item.remainingAllocation}
			</TableCell>
		</TableRow>
	);
}
