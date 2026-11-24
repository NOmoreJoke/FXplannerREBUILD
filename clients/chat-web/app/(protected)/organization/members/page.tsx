"use client";

import {
	InviteForm,
	InvitationList,
	LeaveOrganizationButton,
	MemberTable,
} from "@/components/business/organization";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";

/**
 * 成员与邀请页（W21：MEM-01/02 全生命周期入口）。
 * 有草稿状态的表单以 key={activeOrganizationId} 挂载：切换组织即重置——
 * 旧组织未提交的邀请不得带进新组织（需求 ORG-02.4；外部评审前端批次）。
 */
export default function OrganizationMembersPage() {
	const activeOrganizationId = useActiveOrgId();

	return (
		<div className="mx-auto max-w-4xl space-y-4 p-6">
			<header>
				<h1 className="text-lg font-semibold text-foreground">成员与邀请</h1>
				<p className="text-xs text-muted-foreground">
					调整角色、邀请成员协作、转移所有权（操作按钮按权限显示，后端强制校验）
				</p>
			</header>
			<MemberTable />
			<InviteForm key={activeOrganizationId ?? "none"} />
			<LeaveOrganizationButton />
			<section className="space-y-2">
				<h2 className="text-sm font-semibold text-foreground">邀请记录</h2>
				<InvitationList />
			</section>
		</div>
	);
}
