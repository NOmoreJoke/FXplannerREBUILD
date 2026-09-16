"use client";

import { forwardRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 带显示/隐藏切换的密码输入框（base 层：登录/注册等多处复用）
 *
 * - 眼睛按钮切换 type=password/text，aria-label 随状态切换；
 * - forwardRef 转发内部 input，兼容 react-hook-form register() 的 ref 收集；
 * - 样式与业务表单现有 input 一致（右侧为眼睛按钮预留 pr-10）。
 */
export const PasswordInput = forwardRef<
	HTMLInputElement,
	Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">
>(function PasswordInput({ className, disabled, ...props }, ref) {
	const [visible, setVisible] = useState(false);

	return (
		<div className="relative">
			<input
				{...props}
				ref={ref}
				type={visible ? "text" : "password"}
				disabled={disabled}
				className={cn(
					"w-full rounded-lg border border-border px-4 py-2 pr-10 focus:border-mint-500 focus:ring-2 focus:ring-mint-500",
					className,
				)}
			/>
			<button
				type="button"
				aria-label={visible ? "隐藏密码" : "显示密码"}
				aria-pressed={visible}
				title={visible ? "隐藏密码" : "显示密码"}
				disabled={disabled}
				onClick={() => setVisible((v) => !v)}
				className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
			>
				{visible ? (
					<EyeOff className="size-4" aria-hidden="true" />
				) : (
					<Eye className="size-4" aria-hidden="true" />
				)}
			</button>
		</div>
	);
});
