"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authApi } from "@/lib/api/auth";
import { dataRequestsApi } from "@/lib/api/data-requests";
import { useOtpCountdown } from "@/lib/hooks/use-otp-countdown";
import type { DataRequestPurpose, DataRequestScope } from "@/lib/api/contract";
import { purposeText } from "./request-copy";

/**
 * 数据操作验证码步骤（account-data 技术方案 §8）：发码 → 倒计时 → 输码 → verify。
 * purpose 透传实现用途隔离（登录码不能顶用）；dev 模式 devCode 自动填充
 * （与登录表单同款，生产无 devCode 流程不变）。
 *
 * scope 决定校验走哪个域的 verify 端点（Goal #3B W27 双域物理拆分后两者不通用）：
 * 个人数据操作走 /data-requests/verify，组织数据操作走
 * /organizations/current/data-requests/verify。发码本身是个人端点，与组织无关。
 */

export interface OtpVerifyStepProps {
	target: string;
	purpose: DataRequestPurpose;
	/** 数据域：个人域导出 / 注销，或组织域导出 / 清空 / 删除 */
	scope: DataRequestScope;
	/** 验证成功回调：携带确认凭证与 10 分钟确认截止 */
	onVerified: (challengeId: string, confirmDeadline: string) => void;
}

export function OtpVerifyStep({
	target,
	purpose,
	scope,
	onVerified,
}: OtpVerifyStepProps) {
	const [challengeId, setChallengeId] = useState<string | null>(null);
	const [code, setCode] = useState("");
	const countdown = useOtpCountdown();

	const sendMutation = useMutation({
		mutationFn: () => authApi.sendOtpCode("email", target, purpose),
		onSuccess: (result) => {
			setChallengeId(result.challengeId);
			countdown.start();
			// dev mock 渠道：验证码随响应返回，自动填充（生产无 devCode，流程不变）
			if (result.devCode) {
				setCode(result.devCode);
				toast.success(`验证码已发送（模拟）：${result.devCode}`);
			} else {
				toast.success("验证码已发送，请查收邮箱");
			}
		},
		onError: (error: Error) => toast.error(error.message || "发送失败，请稍后重试"),
	});

	const verifyMutation = useMutation({
		mutationFn: () => {
			if (!challengeId) throw new Error("请先获取验证码");
			const input = { challengeId, code, purpose };
			return scope === "ORGANIZATION"
				? dataRequestsApi.verifyOrganization(input)
				: dataRequestsApi.verifyPersonal(input);
		},
		onSuccess: (result) => {
			toast.success("验证成功，请在 10 分钟内完成确认");
			onVerified(result.challengeId, result.confirmDeadline);
		},
		onError: (error: Error) => toast.error(error.message || "验证失败"),
	});

	const sending = sendMutation.isPending;
	const verifying = verifyMutation.isPending;

	return (
		<div className="space-y-4" data-testid={`otp-verify-${purpose.toLowerCase()}`}>
			<p className="text-sm text-muted-foreground">
				验证码将发送至{" "}
				<span className="font-medium text-foreground">{target}</span>
				，用于本次「{purposeText(scope, purpose)}」操作确认。
			</p>
			<Button
				type="button"
				variant="outline"
				className="w-full"
				data-testid={`otp-send-${purpose.toLowerCase()}`}
				disabled={sending || countdown.cooling}
				onClick={() => sendMutation.mutate()}
			>
				{sending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
				{countdown.cooling ? `重新发送（${countdown.seconds}s）` : "获取验证码"}
			</Button>
			<Input
				placeholder="6 位验证码"
				inputMode="numeric"
				maxLength={6}
				value={code}
				onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
				data-testid="otp-code-input"
			/>
			<Button
				type="button"
				className="w-full"
				data-testid="otp-verify-submit"
				disabled={!challengeId || code.length !== 6 || verifying}
				onClick={() => verifyMutation.mutate()}
			>
				{verifying && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
				验证
			</Button>
		</div>
	);
}
