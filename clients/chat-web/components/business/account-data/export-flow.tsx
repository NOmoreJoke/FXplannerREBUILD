"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
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
import {
	useCreateOrganizationDataRequest,
	useCreatePersonalDataRequest,
} from "@/lib/hooks/use-data-request";
import { useOrganizationCapabilities } from "@/lib/hooks/use-organization-capabilities";
import type { DataRequestScope, DataRequestView } from "@/lib/api/contract";
import { OtpVerifyStep } from "./otp-verify-step";

/**
 * 导出流程（需求 6.2）：数据范围说明 → 邮箱验证 → 最终确认提交。
 * 同步生成（提交即完成），完成后展示 24 小时下载入口。
 *
 * 个人域与组织域是两份不同的数据、两个不同的端点（Goal #3B W26/W28）：
 * - PERSONAL：本人的个人数据副本（资料、偏好、组织摘要、会话元数据），不含组织账本；
 * - ORGANIZATION：当前组织的共享账本全量导出，需 data.export 权限（入口由调用方门控）。
 * 说明文案必须如实区分——用户据此判断自己拿到的会是什么。
 */

type Step = "intro" | "verify" | "confirm";

/** 两个域的说明文案（如实描述各自导出包的内容，取自后端 export-builder 的 README） */
const EXPORT_COPY = {
	PERSONAL: {
		title: "导出个人数据",
		description:
			"生成一份你的个人数据副本（ZIP 文件，内含 CSV 表格与阅读说明）。不包含任何组织的账本明细。",
		items: [
			"账号资料：邮箱、姓名、注册时间",
			"个人展示偏好：语言、地区",
			"所属组织摘要：组织名称、你的角色与加入时间",
			"AI 会话元数据：标题与时间，不含消息正文",
			"条款同意记录与个人数据请求记录",
		],
		note: "文件生成后 24 小时内有效，请及时下载。需要组织账本数据时，请由具备权限的成员在「当前组织数据」区导出。",
	},
	ORGANIZATION: {
		title: "导出组织账本",
		description:
			"按提交时已保存的数据生成当前组织账本的副本（ZIP 文件，内含 CSV 表格与阅读说明）。",
		items: [
			"组织设置、初始外币、买入记录、外汇账户",
			"换汇计划、计划分配、资金使用记录与更正历史",
			"金额标明币种；费用未知将标注「未知」；日期带时区",
			"不含验证码与登录凭证",
		],
		note: "文件生成后 24 小时内有效，请及时下载。导出内容是当前组织的共享账本，请妥善保管。",
	},
} as const;

export interface ExportFlowProps {
	/** 数据域：决定提交到个人端点还是组织端点 */
	scope: DataRequestScope;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	target: string;
	onSubmitted?: (view: DataRequestView) => void;
}

export function ExportFlow({
	scope,
	open,
	onOpenChange,
	target,
	onSubmitted,
}: ExportFlowProps) {
	const [step, setStep] = useState<Step>("intro");
	const [challengeId, setChallengeId] = useState<string | null>(null);
	const copy = EXPORT_COPY[scope];
	// 两个域的提交 hook 都要无条件调用（hooks 顺序恒定），实际只触发所在域的那一个
	const createPersonal = useCreatePersonalDataRequest();
	const createOrganization = useCreateOrganizationDataRequest();
	const isPending = createPersonal.isPending || createOrganization.isPending;

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
		// 缓存失效（个人域 + 组织域 + 组织锁摘要）在 hook 内统一完成
		const callbacks = {
			onSuccess: (view: DataRequestView) => {
				toast.success("导出包已生成，24 小时内可下载");
				// 设置页随即切换为进度卡（重复提交幂等返回原请求）
				onSubmitted?.(view);
				reset();
			},
			onError: (error: Error) => toast.error(error.message || "导出失败"),
		};
		if (scope === "ORGANIZATION") {
			createOrganization.mutate(
				{ type: "EXPORT", scope: "ORGANIZATION", challengeId },
				callbacks,
			);
		} else {
			createPersonal.mutate(
				{ type: "EXPORT", scope: "PERSONAL", challengeId },
				callbacks,
			);
		}
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
					<DialogTitle>{copy.title}</DialogTitle>
					<DialogDescription>{copy.description}</DialogDescription>
				</DialogHeader>

				{step === "intro" && (
					<div className="space-y-4" data-testid="export-intro">
						<p className="text-sm font-medium text-foreground">
							{scope === "PERSONAL"
								? "导出包将包含以下个人数据："
								: "导出包将包含当前组织的以下数据："}
						</p>
						<ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
							{copy.items.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
						<p className="text-xs text-muted-foreground">{copy.note}</p>
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
							scope={scope}
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
								disabled={isPending}
								onClick={submit}
							>
								{isPending && (
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

/** 导出下载入口（进度卡内使用）；个人域与组织域走各自的下载端点 */
export function ExportDownloadButton({ view }: { view: DataRequestView }) {
	const { can } = useOrganizationCapabilities();
	const downloadMutation = useMutation({
		mutationFn: () =>
			view.scope === "ORGANIZATION"
				? dataRequestsApi.downloadOrganization(view.id)
				: dataRequestsApi.downloadPersonal(view.id),
		onError: (error: Error) => toast.error(error.message || "下载失败"),
	});
	// 组织导出的下载需 data.export：降权为 Operator / Viewer 后不再出现越权的下载按钮
	// （后端对下载实时复验，这里只防误触）；个人导出是本人的数据，始终可下载
	const permitted = view.scope === "PERSONAL" || can("data.export");
	if (!view.download || !permitted) return null;
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
