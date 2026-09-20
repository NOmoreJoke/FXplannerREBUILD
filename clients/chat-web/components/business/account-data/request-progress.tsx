"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Loader2, LifeBuoy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { dataRequestsApi } from "@/lib/api/data-requests";
import { useAuthStore } from "@/lib/stores/auth-store";
import type { DataRequestView, DataRequestDisplayStatus } from "@/lib/api/contract";
import { ExportDownloadButton } from "./export-flow";
import { OtpVerifyStep } from "./otp-verify-step";

/**
 * 请求进度卡（需求第五节）：处理状态 / 提交时间 / 截止时间 / 结果；
 * CLEAR PENDING 可直接撤回；DELETION PENDING 需验证邮箱后撤回；
 * FAILED 显示原因与联系支持入口，不假装成功。
 */

const STATUS_TEXT: Record<DataRequestDisplayStatus, string> = {
	SUBMITTED: "已提交",
	WITHDRAWAL_PERIOD: "等待撤回期结束",
	PROCESSING: "处理中",
	COMPLETED: "已完成",
	CANCELLED: "已撤回",
	FAILED: "处理异常",
};

const TYPE_TEXT: Record<DataRequestView["type"], string> = {
	EXPORT: "导出个人数据",
	CLEAR: "清空业务记录",
	DELETION: "注销账号",
};

function formatTime(value: string | null | undefined): string {
	if (!value) return "—";
	return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function RequestProgress({ view }: { view: DataRequestView }) {
	const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
	const userEmail = useAuthStore((state) => state.user?.email ?? "");
	const queryClient = useQueryClient();

	const cancelMutation = useMutation({
		mutationFn: (challengeId?: string) =>
			dataRequestsApi.cancel(view.id, challengeId),
		onSuccess: () => {
			toast.success("已撤回，数据恢复原样");
			void queryClient.invalidateQueries({ queryKey: ["data-request"] });
			setCancelDialogOpen(false);
		},
		onError: (error: Error) => toast.error(error.message || "撤回失败"),
	});

	return (
		<div
			data-testid="request-progress"
			className="rounded-2xl border border-border bg-white p-5"
		>
			<div className="flex items-center justify-between">
				<div>
					<p className="text-sm text-muted-foreground">进行中的请求</p>
					<p className="mt-0.5 text-base font-bold text-foreground">
						{TYPE_TEXT[view.type]}
					</p>
				</div>
				<span
					data-testid="request-progress-status"
					className={`rounded-full px-3 py-1 text-xs font-medium ${
						view.displayStatus === "FAILED"
							? "bg-red-100 text-red-700"
							: view.displayStatus === "COMPLETED"
								? "bg-emerald-100 text-emerald-700"
								: view.displayStatus === "CANCELLED"
									? "bg-muted text-muted-foreground"
									: "bg-blue-100 text-blue-700"
					}`}
				>
					{STATUS_TEXT[view.displayStatus]}
				</span>
			</div>

			<dl className="mt-4 grid grid-cols-2 gap-3 text-sm" data-testid="request-progress-meta">
				<div>
					<dt className="text-muted-foreground">提交时间</dt>
					<dd className="mt-0.5 font-medium text-foreground">
						{formatTime(view.requestedAt)}
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">
						{view.type === "DELETION" && view.status === "PENDING"
							? "撤回期截止"
							: "处理截止"}
					</dt>
					<dd className="mt-0.5 font-medium text-foreground">
						{formatTime(view.dueAt)}
					</dd>
				</div>
			</dl>

			{view.type === "CLEAR" && view.status === "PENDING" && (
				<p className="mt-3 text-xs text-muted-foreground">
					开始清理前可撤回；到期后将自动开始清理，届时不能再撤回。
				</p>
			)}
			{view.type === "DELETION" && view.status === "PENDING" && (
				<p className="mt-3 text-xs text-muted-foreground">
					账号已停用，仅可查看进度或撤回注销；撤回注销需验证邮箱（仅重新登录不算撤回）。
				</p>
			)}
			{view.displayStatus === "FAILED" && (
				<div className="mt-3 space-y-2">
					<div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 dark:bg-red-950/30">
						<CircleAlert className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden="true" />
						<p className="text-sm text-red-800 dark:text-red-200">
							处理中断，未完成的部分仍在处理中，不会假装成功；数据保持锁定状态。
						</p>
					</div>
					<a
						href="mailto:support@fxplanner.app"
						className="inline-flex items-center gap-1.5 text-sm text-blue-600 underline-offset-2 hover:underline"
						data-testid="request-support-link"
					>
						<LifeBuoy className="size-4" aria-hidden="true" />
						联系支持
					</a>
				</div>
			)}

			<div className="mt-4 flex items-center gap-2">
				<ExportDownloadButton view={view} />
				{view.canCancel && (
					<Button
						variant="outline"
						size="sm"
						data-testid="request-cancel"
						onClick={() =>
							view.type === "DELETION"
								? setCancelDialogOpen(true)
								: cancelMutation.mutate(undefined)
						}
					>
						{cancelMutation.isPending && (
							<Loader2 className="size-4 animate-spin" aria-hidden="true" />
						)}
						{view.type === "DELETION" ? "撤回注销" : "撤回请求"}
					</Button>
				)}
			</div>

			{/* 撤回注销：验证邮箱＋点击两步齐全（doc 01:133） */}
			<Dialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
				<DialogContent data-testid="deletion-cancel-dialog">
					<DialogHeader>
						<DialogTitle>撤回注销</DialogTitle>
						<DialogDescription>
							请验证邮箱后确认撤回，账号将恢复原样。
						</DialogDescription>
					</DialogHeader>
					<OtpVerifyStep
						target={userEmail}
						purpose="DELETION"
						onVerified={(challengeId) => cancelMutation.mutate(challengeId)}
					/>
				</DialogContent>
			</Dialog>
		</div>
	);
}
