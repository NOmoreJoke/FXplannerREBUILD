"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrencyName } from "@/lib/api/currencies";
import { ratesApi } from "@/lib/api/rates";
import type { CurrencySeriesEntry } from "@/lib/hooks/use-rate-history";

/** 对比币种数量上限（方案 §3.3：1~5 个；下限由「仅剩一个时禁用移除」保证） */
export const MAX_COMPARE_CURRENCIES = 5;

interface CurrencyMultiSelectProps {
	/** 本位币（不可作为对比币种；页面注明以本位币计价） */
	base: string;
	/** 已选对比币种（有序） */
	value: string[];
	onChange: (next: string[]) => void;
	/** 各币种数据状态（error/empty → 标签置灰并标注「暂无数据」，方案 §3.3） */
	series: CurrencySeriesEntry[];
	disabled?: boolean;
}

/**
 * 对比币种多选（1~5 个）：已选标签行（可移除）+ 下拉追加。
 * 币种清单来自 GET /rates/supported（不硬编码）；中文名取前端本地币种表展示。
 * Select 用 key 重挂载保持「动作即回位」：每次选择后面板回到占位符。
 */
export function CurrencyMultiSelect({
	base,
	value,
	onChange,
	series,
	disabled,
}: CurrencyMultiSelectProps) {
	const supportedQuery = useQuery({
		queryKey: ["rates", "supported"],
		queryFn: () => ratesApi.supported(),
		staleTime: 24 * 60 * 60_000, // 币种清单近乎静态，当日不再重拉
		retry: 1,
	});

	const candidates = (supportedQuery.data ?? []).filter(
		(code) => code !== base && !value.includes(code),
	);
	const canAddMore = value.length < MAX_COMPARE_CURRENCIES;

	const add = (code: string) => {
		if (!canAddMore || value.includes(code) || code === base) return;
		onChange([...value, code]);
	};

	const remove = (code: string) => {
		if (value.length <= 1) return; // 至少保留 1 个对比币种
		onChange(value.filter((item) => item !== code));
	};

	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<div className="flex flex-wrap items-center gap-2">
				{value.map((code) => {
					const state = series.find((item) => item.currency === code);
					const unavailable =
						state?.status === "error" || state?.status === "empty";
					return (
						<Badge
							key={code}
							variant={unavailable ? "outline" : "secondary"}
							data-testid={`currency-tag-${code}`}
							data-unavailable={unavailable || undefined}
							className={
								unavailable
									? "h-6 gap-1 pr-1 text-muted-foreground line-through decoration-muted-foreground/50"
									: "h-6 gap-1 pr-1"
							}
						>
							<span className="font-medium">{code}</span>
							<span className="text-xs font-normal">
								{unavailable
									? getCurrencyName(code) + " · 暂无数据"
									: getCurrencyName(code)}
							</span>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								className="ml-0.5"
								aria-label={`移除 ${code}`}
								disabled={disabled || value.length <= 1}
								onClick={() => remove(code)}
							>
								<X />
							</Button>
						</Badge>
					);
				})}

				{supportedQuery.isPending ? (
					<Skeleton className="h-7 w-28" />
				) : canAddMore && candidates.length > 0 ? (
					<Select key={value.join(",")} onValueChange={add}>
						<SelectTrigger
							size="sm"
							disabled={disabled}
							aria-label="添加对比币种"
							data-testid="currency-add"
							className="w-32"
						>
							<SelectValue placeholder="添加币种" />
						</SelectTrigger>
						<SelectContent>
							{candidates.map((code) => (
								<SelectItem key={code} value={code}>
									{code} · {getCurrencyName(code) ?? code}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : !supportedQuery.isPending && !canAddMore ? (
					<span className="text-xs text-muted-foreground">
						最多 {MAX_COMPARE_CURRENCIES} 个
					</span>
				) : null}

				{supportedQuery.isFetching && !supportedQuery.isPending && (
					<Loader2 className="size-3 animate-spin text-muted-foreground" />
				)}
			</div>
			<p className="text-xs text-muted-foreground">
				以本位币 {base} 计价 · 对比币种 1~{MAX_COMPARE_CURRENCIES} 个
			</p>
		</div>
	);
}
