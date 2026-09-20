"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { authApi } from "@/lib/api/auth";
import { onboardingApi } from "@/lib/api/onboarding";
import { ApiError } from "@/lib/api/client";
import { safeRedirectPath } from "@/lib/auth/safe-redirect-path";
import { setToken } from "@/lib/auth/token";
import { useAuthStore } from "@/lib/stores/auth-store";
import { PasswordInput } from "@/components/base";

/**
 * 注册表单校验（与后端 RegisterDto 对齐）：min(8) + 大小写字母和数字 + 两次密码一致
 */
export const registerSchema = z
	.object({
		email: z.string().email("邮箱格式不正确"),
		password: z
			.string()
			.min(8, "密码长度至少为 8 位")
			.regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, "密码必须包含大小写字母和数字"),
		confirmPassword: z.string().min(1, "请确认密码"),
	})
	.refine((data) => data.password === data.confirmPassword, {
		message: "两次输入的密码不一致",
		path: ["confirmPassword"],
	});

type RegisterFormData = z.infer<typeof registerSchema>;

export function RegisterForm() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const setUser = useAuthStore((s) => s.setUser);
	const redirect = searchParams.get("redirect");
	const [isLoading, setIsLoading] = useState(false);

	// 合规勾选（FE-08：与登录页「登录即用」同级交互，两项独立、默认不勾）。
	// 注册即登录：setToken 后随首次会话提交 saveConsents（失败不阻塞，
	// 未建账用户由建账后端校验兜底）。未全勾时拦截提交。
	const [age18Confirmed, setAge18Confirmed] = useState(false);
	const [termsConfirmed, setTermsConfirmed] = useState(false);
	const consentsGiven = age18Confirmed && termsConfirmed;
	const [consentTouched, setConsentTouched] = useState(false);
	const showConsentHint = consentTouched && !consentsGiven;

	const {
		register,
		handleSubmit,
		formState: { errors },
	} = useForm<RegisterFormData>({
		resolver: zodResolver(registerSchema),
	});

	const onSubmit = async (data: RegisterFormData) => {
		if (!consentsGiven) {
			setConsentTouched(true);
			return;
		}
		try {
			setIsLoading(true);
			const result = await authApi.register(data);

			// token 只写 cookie（唯一事实来源），注册即登录
			setToken(result.accessToken);
			setUser(result.user);

			// 随注册会话提交合规确认（同登录页 finishLogin 语义；失败不阻塞，
			// 未建账用户完成建账时后端会再次校验并拦截）
			try {
				await onboardingApi.saveConsents({
					age18Confirmed,
					termsConfirmed,
				});
			} catch {
				// 失败不阻塞注册流程
			}

			toast.success("注册成功");

			router.push(safeRedirectPath(redirect) ?? "/home");
		} catch (error: unknown) {
			if (error instanceof ApiError) {
				toast.error(error.message);
			} else if (error instanceof Error && error.message) {
				toast.error(error.message);
			} else {
				toast.error("注册失败");
			}
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<div className="min-h-screen flex items-center justify-center bg-background px-4">
			<div className="w-full max-w-md">
				<div className="rounded-lg bg-card p-8 shadow-panel">
					{/* 头部 */}
					<div className="mb-8 text-center">
						<div className="mb-3 flex items-center justify-center gap-2.5">
							<div className="flex size-8 items-center justify-center rounded-lg bg-mint-700 text-xs font-bold text-white">
								FX
							</div>
							<h1 className="font-display text-2xl font-semibold text-foreground">
								FXPlanner
							</h1>
						</div>
						<p className="text-muted-foreground">创建您的账户</p>
					</div>

					{/* 表单 */}
					<form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
						{/* 邮箱 */}
						<div>
							<label
								htmlFor="email"
								className="mb-2 block text-sm font-medium text-foreground"
							>
								邮箱
							</label>
							<input
								id="email"
								type="email"
								autoComplete="email"
								{...register("email")}
								className="w-full rounded-lg border border-border px-4 py-2 focus:border-mint-500 focus:ring-2 focus:ring-mint-500"
								placeholder="your@email.com"
								disabled={isLoading}
							/>
							{errors.email && (
								<p className="mt-1 text-sm text-destructive">
									{errors.email.message}
								</p>
							)}
						</div>

						{/* 密码 */}
						<div>
							<label
								htmlFor="password"
								className="mb-2 block text-sm font-medium text-foreground"
							>
								密码
							</label>
							<PasswordInput
								id="password"
								autoComplete="new-password"
								{...register("password")}
								placeholder="至少 8 位，含大小写字母和数字"
								disabled={isLoading}
							/>
							{errors.password && (
								<p className="mt-1 text-sm text-destructive">
									{errors.password.message}
								</p>
							)}
						</div>

						{/* 确认密码 */}
						<div>
							<label
								htmlFor="confirmPassword"
								className="mb-2 block text-sm font-medium text-foreground"
							>
								确认密码
							</label>
							<PasswordInput
								id="confirmPassword"
								autoComplete="new-password"
								{...register("confirmPassword")}
								placeholder="再次输入密码"
								disabled={isLoading}
							/>
							{errors.confirmPassword && (
								<p className="mt-1 text-sm text-destructive">
									{errors.confirmPassword.message}
								</p>
							)}
						</div>

						{/* 合规勾选（FE-08）：两项独立、默认不勾，未全勾时拦截提交 */}
						<div className="space-y-2.5">
							<label className="flex items-start gap-2.5 text-sm text-foreground">
								<input
									type="checkbox"
									data-testid="consent-age18"
									checked={age18Confirmed}
									onChange={(event) => {
										setConsentTouched(true);
										setAge18Confirmed(event.target.checked);
									}}
									className="mt-0.5 size-4 shrink-0 cursor-pointer accent-mint-700"
								/>
								<span>已满 18 周岁</span>
							</label>
							<label className="flex items-start gap-2.5 text-sm text-foreground">
								<input
									type="checkbox"
									data-testid="consent-terms"
									checked={termsConfirmed}
									onChange={(event) => {
										setConsentTouched(true);
										setTermsConfirmed(event.target.checked);
									}}
									className="mt-0.5 size-4 shrink-0 cursor-pointer accent-mint-700"
								/>
								<span>已阅读并同意服务条款与隐私说明</span>
							</label>
							{showConsentHint && (
								<p
									data-testid="consent-hint"
									className="text-xs text-destructive"
								>
									请先勾选确认年龄与条款
								</p>
							)}
						</div>

						{/* 提交按钮 */}
						<button
							type="submit"
							disabled={isLoading}
							className="w-full rounded-lg bg-mint-700 px-4 py-2 font-medium text-white transition-colors hover:bg-mint-700/90 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{isLoading ? "注册中..." : "注册"}
						</button>
					</form>

					{/* 底部链接 */}
					<div className="mt-6 text-center text-sm text-muted-foreground">
						已有账户？{" "}
						<Link
							href={
								redirect
									? `/login?redirect=${encodeURIComponent(redirect)}`
									: "/login"
							}
							className="font-medium text-mint-700 transition-colors hover:text-mint-900"
						>
							立即登录
						</Link>
					</div>
				</div>
			</div>
		</div>
	);
}
