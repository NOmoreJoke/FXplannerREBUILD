"use client";

import Link from "next/link";
import { ChevronDown, CircleDashed, PencilLine } from "lucide-react";
import { CorrectionHistoryList } from "@/components/business/correction";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { UsageRecord, UsageListResp } from "@/lib/api/contract";

/**
 * 使用记录列表（usage-recording 技术方案 §5.2 / 需求 §6.5）
 *
 * 每行显示：使用日期、金额、备注（未填则不显示）、本笔使用成本（本位币）、
 * 更正入口与该笔使用的更正历史。
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
				<Collapsible asChild key={item.id}>
					<li className="py-3">
						<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
							<div className="min-w-0">
								<p className="text-sm font-bold text-foreground">
									{displayAmount(item.amount)} {currencyCode}
								</p>
								<p className="mt-0.5 text-xs text-muted-foreground">
									{item.usedAt.slice(0, 10)}
									{item.remark ? ` · ${item.remark}` : ""}
								</p>
							</div>
							<div className="flex flex-wrap items-center gap-3">
								<div>
									<p className="text-xs text-muted-foreground">使用成本</p>
									<p className="text-sm font-bold text-foreground">
										{displayAmount(item.cost)}
									</p>
								</div>
								<Link
									href={`/corrections/new?targetType=USAGE&targetId=${item.id}`}
									data-testid="usage-correction-entry"
									aria-label={`更正使用记录 ${item.usedAt.slice(0, 10)}`}
									className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								>
									<PencilLine className="size-3" aria-hidden />
									更正
								</Link>
								<CollapsibleTrigger
									className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&[data-state=open]>svg]:rotate-180"
									aria-label={`更正历史 ${item.usedAt.slice(0, 10)} ${displayAmount(item.amount)} ${currencyCode}`}
								>
									更正历史
									<ChevronDown className="size-3" aria-hidden />
								</CollapsibleTrigger>
							</div>
						</div>
						<CollapsibleContent className="pt-3">
							<CorrectionHistoryList targetType="USAGE" targetId={item.id} />
						</CollapsibleContent>
					</li>
				</Collapsible>
			))}
		</ul>
	);
}
