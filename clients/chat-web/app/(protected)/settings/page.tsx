"use client";

import { PreferencesForm } from "@/components/business/settings";
import { AccountDataSection } from "@/components/business/account-data";
import { redirectToLogin } from "@/lib/auth/redirect-to-login";
import { useAuthStore } from "@/lib/stores/auth-store";
import { useLogout } from "@/lib/query/hooks/use-auth";

/**
 * 设置页（规格模块 4 分区：个人设置/偏好/账号与数据）
 *
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。
 * 页面只做布局与账号操作；个人设置与偏好的数据逻辑由 PreferencesForm 承载
 * （GET/PATCH /settings；本位币只读）。账号与数据区由 AccountDataSection 承载
 * （account-data：退出登录 + 导出/清空/注销三入口与进度卡）。
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

			{/* 账号与数据（退出登录实装；导出/清空/注销全流程见 business/account-data） */}
			<AccountDataSection onLogout={handleLogout} />
		</div>
	);
}

