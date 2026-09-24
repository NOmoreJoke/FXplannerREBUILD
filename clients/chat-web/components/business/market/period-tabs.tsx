"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MarketPeriod } from "@/lib/hooks/use-rate-history";

/** 档位选项（label 按 E2E/规格口径：第四档显示「1年」） */
const PERIOD_OPTIONS = [
	{ value: 7, label: "7天" },
	{ value: 30, label: "30天" },
	{ value: 90, label: "90天" },
	{ value: 365, label: "1年" },
] as const satisfies readonly { value: MarketPeriod; label: string }[];

interface PeriodTabsProps {
	value: MarketPeriod;
	onChange: (period: MarketPeriod) => void;
	disabled?: boolean;
}

/**
 * 时间档位切换（方案 §3.3：7/30/90/365 四档，默认 30 天由页面持有）。
 * 仅受控切换器；档位状态与数据请求由页面/hook 承载。
 */
export function PeriodTabs({ value, onChange, disabled }: PeriodTabsProps) {
	return (
		<Tabs
			value={String(value)}
			onValueChange={(next) => onChange(Number(next) as MarketPeriod)}
		>
			<TabsList aria-label="时间档位">
				{PERIOD_OPTIONS.map((option) => (
					<TabsTrigger
						key={option.value}
						value={String(option.value)}
						disabled={disabled}
						data-testid={`period-${option.value}`}
					>
						{option.label}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
}
