"use client";

import { Wallet } from "lucide-react";
import { formatReportAmount } from "@/components/business/report/plan-cost-summary-card";

/**
 * 账户成本卡（reports 技术方案 §6 account-cost-card）。
 *
 * 报告中心顶部按币种展示剩余成本与平均成本；数据复用既有
 * GET /accounts/:currencyCode（AccountDetail.remainingTotalCost / averageUnitCost，
 * 前端 Promise.all 并发逐币种装配，方案 §5.3 零后端改动）。
 * 空值口径（需求 5.3）：余额 0 / 批次缺失 → 不显示平均成本，显示「暂无法计算」，
 * 绝不显示 0；不同币种金额绝不合计。
 */

/** 单币种账户成本（页面从 accountsApi.detail 装配的字段拷贝） */
export interface AccountCostItem {
	currencyCode: string;
	/** 剩余外币数量（Account.balance，金额字符串） */
	balance: string;
	/** 剩余成本（本位币；null = 无批次/无法计算） */
	remainingTotalCost: string | null;
	/** 平均单位成本（toFixed(8)；null = 余额 0 或全部消耗，不计算） */
	averageUnitCost: string | null;
}

export interface AccountCostCardProps {
	/** 本位币（成本列币种角标；null 退化为纯金额） */
	baseCurrency: string | null;
	items: AccountCostItem[];
}

export function AccountCostCard({ baseCurrency, items }: AccountCostCardProps) {
	if (items.length === 0) {
		return null; // 未建任何账户时隐藏区块（空状态引导由计划列表区承担）
	}
	const costCurrency = baseCurrency ?? undefined;

	return (
		<section
			data-testid="account-cost-card"
			className="rounded-2xl border border-border bg-white p-6"
		>
			<div className="flex items-center gap-2">
				<Wallet className="size-4 text-mint-700" />
				<h3 className="text-base font-bold text-foreground">账户成本摘要</h3>
			</div>
			<p className="mt-1 text-xs text-muted-foreground">
				账户里还没使用的外币当初花多少钱买的（按币种分列，不跨币种汇总）。
			</p>

			<div className="mt-4 grid gap-3 md:grid-cols-2">
				{items.map((item) => (
					<div
						key={item.currencyCode}
						data-testid={`account-cost-${item.currencyCode}`}
						className="rounded-xl border border-border p-4"
					>
						<div className="flex items-center justify-between">
							<span className="text-sm font-semibold text-foreground">
								{item.currencyCode}
							</span>
							<span className="text-xs text-muted-foreground">
								剩余 {formatReportAmount(item.balance, item.currencyCode)}{" "}
								{item.currencyCode}
							</span>
						</div>
						<dl className="mt-2 grid grid-cols-2 gap-x-4 text-sm">
							<div>
								<dt className="text-xs text-muted-foreground">剩余成本</dt>
								<dd className="mt-0.5 font-semibold text-foreground">
									{item.remainingTotalCost === null ? (
										<span
											data-testid={`cost-unavailable-${item.currencyCode}`}
											className="font-normal text-muted-foreground"
										>
											暂无法计算
										</span>
									) : (
										<>
											{formatReportAmount(
												item.remainingTotalCost,
												costCurrency ?? "CNY",
											)}
											<span className="ml-1 text-xs font-normal text-muted-foreground">
												{costCurrency ?? ""}
											</span>
										</>
									)}
								</dd>
							</div>
							<div>
								<dt className="text-xs text-muted-foreground">平均成本</dt>
								<dd className="mt-0.5 font-semibold text-foreground">
									{item.averageUnitCost === null ? (
										<span
											data-testid={`average-unavailable-${item.currencyCode}`}
											className="font-normal text-muted-foreground"
										>
											暂无法计算
										</span>
									) : (
										formatReportAmount(
											item.averageUnitCost,
											costCurrency ?? "CNY",
										)
									)}
								</dd>
							</div>
						</dl>
					</div>
				))}
			</div>
			<p className="mt-3 text-xs text-muted-foreground">
				初始成本为记账起点，不代表当年实际买入花费。
			</p>
		</section>
	);
}
