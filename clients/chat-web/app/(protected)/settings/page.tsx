"use client";

import { PreferencesForm } from "@/components/business/settings";
import { AccountDataSection } from "@/components/business/account-data";
import { useLogoutAndRedirect } from "@/lib/query/hooks/use-auth";

/**
 * 设置页（技术方案 §10.2；Goal #3B W28）
 *
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。
 * 页面只做布局与登出动作，自上而下三块：
 * 1. 个人展示偏好与组织账本设置——数据逻辑由 PreferencesForm 承载
 *    （GET/PATCH /settings/personal 与 GET/PATCH /settings，两个分区各自暂存、一次保存）；
 * 2. 个人账号与数据（退出登录 + 导出个人数据 + 注销个人账号）；
 * 3. 当前组织数据（导出 / 清空 / 删除组织，按角色能力显隐）。
 * 后两块由 AccountDataSection 承载（account-data 双域）。
 */
export default function SettingsPage() {
	const handleLogout = useLogoutAndRedirect();

	return (
		<div data-testid="settings-page" className="mx-auto max-w-3xl px-8 py-6">
			<header className="mb-6">
				<h1 className="text-xl font-bold text-foreground">设置</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					个人展示偏好、当前组织的账本设置，以及个人与组织各自的数据权利。
				</p>
			</header>

			{/* 个人设置 + 偏好（数据逻辑在 business 组件，page 只布局） */}
			<PreferencesForm />

			{/* 账号与数据（退出登录实装；导出/清空/注销全流程见 business/account-data） */}
			<AccountDataSection onLogout={handleLogout} />
		</div>
	);
}

