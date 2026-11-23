import { apiClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema.gen";

/**
 * 组织/成员/邀请/审计 API 封装（ToB R1 W20/W21；技术方案 §7.2）。
 * 类型全部取 schema.gen 别名（后端 DTO 唯一事实，零手写影子 DTO）；
 * 组织头注入统一在 apiClient（读 organization-store），此处不重复拼装。
 */

type Schemas = components["schemas"];

/** GET /organizations 列表项 */
export type OrganizationSummary = Schemas["OrganizationViewDto"];

/** GET /organizations/current 详情（capabilities 为后端权限真源） */
export type OrganizationCurrent = Schemas["OrganizationCurrentDto"];

/** 成员视图 */
export type MemberView = Schemas["MemberViewDto"];

/** 邀请创建响应（token 仅本次出现） */
export type InvitationCreated = Schemas["InvitationCreatedDto"];

/** 邀请列表项 */
export type InvitationView = Schemas["InvitationViewDto"];

/** 受邀摘要（脱敏） */
export type InvitationSummary = Schemas["InvitationSummaryDto"];

/** 审计日志分页 */
export type AuditLogList = Schemas["AuditLogListDto"];

export const organizationsApi = {
	/** 本人全部有效组织（个人端点，单/多组织路由依据） */
	async list(): Promise<OrganizationSummary[]> {
		return apiClient<OrganizationSummary[]>("/organizations", {
			method: "GET",
		});
	},

	/** 当前组织详情 + capabilities + 建账状态（组织上下文端点） */
	async current(): Promise<OrganizationCurrent> {
		return apiClient<OrganizationCurrent>("/organizations/current", {
			method: "GET",
		});
	},

	/** 改名（organization.update） */
	async rename(name: string): Promise<OrganizationCurrent> {
		return apiClient<OrganizationCurrent>("/organizations/current", {
			method: "PATCH",
			body: JSON.stringify({ name }),
		});
	},

	/** 创建组织（个人端点） */
	async create(name: string): Promise<OrganizationSummary> {
		return apiClient<OrganizationSummary>("/organizations", {
			method: "POST",
			body: JSON.stringify({ name }),
		});
	},
};

export const membersApi = {
	/** 成员列表（member.read） */
	async list(): Promise<MemberView[]> {
		return apiClient<MemberView[]>("/organizations/current/members", {
			method: "GET",
		});
	},

	/** 角色调整（member.update） */
	async updateRole(membershipId: string, role: string): Promise<MemberView> {
		return apiClient<MemberView>(
			`/organizations/current/members/${encodeURIComponent(membershipId)}`,
			{ method: "PATCH", body: JSON.stringify({ role }) },
		);
	},

	/** 移除成员（member.remove → DISABLED） */
	async remove(membershipId: string): Promise<{ status: string }> {
		return apiClient<{ status: string }>(
			`/organizations/current/members/${encodeURIComponent(membershipId)}`,
			{ method: "DELETE" },
		);
	},

	/** 主动退出（最后 Owner 409） */
	async leave(): Promise<{ status: string }> {
		return apiClient<{ status: string }>(
			"/organizations/current/members/leave",
			{ method: "POST" },
		);
	},

	/** 所有权转移（owner.transfer；先降后升事务） */
	async transferOwnership(
		targetMembershipId: string,
	): Promise<{ promotedId: string; demotedId: string }> {
		return apiClient<{ promotedId: string; demotedId: string }>(
			"/organizations/current/transfer-ownership",
			{
				method: "POST",
				body: JSON.stringify({ targetMembershipId }),
			},
		);
	},
};

export const invitationsApi = {
	/** 创建邀请（member.invite；token 仅本次响应） */
	async create(
		email: string,
		role: string,
	): Promise<InvitationCreated> {
		return apiClient<InvitationCreated>(
			"/organizations/current/invitations",
			{ method: "POST", body: JSON.stringify({ email, role }) },
		);
	},

	/** 邀请列表（member.read；无 tokenHash） */
	async list(): Promise<InvitationView[]> {
		return apiClient<InvitationView[]>(
			"/organizations/current/invitations",
			{ method: "GET" },
		);
	},

	/** 撤回（member.invite） */
	async revoke(invitationId: string): Promise<{ status: string }> {
		return apiClient<{ status: string }>(
			`/organizations/current/invitations/${encodeURIComponent(invitationId)}`,
			{ method: "DELETE" },
		);
	},

	/** 受邀摘要（登录个人端点；脱敏） */
	async summary(token: string): Promise<InvitationSummary> {
		return apiClient<InvitationSummary>(
			`/organization-invitations/${encodeURIComponent(token)}`,
			{ method: "GET" },
		);
	},

	/** 接受（邮箱严格匹配） */
	async accept(token: string): Promise<{ membershipId: string; role: string }> {
		return apiClient<{ membershipId: string; role: string }>(
			`/organization-invitations/${encodeURIComponent(token)}/accept`,
			{ method: "POST" },
		);
	},

	/** 拒绝 */
	async decline(token: string): Promise<{ status: string }> {
		return apiClient<{ status: string }>(
			`/organization-invitations/${encodeURIComponent(token)}/decline`,
			{ method: "POST" },
		);
	},
};

/** 审计查询参数（audit.read；分页 + 筛选） */
export interface AuditLogsQuery {
	page?: number;
	pageSize?: number;
	from?: string;
	to?: string;
	actorUserId?: string;
	action?: string;
	result?: string;
}

export const auditApi = {
	/** 审计日志分页（audit.read） */
	async list(query: AuditLogsQuery): Promise<AuditLogList> {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined && value !== null && `${value}` !== "") {
				params.set(key, `${value}`);
			}
		}
		const qs = params.toString();
		return apiClient<AuditLogList>(
			`/organizations/current/audit-logs${qs ? `?${qs}` : ""}`,
			{ method: "GET" },
		);
	},
};
