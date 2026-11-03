"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, CircleAlert } from "lucide-react";
import {
	AccountLedgerTable,
	AccountSummaryCards,
	PlanAllocationTable,
} from "@/components/business/account";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/client";
import { getCurrencyName } from "@/lib/api/currencies";
import { accountsApi } from "@/lib/api/accounts";

/**
 * 账户详情页（changes/account-module/技术方案.md §5.2，原型 QKb1c）
 *
 * 瘦壳：按路由币种并行查询账户详情（金额卡）与流水（表格）。
 * 404（ACCOUNT_NOT_FOUND，不泄露存在性）→ 整页提示态；
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。
 */
export default function AccountDetailPage() {
	const params = useParams<{ currency: string }>();
	const raw = params?.currency;
	// 接口对路径参数统一转大写（方案 §4.2），展示层同步大写
	const code = typeof raw === "string" && raw !== "" ? raw.toUpperCase() : null;

	const detailQuery = useQuery({
		queryKey: ["accounts", "detail", code],
		queryFn: () => accountsApi.detail(code as string),
		enabled: code !== null,
		retry: false, // 401 由 apiClient 统一跳登录；404 直接进提示态
	});

	const ledgerQuery = useQuery({
		queryKey: ["accounts", "ledger", code],
		queryFn: () => accountsApi.ledger(code as string),
		enabled: code !== null,
		retry: false,
	});

	// 按计划分配明细（阶段5 §2 功能 13）：只读事实展示，与摘要/流水并行；
	// 失败静默降级不阻塞整页（明细缺失不该挡住余额/流水查看）
	const allocationsQuery = useQuery({
		queryKey: ["accounts", "allocations", code],
		queryFn: () => accountsApi.allocations(code as string),
		enabled: code !== null,
		retry: false,
	});

	// 错误码分支（ApiError.code 对齐后端错误体）：404 不泄露存在性，统一提示
	const isNotFound =
		(detailQuery.error instanceof ApiError &&
			detailQuery.error.code === "ACCOUNT_NOT_FOUND") ||
		(ledgerQuery.error instanceof ApiError &&
			ledgerQuery.error.code === "ACCOUNT_NOT_FOUND");

	if (detailQuery.isLoading || ledgerQuery.isLoading) {
		return <DetailSkeleton />;
	}

	if (code === null || isNotFound) {
		return <AccountNotFound />;
	}

	if (detailQuery.isError || ledgerQuery.isError) {
		return (
			<DetailError
				onRetry={() => {
					void detailQuery.refetch();
					void ledgerQuery.refetch();
				}}
			/>
		);
	}

	if (!detailQuery.data || !ledgerQuery.data) {
		return null; // 不可达：非 loading 非 error 时 data 必已就绪（类型收窄）
	}

	const currencyName = getCurrencyName(code);

	return (
		<div className="mx-auto max-w-5xl px-8 py-6">
			<Link
				href="/accounts"
				className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
			>
				<ArrowLeft className="size-4" />
				返回列表
			</Link>
			<header className="mb-6 mt-3 flex items-center gap-3">
				<h1 className="text-xl font-bold text-foreground">{code} 账户</h1>
				{currencyName ? <Badge variant="outline">{currencyName}</Badge> : null}
			</header>

			<AccountSummaryCards detail={detailQuery.data} />

			{/* 按计划分配（阶段5 §2）：只读明细 + 未分配余额合计；分配与调整操作在计划中 */}
			<section className="mt-8" aria-label="按计划分配">
				<h2 className="text-base font-bold text-foreground">计划分配</h2>
				<p className="mb-4 mt-1 text-xs text-muted-foreground">
					该币种的余额分给了哪些计划；分配与调整请在计划详情中操作。
				</p>
				{allocationsQuery.data ? (
					<PlanAllocationTable
						allocation={allocationsQuery.data.items}
						detail={detailQuery.data}
					/>
				) : allocationsQuery.isError ? (
					<p className="text-sm text-muted-foreground">
						计划分配明细加载失败，可稍后刷新重试。
					</p>
				) : (
					<p className="text-sm text-muted-foreground">加载中…</p>
				)}
			</section>

			<section className="mt-8">
				<h2 className="text-base font-bold text-foreground">账户流水</h2>
				<p className="mb-4 mt-1 text-xs text-muted-foreground">
					按发生时间倒序展示；点击买入行可查看交易详情。
				</p>
				<AccountLedgerTable ledger={ledgerQuery.data} />
			</section>
		</div>
	);
}

/** 整页提示态：404（账户不存在或不属于本人，不泄露存在性） */
function AccountNotFound() {
	return (
		<div className="mx-auto flex max-w-3xl flex-col items-center px-8 py-24 text-center">
			<CircleAlert className="size-10 text-cream-300" />
			<h1 className="mt-4 text-lg font-bold text-foreground">账户不存在</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				该币种账户不存在或不属于当前账号。
			</p>
			<Link
				href="/accounts"
				className="mt-6 text-sm font-medium text-mint-700 hover:underline"
			>
				返回账户列表
			</Link>
		</div>
	);
}

/** 整页错误态：文案 + 重试按钮（两个查询一并 refetch），不跳转误判 */
function DetailError({ onRetry }: { onRetry: () => void }) {
	return (
		<div className="mx-auto flex max-w-5xl flex-col items-center justify-center px-8 py-24 text-center">
			<CircleAlert className="size-10 text-cream-300" />
			<h1 className="mt-4 text-lg font-bold text-foreground">
				账户详情加载失败
			</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				网络异常或服务暂不可用，请稍后重试。
			</p>
			<div className="mt-6 flex items-center gap-3">
				<Button
					className="bg-mint-700 text-white hover:bg-mint-700/90"
					onClick={onRetry}
				>
					重试
				</Button>
				<Link
					href="/accounts"
					className="text-sm text-muted-foreground hover:text-foreground"
				>
					返回列表
				</Link>
			</div>
		</div>
	);
}

/** 整页加载骨架：沿用正常页的区块位置（返回/标题/四卡/表格），避免布局跳动 */
function DetailSkeleton() {
	return (
		<div className="mx-auto max-w-5xl px-8 py-6">
			<Skeleton className="mb-4 h-4 w-20" />
			<Skeleton className="mb-6 h-6 w-32" />
			<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
				{[0, 1, 2, 3].map((i) => (
					<Skeleton key={i} className="h-24 rounded-xl" />
				))}
			</div>
			<Skeleton className="mt-8 h-64 w-full rounded-2xl" />
		</div>
	);
}
