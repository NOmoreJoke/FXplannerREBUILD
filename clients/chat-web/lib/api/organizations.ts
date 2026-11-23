import { apiClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema.gen";

/**
 * 组织/成员/邀请/审计 API 封装（ToB R1 W20/W21；技术方案 §7.2）。
 * 类型全部取 schema.gen 别名（后端 DTO 唯一事实，零手写影子 DTO——评审 I-17：
 * 变更结果与查询参数包同样走生成类型）；组织头注入统一在 apiClient（读
 * organization-store），此处不重复拼装。
 */

type Schemas = components["schemas"];

/** GET /organizations 列表项 */
export type OrganizationSummary = Schemas["OrganizationViewDto"];

/** GET /organizations/current 详情（capabilities 为后端权限真源） */
export type OrganizationCurrent = Schemas["OrganizationCurrentDto"];

/** 创建/改名入参 */
export type OrganizationUpsertInput = Schemas["OrganizationUpsertDto"];

/** 成员视图 */
export type MemberView = Schemas["MemberViewDto"];

/** 角色调整结果 */
export type MemberRoleUpdateResult = Schemas["MemberRoleUpdateResultDto"];

/** 成员移除结果 */
export type MemberRemoveResult = Schemas["MemberRemoveResultDto"];

/** 成员状态结果（退出） */
export type MemberStatusResult = Schemas["MemberStatusResultDto"];

/** 所有权转移入参 / 结果 */
export type TransferOwnershipInput = Schemas["TransferOwnershipDto"];
export type TransferOwnershipResult = Schemas["TransferOwnershipResultDto"];

/** 邀请创建入参 / 响应（token 仅本次出现） */
export type CreateInvitationInput = Schemas["CreateInvitationDto"];
export type InvitationCreated = Schemas["InvitationCreatedDto"];

/** 邀请列表项 */
export type InvitationView = Schemas["InvitationViewDto"];

/** 受邀摘要（脱敏） */
export type InvitationSummary = Schemas["InvitationSummaryDto"];

/** 接受邀请结果 */
export type InvitationAcceptResult = Schemas["InvitationAcceptResultDto"];

/** 邀请终态结果（撤回/拒绝） */
export type InvitationStatusResult = Schemas["InvitationStatusResultDto"];

/** 审计日志分页 / 查询参数包 */
export type AuditLogList = Schemas["AuditLogListDto"];
export type AuditLogsQuery = Schemas["ListAuditLogsQueryDto"];

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
	async rename(input: OrganizationUpsertInput): Promise<OrganizationCurrent> {
		return apiClient<OrganizationCurrent>("/organizations/current", {
			method: "PATCH",
			body: JSON.stringify(input),
		});
	},

	/** 创建组织（个人端点） */
	async create(input: OrganizationUpsertInput): Promise<OrganizationSummary> {
		return apiClient<OrganizationSummary>("/organizations", {
			method: "POST",
			body: JSON.stringify(input),
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
	async updateRole(
		membershipId: string,
		input: Schemas["UpdateMemberDto"],
	): Promise<MemberRoleUpdateResult> {
		return apiClient<MemberRoleUpdateResult>(
			`/organizations/current/members/${encodeURIComponent(membershipId)}`,
			{ method: "PATCH", body: JSON.stringify(input) },
		);
	},

	/** 移除成员（member.remove → DISABLED） */
	async remove(membershipId: string): Promise<MemberRemoveResult> {
		return apiClient<MemberRemoveResult>(
			`/organizations/current/members/${encodeURIComponent(membershipId)}`,
			{ method: "DELETE" },
		);
	},

	/** 主动退出（最后 Owner 409） */
	async leave(): Promise<MemberStatusResult> {
		return apiClient<MemberStatusResult>(
			"/organizations/current/members/leave",
			{ method: "POST" },
		);
	},

	/** 所有权转移（owner.transfer；先降后升事务） */
	async transferOwnership(
		input: TransferOwnershipInput,
	): Promise<TransferOwnershipResult> {
		return apiClient<TransferOwnershipResult>(
			"/organizations/current/transfer-ownership",
			{ method: "POST", body: JSON.stringify(input) },
		);
	},
};

export const invitationsApi = {
	/** 创建邀请（member.invite；token 仅本次响应） */
	async create(input: CreateInvitationInput): Promise<InvitationCreated> {
		return apiClient<InvitationCreated>(
			"/organizations/current/invitations",
			{ method: "POST", body: JSON.stringify(input) },
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
	async revoke(invitationId: string): Promise<InvitationStatusResult> {
		return apiClient<InvitationStatusResult>(
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
	async accept(token: string): Promise<InvitationAcceptResult> {
		return apiClient<InvitationAcceptResult>(
			`/organization-invitations/${encodeURIComponent(token)}/accept`,
			{ method: "POST" },
		);
	},

	/** 拒绝 */
	async decline(token: string): Promise<InvitationStatusResult> {
		return apiClient<InvitationStatusResult>(
			`/organization-invitations/${encodeURIComponent(token)}/decline`,
			{ method: "POST" },
		);
	},
};

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
