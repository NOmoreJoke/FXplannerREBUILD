"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, TriangleAlert } from "lucide-react";
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
import { OtpVerifyStep } from "./otp-verify-step";

/**
 * 注销账号流程（需求 6.4）：将删除内容与先导出提醒 → 邮箱验证 →
 * 最终确认 → 提交后立即退出登录并进入进度页（撤回期 7 个自然日）。
 */

type Step = "intro" | "verify" | "confirm";

export function DeletionFlow({
	open,
	onOpenChange,
	target,
	onSubmitted,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	target: string;
	onSubmitted?: () => void;
}) {
	const [step, setStep] = useState<Step>("intro");
	const [challengeId, setChallengeId] = useState<string | null>(null);
	const queryClient = useQueryClient();
	const router = useRouter();

	const createMutation = useMutation({
		mutationFn: () =>
			dataRequestsApi.create({
				type: "DELETION",
				challengeId: challengeId ?? "",
			}),
		onSuccess: () => {
			toast.success("注销请求已提交，7 个自然日撤回期内可反悔");
			// 失效当前请求缓存：进度页读到 WITHDRAWAL_PERIOD（锁定由后端守卫强制）
			void queryClient.invalidateQueries({ queryKey: ["data-request"] });
			onSubmitted?.();
			reset();
			// 注销即「退出所有现有登录」的等效体验：直达进度页（其余端点已被锁拦截）
			router.push("/data-requests");
		},
		onError: (error: Error) => toast.error(error.message || "提交失败"),
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
			<DialogContent data-testid="deletion-flow-dialog">
				<DialogHeader>
					<DialogTitle>注销账号</DialogTitle>
					<DialogDescription>
						关闭账号并删除全部个人数据，原账号不能恢复。
					</DialogDescription>
				</DialogHeader>

				{step === "intro" && (
					<div className="space-y-4" data-testid="deletion-intro">
						<div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 dark:bg-red-950/30">
							<TriangleAlert
								className="mt-0.5 size-4 shrink-0 text-red-600"
								aria-hidden="true"
							/>
							<div className="text-sm text-red-800 dark:text-red-200">
								<p>提交后将删除：</p>
								<ul className="mt-1 list-disc pl-5">
									<li>账号资料（邮箱等）与全部业务记录</li>
									<li>地区语言、准备偏好、提醒设置</li>
								</ul>
							</div>
						</div>
						<p className="text-xs text-muted-foreground">
							建议先导出一份数据副本；撤回期（7 个自然日）内可验证邮箱撤回注销；
							撤回期结束后账号关闭，30 个自然日内完成清理，之后该邮箱可注册新账号。
						</p>
						<DialogFooter>
							<Button variant="outline" onClick={reset}>
								取消
							</Button>
							<Button
								variant="destructive"
								data-testid="deletion-start-verify"
								onClick={() => setStep("verify")}
							>
								下一步：验证邮箱
							</Button>
						</DialogFooter>
					</div>
				)}

				{step === "verify" && (
					<div data-testid="deletion-verify">
						<OtpVerifyStep
							target={target}
							purpose="DELETION"
							onVerified={(id) => {
								setChallengeId(id);
								setStep("confirm");
							}}
						/>
					</div>
				)}

				{step === "confirm" && (
					<div className="space-y-4" data-testid="deletion-confirm">
						<p className="text-sm text-muted-foreground">
							验证已通过（10 分钟内有效）。确认后所有登录立即失效、账本与提醒停用，
							进入 7 个自然日撤回期。
						</p>
						<DialogFooter>
							<Button variant="outline" onClick={reset}>
								再想想
							</Button>
							<Button
								variant="destructive"
								data-testid="deletion-confirm-submit"
								disabled={createMutation.isPending}
								onClick={() => createMutation.mutate()}
							>
								{createMutation.isPending && (
									<Loader2 className="size-4 animate-spin" aria-hidden="true" />
								)}
								确认注销
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
