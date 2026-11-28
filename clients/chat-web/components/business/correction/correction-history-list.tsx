"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { useState } from "react";
import type {
	CorrectionLogItem,
	CorrectionTargetType,
} from "@/lib/api/contract";
import { correctionsApi } from "@/lib/api/corrections";
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * 版本历史区（corrections 技术方案 §6「correction-history-list」）
 *
 * GET /corrections?targetType=&targetId= 分页展示（createdAt 倒序），
 * 含 APPLIED（已生效）与 FAILED（提交失败，附原因）——失败尝试同样留痕可查
 * （doc 09:76-84、验收场景 16）。使用记录同时展示快照中的金额和日期。
 */

export interface CorrectionHistoryListProps {
	targetType: CorrectionTargetType;
	targetId: string;
}

export function CorrectionHistoryList({
	targetType,
	targetId,
}: CorrectionHistoryListProps) {
	const isUsage = targetType === "USAGE";
	const [page, setPage] = useState(1);
	// 组织作用域缓存键 + 未选组织不发业务请求（评审 R2-I07）
	const orgId = useActiveOrgId();
	const query = useQuery({
		queryKey: withOrgScope(
			orgId,
			queryKeys.corrections.list(targetType, targetId, page),
		),
		queryFn: () => correctionsApi.list(targetType, targetId, page),
		enabled: orgId !== null,
		staleTime: isUsage ? 0 : undefined,
		placeholderData: isUsage ? keepPreviousData : undefined,
	});

	if (query.isLoading) {
		return (
			<div className="space-y-2">
				<Skeleton className="h-16 w-full rounded-xl" />
				<Skeleton className="h-16 w-full rounded-xl" />
			</div>
		);
	}

	if (query.isError || !query.data) {
		return (
			<p
				className="flex items-center gap-2 text-sm text-muted-foreground"
				role="alert"
			>
				<CircleAlert className="size-4" />
				修改记录加载失败
			</p>
		);
	}

	if (query.data.items.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				该记录暂无更正历史（首次录入为第 1 版）。
			</p>
		);
	}

	const pageCount = Math.ceil(query.data.total / query.data.pageSize);

	return (
		<>
			<ul className="space-y-3" data-testid="correction-history-list">
				{query.data.items.map((item) => (
					<li
						key={item.id}
						className="rounded-xl border border-border bg-white px-4 py-3"
					>
						<div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
							<div className="min-w-0 flex-1">
								<p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
									{item.status === "APPLIED" ? (
										<CircleCheck className="size-4 shrink-0 text-commit" />
									) : (
										<CircleX className="size-4 shrink-0 text-destructive" />
									)}
									{item.status === "APPLIED" ? "更正已生效" : "提交失败"}
								</p>
								<p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
									原因：{item.reason}
								</p>
								{item.status === "FAILED" && item.failReason ? (
									<p className="mt-0.5 break-words text-xs text-destructive">
										失败原因：{item.failReason}
									</p>
								) : null}
							</div>
							<time
								dateTime={item.createdAt}
								className="shrink-0 text-xs text-muted-foreground tabular-nums"
							>
								{item.createdAt.slice(0, 16).replace("T", " ")}
							</time>
						</div>
						{isUsage && <UsageSnapshotComparison item={item} />}
					</li>
				))}
			</ul>
			{isUsage && pageCount > 1 && (
				<div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={page <= 1 || query.isPlaceholderData}
						onClick={() => setPage(page - 1)}
					>
						上一页
					</Button>
					<span aria-live="polite">
						第 {query.data.page} / {pageCount} 页
					</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={page >= pageCount || query.isPlaceholderData}
						onClick={() => setPage(page + 1)}
					>
						下一页
					</Button>
				</div>
			)}
		</>
	);
}

function readSnapshotFields(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function formatUsageAmount(amount: unknown, currencyCode: unknown): string {
	if (typeof amount !== "string") return "—";
	return typeof currencyCode === "string" ? `${amount} ${currencyCode}` : amount;
}

function formatUsageDate(date: unknown): string {
	return typeof date === "string" ? date.slice(0, 10) : "—";
}

function UsageSnapshotComparison({ item }: { item: CorrectionLogItem }) {
	const before = readSnapshotFields(item.beforeSnapshot.target);
	const applied = item.status === "APPLIED";
	const changes = readSnapshotFields(item.beforeSnapshot.changes);
	const after = applied
		? readSnapshotFields(item.afterSnapshot.target)
		: { ...before, ...changes };
	const fields = [
		[
			"使用金额",
			formatUsageAmount(before.amount, before.currencyCode),
			formatUsageAmount(after.amount, after.currencyCode),
		],
		["使用日期", formatUsageDate(before.usedAt), formatUsageDate(after.usedAt)],
	];

	return (
		<table className="mt-3 w-full text-left text-xs tabular-nums">
			<thead className="text-muted-foreground">
				<tr>
					<th scope="col" className="py-1 pr-2 font-medium">
						字段
					</th>
					<th scope="col" className="py-1 pr-2 font-medium">
						修改前
					</th>
					<th scope="col" className="py-1 font-medium">
						{applied ? "修改后" : "拟修改值"}
					</th>
				</tr>
			</thead>
			<tbody>
				{fields.map(([label, previous, next]) => (
					<tr key={label} className="border-t border-border">
						<th scope="row" className="py-1 pr-2 font-medium">
							{label}
						</th>
						<td className="py-1 pr-2">{previous}</td>
						<td className="py-1">{next}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
