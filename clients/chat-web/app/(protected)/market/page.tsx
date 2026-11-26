"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { PageLoading } from "@/components/base";
import {
	CurrencyMultiSelect,
	PeriodTabs,
	RateChartPanel,
} from "@/components/business/market";
import { Button } from "@/components/ui/button";
import { DATA_REQUESTS_PAGE_PATH } from "@/lib/api/client";
import {
	useOrganizationCapabilities,
} from "@/lib/hooks/use-organization-capabilities";
import { useOrganizationSettings } from "@/lib/hooks/use-organization-settings";
import {
	useRateHistory,
	type MarketPeriod,
} from "@/lib/hooks/use-rate-history";

/**
 * 汇率行情页（changes/rate-chart/技术方案.md §3.3 瘦壳）
 *
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。页面只持三件事：
 * 本位币读取（经 useOrganizationSettings，只读）、档位/对比币种状态、组装渲染面板；
 * 数据拉取与合并由 useRateHistory 承载，展示由 business/market 组件承载。
 *
 * 查询降噪（Goal #3B W28）：本位币随组织变化，由布局的组织作用域边界在切换时整体
 * 重新挂载来重置 initializedRef 等本地状态。组织未建账时本位币尚未确定，此时不再请求
 * GET /settings（必然 409），直接提示去建账。
 */
export default function MarketPage() {
	const router = useRouter();
	const { can } = useOrganizationCapabilities();
	const settings = useOrganizationSettings();
	const base = settings.data?.baseCurrency ?? null;

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
		const shell = (body: React.ReactNode) => (
			<div data-testid="market-page" className="mx-auto max-w-5xl px-8 py-6">
				<header className="mb-6">
					<h1 className="text-xl font-bold text-foreground">汇率行情</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						以本位币为基准的多币种汇率走势。
					</p>
				</header>
				{body}
			</div>
		);

		if (settings.gate === "not-onboarded") {
			// 组织未建账：本位币尚未确定（未发 GET /settings），如实提示而不是报「读取失败」
			return shell(
				<div
					data-testid="market-not-onboarded"
					className="rounded-xl border border-dashed border-border bg-background p-8 text-center"
				>
					<p className="text-sm text-muted-foreground">
						当前组织尚未完成建账，确定本位币后即可查看以本位币为基准的汇率走势。
					</p>
					{can("settings.update") && (
						<Button
							className="mt-4 bg-mint-700 text-white hover:bg-mint-700/90"
							onClick={() => router.push("/onboarding")}
						>
							去建账
						</Button>
					)}
				</div>,
			);
		}

		if (settings.gate === "deletion-locked") {
			// 组织删除处理中：账本查询已被闸门静默，引导去进度页（那里可以撤回）
			return shell(
				<div
					data-testid="market-data-locked"
					className="rounded-xl border border-dashed border-border bg-background p-8 text-center"
				>
					<p className="text-sm text-muted-foreground">
						当前组织正在删除处理中，账本数据暂不可查看。
					</p>
					<Button variant="outline" size="sm" className="mt-4 bg-white" asChild>
						<Link href={DATA_REQUESTS_PAGE_PATH}>查看处理进度</Link>
					</Button>
				</div>,
			);
		}

		if (settings.isLoading || settings.gate === "loading") {
			return <PageLoading />;
		}
		// 读取失败：页面任何情况下不白屏（规格验收路径）
		return shell(
			<div className="rounded-xl border border-border bg-background p-8 text-center">
				<p className="text-sm text-muted-foreground">
					{settings.error instanceof Error
						? `本位币读取失败：${settings.error.message}`
						: "本位币读取失败，请稍后重试。"}
				</p>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="mt-4"
					onClick={() => void settings.refetch()}
				>
					<RotateCcw />
					重试
				</Button>
			</div>,
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
				onRetry={history.refetch}
			/>
		</div>
	);
}
