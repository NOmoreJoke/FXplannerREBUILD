"use client";

import Link from "next/link";
import { CircleAlert, PenLine } from "lucide-react";
import { getCurrencyName } from "@/lib/api/currencies";
import type { TransactionDto } from "@/lib/api/contract";
import { CorrectionHistoryList } from "@/components/business/correction";
import { useOrganizationCapabilities } from "@/lib/hooks/use-organization-capabilities";

/**
 * 交易详情卡（changes/transaction-entry/技术方案.md §5.2 / §6）
 *
 * 纯展示组件：金额一律原样展示后端返回的 toFixed(4) / toFixed(8) 字符串，
 * 前端不做二次舍入。手续费未知时 feeAmount=null、totalCost=null、
 * feeKnown=false —— 显示「费用未明确」提示与「成本不完整」，绝不当 0 计算。
 *
 * 单位口径（FE-01 修复）：到账数量为买入外币（currencyCode）；本金/手续费/
 * 交易总成本按后端契约一律为「本位币」，由父级从当前组织设置动态传入 baseCurrency；
 * 未就绪时省略币种后缀，不硬编码 CNY。
 *
 * 能力门控（Goal #3B W28）：「更正」入口需 correction.apply（Operator / Viewer 不显示，
 * 后端仍强制校验）。修改记录（含失败尝试）对所有可读角色照常展示。
 */

export interface TransactionDetailProps {
	detail: TransactionDto;
	/** 当前组织本位币；缺省时省略本金/手续费/总成本后缀 */
	baseCurrency?: string | null;
}

/** ISO 8601 UTC 时间戳 → yyyy-MM-dd（交易日期按用户所选日期语义落库，直接取日期部分） */
function formatDisplayDate(isoDate: string): string {
	return isoDate.slice(0, 10);
}

export function TransactionDetail({
	detail,
	baseCurrency = null,
}: TransactionDetailProps) {
	const currencyName = getCurrencyName(detail.currencyCode);
	const { can } = useOrganizationCapabilities();
	const canCorrect = can("correction.apply");
	const baseUnit = baseCurrency ? ` ${baseCurrency}` : "";

	return (
		<div className="space-y-6">
			{!detail.feeKnown && (
				<section
					className="flex items-start gap-3 rounded-xl border border-caution bg-caution px-5 py-4 text-caution"
					role="alert"
				>
					<CircleAlert className="mt-0.5 size-5 shrink-0 text-caution" />
					<div>
						<p className="text-sm font-semibold">费用未明确</p>
						<p className="mt-0.5 text-xs leading-5">
							本笔交易手续费未知（未知 ≠ 0），交易总成本不完整；
							{canCorrect
								? "了解实际费用后可通过更正功能补录。"
								: "如需补录实际费用，请联系有更正权限的成员。"}
						</p>
					</div>
				</section>
			)}

			<section className="rounded-2xl border border-border bg-white p-6">
				<div className="flex items-start justify-between">
					<h2 className="text-base font-bold text-foreground">买入详情</h2>
					<div className="flex items-center gap-2">
						<span className="rounded-full border border-neutral-note bg-neutral-note px-3 py-1.5 text-xs font-medium text-ink-700">
							{detail.currencyCode}
							{currencyName ? ` · ${currencyName}` : ""}
						</span>
						{canCorrect ? (
							<Link
								href={`/corrections/new?targetType=TRANSACTION&targetId=${detail.id}`}
								className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
								data-testid="correction-entry"
							>
								<PenLine className="size-3.5" />
								更正
							</Link>
						) : null}
					</div>
				</div>

				<dl className="mt-5 divide-y divide-border">
					<DetailRow
						label="到账数量"
						value={`${detail.quantity} ${detail.currencyCode}`}
					/>
					<DetailRow label="本金" value={`${detail.principalAmount}${baseUnit}`} />
					<DetailRow
						label="手续费"
						value={
							detail.feeAmount === null
								? "未知（未明确，不当 0 计算）"
								: `${detail.feeAmount}${baseUnit}`
						}
						muted={detail.feeAmount === null}
					/>
					<DetailRow
						label="交易总成本"
						value={
							detail.totalCost === null
								? "不完整（费用未明确）"
								: `${detail.totalCost}${baseUnit}`
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
							detail.planName && detail.planId ? (
								/* FE-02 修复：跳计划详情（原死链 /plans）；planId 缺失时降级纯文本 */
								<Link
									href={`/plans/${detail.planId}`}
									className="text-ink-700 hover:text-ink-900 hover:underline"
								>
									{detail.planName}
								</Link>
							) : detail.planName ? (
								detail.planName
							) : (
								"未关联"
							)
						}
					/>
					<DetailRow label="记录版本" value={`v${detail.version}`} />
				</dl>
			</section>

			<section className="rounded-2xl border border-border bg-white p-6">
				<h2 className="text-base font-bold text-foreground">修改记录</h2>
				<p className="mb-4 mt-1 text-xs text-muted-foreground">
					含失败的更正尝试；单笔更正保留原记录及修改历史，整套数据清理按账号与组织数据规则处理。
				</p>
				<CorrectionHistoryList targetType="TRANSACTION" targetId={detail.id} />
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
					muted ? "font-medium text-ink-500" : "font-semibold text-foreground"
				}
			>
				{value}
			</dd>
		</div>
	);
}
