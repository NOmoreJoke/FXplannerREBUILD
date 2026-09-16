"use client";

import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ratesApi } from "@/lib/api/rates";

/**
 * 汇率参考卡（changes/transaction-entry/技术方案.md §4.3 / §6）
 *
 * 进录入页按「本位币 → 买入币种」调已有 GET /rates/latest 显示参考汇率
 * （统一「1 外币 = X 本位币」口径，录入价取 sellRate ?? rate），
 * 仅作默认回填值，用户可改；提交值一律视为实际成交数据。
 * 获取失败不阻塞录入（方案假设 #4）：提示用户直接手填实际成交汇率。
 */

export interface RateReferenceCardProps {
	/** 本位币（未完成首次设置时为 null，整卡不查询） */
	baseCurrency: string | null;
	/** 买入币种（空串 = 未选择） */
	targetCurrency: string;
	/** 「采用此汇率」回调（把参考汇率回填到表单汇率字段） */
	onApply: (rate: string) => void;
	/** 是否允许采用（填法 B 下汇率为反算只读值，不提供采用按钮） */
	canApply?: boolean;
}

/** 单目标平铺响应（后端 LatestRateResponseDto：含 rate/sellRate/source/observedAt/fresh） */
interface LatestRateResponse {
	base: string;
	target: string;
	rate: string;
	sellRate?: string;
	source: string;
	observedAt: string;
	validUntil: string;
	fresh: boolean;
}

/** 多目标响应带 items 数组，据此收窄联合类型（ratesApi.latest 单目标恒为平铺结构） */
function isFlatResponse(
	data: Awaited<ReturnType<typeof ratesApi.latest>>,
): data is LatestRateResponse {
	return !("items" in data);
}

export function RateReferenceCard({
	baseCurrency,
	targetCurrency,
	onApply,
	canApply = true,
}: RateReferenceCardProps) {
	const enabled = baseCurrency !== null && targetCurrency !== "";
	const query = useQuery({
		queryKey: ["rates", "latest", baseCurrency, targetCurrency],
		queryFn: () =>
			ratesApi.latest(baseCurrency as string, [targetCurrency], true),
		enabled,
		// 参考汇率仅辅助回填：失败不阻塞录入，也不自动重试打扰
		retry: false,
		staleTime: 60 * 1000,
	});

	if (!enabled) {
		return (
			<section className="rounded-2xl border border-border bg-white p-6">
				<h2 className="text-base font-bold text-foreground">汇率参考</h2>
				<p className="mt-2 text-sm text-muted-foreground">
					选择买入币种后显示最新参考汇率。
				</p>
			</section>
		);
	}

	const data = query.data;
	const flat = data !== undefined && isFlatResponse(data) ? data : null;
	// rate/sellRate 同为「1 外币 = X 本位币」口径（rate-source 契约），
	// 现汇卖出价仅 abc 源返回，录入价取 sellRate ?? rate
	const referenceRate = flat ? (flat.sellRate ?? flat.rate) : undefined;
	const sourceLabel = resolveSourceLabel(flat?.source);
	const observedDate = flat?.observedAt.slice(0, 10);

	return (
		<section className="rounded-2xl border border-border bg-white p-6">
			<h2 className="text-base font-bold text-foreground">汇率参考</h2>

			{query.isLoading ? (
				<p className="mt-2 text-sm text-muted-foreground">正在获取参考汇率…</p>
			) : query.isError || referenceRate === undefined ? (
				<p
					className="mt-2 rounded-lg bg-cream-100 px-3 py-2 text-sm text-ink-600"
					role="alert"
				>
					参考汇率获取失败，请填写实际成交数据。
				</p>
			) : (
				<>
					<p className="mt-3 text-2xl font-bold text-foreground">
						1 {targetCurrency} = {referenceRate}{" "}
						<span className="text-sm font-medium text-muted-foreground">
							{baseCurrency}
						</span>
					</p>
					<p className="mt-1 text-xs text-muted-foreground">
						{buildMetaLine(sourceLabel, observedDate, flat?.fresh)}
					</p>
					{canApply && (
						<Button
							variant="outline"
							className="mt-4 bg-white"
							onClick={() => onApply(referenceRate)}
						>
							<Check className="size-4" />
							采用此汇率
						</Button>
					)}
				</>
			)}
		</section>
	);
}

/** 数据源展示文案（null = 源标识缺失，不展示来源） */
function resolveSourceLabel(source: string | undefined): string | null {
	if (source === undefined) return null;
	if (source === "abc") return "农行牌价 · 现汇卖出价";
	return source;
}

/** 报价来源 + 日期 + 有效期拼为单行元信息 */
function buildMetaLine(
	sourceLabel: string | null,
	observedDate: string | undefined,
	fresh: boolean | undefined,
): string {
	const parts: string[] = [];
	if (sourceLabel !== null) parts.push(sourceLabel);
	parts.push(`报价日期 ${observedDate ?? "—"}`);
	parts.push(fresh ? "有效期内" : "已过期，仅供参考");
	return parts.join(" · ");
}
