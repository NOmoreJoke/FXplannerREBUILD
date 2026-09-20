"use client";

import { useState } from "react";
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
import { ApiError } from "@/lib/api/client";
import { dataRequestsApi } from "@/lib/api/data-requests";
import { useImpact } from "@/lib/hooks/use-data-request";
import type { ImpactTotals } from "@/lib/api/contract";
import { OtpVerifyStep } from "./otp-verify-step";

/**
 * 清空业务记录流程（需求 6.3）：记录数量与不可恢复警示 → 可选先导出 →
 * 邮箱验证 → 最终确认（快照比对，变化则要求重新确认）。
 */

type Step = "intro" | "verify" | "confirm";

const TOTAL_LABELS: Array<[keyof ImpactTotals, string]> = [
	["transactions", "买入记录"],
	["plans", "换汇计划"],
	["accounts", "外汇账户"],
	["initialHoldings", "初始外币"],
	["usageRecords", "资金使用记录"],
	["corrections", "更正记录"],
];

export function ClearFlow({
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
	const impact = useImpact();

	const createMutation = useMutation({
		mutationFn: (totals: ImpactTotals | undefined) =>
			dataRequestsApi.create({
				type: "CLEAR",
				challengeId: challengeId ?? "",
				confirmedTotals: totals,
			}),
		onSuccess: () => {
			toast.success("清空请求已提交，开始清理前可撤回");
			// 失效当前请求缓存：设置页立即切换为进度卡（写锁同步生效）
			void queryClient.invalidateQueries({ queryKey: ["data-request"] });
			onSubmitted?.();
			reset();
		},
		onError: (error: Error) => {
			if (error instanceof ApiError && error.code === "IMPACT_CHANGED") {
				toast.error("数据已发生变化，请重新确认影响");
				setStep("intro");
				return;
			}
			toast.error(error.message || "提交失败");
		},
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
			<DialogContent data-testid="clear-flow-dialog">
				<DialogHeader>
					<DialogTitle>清空业务记录</DialogTitle>
					<DialogDescription>
						删除全部业务记录，保留账号与本位币设置。
					</DialogDescription>
				</DialogHeader>

				{step === "intro" && (
					<div className="space-y-4" data-testid="clear-intro">
						{impact.data ? (
							<div data-testid="clear-totals">
								<p className="text-sm font-medium text-foreground">
									本次将删除以下记录：
								</p>
								<ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
									{TOTAL_LABELS.map(([key, label]) => (
										<li key={key}>
											{label}：
											<span className="font-medium text-foreground">
												{impact.data!.totals[key]} 项
											</span>
										</li>
									))}
								</ul>
							</div>
						) : (
							<p className="text-sm text-muted-foreground">正在统计记录数量…</p>
						)}
						<div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/30">
							<TriangleAlert
								className="mt-0.5 size-4 shrink-0 text-amber-600"
								aria-hidden="true"
							/>
							<p
								className="text-sm text-amber-800 dark:text-amber-200"
								data-testid="clear-warning"
							>
								这是删除全部业务记录，不是取消一个计划；删除后不能恢复。
							</p>
						</div>
						<p className="text-xs text-muted-foreground">
							可先导出一份数据副本留存；提交后 7 个自然日内完成清理，开始清理前可撤回。
						</p>
						<DialogFooter>
							<Button variant="outline" onClick={reset}>
								取消
							</Button>
							<Button
								variant="destructive"
								data-testid="clear-start-verify"
								disabled={!impact.data}
								onClick={() => setStep("verify")}
							>
								下一步：验证邮箱
							</Button>
						</DialogFooter>
					</div>
				)}

				{step === "verify" && (
					<div data-testid="clear-verify">
						<OtpVerifyStep
							target={target}
							purpose="CLEAR"
							onVerified={(id) => {
								setChallengeId(id);
								setStep("confirm");
							}}
						/>
					</div>
				)}

				{step === "confirm" && (
					<div className="space-y-4" data-testid="clear-confirm">
						<p className="text-sm text-muted-foreground">
							验证已通过（10 分钟内有效）。提交后立即停止新增和修改业务记录，
							7 个自然日内完成清理；开始清理前可撤回。
						</p>
						<DialogFooter>
							<Button variant="outline" onClick={reset}>
								再想想
							</Button>
							<Button
								variant="destructive"
								data-testid="clear-confirm-submit"
								disabled={createMutation.isPending || !impact.data}
								onClick={() => createMutation.mutate(impact.data!.totals)}
							>
								{createMutation.isPending && (
									<Loader2 className="size-4 animate-spin" aria-hidden="true" />
								)}
								确认清空
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
