"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Mail, MessageSquare, Send } from "lucide-react";
import { toast } from "sonner";
import type {
	AuthResponse,
	OtpChannel,
	PasswordLoginInput,
} from "@/lib/api/contract";
import { authApi } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/client";
import { safeRedirectPath } from "@/lib/auth/safe-redirect-path";
import { setToken } from "@/lib/auth/token";
import { useAuthStore } from "@/lib/stores/auth-store";
import { useOtpCountdown } from "@/lib/hooks/use-otp-countdown";

/**
 * 登录表单校验（与后端 LoginDto 对齐）：邮箱格式 + 密码非空
 */
export const loginSchema = z.object({
	email: z.string().email("邮箱格式不正确"),
	password: z.string().min(1, "请输入密码"),
});

type LoginFormData = z.infer<typeof loginSchema>;
type LoginMode = "password" | "otp";

/** 邮箱正则（对齐后端 otp.service normalizeOtpTarget 的 email 校验） */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** E.164 手机号正则（对齐后端 otp.service normalizeOtpTarget 的 phone 校验） */
const E164_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * OTP 发送目标格式校验（与后端 normalizeOtpTarget 对齐）
 * email 渠道校验邮箱格式；phone 渠道先归一化（去空格/横线/括号、00 → +）再校验 E.164
 */
export function isValidOtpTarget(
	channel: OtpChannel,
	rawTarget: string,
): boolean {
	const value = rawTarget.trim();
	if (!value) return false;
	if (channel === "email") {
		return EMAIL_PATTERN.test(value.toLowerCase());
	}
	const normalized = value.replace(/[\s()-]/g, "").replace(/^00/, "+");
	return E164_PHONE_PATTERN.test(normalized);
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
	const setUser = useAuthStore((s) => s.setUser);
	const redirect = searchParams.get("redirect");
	const [mode, setMode] = useState<LoginMode>("password");
	const [channel, setChannel] = useState<OtpChannel>("email");
	const [otpTarget, setOtpTarget] = useState("");
	const [otpCode, setOtpCode] = useState("");
	const [challengeId, setChallengeId] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [isSendingOtp, setIsSendingOtp] = useState(false);
	const {
		seconds: cooldown,
		cooling,
		start: startCooldown,
		reset: resetCooldown,
	} = useOtpCountdown();

	const {
		register,
		handleSubmit,
		formState: { errors },
	} = useForm<LoginFormData>({
		resolver: zodResolver(loginSchema),
	});

	// 登录成功后的统一收尾：token 只写 cookie（唯一事实来源），并按白名单回跳
	const finishLogin = (result: AuthResponse) => {
		setToken(result.accessToken);
		setUser(result.user);
		toast.success("登录成功");
		router.push(safeRedirectPath(redirect) ?? "/home");
	};

	const onPasswordSubmit = async (data: PasswordLoginInput) => {
		try {
			setIsLoading(true);
			finishLogin(await authApi.login(data));
		} catch (error) {
			toast.error(getErrorMessage(error, "登录失败"));
		} finally {
			setIsLoading(false);
		}
	};

	const changeChannel = (nextChannel: OtpChannel) => {
		setChannel(nextChannel);
		setOtpTarget("");
		setOtpCode("");
		setChallengeId(null);
		resetCooldown();
	};

	const sendOtpCode = async () => {
		const target = otpTarget.trim();
		if (!isValidOtpTarget(channel, target)) {
			toast.error(
				channel === "email"
					? "请输入正确的邮箱地址"
					: "请输入正确的手机号（E.164 格式，如 +8613800138000）",
			);
			return;
		}

		try {
			setIsSendingOtp(true);
			const result = await authApi.sendOtpCode(channel, target);
			setChallengeId(result.challengeId);
			setOtpCode("");
			startCooldown();
			toast.success("验证码已发送");
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
			finishLogin(await authApi.loginWithOtp(challengeId, otpCode));
		} catch (error) {
			toast.error(getErrorMessage(error, "OTP 登录失败"));
		} finally {
			setIsLoading(false);
		}
	};

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
						<p className="text-muted-foreground">登录您的账户</p>
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
								<input
									id="password"
									type="password"
									autoComplete="current-password"
									{...register("password")}
									className="w-full rounded-lg border border-border px-4 py-2 focus:border-mint-500 focus:ring-2 focus:ring-mint-500"
									placeholder="••••••••"
									disabled={isLoading}
								/>
								{errors.password && (
									<p className="mt-1 text-sm text-destructive">
										{errors.password.message}
									</p>
								)}
							</div>

							<button
								type="submit"
								disabled={isLoading}
								className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-mint-700 px-4 py-2 font-medium text-white transition-colors hover:bg-mint-700/90 disabled:cursor-not-allowed disabled:opacity-50"
							>
								{isLoading ? "登录中..." : "登录"}
							</button>
						</form>
					) : (
						<form onSubmit={loginWithOtp} className="space-y-6">
							<div className="grid grid-cols-2 gap-2">
								<button
									type="button"
									aria-pressed={channel === "email"}
									onClick={() => changeChannel("email")}
									className={`inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
										channel === "email"
											? "border-mint-700 bg-mint-50 text-mint-700"
											: "border-border text-muted-foreground hover:border-ink-300"
									}`}
								>
									<Mail className="h-4 w-4" aria-hidden="true" />
									邮箱
								</button>
								<button
									type="button"
									aria-pressed={channel === "phone"}
									onClick={() => changeChannel("phone")}
									className={`inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
										channel === "phone"
											? "border-mint-700 bg-mint-50 text-mint-700"
											: "border-border text-muted-foreground hover:border-ink-300"
									}`}
								>
									<MessageSquare className="h-4 w-4" aria-hidden="true" />
									手机号
								</button>
							</div>

							<div>
								<label
									htmlFor="otpTarget"
									className="mb-2 block text-sm font-medium text-foreground"
								>
									{channel === "email" ? "邮箱" : "手机号"}
								</label>
								<input
									id="otpTarget"
									name="otpTarget"
									type={channel === "email" ? "email" : "tel"}
									autoComplete={channel === "email" ? "email" : "tel"}
									value={otpTarget}
									onChange={(event) => {
										setOtpTarget(event.target.value);
										setChallengeId(null);
										setOtpCode("");
									}}
									className="w-full rounded-lg border border-border px-4 py-2 focus:border-mint-500 focus:ring-2 focus:ring-mint-500"
									placeholder={
										channel === "email" ? "your@email.com" : "+8613800138000"
									}
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
										onClick={sendOtpCode}
										disabled={isLoading || isSendingOtp || cooling}
										className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
									>
										<Send className="h-4 w-4" aria-hidden="true" />
										{cooling
											? `${cooldown}s`
											: isSendingOtp
												? "发送中..."
												: "获取验证码"}
									</button>
								</div>
							</div>

							<button
								type="submit"
								disabled={isLoading || !challengeId}
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
