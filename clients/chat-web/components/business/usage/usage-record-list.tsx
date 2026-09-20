"use client";

import { CircleDashed } from "lucide-react";
import type { UsageRecord, UsageListResp } from "@/lib/api/contract";

/**
 * 使用记录列表（usage-recording 技术方案 §5.2 / 需求 §6.5）
 *
 * 每行显示：使用日期、金额、备注（未填则不显示）、本笔使用成本（本位币）。
 * 数据已由服务端按 usedAt 倒序、同刻录入先后倒序排列；空状态显示
 * 「还没有使用记录」（记录使用入口由页面另行保留）。
 */

/** 展示用金额（去尾零） */
function displayAmount(value: string): string {
	if (!/^\d+(\.\d+)?$/.test(value)) return value;
	const [intPart, decimalPart] = value.split(".");
	const trimmed = decimalPart?.replace(/0+$/, "") ?? "";
	return trimmed ? `${intPart}.${trimmed}` : intPart;
}

export function UsageRecordList({
	ledger,
	currencyCode,
}: {
	/** 使用记录列表（GET /plans/:id/usages 的 data） */
	ledger: UsageListResp;
	currencyCode: string;
}) {
	const items: UsageRecord[] = ledger.items;

	if (items.length === 0) {
		return (
			<p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
				<CircleDashed className="size-4" />
				还没有使用记录
			</p>
		);
	}

	return (
		<ul className="mt-4 divide-y divide-border">
			{items.map((item) => (
				<li
					key={item.id}
					className="flex items-center justify-between gap-4 py-3"
				>
					<div className="min-w-0">
						<p className="text-sm font-bold text-foreground">
							{displayAmount(item.amount)} {currencyCode}
						</p>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{item.usedAt.slice(0, 10)}
							{item.remark ? ` · ${item.remark}` : ""}
						</p>
					</div>
					<div className="shrink-0 text-right">
						<p className="text-xs text-muted-foreground">使用成本</p>
						<p className="text-sm font-bold text-foreground">
							{displayAmount(item.cost)}
						</p>
					</div>
				</li>
			))}
		</ul>
	);
}
