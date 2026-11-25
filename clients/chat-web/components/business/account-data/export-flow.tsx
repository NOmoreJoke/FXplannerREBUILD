"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
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
import { invalidateAfterDataRequestMutation } from "@/lib/api/query-keys";
import type { DataRequestView } from "@/lib/api/contract";
import { OtpVerifyStep } from "./otp-verify-step";

/**
 * 导出数据流程（需求 6.2）：数据范围说明 → 邮箱验证 → 最终确认提交。
 * 同步生成（提交即完成），完成后展示 24 小时下载入口。
 */

type Step = "intro" | "verify" | "confirm";

export function ExportFlow({
	open,
	onOpenChange,
	target,
	onSubmitted,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	target: string;
	onSubmitted?: (view: DataRequestView) => void;
}) {
	const [step, setStep] = useState<Step>("intro");
	const [challengeId, setChallengeId] = useState<string | null>(null);
	const queryClient = useQueryClient();

	const createMutation = useMutation({
		mutationFn: () =>
			dataRequestsApi.create({
				type: "EXPORT",
				challengeId: challengeId ?? "",
			}),
		onSuccess: (view) => {
			toast.success("导出包已生成，24 小时内可下载");
			// 失效当前请求缓存：设置页立即切换为进度卡（重复提交幂等返回原请求）
			invalidateAfterDataRequestMutation(queryClient);
			onSubmitted?.(view);
			reset();
		},
		onError: (error: Error) => toast.error(error.message || "导出失败"),
	});

	const reset = () => {
		setStep("intro");
		setChallengeId(null);
		onOpenChange(false);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) reset();
			}}
		>
			<DialogContent data-testid="export-flow-dialog">
				<DialogHeader>
					<DialogTitle>导出个人数据</DialogTitle>
					<DialogDescription>
						按提交时已保存的数据生成 ZIP 文件（内含 CSV 表格与阅读说明）。
					</DialogDescription>
				</DialogHeader>

				{step === "intro" && (
					<div className="space-y-4" data-testid="export-intro">
						<ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
							<li>账号设置、初始外币、买入、账户、计划、分配、使用、更正</li>
							<li>条款同意记录与历史数据请求记录</li>
							<li>金额标明币种；费用未知将标注「未知」；日期带时区</li>
							<li>不含验证码与登录凭证</li>
						</ul>
						<p className="text-xs text-muted-foreground">
							文件生成后 24 小时内有效，请及时下载。
						</p>
						<DialogFooter>
							<Button variant="outline" onClick={reset}>
								取消
							</Button>
							<Button
								data-testid="export-start-verify"
								onClick={() => setStep("verify")}
							>
								<span className="inline-flex items-center gap-1.5">
									<Download className="size-4" aria-hidden="true" />
									下一步：验证邮箱
								</span>
							</Button>
						</DialogFooter>
					</div>
				)}

				{step === "verify" && (
					<div data-testid="export-verify">
						<OtpVerifyStep
							target={target}
							purpose="EXPORT"
							onVerified={(id) => {
								setChallengeId(id);
								setStep("confirm");
							}}
						/>
					</div>
				)}

				{step === "confirm" && (
					<div className="space-y-4" data-testid="export-confirm">
						<p className="text-sm text-muted-foreground">
							验证已通过（10 分钟内有效）。确认提交后将立即生成导出包。
						</p>
						<DialogFooter>
							<Button variant="outline" onClick={reset}>
								取消
							</Button>
							<Button
								data-testid="export-confirm-submit"
								disabled={createMutation.isPending}
								onClick={() => createMutation.mutate()}
							>
								{createMutation.isPending && (
									<Loader2 className="size-4 animate-spin" aria-hidden="true" />
								)}
								确认导出
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** 导出下载入口（进度卡内使用） */
export function ExportDownloadButton({ view }: { view: DataRequestView }) {
	const downloadMutation = useMutation({
		mutationFn: () => dataRequestsApi.download(view.id, view.scope),
		onError: (error: Error) => toast.error(error.message || "下载失败"),
	});
	if (!view.download) return null;
	return (
		<Button
			variant="outline"
			size="sm"
			data-testid="request-download"
			disabled={downloadMutation.isPending}
			onClick={() => downloadMutation.mutate()}
		>
			{downloadMutation.isPending ? (
				<Loader2 className="size-4 animate-spin" aria-hidden="true" />
			) : (
				<Download className="size-4" aria-hidden="true" />
			)}
			下载导出包
		</Button>
	);
}
