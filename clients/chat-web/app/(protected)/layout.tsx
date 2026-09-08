"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
	ArrowLeftRight,
	FileText,
	History,
	Home,
	Settings,
	Split,
	Wallet,
} from "lucide-react";
import { authApi } from "@/lib/api/auth";
import { useAuthStore } from "@/lib/stores/auth-store";
import { PageLoading } from "@/components/base";
import { cn } from "@/lib/utils";

/**
 * 保护区守卫 + 工作台壳（路由组 (protected) 的唯一入口）
 *
 * 放在本组下的所有页面自动受保护：无 token 或 token 失效 → 跳 /login 并带 redirect 回跳地址。
 * 新增受保护页面只需放进 (protected)/ 目录，无需再写任何校验代码。
 * 公开页面（落地页、login、register）不要放进本组。
 */
export default function ProtectedLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const router = useRouter();
	const pathname = usePathname();
	const { setUser, clearUser } = useAuthStore();
	const [checking, setChecking] = useState(true);

	useEffect(() => {
		const checkAuth = async () => {
			const token = document.cookie.match(/(?:^|;\s*)accessToken=([^;]*)/)?.[1];
			if (!token) {
				router.push(`/login?redirect=${encodeURIComponent(pathname)}`);
				return;
			}

			try {
				const user = await authApi.getMe();
				setUser(user);
				setChecking(false);
			} catch {
				clearUser();
				router.push(`/login?redirect=${encodeURIComponent(pathname)}`);
			}
		};

		checkAuth();
	}, [router, pathname, setUser, clearUser]);

	if (checking) {
		return <PageLoading />;
	}

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

				{/* 当前用户（静态占位） */}
				<div className="mx-3 mb-5 flex items-center gap-3 rounded-xl border border-border p-3">
					<div className="flex size-8 items-center justify-center rounded-full bg-ink-100 text-xs font-medium text-ink-600">
						K
					</div>
					<div className="min-w-0">
						<p className="truncate text-sm font-medium text-foreground">Kal</p>
						<p className="truncate text-xs text-muted-foreground">
							已认证 · 试用中
						</p>
					</div>
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
