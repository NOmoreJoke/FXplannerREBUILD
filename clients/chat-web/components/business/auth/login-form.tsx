"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Send } from "lucide-react";
import { toast } from "sonner";
import type { AuthResponse, PasswordLoginInput } from "@/lib/api/contract";
import { authApi } from "@/lib/api/auth";
import { onboardingApi } from "@/lib/api/onboarding";
import { organizationsApi } from "@/lib/api/organizations";
import { queryKeys } from "@/lib/api/query-keys";
import { ApiError } from "@/lib/api/client";
import { safeRedirectPath } from "@/lib/auth/safe-redirect-path";
import { resolvePostLoginTarget } from "@/lib/auth/post-login-target";
import { beginAuthenticatedSession } from "@/lib/auth/session-reset";
import { useOtpCountdown } from "@/lib/hooks/use-otp-countdown";
import { PasswordInput } from "@/components/base";

/**
 * 登录表单校验（与后端 LoginDto 对齐）：邮箱格式 + 密码非空
 */
export const loginSchema = z.object({
	email: z.string().email("邮箱格式不正确"),
	password: z.string().min(1, "请输入密码"),
});

type LoginFormData = z.infer<typeof loginSchema>;
type LoginMode = "password" | "otp";

/** 邮箱正则（对齐后端 otp.service normalizeOtpTarget 的 email 校验；仅支持邮箱，无手机号渠道） */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * OTP 发送目标格式校验（与后端 normalizeOtpTarget 对齐，仅邮箱渠道）
 */
export function isValidOtpTarget(rawTarget: string): boolean {
	const value = rawTarget.trim();
	if (!value) return false;
	return EMAIL_PATTERN.test(value.toLowerCase());
}

/** 统一提取接口错误文案（ApiError / Error / 兜底） */
function getErrorMessage(error: unknown, fallback: string): string {
	if (error instanceof ApiError) return error.message;
	if (error instanceof Error && error.message) return error.message;
	return fallback;
}

export function LoginForm() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const queryClient = useQueryClient();
	const redirect = searchParams.get("redirect");
	const [mode, setMode] = useState<LoginMode>("password");
	const [otpTarget, setOtpTarget] = useState("");
	const [otpCode, setOtpCode] = useState("");
	const [challengeId, setChallengeId] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [isSendingOtp, setIsSendingOtp] = useState(false);
	const {
		seconds: cooldown,
		cooling,
		start: startCooldown,
	} = useOtpCountdown();

	// 合规勾选（onboarding-rework：两项独立、默认不勾；密码与 OTP 双模式均拦截）。
	// OTP 模式发送验证码后不重置勾选状态，登录时随 finishLogin 提交真实勾选值。
	const [age18Confirmed, setAge18Confirmed] = useState(false);
	const [termsConfirmed, setTermsConfirmed] = useState(false);
	const consentsGiven = age18Confirmed && termsConfirmed;

	const {
		register,
		handleSubmit,
		formState: { errors },
	} = useForm<LoginFormData>({
		resolver: zodResolver(loginSchema),
	});

	// 登录成功后的统一收尾：token 只写 cookie（唯一事实来源），并按白名单回跳。
	// 回跳前自动提交登录页勾选的 consents（失败不阻塞，未建账用户由建账后端
	// 校验兜底，技术方案 §3.1）；再按建账态分流：未建账进向导，已建账回首页或
	// 登录前正在浏览的页面（列表拉取失败不拦截，按已建账回跳）。
	const finishLogin = async (result: AuthResponse) => {
		// 评审 R2-I10：写入新 token 之前重置会话上下文——上一个账号（凭证过期后停在
		// 登录页）持久化的组织选择不得被继承。否则下面的组织列表查询会带着旧组织头
		// 发出：新账号不是成员则 404 被吞、未建账的新用户被直接放进 /home 跳过向导；
		// 恰好也是成员则静默继承上一个账号的组织选择（顺序见 beginAuthenticatedSession）
		beginAuthenticatedSession({
			accessToken: result.accessToken,
			user: result.user,
			queryClient,
		});
		try {
			await onboardingApi.saveConsents({ age18Confirmed, termsConfirmed });
		} catch {
			// 失败不阻塞登录流程；未建账用户完成建账时后端会再次校验并拦截
		}
		const safeTarget = safeRedirectPath(redirect);
		let target: string;
		try {
			// 建账态改判个人域端点 GET /organizations（列表项自带 onboardingCompleted）：
			// 登录时组织选择已被会话重置清空，GET /onboarding/status 是组织域端点，
			// W30（MIG-D）起缺组织头一律 400——不得再靠后端回落「唯一默认组织」。
			// 走既有查询键，顺带把结果留在缓存里供受保护区布局的组织路由分流复用。
			const organizations = await queryClient.fetchQuery({
				queryKey: queryKeys.organizations.list(),
				queryFn: () => organizationsApi.list(),
				retry: false,
			});
			target = resolvePostLoginTarget(organizations, safeTarget);
		} catch {
			// 列表拉取失败不阻塞登录：受保护区布局会展示组织路由错误态与重试
			target = safeTarget ?? "/home";
		}
		toast.success("登录成功");
		router.push(target);
	};

	const onPasswordSubmit = async (data: PasswordLoginInput) => {
		try {
			setIsLoading(true);
			await finishLogin(await authApi.login(data));
		} catch (error) {
			toast.error(getErrorMessage(error, "登录失败"));
		} finally {
			setIsLoading(false);
		}
	};

	const sendOtpCode = async () => {
		const target = otpTarget.trim();
		if (!isValidOtpTarget(target)) {
			toast.error("请输入正确的邮箱地址");
			return;
		}

		try {
			setIsSendingOtp(true);
			const result = await authApi.sendOtpCode("email", target);
			setChallengeId(result.challengeId);
			setOtpCode("");
			startCooldown();
			// dev mock 模式：后端未接入真实邮件服务时随响应带回验证码，
			// 提示并自动填入（生产环境无 devCode，流程不变）
			if (result.devCode) {
				setOtpCode(result.devCode);
				toast.success(`验证码已发送（模拟）：${result.devCode}`);
			} else {
				toast.success("验证码已发送，请查收邮箱");
			}
		} catch (error) {
			toast.error(getErrorMessage(error, "验证码发送失败"));
		} finally {
			setIsSendingOtp(false);
		}
	};

	const loginWithOtp = async (event: React.SyntheticEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!challengeId) {
			toast.error("请先获取验证码");
			return;
		}
		if (!/^\d{6}$/.test(otpCode)) {
			toast.error("请输入 6 位验证码");
			return;
		}

		try {
			setIsLoading(true);
			await finishLogin(await authApi.loginWithOtp(challengeId, otpCode));
		} catch (error) {
			toast.error(getErrorMessage(error, "OTP 登录失败"));
		} finally {
			setIsLoading(false);
		}
	};

	const sendOtpLabel = isSendingOtp ? "发送中..." : "获取验证码";

	return (
		<div className="min-h-screen flex items-center justify-center bg-background px-4">
			<div className="w-full max-w-md">
				<div className="rounded-lg bg-card p-8 shadow-panel">
					<div className="mb-8 text-center">
						<div className="mb-3 flex items-center justify-center gap-2.5">
							<div className="flex size-8 items-center justify-center rounded-lg bg-mint-700 text-xs font-bold text-white">
								FX
							</div>
							<h1 className="font-display text-2xl font-semibold text-foreground">
								FXPlanner
							</h1>
						</div>
						<p className="text-muted-foreground">登录您的账户，支持团队协作与组织账本</p>
					</div>

					<div
						className="mb-6 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
						role="tablist"
						aria-label="登录方式"
					>
						<button
							type="button"
							role="tab"
							aria-selected={mode === "password"}
							onClick={() => setMode("password")}
							className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
								mode === "password"
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							密码登录
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={mode === "otp"}
							onClick={() => setMode("otp")}
							className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
								mode === "otp"
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							验证码登录
						</button>
					</div>

					{/* 合规勾选（两种登录模式共享）：默认不勾、相互独立，未全勾时拦截并提示 */}
					<div className="mb-6 space-y-2.5">
						<label className="flex items-start gap-2.5 text-sm text-foreground">
							<input
								type="checkbox"
								data-testid="consent-age18"
								checked={age18Confirmed}
								onChange={(event) => setAge18Confirmed(event.target.checked)}
								className="mt-0.5 size-4 shrink-0 cursor-pointer accent-mint-700"
							/>
							<span>已满 18 周岁</span>
						</label>
						<label className="flex items-start gap-2.5 text-sm text-foreground">
							<input
								type="checkbox"
								data-testid="consent-terms"
								checked={termsConfirmed}
								onChange={(event) => setTermsConfirmed(event.target.checked)}
								className="mt-0.5 size-4 shrink-0 cursor-pointer accent-mint-700"
							/>
							<span>已阅读并同意服务条款与隐私说明</span>
						</label>
						{!consentsGiven && (
							<p
								data-testid="consent-hint"
								className="text-xs text-destructive"
							>
								请先勾选确认年龄与条款
							</p>
						)}
					</div>

					{mode === "password" ? (
						<form
							onSubmit={handleSubmit(onPasswordSubmit)}
							className="space-y-6"
						>
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

							<div>
								<label
									htmlFor="password"
									className="mb-2 block text-sm font-medium text-foreground"
								>
									密码
								</label>
								<PasswordInput
									id="password"
									autoComplete="current-password"
									placeholder="••••••••"
									disabled={isLoading}
									{...register("password")}
								/>
								{errors.password && (
									<p className="mt-1 text-sm text-destructive">
										{errors.password.message}
									</p>
								)}
							</div>

							<button
								type="submit"
								data-testid="password-login-submit"
								disabled={isLoading || !consentsGiven}
								className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-mint-700 px-4 py-2 font-medium text-white transition-colors hover:bg-mint-700/90 disabled:cursor-not-allowed disabled:opacity-50"
							>
								{isLoading ? "登录中..." : "登录"}
							</button>
						</form>
					) : (
						<form onSubmit={loginWithOtp} className="space-y-6">
							<div>
								<label
									htmlFor="otpTarget"
									className="mb-2 block text-sm font-medium text-foreground"
								>
									邮箱
								</label>
								<input
									id="otpTarget"
									name="otpTarget"
									type="email"
									autoComplete="email"
									value={otpTarget}
									onChange={(event) => {
										setOtpTarget(event.target.value);
										setChallengeId(null);
										setOtpCode("");
									}}
									className="w-full rounded-lg border border-border px-4 py-2 focus:border-mint-500 focus:ring-2 focus:ring-mint-500"
									placeholder="your@email.com"
									disabled={isLoading || isSendingOtp}
								/>
							</div>

							<div>
								<label
									htmlFor="otpCode"
									className="mb-2 block text-sm font-medium text-foreground"
								>
									验证码
								</label>
								<div className="flex gap-2">
									<input
										id="otpCode"
										name="otpCode"
										type="text"
										inputMode="numeric"
										autoComplete="one-time-code"
										maxLength={6}
										value={otpCode}
										onChange={(event) =>
											setOtpCode(
												event.target.value.replace(/\D/g, "").slice(0, 6),
											)
										}
										className="min-w-0 flex-1 rounded-lg border border-border px-4 py-2 tracking-[0.2em] focus:border-mint-500 focus:ring-2 focus:ring-mint-500"
										placeholder="6 位数字"
										disabled={isLoading}
									/>
									<button
										type="button"
										data-testid="send-otp"
										onClick={sendOtpCode}
										disabled={
											isLoading || isSendingOtp || cooling || !consentsGiven
										}
										className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
									>
										<Send className="h-4 w-4" aria-hidden="true" />
										{cooling ? `${cooldown}s` : sendOtpLabel}
									</button>
								</div>
							</div>

							<button
								type="submit"
								data-testid="otp-login-submit"
								disabled={isLoading || !challengeId || !consentsGiven}
								className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-mint-700 px-4 py-2 font-medium text-white transition-colors hover:bg-mint-700/90 disabled:cursor-not-allowed disabled:opacity-50"
							>
								{isLoading ? "验证中..." : "验证并登录"}
							</button>
						</form>
					)}

					<div className="mt-6 text-center text-sm text-muted-foreground">
						还没有账户？{" "}
						<Link
							href={
								redirect
									? `/register?redirect=${encodeURIComponent(redirect)}`
									: "/register"
							}
							className="font-medium text-mint-700 transition-colors hover:text-mint-900"
						>
							立即注册
						</Link>
					</div>
				</div>
			</div>
		</div>
	);
}
