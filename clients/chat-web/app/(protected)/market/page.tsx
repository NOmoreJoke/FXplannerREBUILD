"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { PageLoading } from "@/components/base";
import {
	CurrencyMultiSelect,
	PeriodTabs,
	RateChartPanel,
} from "@/components/business/market";
import { Button } from "@/components/ui/button";
import { settingsApi } from "@/lib/api/settings";
import {
	useRateHistory,
	type MarketPeriod,
} from "@/lib/hooks/use-rate-history";

/**
 * 汇率行情页（changes/rate-chart/技术方案.md §3.3 瘦壳）
 *
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。页面只持三件事：
 * 本位币读取（GET /settings，只读）、档位/对比币种状态、组装渲染面板；
 * 数据拉取与合并由 useRateHistory 承载，展示由 business/market 组件承载。
 */
export default function MarketPage() {
	const settingsQuery = useQuery({
		queryKey: ["settings"],
		queryFn: settingsApi.getSettings,
		retry: false, // 401 由 apiClient 统一处理；409/其余失败走错误分支
	});
	const base = settingsQuery.data?.baseCurrency ?? null;

	// 默认 30 天（规格验收：默认档位 30 天）
	const [period, setPeriod] = useState<MarketPeriod>(30);
	const [currencies, setCurrencies] = useState<string[]>([]);
	// 默认对比币种只随本位币初始化一次（USD；本位币即 USD → EUR，方案 §3.3）
	const initializedRef = useRef(false);

	useEffect(() => {
		if (!base || initializedRef.current) return;
		initializedRef.current = true;
		setCurrencies([base === "USD" ? "EUR" : "USD"]);
	}, [base]);

	const history = useRateHistory({
		base: base ?? "",
		targets: currencies,
		period,
	});

	if (!base) {
		// 设置未就绪/失败：页面任何情况下不白屏（规格验收路径）
		if (settingsQuery.isPending) {
			return <PageLoading />;
		}
		return (
			<div data-testid="market-page" className="mx-auto max-w-5xl px-8 py-6">
				<header className="mb-6">
					<h1 className="text-xl font-bold text-foreground">汇率行情</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						以本位币为基准的多币种汇率走势。
					</p>
				</header>
				<div className="rounded-xl border border-border bg-background p-8 text-center">
					<p className="text-sm text-muted-foreground">
						{settingsQuery.error instanceof Error
							? `本位币读取失败：${settingsQuery.error.message}`
							: "本位币读取失败，请稍后重试。"}
					</p>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="mt-4"
						onClick={() => void settingsQuery.refetch()}
					>
						<RotateCcw />
						重试
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div data-testid="market-page" className="mx-auto max-w-5xl px-8 py-6">
			<header className="mb-6">
				<h1 className="text-xl font-bold text-foreground">汇率行情</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					以本位币 {base} 为基准的多币种汇率走势，辅助换汇时机判断。
				</p>
			</header>

			{/* 控制行：币种多选（左）+ 档位切换（右） */}
			<div className="mb-4 flex flex-wrap items-start justify-between gap-4">
				<CurrencyMultiSelect
					base={base}
					value={currencies}
					onChange={setCurrencies}
					series={history.series}
				/>
				<PeriodTabs value={period} onChange={setPeriod} />
			</div>

			<RateChartPanel
				base={base}
				period={period}
				rows={history.rows}
				series={history.series}
				isLoading={history.isLoading}
				isAllUnavailable={history.isAllUnavailable}
				onRetry={history.refetch}
			/>
		</div>
	);
}
