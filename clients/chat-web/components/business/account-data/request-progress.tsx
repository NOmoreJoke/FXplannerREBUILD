"use client";

import { useState } from "react";
import { CircleAlert, LifeBuoy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useOrganizationCapabilities } from "@/lib/hooks/use-organization-capabilities";
import {
	useCancelOrganizationDataRequest,
	useCancelPersonalDataRequest,
} from "@/lib/hooks/use-data-request";
import type { DataRequestDisplayStatus, DataRequestView } from "@/lib/api/contract";
import { useAuthStore } from "@/lib/stores/auth-store";
import { ExportDownloadButton } from "./export-flow";
import { OtpVerifyStep } from "./otp-verify-step";
import { organizationCancelPermission, requestTypeText } from "./request-copy";

/**
 * 请求进度卡（需求第五节）：处理状态 / 提交时间 / 截止时间 / 结果；
 * CLEAR PENDING 可直接撤回；DELETION PENDING 需验证邮箱后撤回；
 * FAILED 显示原因与联系支持入口，不假装成功。
 *
 * 个人域与组织域共用本卡，按服务端视图的 scope 决定走哪套端点（Goal #3B W28）：
 * - 个人域（scope=PERSONAL）：本人的数据，撤回与下载始终可操作——即使本人正处于
 *   注销锁定期（这正是 403 ACCOUNT_PENDING_DELETION 跳到进度页后要做的事）；
 * - 组织域（scope=ORGANIZATION）：任意有效成员都可查看进度；撤回与下载按钮同时受
 *   角色能力（CLEAR → data.clear、DELETION → organization.delete、下载 → data.export）
 *   与发起人身份（view.isRequester）双重门控，非发起人展示明确提示而非点击后 404，
 *   Viewer / 无权成员看得到进度但不展示操作按钮或非发起人提示。
 */

const STATUS_TEXT: Record<DataRequestDisplayStatus, string> = {
	SUBMITTED: "已提交",
	WITHDRAWAL_PERIOD: "等待撤回期结束",
	PROCESSING: "处理中",
	COMPLETED: "已完成",
	CANCELLED: "已撤回",
	FAILED: "处理异常",
};

/** 状态徽标配色（异常用 destructive，进行中用中性胶囊，已完成用已入账事实语义） */
const STATUS_BADGE_CLASS: Record<DataRequestDisplayStatus, string> = {
	FAILED: "border border-destructive/30 bg-destructive/10 text-destructive",
	COMPLETED: "border border-commit bg-commit-subtle text-commit",
	CANCELLED: "bg-muted text-muted-foreground",
	SUBMITTED: "border border-neutral-note bg-neutral-note text-ink-700",
	WITHDRAWAL_PERIOD: "border border-neutral-note bg-neutral-note text-ink-700",
	PROCESSING: "border border-neutral-note bg-neutral-note text-ink-700",
};

function formatTime(value: string | null | undefined): string {
	if (!value) return "—";
	return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

/** 请求分区的加载态（设置页与进度页的个人 / 组织分区共用） */
export function RequestPanelLoading() {
	return (
		<p
			role="status"
			className="flex items-center gap-2 rounded-xl border border-border px-4 py-5 text-sm text-muted-foreground"
		>
			<Loader2 className="size-4 animate-spin" aria-hidden="true" />
			正在加载…
		</p>
	);
}

/** 请求分区的错误态 + 重试（401 已由 apiClient 统一处理，这里只剩网络 / 5xx 等） */
export function RequestPanelError({
	error,
	onRetry,
	testId,
}: {
	error: Error | null;
	onRetry: () => void;
	testId?: string;
}) {
	return (
		<div
			data-testid={testId}
			role="alert"
			className="flex flex-col items-center rounded-xl border border-border px-6 py-6 text-center"
		>
			<CircleAlert className="size-6 text-ink-300" aria-hidden="true" />
			<p className="mt-3 text-sm text-muted-foreground">
				{error instanceof Error && error.message
					? error.message
					: "加载失败，请稍后重试。"}
			</p>
			<Button
				variant="outline"
				size="sm"
				className="mt-4 bg-white"
				onClick={onRetry}
			>
				重试
			</Button>
		</div>
	);
}

export function RequestProgress({ view }: { view: DataRequestView }) {
	const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
	const userEmail = useAuthStore((state) => state.user?.email ?? "");
	const { can } = useOrganizationCapabilities();
	// 两套撤回 hook 都无条件调用，实际只触发视图所在域的那一个
	const cancelPersonal = useCancelPersonalDataRequest();
	const cancelOrganization = useCancelOrganizationDataRequest();

	const isPersonal = view.scope === "PERSONAL";
	const isDeletion = view.type === "DELETION";
	// 组织域撤回按请求类型对应的权限点显隐，且仅限发起人本人（个人域只看服务端 canCancel）
	const cancelPermission = isPersonal
		? null
		: organizationCancelPermission(view.type);
	const hasCancelPermission =
		isPersonal || (cancelPermission !== null && can(cancelPermission));
	const canCancel =
		view.canCancel && hasCancelPermission && (isPersonal || view.isRequester);
	const showNonRequesterHint =
		!isPersonal &&
		!view.isRequester &&
		((view.canCancel && hasCancelPermission) ||
			(Boolean(view.download) && can("data.export")));

	const cancel = (challengeId?: string) => {
		const callbacks = {
			onSuccess: () => {
				toast.success("已撤回，数据恢复原样");
				setCancelDialogOpen(false);
			},
			onError: (error: Error) => toast.error(error.message || "撤回失败"),
		};
		if (isPersonal) {
			cancelPersonal.mutate({ requestId: view.id, challengeId }, callbacks);
		} else {
			cancelOrganization.mutate({ requestId: view.id, challengeId }, callbacks);
		}
	};

	const cancelPending = cancelPersonal.isPending || cancelOrganization.isPending;
	const cancelLabel = isDeletion
		? isPersonal
			? "撤回注销"
			: "撤回删除"
		: "撤回请求";

	return (
		<div
			data-testid="request-progress"
			data-scope={view.scope}
			className="rounded-2xl border border-border bg-white p-5"
		>
			<div className="flex items-center justify-between gap-3">
				<div>
					<p className="text-sm text-muted-foreground">进行中的请求</p>
					<p className="mt-0.5 text-base font-bold text-foreground">
						{requestTypeText(view.scope, view.type)}
					</p>
				</div>
				<span
					data-testid="request-progress-status"
					className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${STATUS_BADGE_CLASS[view.displayStatus]}`}
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
						{isDeletion && view.status === "PENDING" ? "撤回期截止" : "处理截止"}
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
					{isPersonal
						? "账号已停用，仅可查看进度或撤回注销；撤回注销需验证邮箱（仅重新登录不算撤回）。"
						: "组织已进入删除处理期，账本暂不可读写；撤回删除需验证邮箱，到期后组织与共享账本将被删除（成员个人账号不受影响）。"}
				</p>
			)}
			{view.displayStatus === "FAILED" && (
				<div className="mt-3 space-y-2">
					<div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
						<CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
						<p className="text-sm text-foreground">
							处理中断，未完成的部分仍在处理中，不会假装成功；数据保持锁定状态。
						</p>
					</div>
					<a
						href="mailto:support@fxplanner.app"
						className="inline-flex items-center gap-1.5 text-sm text-ink-700 underline-offset-2 hover:text-ink-900 hover:underline"
						data-testid="request-support-link"
					>
						<LifeBuoy className="size-4" aria-hidden="true" />
						联系支持
					</a>
				</div>
			)}

			<div className="mt-4 flex flex-wrap items-center gap-2">
				<ExportDownloadButton view={view} />
				{canCancel && (
					<Button
						variant="outline"
						size="sm"
						data-testid="request-cancel"
						disabled={cancelPending}
						onClick={() => (isDeletion ? setCancelDialogOpen(true) : cancel())}
					>
						{cancelPending && (
							<Loader2 className="size-4 animate-spin" aria-hidden="true" />
						)}
						{cancelLabel}
					</Button>
				)}
				{showNonRequesterHint && (
					<p
						data-testid="organization-request-non-requester-hint"
						className="text-xs text-muted-foreground"
					>
						该组织请求由其他成员发起，仅发起人本人可撤回或下载导出包。
					</p>
				)}
			</div>

			{/* 撤回注销 / 撤回删除：验证邮箱＋点击两步齐全（doc 01:133） */}
			<Dialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
				<DialogContent data-testid="deletion-cancel-dialog">
					<DialogHeader>
						<DialogTitle>{cancelLabel}</DialogTitle>
						<DialogDescription>
							请验证邮箱后确认撤回，{isPersonal ? "账号将恢复原样" : "组织与账本将恢复可用"}。
						</DialogDescription>
					</DialogHeader>
					<OtpVerifyStep
						target={userEmail}
						purpose="DELETION"
						scope={view.scope}
						onVerified={(challengeId) => cancel(challengeId)}
					/>
				</DialogContent>
			</Dialog>
		</div>
	);
}
