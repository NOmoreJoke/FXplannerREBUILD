"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { authApi } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/client";
import { safeRedirectPath } from "@/lib/auth/safe-redirect-path";
import { setToken } from "@/lib/auth/token";
import { useAuthStore } from "@/lib/stores/auth-store";

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

	const {
		register,
		handleSubmit,
		formState: { errors },
	} = useForm<RegisterFormData>({
		resolver: zodResolver(registerSchema),
	});

	const onSubmit = async (data: RegisterFormData) => {
		try {
			setIsLoading(true);
			const result = await authApi.register(data);

			// token 只写 cookie（唯一事实来源），注册即登录
			setToken(result.accessToken);
			setUser(result.user);

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
							<input
								id="password"
								type="password"
								autoComplete="new-password"
								{...register("password")}
								className="w-full rounded-lg border border-border px-4 py-2 focus:border-mint-500 focus:ring-2 focus:ring-mint-500"
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
							<input
								id="confirmPassword"
								type="password"
								autoComplete="new-password"
								{...register("confirmPassword")}
								className="w-full rounded-lg border border-border px-4 py-2 focus:border-mint-500 focus:ring-2 focus:ring-mint-500"
								placeholder="再次输入密码"
								disabled={isLoading}
							/>
							{errors.confirmPassword && (
								<p className="mt-1 text-sm text-destructive">
									{errors.confirmPassword.message}
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
