"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { ApiError, DATA_REQUESTS_PAGE_PATH } from "@/lib/api/client";
import { useDeleteOrganization } from "@/lib/hooks/use-data-request";
import { OtpVerifyStep } from "./otp-verify-step";

/**
 * 删除当前组织流程（技术方案 §7.2 DELETE /organizations/current；需求 DATA-01）：
 * 删除范围说明 → 邮箱验证 → 最终确认 → 提交后进入 7 日撤回期。
 *
 * - 仅 Owner 可发起（organization.delete；入口由调用方按 capabilities 门控，后端强制）；
 * - 删除的只是该组织与其共享账本、成员与邀请关系、组织设置、审计记录；
 *   **不删除任何成员的个人账号**——成员仍可登录并使用自己的其他组织；
 * - 发起后组织立即进入删除处理期（账本不可读写），到期才真正删除，期内可凭邮箱验证撤回；
 *   个人账号注销走另一条流程（「个人账号与数据」区）。
 */

type Step = "intro" | "verify" | "confirm";

export function OrganizationDeletionFlow({
	open,
	onOpenChange,
	target,
	organizationName,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	target: string;
	organizationName: string | null;
}) {
	const [step, setStep] = useState<Step>("intro");
	const [challengeId, setChallengeId] = useState<string | null>(null);
	const router = useRouter();
	const deleteRequest = useDeleteOrganization();

	const reset = () => {
		setStep("intro");
		setChallengeId(null);
		onOpenChange(false);
	};

	const submit = () => {
		if (!challengeId) {
			toast.error("请先完成邮箱验证");
			return;
		}
		// 缓存失效（组织域 + 组织锁摘要，后者让各页面的锁门控立即生效）在 hook 内统一完成
		deleteRequest.mutate(
			{ challengeId },
			{
				onSuccess: () => {
					toast.success("删除请求已提交，7 个自然日内可撤回");
					reset();
					// 组织随即进入删除处理期：直达进度页（撤回入口在那里）。
					// 纯 /data-requests，不拼查询参数（与组织锁的 403 跳转同一目的地）
					router.push(DATA_REQUESTS_PAGE_PATH);
				},
				onError: (error: Error) => {
					// 凭证失效（过期 / 已用 / 非法）：清掉凭证并退回验证步骤，让用户重新验证
					if (
						error instanceof ApiError &&
						(error.code === "VERIFICATION_EXPIRED" ||
							error.code === "VERIFICATION_USED" ||
							error.code === "VERIFICATION_INVALID")
					) {
						setChallengeId(null);
						setStep("verify");
						toast.error(error.message || "验证已失效，请重新验证邮箱");
						return;
					}
					// 其余错误（409 DATA_REQUEST_CONFLICT / 403 PERMISSION_DENIED 等）：
					// 必须给出反馈，绝不静默卡死在确认页
					toast.error(error.message || "提交失败");
				},
			},
		);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) reset();
			}}
		>
			<DialogContent data-testid="organization-deletion-flow-dialog">
				<DialogHeader>
					<DialogTitle>删除当前组织</DialogTitle>
					<DialogDescription>
						「{organizationName ?? "当前组织"}」将进入 7 日删除期，到期后组织及其共享账本被永久删除。
					</DialogDescription>
				</DialogHeader>

				{step === "intro" && (
					<div className="space-y-4" data-testid="organization-deletion-intro">
						<div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
							<ShieldAlert
								className="mt-0.5 size-4 shrink-0 text-destructive"
								aria-hidden="true"
							/>
							<div className="text-sm text-destructive">
								<p>到期后将删除：</p>
								<ul className="mt-1 list-disc pl-5">
									<li>该组织的共享账本：买入、账户、计划、分配、使用与更正记录</li>
									<li>组织信息、成员与邀请关系、组织设置、审计记录</li>
								</ul>
							</div>
						</div>
						<p className="text-sm text-foreground" data-testid="organization-deletion-members-note">
							不删除任何成员的个人账号：成员仍可登录，并继续使用自己的其他组织。
						</p>
						<p className="text-xs text-muted-foreground">
							建议先由有权限的成员导出一份组织账本副本；提交后组织立即进入删除处理期，
							账本不可再读写，7 个自然日内可验证邮箱撤回，到期后不能恢复。
						</p>
						<DialogFooter>
							<Button variant="outline" onClick={reset}>
								取消
							</Button>
							<Button
								variant="destructive"
								data-testid="organization-deletion-start-verify"
								onClick={() => setStep("verify")}
							>
								下一步：验证邮箱
							</Button>
						</DialogFooter>
					</div>
				)}

				{step === "verify" && (
					<div data-testid="organization-deletion-verify">
						<OtpVerifyStep
							target={target}
							purpose="DELETION"
							scope="ORGANIZATION"
							onVerified={(id) => {
								setChallengeId(id);
								setStep("confirm");
							}}
						/>
					</div>
				)}

				{step === "confirm" && (
					<div className="space-y-4" data-testid="organization-deletion-confirm">
						<p className="text-sm text-muted-foreground">
							验证已通过（10 分钟内有效）。确认后「{organizationName ?? "当前组织"}」
							立即进入删除处理期，全体成员都不能再读写该组织的账本；7 个自然日内可验证邮箱撤回。
						</p>
						<DialogFooter>
							<Button variant="outline" onClick={reset}>
								再想想
							</Button>
							<Button
								variant="destructive"
								data-testid="organization-deletion-confirm-submit"
								disabled={deleteRequest.isPending}
								onClick={submit}
							>
								{deleteRequest.isPending && (
									<Loader2 className="size-4 animate-spin" aria-hidden="true" />
								)}
								确认删除组织
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
