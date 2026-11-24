"use client";

import Link from "next/link";
import {
	CreateOrganizationCard,
	OrganizationForm,
} from "@/components/business/organization";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { useCurrentOrganization } from "@/lib/hooks/use-organizations";

/**
 * 组织信息页（W21：信息 + 改名 + 入口导航；成员/审计在子路由）。
 * - 入口用 next/link（此前是 <a href>，每次整页重载）；面包屑能点击回到本页；
 * - 审计入口按服务端 capabilities 的 audit.read 门控——无权角色不再看到一个
 *   点进去只有「无权限」提示的卡片（后端仍强制校验）；
 * - 有草稿状态的卡片按 activeOrganizationId 加 key，切换组织即重置；两张卡是同级兄弟，
 *   key 带不同前缀（同为组织 id 会触发 React 重复 key）。
 */
export default function OrganizationPage() {
	const activeOrganizationId = useActiveOrgId();
	const { data: current } = useCurrentOrganization();
	const canReadAudit = current?.capabilities["audit.read"] === true;

	return (
		<div className="mx-auto max-w-4xl space-y-4 p-6">
			<header>
				<h1 className="text-lg font-semibold text-foreground">组织设置</h1>
				<p className="text-xs text-muted-foreground">
					组织信息、成员与邀请、审计记录
				</p>
			</header>
			<OrganizationForm key={`form:${activeOrganizationId ?? "none"}`} />
			<nav className="grid gap-2 sm:grid-cols-2">
				<Link
					href="/organization/members"
					className="rounded-xl border border-border p-4 text-sm transition-colors hover:bg-muted"
					data-testid="organization-nav-members"
				>
					<p className="font-medium text-foreground">成员与邀请</p>
					<p className="mt-1 text-xs text-muted-foreground">
						管理成员角色、邀请协作、转移所有权
					</p>
				</Link>
				{canReadAudit && (
					<Link
						href="/organization/audit"
						className="rounded-xl border border-border p-4 text-sm transition-colors hover:bg-muted"
						data-testid="organization-nav-audit"
					>
						<p className="font-medium text-foreground">审计记录</p>
						<p className="mt-1 text-xs text-muted-foreground">
							组织操作留痕（只读，分页加载）
						</p>
					</Link>
				)}
			</nav>
			<CreateOrganizationCard
				key={`create:${activeOrganizationId ?? "none"}`}
			/>
		</div>
	);
}
