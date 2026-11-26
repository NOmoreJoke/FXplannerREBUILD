"use client";

import { useState } from "react";
import {
	Building2,
	Check,
	ChevronsUpDown,
	LogOut,
	Plus,
	RefreshCw,
} from "lucide-react";
import {
	useCreateOrganization,
	useOrganizations,
	useSwitchOrganization,
} from "@/lib/hooks/use-organizations";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { useLogoutAndRedirect } from "@/lib/query/hooks/use-auth";
import { cn } from "@/lib/utils";

/**
 * 组织切换器（需求 ORG-02；技术方案 §10.1；W21）：
 * - 单组织：简化态（仅名称，无下拉）；
 * - 多组织：下拉切换（switchOrganization：中止在途 + 清缓存 + 切选择）；
 * - 加载中：过渡锁（禁交互，防新旧组织数据混显，ORG-02.4）。
 * 组件不裸写 useEffect/setTimeout（状态流 + react-query 驱动）。
 */
export function OrganizationSwitcher() {
	const { data: organizations, isLoading } = useOrganizations();
	const switchOrganization = useSwitchOrganization();
	const activeOrganizationId = useActiveOrgId();
	const [open, setOpen] = useState(false);

	const active = organizations?.find((o) => o.id === activeOrganizationId);
	const displayName = active?.name ?? (isLoading ? "组织加载中…" : "未选择组织");

	if (isLoading) {
		return (
			<div
				data-testid="organization-switcher-loading"
				className="mx-3 mt-4 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground"
			>
				<Building2 className="size-4" aria-hidden />
				组织加载中…
			</div>
		);
	}

	// 单组织简化态（ORG-02.6）：只显示名称与设置入口，无切换下拉。
	// 自动选中由 (protected)/layout 的组织路由分流负责（本组件纯展示，不产生副作用）
	if (organizations && organizations.length <= 1) {
		const single = organizations[0];
		return (
			<div
				data-testid="organization-switcher-single"
				className="mx-3 mt-4 flex items-center gap-2 rounded-lg border border-border px-3 py-2"
			>
				<Building2 className="size-4 shrink-0 text-mint-700" aria-hidden />
				<span className="truncate text-sm font-medium text-foreground">
					{single?.name ?? displayName}
				</span>
			</div>
		);
	}

	return (
		<div className="relative mx-3 mt-4" data-testid="organization-switcher">
			<button
				type="button"
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-muted"
			>
				<Building2 className="size-4 shrink-0 text-mint-700" aria-hidden />
				<span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
					{displayName}
				</span>
				<ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
			</button>
			{open && (
				<ul
					role="listbox"
					className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-auto rounded-lg border border-border bg-background p-1 shadow-lg"
				>
					{organizations?.map((org) => (
						<li key={org.id} role="option" aria-selected={org.id === activeOrganizationId}>
							<button
								type="button"
								className={cn(
									"flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors",
									org.id === activeOrganizationId
										? "bg-muted font-medium text-foreground"
										: "text-ink-500 hover:bg-muted hover:text-foreground",
								)}
								onClick={() => {
									setOpen(false);
									if (org.id !== activeOrganizationId) {
										switchOrganization(org.id);
									}
								}}
							>
								<span className="min-w-0 flex-1 truncate">{org.name}</span>
								<span className="shrink-0 text-xs text-muted-foreground">
									{org.role}
								</span>
								{org.id === activeOrganizationId && (
									<Check className="size-3.5 shrink-0 text-mint-700" aria-hidden />
								)}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/**
 * 组织选择卡（多组织未选择 / 无组织引导；需求 ORG-00.3、§13 路由分流）：
 * - ≥2 组织且未选：卡片列表选择；
 * - 0 组织：新建组织引导（创建后自动选中）。
 * 由 (protected)/layout 在组织上下文未就绪时整屏渲染（ORG-02.4 加载隔离）。
 * 创建走 useCreateOrganization（清缓存 + 切换 + 列表失效的唯一步骤序列）。
 * 创建成功后不派发「完成」回调：切换组织会让本组件被布局卸载，mutate 的调用点
 * 回调只向仍挂载的观察者派发，挂上也不会执行（同评审 R3-I02 / R3-I01 的机制）。
 *
 * 退出登录入口（Goal #3A §9.6）：本组件整屏渲染时没有侧栏——此前 0 组织或选错账号的
 * 用户没有任何登出入口，只能手动清 cookie 换账号。登出走 useLogoutAndRedirect
 * （内部经 resetSessionContext 清掉缓存与组织选择态，换账号登录不会继承上一个账号的组织）。
 */
export function OrganizationPicker() {
	const { data: organizations, isLoading } = useOrganizations();
	const switchOrganization = useSwitchOrganization();
	const logout = useLogoutAndRedirect();
	const createMutation = useCreateOrganization();
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");

	const submitCreate = () => {
		createMutation.mutate({ name: newName.trim() });
	};

	if (isLoading) {
		return (
			<div className="flex min-h-screen items-center justify-center bg-background">
				<p className="text-sm text-muted-foreground">正在加载组织…</p>
			</div>
		);
	}

	const hasOrganizations = (organizations?.length ?? 0) > 0;

	return (
		<div className="flex min-h-screen items-center justify-center bg-background px-4">
			<div className="w-full max-w-md space-y-4">
				<h1 className="text-center text-lg font-semibold text-foreground">
					{hasOrganizations ? "选择要进入的组织" : "创建你的组织工作台"}
				</h1>
				{hasOrganizations ? (
					<ul className="space-y-2" data-testid="organization-picker-list">
						{organizations?.map((org) => (
							<li key={org.id}>
								<button
									type="button"
									className="flex w-full items-center justify-between rounded-xl border border-border px-4 py-3 text-left transition-colors hover:bg-muted"
									onClick={() => {
										switchOrganization(org.id);
									}}
								>
									<span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
										{org.name}
									</span>
									<span className="ml-3 shrink-0 text-xs text-muted-foreground">
										{org.role}
										{org.onboardingCompleted ? "" : " · 待建账"}
									</span>
								</button>
							</li>
						))}
					</ul>
				) : (
					<div className="space-y-3 rounded-xl border border-border p-4">
						{creating ? (
							<>
								<input
									value={newName}
									onChange={(e) => setNewName(e.target.value)}
									placeholder="组织名称（1~100 字符）"
									maxLength={100}
									className="w-full rounded-lg border border-border px-3 py-2 text-sm"
									data-testid="organization-create-name"
								/>
								{createMutation.error && (
									<p role="alert" className="text-xs text-red-600">
										{createMutation.error.message}
									</p>
								)}
								<div className="flex gap-2">
									<button
										type="button"
										disabled={!newName.trim() || createMutation.isPending}
										onClick={submitCreate}
										className="flex-1 rounded-lg bg-mint-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
										data-testid="organization-create-submit"
									>
										{createMutation.isPending ? "创建中…" : "创建组织"}
									</button>
									<button
										type="button"
										onClick={() => setCreating(false)}
										className="rounded-lg border border-border px-3 py-2 text-sm text-ink-500"
									>
										取消
									</button>
								</div>
							</>
						) : (
							<button
								type="button"
								onClick={() => setCreating(true)}
								className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground transition-colors hover:bg-muted"
								data-testid="organization-create-entry"
							>
								<Plus className="size-4" aria-hidden />
								新建组织工作台
							</button>
						)}
					</div>
				)}
				{/* 登出入口：0 组织与多组织选择两种状态下都在（整屏态没有侧栏） */}
				<div className="pt-2 text-center">
					<button
						type="button"
						onClick={logout}
						data-testid="organization-picker-logout"
						aria-label="退出登录"
						className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						<LogOut className="size-4" aria-hidden />
						退出登录
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * 组织列表加载失败（网络/服务不可用）：显式错误态 + 重试。
 * 此前失败态会被当作「0 组织」而显示新建引导，或停留在无限加载。
 * 附带退出登录入口：整屏态没有侧栏，服务持续不可用时用户仍能换账号或离开。
 */
export function OrganizationRoutingError({ onRetry }: { onRetry: () => void }) {
	const logout = useLogoutAndRedirect();
	return (
		<div
			className="flex min-h-screen items-center justify-center bg-background px-4"
			data-testid="organization-routing-error"
		>
			<div className="w-full max-w-sm space-y-3 rounded-xl border border-border p-6 text-center">
				<h1 className="text-base font-semibold text-foreground">
					组织列表加载失败
				</h1>
				<p className="text-sm text-muted-foreground">
					暂时无法获取你的组织，请检查网络后重试。
				</p>
				<div className="flex items-center justify-center gap-3">
					<button
						type="button"
						onClick={onRetry}
						className="inline-flex items-center gap-2 rounded-lg bg-mint-700 px-4 py-2 text-sm font-medium text-white"
						data-testid="organization-routing-retry"
					>
						<RefreshCw className="size-4" aria-hidden />
						重试
					</button>
					<button
						type="button"
						onClick={logout}
						data-testid="organization-routing-logout"
						aria-label="退出登录"
						className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink-600 transition-colors hover:bg-muted hover:text-foreground"
					>
						<LogOut className="size-4" aria-hidden />
						退出登录
					</button>
				</div>
			</div>
		</div>
	);
}
