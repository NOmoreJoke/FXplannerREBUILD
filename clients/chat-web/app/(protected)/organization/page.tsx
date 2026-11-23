"use client";

import { OrganizationForm } from "@/components/business/organization";

/** 组织信息页（W21：信息 + 改名 + 入口导航；成员/审计在子路由） */
export default function OrganizationPage() {
	return (
		<div className="mx-auto max-w-4xl space-y-4 p-6">
			<header>
				<h1 className="text-lg font-semibold text-foreground">组织设置</h1>
				<p className="text-xs text-muted-foreground">
					组织信息、成员与邀请、审计记录
				</p>
			</header>
			<OrganizationForm />
			<nav className="grid gap-2 sm:grid-cols-2">
				<a
					href="/organization/members"
					className="rounded-xl border border-border p-4 text-sm transition-colors hover:bg-muted"
					data-testid="organization-nav-members"
				>
					<p className="font-medium text-foreground">成员与邀请</p>
					<p className="mt-1 text-xs text-muted-foreground">
						管理成员角色、邀请协作、转移所有权
					</p>
				</a>
				<a
					href="/organization/audit"
					className="rounded-xl border border-border p-4 text-sm transition-colors hover:bg-muted"
					data-testid="organization-nav-audit"
				>
					<p className="font-medium text-foreground">审计记录</p>
					<p className="mt-1 text-xs text-muted-foreground">
						组织操作留痕（仅 Owner/Admin/Finance 可见）
					</p>
				</a>
			</nav>
		</div>
	);
}
