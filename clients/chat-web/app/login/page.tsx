"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Mail, MessageSquare, Send } from "lucide-react";
import toast from "react-hot-toast";
import type {
	AuthResponse,
	OtpChannel,
	PasswordLoginInput,
} from "@/lib/api/contract";
import { authApi } from "@/lib/api/auth";
import { useAuthStore } from "@/lib/stores/auth-store";
import { PageLoading } from "@/components/base";

const loginSchema = z.object({
	email: z.string().email("邮箱格式不正确"),
	password: z.string().min(6, "密码至少 6 个字符"),
});

type LoginFormData = z.infer<typeof loginSchema>;
type LoginMode = "password" | "otp";

function LoginForm() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const setUser = useAuthStore((s) => s.setUser);
	const [mode, setMode] = useState<LoginMode>("password");
	const [channel, setChannel] = useState<OtpChannel>("email");
	const [otpTarget, setOtpTarget] = useState("");
	const [otpCode, setOtpCode] = useState("");
	const [challengeId, setChallengeId] = useState<string | null>(null);
	const [cooldown, setCooldown] = useState(0);
	const [isLoading, setIsLoading] = useState(false);
	const [isSendingOtp, setIsSendingOtp] = useState(false);

	const {
		register,
		handleSubmit,
		formState: { errors },
	} = useForm<LoginFormData>({
		resolver: zodResolver(loginSchema),
	});

	useEffect(() => {
		if (cooldown <= 0) return undefined;
		const timer = window.setInterval(() => {
			setCooldown((current) => Math.max(current - 1, 0));
		}, 1000);
		return () => window.clearInterval(timer);
	}, [cooldown]);

	const finishLogin = (result: AuthResponse) => {
		localStorage.setItem("accessToken", result.accessToken);
		document.cookie = `accessToken=${result.accessToken}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax`;
		setUser(result.user);
		toast.success("登录成功");
		router.push(searchParams.get("redirect") || "/home");
	};

	const onPasswordSubmit = async (data: PasswordLoginInput) => {
		try {
			setIsLoading(true);
			finishLogin(await authApi.login(data));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "登录失败");
		} finally {
			setIsLoading(false);
		}
	};

	const changeChannel = (nextChannel: OtpChannel) => {
		setChannel(nextChannel);
		setOtpTarget("");
		setOtpCode("");
		setChallengeId(null);
		setCooldown(0);
	};

	const sendOtpCode = async () => {
		const target = otpTarget.trim();
		if (!target) {
			toast.error(channel === "email" ? "请输入邮箱" : "请输入手机号");
			return;
		}

		try {
			setIsSendingOtp(true);
			const result = await authApi.sendOtpCode(channel, target);
			setChallengeId(result.challengeId);
			setOtpCode("");
			setCooldown(60);
			toast.success("验证码已发送");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "验证码发送失败");
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
			toast.error(error instanceof Error ? error.message : "OTP 登录失败");
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
			<div className="w-full max-w-md">
				<div className="bg-white rounded-lg shadow-lg p-8">
					<div className="text-center mb-8">
						<h1 className="text-3xl font-bold text-blue-600 mb-2">
							FXPlanner-new
						</h1>
						<p className="text-gray-600">登录您的账户</p>
					</div>

					<div
						className="grid grid-cols-2 gap-1 rounded-lg bg-gray-100 p-1 mb-6"
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
									? "bg-white text-gray-900 shadow-sm"
									: "text-gray-500 hover:text-gray-700"
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
									? "bg-white text-gray-900 shadow-sm"
									: "text-gray-500 hover:text-gray-700"
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
									className="block text-sm font-medium text-gray-700 mb-2"
								>
									邮箱
								</label>
								<input
									id="email"
									type="email"
									{...register("email")}
									className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
									placeholder="your@email.com"
									disabled={isLoading}
								/>
								{errors.email && (
									<p className="mt-1 text-sm text-red-600">
										{errors.email.message}
									</p>
								)}
							</div>

							<div>
								<label
									htmlFor="password"
									className="block text-sm font-medium text-gray-700 mb-2"
								>
									密码
								</label>
								<input
									id="password"
									type="password"
									{...register("password")}
									className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
									placeholder="••••••••"
									disabled={isLoading}
								/>
								{errors.password && (
									<p className="mt-1 text-sm text-red-600">
										{errors.password.message}
									</p>
								)}
							</div>

							<button
								type="submit"
								disabled={isLoading}
								className="w-full inline-flex items-center justify-center gap-2 py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
											? "border-blue-600 text-blue-700 bg-blue-50"
											: "border-gray-300 text-gray-600 hover:border-gray-400"
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
											? "border-blue-600 text-blue-700 bg-blue-50"
											: "border-gray-300 text-gray-600 hover:border-gray-400"
									}`}
								>
									<MessageSquare className="h-4 w-4" aria-hidden="true" />
									手机号
								</button>
							</div>

							<div>
								<label
									htmlFor="otpTarget"
									className="block text-sm font-medium text-gray-700 mb-2"
								>
									{channel === "email" ? "邮箱" : "手机号"}
								</label>
								<input
									id="otpTarget"
									name="otpTarget"
									type={channel === "email" ? "email" : "tel"}
									value={otpTarget}
									onChange={(event) => {
										setOtpTarget(event.target.value);
										setChallengeId(null);
										setOtpCode("");
									}}
									className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
									placeholder={
										channel === "email" ? "your@email.com" : "+8613800138000"
									}
									disabled={isLoading || isSendingOtp}
								/>
							</div>

							<div>
								<label
									htmlFor="otpCode"
									className="block text-sm font-medium text-gray-700 mb-2"
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
										className="min-w-0 flex-1 px-4 py-2 border border-gray-300 rounded-lg tracking-[0.2em] focus:ring-2 focus:ring-blue-500 focus:border-transparent"
										placeholder="6 位数字"
										disabled={isLoading}
									/>
									<button
										type="button"
										onClick={sendOtpCode}
										disabled={isLoading || isSendingOtp || cooldown > 0}
										className="shrink-0 inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
									>
										<Send className="h-4 w-4" aria-hidden="true" />
										{cooldown > 0
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
								className="w-full inline-flex items-center justify-center gap-2 py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{isLoading ? "验证中..." : "验证并登录"}
							</button>
						</form>
					)}

					<div className="mt-6 text-center text-sm text-gray-600">
						还没有账户？{" "}
						<Link
							href="/register"
							className="text-blue-600 hover:text-blue-700 font-medium"
						>
							立即注册
						</Link>
					</div>
				</div>
			</div>
		</div>
	);
}

export default function LoginPage() {
	return (
		<Suspense fallback={<PageLoading />}>
			<LoginForm />
		</Suspense>
	);
}
