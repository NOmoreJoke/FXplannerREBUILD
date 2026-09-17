"use client";

import { Download, LogOut, Trash2, UserX } from "lucide-react";
import { PreferencesForm } from "@/components/business/settings";
import { Button } from "@/components/ui/button";
import { redirectToLogin } from "@/lib/auth/redirect-to-login";
import { useAuthStore } from "@/lib/stores/auth-store";
import { useLogout } from "@/lib/query/hooks/use-auth";

/**
 * 设置页（规格模块 4 分区：个人设置/偏好/账号与数据）
 *
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。
 * 页面只做布局与账号操作；个人设置与偏好的数据逻辑由 PreferencesForm 承载
 * （GET/PATCH /settings；本位币只读）。账号与数据区：退出登录本期实装，
 * 导出个人数据/清空业务记录/注销账号按规格 2.3-7 展示为禁用态（即将上线）。
 */
export default function SettingsPage() {
	const clearUser = useAuthStore((s) => s.clearUser);
	const logout = useLogout();

	const handleLogout = () => {
		logout();
		clearUser();
		redirectToLogin("/");
	};

	return (
		<div data-testid="settings-page" className="mx-auto max-w-3xl px-8 py-6">
			<header className="mb-6">
				<h1 className="text-xl font-bold text-foreground">设置</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					管理账户偏好与本位币设置。
				</p>
			</header>

			{/* 个人设置 + 偏好（数据逻辑在 business 组件，page 只布局） */}
			<PreferencesForm />

			{/* 账号与数据：退出登录实装；导出/清空/注销本期禁用（即将上线） */}
			<section className="mt-6 rounded-2xl border border-border bg-white p-6">
				<h2 className="text-base font-bold text-foreground">账号与数据</h2>
				<div className="mt-5 divide-y divide-border">
					<div className="flex items-center justify-between pb-4">
						<div className="flex items-center gap-2.5">
							<LogOut className="size-4 text-ink-500" aria-hidden="true" />
							<span className="text-sm text-foreground">退出登录</span>
						</div>
						<Button
							variant="outline"
							data-testid="settings-logout"
							className="bg-white"
							onClick={handleLogout}
						>
							退出
						</Button>
					</div>

					<AccountDataRow icon={Download} label="导出个人数据" />
					<AccountDataRow icon={Trash2} label="清空业务记录" />
					<AccountDataRow icon={UserX} label="注销账号" />
				</div>
			</section>
		</div>
	);
}

/** 账号与数据禁用行（规格 2.3-7：本期不实装，展示「即将上线」） */
function AccountDataRow({
	icon: Icon,
	label,
}: {
	icon: typeof Download;
	label: string;
}) {
	return (
		<div className="flex items-center justify-between py-4">
			<div className="flex items-center gap-2.5">
				<Icon className="size-4 text-ink-500" aria-hidden="true" />
				<span className="text-sm text-foreground">{label}</span>
			</div>
			<Button variant="outline" disabled className="bg-white">
				即将上线
			</Button>
		</div>
	);
}
