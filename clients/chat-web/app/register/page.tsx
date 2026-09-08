"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import toast from "react-hot-toast";
import { authApi } from "@/lib/api/auth";
import { useAuthStore } from "@/lib/stores/auth-store";

const registerSchema = z
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

export default function RegisterPage() {
	const router = useRouter();
	const setUser = useAuthStore((s) => s.setUser);
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

			// 存储 Token 到 localStorage 和 Cookie
			localStorage.setItem("accessToken", result.accessToken);
			// 设置 Cookie（7天有效期，与后端一致）
			document.cookie = `accessToken=${result.accessToken}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax`;

			// 更新状态
			setUser(result.user);

			toast.success("注册成功");

			// 跳转到首页
			router.push("/home");
		} catch (error: any) {
			toast.error(error.message || "注册失败");
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
			<div className="w-full max-w-md">
				<div className="bg-white rounded-lg shadow-lg p-8">
					{/* 头部 */}
					<div className="text-center mb-8">
						<h1 className="text-3xl font-bold text-blue-600 mb-2">
							FXPlanner-new
						</h1>
						<p className="text-gray-600">创建您的账户</p>
					</div>

					{/* 表单 */}
					<form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
						{/* 邮箱 */}
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

						{/* 密码 */}
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
								placeholder="至少 8 位，含大小写字母和数字"
								disabled={isLoading}
							/>
							{errors.password && (
								<p className="mt-1 text-sm text-red-600">
									{errors.password.message}
								</p>
							)}
						</div>

						{/* 确认密码 */}
						<div>
							<label
								htmlFor="confirmPassword"
								className="block text-sm font-medium text-gray-700 mb-2"
							>
								确认密码
							</label>
							<input
								id="confirmPassword"
								type="password"
								{...register("confirmPassword")}
								className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
								placeholder="再次输入密码"
								disabled={isLoading}
							/>
							{errors.confirmPassword && (
								<p className="mt-1 text-sm text-red-600">
									{errors.confirmPassword.message}
								</p>
							)}
						</div>

						{/* 提交按钮 */}
						<button
							type="submit"
							disabled={isLoading}
							className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{isLoading ? "注册中..." : "注册"}
						</button>
					</form>

					{/* 底部链接 */}
					<div className="mt-6 text-center text-sm text-gray-600">
						已有账户？{" "}
						<Link
							href="/login"
							className="text-blue-600 hover:text-blue-700 font-medium"
						>
							立即登录
						</Link>
					</div>
				</div>
			</div>
		</div>
	);
}
