"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
	ArrowLeftRight,
	FileText,
	History,
	Home,
	LogOut,
	Settings,
	Split,
	Wallet,
} from "lucide-react";
import { authApi } from "@/lib/api/auth";
import { getToken } from "@/lib/auth/token";
import { redirectToLogin } from "@/lib/auth/redirect-to-login";
import { useAuthStore } from "@/lib/stores/auth-store";
import { useLogout } from "@/lib/query/hooks/use-auth";
import { PageLoading } from "@/components/base";
import { cn } from "@/lib/utils";

/**
 * 保护区守卫 + 工作台壳（路由组 (protected) 的唯一入口）
 *
 * 放在本组下的所有页面自动受保护：无 token 或 token 失效 → 跳 /login 并带 redirect 回跳地址。
 * 守卫只在 authStore 无用户时校验一次（getMe），站内导航不再重复请求；
 * 认证失败统一走 redirectToLogin（带防重复跳转保护），与 apiClient 的 401 处理互不竞争。
 * 新增受保护页面只需放进 (protected)/ 目录，无需再写任何校验代码。
 * 公开页面（落地页、login、register）不要放进本组。
 */
export default function ProtectedLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const pathname = usePathname();
	const user = useAuthStore((s) => s.user);
	const setUser = useAuthStore((s) => s.setUser);
	const clearUser = useAuthStore((s) => s.clearUser);
	const logout = useLogout();
	const verifiedRef = useRef(false);

	// 仅在 authStore 无用户时校验一次；之后由内存中的 user 状态兜底，站内导航零开销
	useEffect(() => {
		if (verifiedRef.current) return;
		verifiedRef.current = true;

		const checkAuth = async () => {
			if (!getToken()) {
				redirectToLogin(pathname);
				return;
			}

			try {
				const me = await authApi.getMe();
				setUser(me);
			} catch {
				clearUser();
				redirectToLogin(pathname);
			}
		};

		void checkAuth();
	}, [pathname, setUser, clearUser]);

	if (!user) {
		return <PageLoading />;
	}

	const displayName = user.name || user.email || "已认证用户";
	const initial = (user.name || user.email || "?").charAt(0).toUpperCase();

	const handleLogout = () => {
		logout();
		clearUser();
		redirectToLogin("/");
	};

	return (
		<div className="flex min-h-screen bg-background">
			<aside className="flex w-60 shrink-0 flex-col border-r border-border">
				{/* Logo */}
				<div className="flex items-center gap-2.5 px-5 pb-1 pt-6">
					<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-mint-700 text-xs font-bold text-white">
						FX
					</div>
					<span className="font-display text-lg font-semibold text-foreground">
						FXPlanner
					</span>
				</div>
				<p className="px-5 pb-4 text-xs text-muted-foreground">
					规划你的换汇工作台
				</p>

				{/* 导航菜单 */}
				<nav className="flex-1 space-y-1 px-3">
					{NAV_ITEMS.map((item) => {
						const active = pathname.startsWith(item.href);
						return (
							<Link
								key={item.href}
								href={item.href}
								className={cn(
									"flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
									active
										? "bg-mint-50 font-medium text-mint-700"
										: "text-ink-500 hover:bg-muted hover:text-foreground",
								)}
							>
								<item.icon className="size-4" />
								{item.label}
							</Link>
						);
					})}
				</nav>

				{/* 个人计划卡片（静态占位） */}
				<div className="mx-3 mb-3 rounded-xl bg-mint-50 p-4">
					<p className="text-sm font-medium text-mint-700">个人计划</p>
					<p className="mt-2 text-xs leading-5 text-ink-500">
						倒计时: <span className="font-medium text-foreground">8 天</span>
						<br />
						安全换汇剩余时间
					</p>
				</div>

				{/* 当前用户（真实数据 + 登出） */}
				<div className="mx-3 mb-5 flex items-center gap-3 rounded-xl border border-border p-3">
					<div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink-100 text-xs font-medium text-ink-600">
						{initial}
					</div>
					<div className="min-w-0 flex-1">
						<p className="truncate text-sm font-medium text-foreground">
							{displayName}
						</p>
						<p className="truncate text-xs text-muted-foreground">
							{user.name ? user.email : "已认证"}
						</p>
					</div>
					<button
						type="button"
						onClick={handleLogout}
						aria-label="退出登录"
						title="退出登录"
						className="shrink-0 rounded-md p-1.5 text-ink-500 transition-colors hover:bg-muted hover:text-foreground"
					>
						<LogOut className="size-4" />
					</button>
				</div>
			</aside>

			<main className="min-w-0 flex-1">{children}</main>
		</div>
	);
}

const NAV_ITEMS = [
	{ href: "/home", label: "首页", icon: Home },
	{ href: "/accounts", label: "外汇账户", icon: Wallet },
	{ href: "/plans", label: "换汇计划", icon: ArrowLeftRight },
	{ href: "/paths", label: "路径比较", icon: Split },
	{ href: "/history", label: "历史模拟", icon: History },
	{ href: "/reports", label: "我的报告", icon: FileText },
	{ href: "/settings", label: "设置", icon: Settings },
] as const;
