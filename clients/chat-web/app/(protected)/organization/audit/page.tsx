"use client";

import { AuditLogTable } from "@/components/business/audit";

/** 审计分页页（W21：无权角色显示无权限提示，无任何编辑/删除入口） */
export default function OrganizationAuditPage() {
	return (
		<div className="mx-auto max-w-5xl space-y-4 p-6">
			<header>
				<h1 className="text-lg font-semibold text-foreground">审计记录</h1>
				<p className="text-xs text-muted-foreground">
					组织创建/改名、成员与邀请、权限拒绝等操作留痕（只读，分页加载）
				</p>
			</header>
			<AuditLogTable />
		</div>
	);
}
