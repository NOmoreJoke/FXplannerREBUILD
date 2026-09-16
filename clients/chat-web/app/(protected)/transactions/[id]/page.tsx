"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CircleAlert } from "lucide-react";
import { TransactionDetail } from "@/components/business/transaction";
import { ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { transactionsApi } from "@/lib/api/transactions";

/**
 * 交易详情页（changes/transaction-entry/技术方案.md §5.2）
 *
 * 瘦壳：按路由 id 查询 GET /transactions/:id 并挂详情卡。
 * 404（不存在或不属于本人，不泄露存在性）→ 整页提示态；
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。
 */
export default function TransactionDetailPage() {
	const params = useParams<{ id: string }>();
	const id = params?.id;

	const query = useQuery({
		queryKey: ["transactions", "detail", id],
		queryFn: () => transactionsApi.detail(id as string),
		enabled: typeof id === "string" && id !== "",
		retry: false, // 401 由 apiClient 统一跳登录；404 直接进提示态
	});

	if (query.isLoading) {
		return <DetailSkeleton />;
	}

	if (query.isError) {
		// 错误码分支（ApiError.code 对齐后端错误体）：404 不泄露存在性，统一提示
		const isNotFound =
			query.error instanceof ApiError &&
			query.error.code === "TRANSACTION_NOT_FOUND";
		return (
			<div className="mx-auto flex max-w-3xl flex-col items-center px-8 py-24 text-center">
				<CircleAlert className="size-10 text-cream-300" />
				<h1 className="mt-4 text-lg font-bold text-foreground">
					{isNotFound ? "交易记录不存在" : "交易详情加载失败"}
				</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					{isNotFound
						? "该记录不存在或不属于当前账号。"
						: "网络异常或服务暂不可用，请稍后重试。"}
				</p>
				<div className="mt-6 flex items-center gap-3">
					<Button
						className="bg-mint-700 text-white hover:bg-mint-700/90"
						onClick={() => query.refetch()}
					>
						重试
					</Button>
					<Link
						href="/home"
						className="text-sm text-muted-foreground hover:text-foreground"
					>
						返回首页
					</Link>
				</div>
			</div>
		);
	}

	if (!query.data) {
		return null; // 不可达：非 loading 非 error 时 data 必已就绪（类型收窄）
	}

	return (
		<div className="mx-auto max-w-3xl px-8 py-6">
			<header className="mb-6 flex items-center justify-between">
				<h1 className="text-xl font-bold text-foreground">交易详情</h1>
				<Link
					href="/transactions/new"
					className="text-sm text-mint-700 hover:underline"
				>
					再记一笔
				</Link>
			</header>
			<TransactionDetail detail={query.data} />
		</div>
	);
}

function DetailSkeleton() {
	return (
		<div className="mx-auto max-w-3xl px-8 py-6">
			<Skeleton className="mb-6 h-6 w-24" />
			<Skeleton className="mb-6 h-20 w-full rounded-xl" />
			<Skeleton className="h-80 w-full rounded-2xl" />
		</div>
	);
}
