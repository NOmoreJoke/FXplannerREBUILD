"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { CircleAlert } from "lucide-react";
import {
	PlanAdjustDialog,
	PlanChangeLogList,
	PlanCompleteHint,
	PlanDetailCard,
} from "@/components/business/plan";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/client";
import { plansApi } from "@/lib/api/plans";
import type { PlanDetail } from "@/lib/api/contract";

/**
 * 换汇计划详情页（changes/plan-management/技术方案.md §5.2）
 *
 * 瘦壳：GET /plans/:id → PlanDetailCard（进度/准备节点）+ 修改记录 +
 * 操作按钮（canModify/canCancel/canComplete/canReopen 服务端标记控制显隐，
 * 不加其他按钮）。修改与重新开启走两段式对话框；完成/取消走显式确认弹窗。
 * 404（不存在或不属于本人，不泄露存在性）→ 整页提示态；
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。
 */

/** 详情查询 Key（写操作成功后据此精确回写） */
function planDetailKey(id: string) {
	return ["plans", "detail", id] as const;
}

export default function PlanDetailPage() {
	const params = useParams<{ id: string }>();
	const id = params?.id;
	const queryClient = useQueryClient();

	const query = useQuery({
		queryKey: planDetailKey(id as string),
		queryFn: () => plansApi.getDetail(id as string),
		enabled: typeof id === "string" && id !== "",
		retry: false, // 401 由 apiClient 统一跳登录；404 直接进提示态
	});

	if (query.isLoading) {
		return <DetailSkeleton />;
	}

	if (query.isError) {
		const isNotFound =
			query.error instanceof ApiError && query.error.code === "PLAN_NOT_FOUND";
		return (
			<div className="mx-auto flex max-w-3xl flex-col items-center px-8 py-24 text-center">
				<CircleAlert className="size-10 text-cream-300" />
				<h1 className="mt-4 text-lg font-bold text-foreground">
					{isNotFound ? "换汇计划不存在" : "计划详情加载失败"}
				</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					{isNotFound
						? "该计划不存在或不属于当前账号。"
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
						href="/plans"
						className="text-sm text-muted-foreground hover:text-foreground"
					>
						返回计划列表
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
			<DetailHeader
				plan={query.data}
				onApplied={(detail) => {
					if (typeof id !== "string") return;
					queryClient.setQueryData(planDetailKey(id), detail);
					void queryClient.invalidateQueries({ queryKey: ["plans", "list"] });
				}}
				onWriteFailed={() => void query.refetch()}
			/>

			<PlanDetailCard plan={query.data} />
			<PlanCompleteHint plan={query.data} />

			{/* 修改记录 */}
			<section className="mt-6 rounded-2xl border border-border bg-white p-6">
				<h3 className="text-base font-bold text-foreground">修改记录</h3>
				<p className="mt-1 text-xs text-muted-foreground">
					目标的每次调整、完成与取消都会留存在这里。
				</p>
				<div className="mt-4">
					<PlanChangeLogList logs={query.data.changeLogs} />
				</div>
			</section>
		</div>
	);
}

/**
 * 详情页头（返回链接 + 操作按钮 + 全部写操作交互）：
 * 修改/重新开启走两段式对话框；完成/取消走显式确认弹窗。
 * 按钮显隐完全由服务端 canXxx 标记控制。
 */
function DetailHeader({
	plan,
	onApplied,
	onWriteFailed,
}: {
	plan: PlanDetail;
	/** 写操作成功：回写详情缓存并失效列表 */
	onApplied: (detail: PlanDetail) => void;
	/** 写操作失败：状态可能已被并发操作改变，核对最新数据 */
	onWriteFailed: () => void;
}) {
	const [adjustOpen, setAdjustOpen] = useState(false);
	const [completeOpen, setCompleteOpen] = useState(false);
	const [cancelOpen, setCancelOpen] = useState(false);

	/** 写操作错误提示：ApiError 透出后端 message（官方术语文案），其余兜底 */
	const writeError = (error: unknown, fallback: string) => {
		toast.error(
			error instanceof ApiError && error.message ? error.message : fallback,
		);
	};

	const completeMutation = useMutation({
		mutationFn: () => plansApi.complete(plan.id),
		onSuccess: (detail) => {
			onApplied(detail);
			setCompleteOpen(false);
			toast.success("计划已完成");
		},
		onError: (error: unknown) => {
			setCompleteOpen(false);
			writeError(error, "完成确认失败，请稍后重试");
			onWriteFailed();
		},
	});

	const cancelMutation = useMutation({
		mutationFn: () => plansApi.cancel(plan.id),
		onSuccess: (detail) => {
			onApplied(detail);
			setCancelOpen(false);
			toast.success("计划已取消，剩余分配已释放");
		},
		onError: (error: unknown) => {
			setCancelOpen(false);
			writeError(error, "取消计划失败，请稍后重试");
			onWriteFailed();
		},
	});

	return (
		<>
			<header className="mb-6 flex items-center justify-between">
				<Link
					href="/plans"
					className="text-sm text-muted-foreground hover:text-foreground"
				>
					← 返回计划列表
				</Link>
				<div className="flex items-center gap-2">
					{plan.canModify ? (
						<Button
							asChild
							className="bg-mint-700 text-white hover:bg-mint-700/90"
						>
							{/* 自动关联本计划：录入页预填 planId + 币种（默认选好、可修改） */}
							<Link
								href={`/transactions/new?planId=${plan.id}&currency=${plan.targetCurrency}`}
							>
								录入买入
							</Link>
						</Button>
					) : null}
					{plan.canModify ? (
						<Button
							variant="outline"
							className="bg-white"
							onClick={() => setAdjustOpen(true)}
						>
							修改
						</Button>
					) : null}
					{plan.canReopen ? (
						<Button
							className="bg-mint-700 text-white hover:bg-mint-700/90"
							onClick={() => setAdjustOpen(true)}
						>
							重新开启
						</Button>
					) : null}
					{plan.canComplete ? (
						<Button
							className="bg-mint-700 text-white hover:bg-mint-700/90"
							onClick={() => setCompleteOpen(true)}
						>
							完成确认
						</Button>
					) : null}
					{plan.canCancel ? (
						<Button
							variant="outline"
							className="border-red-200 bg-white text-red-600 hover:bg-red-50"
							onClick={() => setCancelOpen(true)}
						>
							取消计划
						</Button>
					) : null}
				</div>
			</header>

			{/* 修改 / 重新开启：两段式对话框（预览 → 确认提交） */}
			<PlanAdjustDialog
				plan={plan}
				open={adjustOpen}
				onOpenChange={setAdjustOpen}
				onSuccess={(detail) => {
					onApplied(detail);
					toast.success(
						plan.status === "COMPLETED" ? "计划已重新开启" : "计划修改已保存",
					);
				}}
				onUnknownOutcome={(detail) => onApplied(detail)}
			/>

			{/* 完成确认：显式确认（状态流转，不可逆，可重新开启） */}
			<AlertDialog open={completeOpen} onOpenChange={setCompleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>确认完成这个换汇计划？</AlertDialogTitle>
						<AlertDialogDescription>
							完成表示资金已按目标备齐并使用完毕，计划数据不再变化。此后如需继续可「重新开启」。
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>再想想</AlertDialogCancel>
						<AlertDialogAction
							className="bg-mint-700 text-white hover:bg-mint-700/90"
							disabled={completeMutation.isPending}
							onClick={(event) => {
								event.preventDefault(); // 阻止 AlertDialog 自动关闭，等待结果
								completeMutation.mutate();
							}}
						>
							{completeMutation.isPending ? "提交中…" : "确认完成"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* 取消计划：终态确认（释放剩余分配，已用金额不恢复） */}
			<AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>确认取消这个换汇计划？</AlertDialogTitle>
						<AlertDialogDescription>
							取消后剩余分配将全部释放回未分配余额，已发生的换汇与使用记录保留；已使用的金额不会恢复。此操作不可撤销。
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>再想想</AlertDialogCancel>
						<AlertDialogAction
							className="bg-red-600 text-white hover:bg-red-600/90"
							disabled={cancelMutation.isPending}
							onClick={(event) => {
								event.preventDefault();
								cancelMutation.mutate();
							}}
						>
							{cancelMutation.isPending ? "提交中…" : "确认取消计划"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

function DetailSkeleton() {
	return (
		<div className="mx-auto max-w-3xl px-8 py-6">
			<Skeleton className="mb-6 h-6 w-28" />
			<Skeleton className="mb-6 h-64 w-full rounded-2xl" />
			<Skeleton className="mb-6 h-40 w-full rounded-2xl" />
			<Skeleton className="h-40 w-full rounded-2xl" />
		</div>
	);
}
