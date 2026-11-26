"use client";

import { useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
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
import { useOrganizationCapabilities } from "@/lib/hooks/use-organization-capabilities";
import {
	useCreateOrganizationDataRequest,
	useOrganizationImpact,
} from "@/lib/hooks/use-data-request";
import type { ImpactTotals } from "@/lib/api/contract";
import { OtpVerifyStep } from "./otp-verify-step";

/**
 * 清空组织账本流程（需求 6.3；技术方案 §9.2：原个人「清空业务记录」自 W26 起是组织域
 * 的 ORGANIZATION CLEAR）：记录数量与不可恢复警示 → 可选先导出 → 邮箱验证 →
 * 最终确认（快照比对，变化则要求重新确认）。
 *
 * 只清空**当前组织**的账本，不影响成员账号与其他组织；需 data.clear 权限（入口由
 * 调用方门控）。影响快照只在对话框打开后才请求（见 useOrganizationImpact）。
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
	organizationName,
	onSubmitted,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	target: string;
	organizationName: string | null;
	onSubmitted?: () => void;
}) {
	const [step, setStep] = useState<Step>("intro");
	const [challengeId, setChallengeId] = useState<string | null>(null);
	const { baseCurrency } = useOrganizationCapabilities();
	const impact = useOrganizationImpact({ enabled: open });
	const createRequest = useCreateOrganizationDataRequest();
	// 影响快照：未就绪时为 undefined（确认页显示「正在统计」、按钮禁用）
	const totals = impact.data?.totals;
	const hasDownloadableExport = impact.data?.hasDownloadableExport === true;

	const submit = () => {
		if (!challengeId) {
			toast.error("请先完成邮箱验证");
			return;
		}
		// 确认按钮在影响快照未就绪时本就禁用；这里再拦一道，快照缺失不提交
		if (!totals) return;
		// 缓存失效（组织域 + 组织锁摘要）在 hook 内统一完成
		createRequest.mutate(
			{
				type: "CLEAR",
				scope: "ORGANIZATION",
				challengeId,
				confirmedTotals: totals,
			},
			{
				onSuccess: () => {
					toast.success("清空请求已提交，开始清理前可撤回");
					// 设置页随即切换为进度卡（写锁同步生效）
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
			},
		);
	};

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
					<DialogTitle>清空组织账本</DialogTitle>
					<DialogDescription>
						删除「{organizationName ?? "当前组织"}」的全部账本记录，保留组织、
						成员账号与本位币设置。
					</DialogDescription>
				</DialogHeader>

				{step === "intro" && (
					<div className="space-y-4" data-testid="clear-intro">
						{totals ? (
							<div data-testid="clear-totals">
								<p className="text-sm font-medium text-foreground">
									本次将删除以下记录：
								</p>
								<ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
									{TOTAL_LABELS.map(([key, label]) => (
										<li key={key}>
											{label}：
											<span className="font-medium text-foreground">
												{totals[key]} 项
											</span>
										</li>
									))}
								</ul>
							</div>
						) : (
							<p className="text-sm text-muted-foreground">正在统计记录数量…</p>
						)}
						<div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
							<ShieldAlert
								className="mt-0.5 size-4 shrink-0 text-destructive"
								aria-hidden="true"
							/>
							<p
								className="text-sm text-destructive"
								data-testid="clear-warning"
							>
								这是删除全部业务记录，不是取消一个计划；删除后不能恢复。
							</p>
						</div>
						<p className="text-xs text-muted-foreground" data-testid="clear-ledger-note">
							清空后账本记录与记账起点一并清空
							{baseCurrency ? `，本位币（${baseCurrency}）与准备偏好保留` : ""}
							；只影响当前组织，成员账号与你所在的其他组织不受影响。
						</p>
						<p className="text-xs text-muted-foreground">
							可先导出一份数据副本留存；提交后 7 个自然日内完成清理，开始清理前可撤回。
						</p>
						{hasDownloadableExport && (
							<p className="text-xs text-muted-foreground">
								已有一份仍可下载的组织导出包，可在进度页直接取用。
							</p>
						)}
						<DialogFooter>
							<Button variant="outline" onClick={reset}>
								取消
							</Button>
							<Button
								variant="destructive"
								data-testid="clear-start-verify"
								disabled={!totals}
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
							scope="ORGANIZATION"
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
							验证已通过（10 分钟内有效）。提交后立即停止新增和修改当前组织的业务记录，
							7 个自然日内完成清理；开始清理前可撤回。
						</p>
						<DialogFooter>
							<Button variant="outline" onClick={reset}>
								再想想
							</Button>
							<Button
								variant="destructive"
								data-testid="clear-confirm-submit"
								disabled={createRequest.isPending || !totals}
								onClick={submit}
							>
								{createRequest.isPending && (
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
