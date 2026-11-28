"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert } from "lucide-react";
import {
	HomeDashboard,
	HomeEmptyState,
	InitialBackfillCard,
} from "@/components/business/home";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DATA_REQUESTS_PAGE_PATH } from "@/lib/api/client";
import { useHomeState } from "@/lib/hooks/use-home-state";

/**
 * 工作台首页（分流瘦壳）
 *
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。
 * 分流依据（changes/home-state-routing/技术方案.md §3.1 + onboarding-rework 口径）：
 * - 当前组织未建账（组织详情 onboardingCompleted=false）→ replace 跳 /onboarding 建账向导；
 * - 组织删除处理中 → replace 跳 /data-requests（账本端点此时全部被锁，不靠 403 硬跳转）；
 * - 已建账，无账户 且 无计划          → 空状态引导页 + 补录初始持仓引导卡
 *   （未录初始持仓时；E2E 场景 1/10：跳过持仓后首页可见引导卡，补录后消失）；
 * - 已建账，有账户 或 有计划          → 正常数据首页（未录初始持仓时挂补录引导卡）。
 * 请求失败：整页错误态 + 重试，不跳转不误判。
 * 注：渲染期跳转统一走 useEffect + 提前 return（对齐 redirectToLogin 的防重复思路），
 * 避免 React 渲染期间触发导航告警。
 */
export default function HomePage() {
	const router = useRouter();
	const {
		isLoading,
		isError,
		refetch,
		state,
		dashboard,
		needsOnboarding,
		isDeletionLocked,
	} = useHomeState();

	// 分流：导航统一在 effect 中触发（渲染期只提前返回骨架），
	// hooks 顺序恒定（rules-of-hooks），组织上下文未就绪时不分流
	useEffect(() => {
		if (needsOnboarding) {
			router.replace("/onboarding");
		} else if (isDeletionLocked) {
			router.replace(DATA_REQUESTS_PAGE_PATH);
		}
	}, [needsOnboarding, isDeletionLocked, router]);

	if (isLoading) {
		return <HomeSkeleton />;
	}

	// 组织删除处理中：账本查询已被闸门静默（零 403），此处只是在等上面的跳转生效
	if (isDeletionLocked) {
		return <HomeSkeleton />;
	}

	if (isError) {
		return <HomeError onRetry={() => refetch()} />;
	}

	if (!state) {
		return null; // 不可达：非 loading 非 error 时 data 必已就绪（类型收窄）
	}

	if (needsOnboarding) {
		return <HomeSkeleton />;
	}

	// 空状态分支：已建账但无账户无计划 → 引导页 + 补录初始持仓引导卡
	if (!state.hasAccounts && !state.hasPlans) {
		return (
			<>
				<HomeEmptyState />
				{!dashboard?.hasInitialHoldings && (
					<div className="mx-auto max-w-5xl px-8 pb-6">
						<InitialBackfillCard />
					</div>
				)}
			</>
		);
	}

	if (!dashboard) {
		return null; // 不可达：state 就绪时 dashboard 必已同步派生（类型收窄）
	}

	return <HomeDashboard dashboard={dashboard} />;
}

/**
 * 整页加载骨架：沿用正常首页的区块位置（顶栏/横幅/统计卡/账户区），避免布局跳动
 */
function HomeSkeleton() {
	return (
		<div className="mx-auto max-w-5xl px-8 py-6">
			<header className="mb-6 flex items-start justify-between">
				<div className="space-y-2">
					<Skeleton className="h-6 w-16" />
					<Skeleton className="h-3 w-56" />
				</div>
				<Skeleton className="h-6 w-28 rounded-full" />
			</header>
			<Skeleton className="mb-6 h-20 w-full rounded-xl" />
			<div className="mb-8 grid grid-cols-4 gap-4">
				{[0, 1, 2, 3].map((i) => (
					<Skeleton key={i} className="h-24 rounded-xl" />
				))}
			</div>
			<div className="space-y-3">
				<Skeleton className="h-4 w-32" />
				<div className="grid grid-cols-3 gap-4">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-40 rounded-xl" />
					))}
				</div>
			</div>
		</div>
	);
}

/**
 * 整页错误态：文案 + 重试按钮（react-query refetch），不跳转
 */
function HomeError({ onRetry }: { onRetry: () => void }) {
	return (
		<div className="mx-auto flex max-w-5xl flex-col items-center justify-center px-8 py-24 text-center">
			<CircleAlert className="size-10 text-ink-300" />
			<h1 className="mt-4 text-lg font-bold text-foreground">
				首页状态加载失败
			</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				无法获取账号当前状态，请检查网络后重试。
			</p>
			<Button
				className="mt-6 bg-ink-900 text-white hover:bg-ink-900/90"
				onClick={onRetry}
			>
				重试
			</Button>
		</div>
	);
}
