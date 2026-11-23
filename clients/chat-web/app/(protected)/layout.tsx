"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
	ArrowLeftRight,
	Bot,
	Building2,
	FileText,
	Home,
	LogOut,
	Settings,
	TrendingUp,
	Wallet,
} from "lucide-react";
import { authApi } from "@/lib/api/auth";
import { getToken } from "@/lib/auth/token";
import { redirectToLogin } from "@/lib/auth/redirect-to-login";
import { useAuthStore } from "@/lib/stores/auth-store";
import { useLogout } from "@/lib/query/hooks/use-auth";
import { useOrganizationRouting } from "@/lib/hooks/use-organizations";
import { AppBreadcrumb, PageLoading } from "@/components/base";
import { ReminderBell } from "@/components/business/reminder";
import {
	OrganizationPicker,
	OrganizationRoutingError,
	OrganizationSwitcher,
} from "@/components/business/organization";
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

	// ToB R1 组织路由分流（W21；需求 ORG-00.3/ORG-02.4；评审 I-18）：
	// 选择校验与单组织自动选中都在 useOrganizationRouting 内以受控副作用完成，
	// 本组件不在渲染期写 store；认证未就绪（user 为空）不拉组织列表。
	// ready = 单组织直达 / 多组织已选；pick = 多组织未选 → OrganizationPicker
	// （整屏隔离，不闪旧组织数据）或 0 组织 → Picker 内新建引导；error = 列表
	// 拉取失败 → 显式错误态与重试（不误入「创建组织」引导）。
	// 组织上下文未就绪前业务页面不渲染（hooks enabled 门控 + 缓存清理双保险）。
	// 豁免路由：/invitations/*（受邀者可能尚无任何组织，接受流程为个人端点）。
	const routing = useOrganizationRouting({ enabled: Boolean(user) });

	if (!user) {
		return <PageLoading />;
	}

	const orglessRouteAllowed = pathname.startsWith("/invitations");
	// 组织上下文就绪检查：认证已过但组织未就绪（加载中/待选择/待创建/加载失败）
	if (!orglessRouteAllowed) {
		if (routing.status === "disabled" || routing.status === "loading") {
			return <PageLoading />;
		}
		if (routing.status === "error") {
			return <OrganizationRoutingError onRetry={routing.retry} />;
		}
		if (routing.status === "pick") {
			return <OrganizationPicker />;
		}
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
				{/* Logo（可点击回首页） */}
				<Link
					href="/home"
					aria-label="回到首页"
					title="回到首页"
					className="flex items-center gap-2.5 px-5 pb-1 pt-6 transition-opacity hover:opacity-80"
				>
					<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-mint-700 text-xs font-bold text-white">
						FX
					</div>
					<span className="font-display text-lg font-semibold text-foreground">
						FXPlanner
					</span>
				</Link>
			<p className="px-5 pb-4 text-xs text-muted-foreground">
				规划你的换汇工作台
			</p>

			{/* ToB R1 组织切换器（W21）：单组织简化态 / 多组织下拉切换 */}
			<OrganizationSwitcher />

				{/* 导航菜单 */}
				<nav className="flex-1 space-y-1 px-3">
					{NAV_ITEMS.map((item) => {
						// 首页精确匹配；其余前缀匹配，子页面（如 /plans/[id]）自动跟随父级高亮
						const active =
							item.href === "/home"
								? pathname === "/home"
								: pathname.startsWith(item.href);
						return (
							<Link
								key={item.href}
								href={item.href}
								aria-current={active ? "page" : undefined}
								className={cn(
									"flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
									active
										? "bg-mint-700 font-medium text-white shadow-sm"
										: "text-ink-500 hover:bg-muted hover:text-foreground",
								)}
							>
								<item.icon className="size-4" />
								{item.label}
							</Link>
						);
					})}
				</nav>

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

			<main className="min-w-0 flex-1">
				{/* 统一面包屑行：面包屑靠左，提醒铃铛靠右（全部子页面自动获得，页面内禁止重复实现） */}
				<AppBreadcrumb actions={<ReminderBell />} />
				{children}
			</main>
		</div>
	);
}

const NAV_ITEMS = [
	{ href: "/home", label: "首页", icon: Home },
	{ href: "/plans", label: "换汇计划", icon: ArrowLeftRight },
	{ href: "/accounts", label: "外汇账户", icon: Wallet },
	{ href: "/reports", label: "我的报告", icon: FileText },
	{ href: "/market", label: "汇率行情", icon: TrendingUp },
	{ href: "/chat", label: "AI 助手", icon: Bot },
	// ToB R1：组织设置入口（信息/成员与邀请/审计；此前只能手输地址进入）
	{ href: "/organization", label: "组织", icon: Building2 },
	{ href: "/settings", label: "设置", icon: Settings },
] as const;
