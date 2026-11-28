"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, ShieldAlert } from "lucide-react";
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
import { DATA_REQUESTS_PAGE_PATH, ApiError } from "@/lib/api/client";
import { getBlockingOrganizations } from "@/lib/api/data-requests";
import { useCreatePersonalDataRequest } from "@/lib/hooks/use-data-request";
import { useSwitchOrganization } from "@/lib/hooks/use-organizations";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import type { BlockingOrganization } from "@/lib/api/contract";
import { OtpVerifyStep } from "./otp-verify-step";

/**
 * 注销个人账号流程（需求 6.4；技术方案 §9.2）：将删除内容与先导出提醒 → 邮箱验证 →
 * 最终确认 → 提交后进入进度页（撤回期 7 个自然日）。
 *
 * 这是**个人域**请求，与组织无关：只删除本人的个人身份数据，绝不级联删除所在组织的
 * 共享账本。正因如此有一道前置保护（W26）——本人若仍是某组织的唯一所有者，后端以
 * 409 LAST_OWNER_REQUIRED 拒绝并列出阻塞组织；此时不弹一句报错了事，而是在对话框内
 * 列出这些组织并提供直达入口（先转移所有权或删除组织，再回来注销）。
 */

type Step = "intro" | "verify" | "confirm" | "blocked";

/** 阻塞组织行里「你的角色」的展示文案（后端无成员关系时给 NONE） */
const BLOCKING_ROLE_LABEL: Record<string, string> = {
	OWNER: "所有者",
	ADMIN: "管理员",
	FINANCE: "财务",
	OPERATOR: "操作员",
	VIEWER: "查看者",
	NONE: "无成员关系（名下仍有该组织的共享记录）",
};

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
	const [blockingOrganizations, setBlockingOrganizations] = useState<
		BlockingOrganization[]
	>([]);
	/** 已有进行中的数据请求（本人名下任一域）：后端 409 DATA_REQUEST_CONFLICT */
	const [hasActiveRequest, setHasActiveRequest] = useState(false);
	const router = useRouter();
	const switchOrganization = useSwitchOrganization();
	const activeOrganizationId = useActiveOrgId();
	// 缓存失效（个人域 + 组织域 + 组织锁摘要）在 hook 内统一完成
	const createRequest = useCreatePersonalDataRequest();

	const reset = () => {
		setStep("intro");
		setChallengeId(null);
		setBlockingOrganizations([]);
		setHasActiveRequest(false);
		onOpenChange(false);
	};

	const submit = () => {
		if (!challengeId) {
			toast.error("请先完成邮箱验证");
			return;
		}
		createRequest.mutate(
			{ type: "DELETION", scope: "PERSONAL", challengeId },
			{
				onSuccess: () => {
					toast.success("注销请求已提交，7 个自然日撤回期内可反悔");
					// 进度页随即读到 WITHDRAWAL_PERIOD（锁定由后端守卫强制）
					onSubmitted?.();
					reset();
					// 注销即「退出所有现有登录」的等效体验：直达进度页（其余端点已被锁拦截）。
					// 必须是纯 /data-requests（不拼查询参数）：账号锁的 403 跳转也落在这里
					router.push(DATA_REQUESTS_PAGE_PATH);
				},
				onError: (error: Error) => {
					const blocking = getBlockingOrganizations(error);
					if (blocking) {
						setBlockingOrganizations(blocking);
						setStep("blocked");
						return;
					}
					if (
						error instanceof ApiError &&
						error.code === "DATA_REQUEST_CONFLICT"
					) {
						setHasActiveRequest(true);
						setStep("intro");
						return;
					}
					toast.error(error.message || "提交失败");
				},
			},
		);
	};

	/**
	 * 直达阻塞组织：先切到该组织再进组织页（成员与邀请入口在那里，可转移所有权）。
	 * 只给一个 /organization 链接而不切组织的话，用户看到的会是当前组织的页面。
	 */
	const goToOrganization = (organizationId: string) => {
		reset();
		if (organizationId !== activeOrganizationId) {
			switchOrganization(organizationId);
		}
		router.push("/organization");
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
					<DialogTitle>注销个人账号</DialogTitle>
					<DialogDescription>
						关闭账号并删除你的个人数据，原账号不能恢复。
					</DialogDescription>
				</DialogHeader>

				{step === "intro" && (
					<div className="space-y-4" data-testid="deletion-intro">
						<div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
							<ShieldAlert
								className="mt-0.5 size-4 shrink-0 text-destructive"
								aria-hidden="true"
							/>
							<div className="text-sm text-foreground">
								<p>提交后将删除：</p>
								<ul className="mt-1 list-disc pl-5">
									<li>账号资料（邮箱、姓名）</li>
									<li>个人展示偏好（地区、语言）</li>
									<li>个人 AI 会话元数据与条款同意记录</li>
								</ul>
								<p className="mt-2">
									你所在组织的共享账本、成员账号不会被删除。
								</p>
							</div>
						</div>
						<p className="text-xs text-muted-foreground">
							建议先导出一份个人数据副本；撤回期（7 个自然日）内可验证邮箱撤回注销；
							撤回期结束后账号及上述数据将被删除，不能恢复。
						</p>
						{hasActiveRequest && (
							<div
								className="rounded-lg border border-caution bg-caution p-3 text-sm text-caution"
								role="alert"
								data-testid="deletion-conflict"
							>
								你已有进行中的数据请求，完成或撤回后才能注销账号。
								<Link
									href={DATA_REQUESTS_PAGE_PATH}
									className="ml-1 font-medium text-ink-700 underline-offset-2 hover:text-ink-900 hover:underline"
								>
									查看处理进度
								</Link>
							</div>
						)}
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
							scope="PERSONAL"
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
							验证已通过（10 分钟内有效）。确认后账号立即进入注销撤回期，
							期间业务功能停用，7 个自然日内可验证邮箱撤回。
						</p>
						<DialogFooter>
							<Button variant="outline" onClick={reset}>
								再想想
							</Button>
							<Button
								variant="destructive"
								data-testid="deletion-confirm-submit"
								disabled={createRequest.isPending}
								onClick={submit}
							>
								{createRequest.isPending && (
									<Loader2 className="size-4 animate-spin" aria-hidden="true" />
								)}
								确认注销
							</Button>
						</DialogFooter>
					</div>
				)}

				{step === "blocked" && (
					<div className="space-y-4" data-testid="deletion-blocked">
						<div
							className="flex items-start gap-2 rounded-lg border border-caution bg-caution p-3 text-caution"
							role="alert"
						>
							<ShieldAlert
								className="mt-0.5 size-4 shrink-0 text-caution"
								aria-hidden="true"
							/>
							<div className="text-sm text-caution">
								<p className="font-semibold">暂时无法注销账号</p>
								<p className="mt-1 leading-6">
									你仍是下列组织的唯一所有者。组织不能没有所有者，请先把所有权转移给其他成员，
									或先删除这些组织，再回来注销。
								</p>
							</div>
						</div>

						{blockingOrganizations.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								服务端未返回具体的组织，请到组织页确认你作为所有者的组织。
							</p>
						) : (
							<ul className="space-y-2">
								{blockingOrganizations.map((organization) => (
									<li
										key={organization.organizationId}
										data-testid="blocking-organization-row"
										className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3"
									>
										<div className="min-w-0">
											<p className="truncate text-sm font-medium text-foreground">
												{organization.organizationName}
											</p>
											<p className="mt-0.5 text-xs text-muted-foreground">
												你的角色：
												{BLOCKING_ROLE_LABEL[organization.role] ?? organization.role}
											</p>
										</div>
										<Button
											variant="outline"
											size="sm"
											className="shrink-0 bg-white"
											data-testid="blocking-organization-link"
											onClick={() =>
												goToOrganization(organization.organizationId)
											}
										>
											前往处理
											<ArrowRight className="size-3.5" aria-hidden="true" />
										</Button>
									</li>
								))}
							</ul>
						)}

						<p className="text-xs text-muted-foreground">
							进入组织后可在「成员与邀请」转移所有权；删除组织的入口在设置页的
							「当前组织数据」区。
						</p>
						<DialogFooter>
							<Button variant="outline" onClick={reset}>
								知道了
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
