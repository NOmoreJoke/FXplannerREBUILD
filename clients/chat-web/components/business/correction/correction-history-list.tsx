"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import type { CorrectionTargetType } from "@/lib/api/contract";
import { correctionsApi } from "@/lib/api/corrections";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * 版本历史区（corrections 技术方案 §6「correction-history-list」）
 *
 * GET /corrections?targetType=&targetId= 分页展示（createdAt 倒序），
 * 含 APPLIED（已生效）与 FAILED（提交失败，附原因）——失败尝试同样留痕可查
 * （doc 09:76-84、验收场景 16）。原样渲染快照 JSON 摘要由详情页负责组装。
 */

export interface CorrectionHistoryListProps {
	targetType: CorrectionTargetType;
	targetId: string;
}

export function CorrectionHistoryList({
	targetType,
	targetId,
}: CorrectionHistoryListProps) {
	const query = useQuery({
		queryKey: ["corrections", "list", targetType, targetId],
		queryFn: () => correctionsApi.list(targetType, targetId),
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

	return (
		<ul className="space-y-3" data-testid="correction-history-list">
			{query.data.items.map((item) => (
				<li
					key={item.id}
					className="rounded-xl border border-border bg-white px-4 py-3"
				>
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0">
							<p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
								{item.status === "APPLIED" ? (
									<CircleCheck className="size-4 shrink-0 text-mint-700" />
								) : (
									<CircleX className="size-4 shrink-0 text-destructive" />
								)}
								{item.status === "APPLIED" ? "更正已生效" : "提交失败"}
							</p>
							<p className="mt-1 truncate text-xs text-muted-foreground">
								原因：{item.reason}
							</p>
							{item.status === "FAILED" && item.failReason ? (
								<p className="mt-0.5 truncate text-xs text-destructive">
									失败原因：{item.failReason}
								</p>
							) : null}
						</div>
						<time className="shrink-0 text-xs text-muted-foreground tabular-nums">
							{item.createdAt.slice(0, 16).replace("T", " ")}
						</time>
					</div>
				</li>
			))}
		</ul>
	);
}
