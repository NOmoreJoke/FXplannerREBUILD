"use client";

import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
} from "@/components/ui/card";
import type { AccountDetail } from "@/lib/api/accounts";

/**
 * 账户金额卡（changes/account-module/技术方案.md §5.2）
 *
 * 四张金额卡：余额 / 已分配 / 未分配余额 / 平均单位成本（官方术语，doc 04 五项口径）。
 * 数值一律原样渲染接口返回的金额字符串（toFixed(4) / toFixed(8)），
 * 前端不做千分位/精度裁剪/浮点换算（保障 E2E toContainText 精确断言）；
 * null 显示「—」（平均单位成本在余额 0 或批次缺失时为 null，方案 §3.3）。
 */

export interface AccountSummaryCardsProps {
	/** 账户详情（GET /accounts/:currencyCode 的 data） */
	detail: AccountDetail;
}

export function AccountSummaryCards({ detail }: AccountSummaryCardsProps) {
	return (
		<section
			aria-label="账户金额概览"
			className="grid grid-cols-2 gap-4 md:grid-cols-4"
		>
			<AmountCard label="余额" value={detail.balance} />
			<AmountCard label="已分配" value={detail.allocatedAmount} />
			<AmountCard label="未分配余额" value={detail.unallocatedAmount} />
			<AmountCard label="平均单位成本" value={detail.averageUnitCost} />
		</section>
	);
}

/** 单张金额卡：label + 原样字符串值；null（不适用）显示「—」 */
function AmountCard({ label, value }: { label: string; value: string | null }) {
	return (
		<Card size="sm">
			<CardHeader>
				<CardDescription>{label}</CardDescription>
			</CardHeader>
			<CardContent>
				<p className="text-lg font-bold text-foreground tabular-nums">
					{value ?? "—"}
				</p>
			</CardContent>
		</Card>
	);
}
