"use client";

import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { getCurrencyName } from "@/lib/api/currencies";
import type { TransactionDto } from "@/lib/api/contract";

/**
 * 交易详情卡（changes/transaction-entry/技术方案.md §5.2 / §6）
 *
 * 纯展示组件：金额一律原样展示后端返回的 toFixed(4) / toFixed(8) 字符串，
 * 前端不做二次舍入。手续费未知时 feeAmount=null、totalCost=null、
 * feeKnown=false —— 显示「费用未明确」提示与「成本不完整」，绝不当 0 计算。
 */

export interface TransactionDetailProps {
	detail: TransactionDto;
}

/** ISO 8601 UTC 时间戳 → yyyy-MM-dd（交易日期按用户所选日期语义落库，直接取日期部分） */
function formatDisplayDate(isoDate: string): string {
	return isoDate.slice(0, 10);
}

export function TransactionDetail({ detail }: TransactionDetailProps) {
	const currencyName = getCurrencyName(detail.currencyCode);

	return (
		<div className="space-y-6">
			{!detail.feeKnown && (
				<section
					className="flex items-start gap-3 rounded-xl bg-cream-100 px-5 py-4"
					role="alert"
				>
					<CircleAlert className="mt-0.5 size-5 shrink-0 text-cream-300" />
					<div>
						<p className="text-sm font-semibold text-foreground">
							费用未明确
						</p>
						<p className="mt-0.5 text-xs leading-5 text-ink-600">
							本笔交易手续费未知（未知 ≠ 0），交易总成本不完整；
							了解实际费用后可通过更正功能补录。
						</p>
					</div>
				</section>
			)}

			<section className="rounded-2xl border border-border bg-white p-6">
				<div className="flex items-start justify-between">
					<h2 className="text-base font-bold text-foreground">买入详情</h2>
					<span className="rounded-full bg-mint-50 px-3 py-1.5 text-xs font-medium text-mint-700">
						{detail.currencyCode}
						{currencyName ? ` · ${currencyName}` : ""}
					</span>
				</div>

				<dl className="mt-5 divide-y divide-border">
					<DetailRow
						label="到账数量"
						value={`${detail.quantity} ${detail.currencyCode}`}
					/>
					<DetailRow
						label="本金"
						value={`${detail.principalAmount} ${detail.currencyCode}`}
					/>
					<DetailRow
						label="手续费"
						value={
							detail.feeAmount === null
								? "未知（未明确，不当 0 计算）"
								: `${detail.feeAmount} ${detail.currencyCode}`
						}
						muted={detail.feeAmount === null}
					/>
					<DetailRow
						label="交易总成本"
						value={
							detail.totalCost === null
								? "不完整（费用未明确）"
								: `${detail.totalCost} ${detail.currencyCode}`
						}
						muted={detail.totalCost === null}
					/>
					<DetailRow
						label="成交汇率"
						value={`1 ${detail.currencyCode} = ${detail.exchangeRate}`}
					/>
					<DetailRow
						label="交易日期"
						value={formatDisplayDate(detail.transactedAt)}
					/>
					<DetailRow
						label="关联计划"
						value={
							detail.planName ? (
								<Link
									href={`/plans`}
									className="text-mint-700 hover:underline"
								>
									{detail.planName}
								</Link>
							) : (
								"未关联"
							)
						}
					/>
					<DetailRow label="记录版本" value={`v${detail.version}`} />
				</dl>
			</section>
		</div>
	);
}

function DetailRow({
	label,
	value,
	muted = false,
}: {
	label: string;
	value: React.ReactNode;
	muted?: boolean;
}) {
	return (
		<div className="flex items-center justify-between py-3 text-sm">
			<dt className="text-muted-foreground">{label}</dt>
			<dd
				className={
					muted
						? "font-medium text-ink-500"
						: "font-semibold text-foreground"
				}
			>
				{value}
			</dd>
		</div>
	);
}
