/**
 * 集中权限策略纯函数真源（技术方案 §6；需求 §7.3 固定角色矩阵）。
 *
 * 纪律：
 * - 角色到权限点的映射只存在这一份（ROLE_PERMISSIONS）；Controller 用
 *   @RequiresPermission 权限点装饰器，前端从后端 capabilities 获取展示能力，
 *   任何一层都不得复制一份角色逻辑作为授权依据。
 * - 未知角色默认拒绝（fail-closed）；敏感权限（data.export/clear）只决定能否
 *   进入流程，OTP/二次验证仍是独立必要条件。
 * - 本文件零 IO：Date/比较均由调用方传入，保证可属性测试与幂等。
 */

import type {
	MembershipStatus,
	OrganizationRole,
	Permission,
} from "./authorization.types";

import { PERMISSIONS } from "./authorization.types";

/** 角色到权限点映射（需求 §7.3 表 + 补充规则的唯一真源） */
export const ROLE_PERMISSIONS: Record<
	OrganizationRole,
	readonly Permission[]
> = {
	// Owner：全量权限（含 owner.transfer、organization.delete）
	OWNER: [...PERMISSIONS],
	// Admin：除 owner.transfer / organization.delete 外全量（含 member 普通管理与 data.clear）
	ADMIN: [
		"organization.read",
		"organization.update",
		"member.read",
		"member.invite",
		"member.update",
		"member.remove",
		"settings.read",
		"settings.update",
		"account.read",
		"plan.read",
		"plan.create",
		"plan.adjust",
		"transaction.read",
		"transaction.create",
		"usage.read",
		"usage.create",
		"correction.read",
		"correction.preview",
		"correction.apply",
		"report.read",
		"audit.read",
		"data.export",
		"data.clear",
		"agent.use",
		"agent.business_read",
		"agent.draft",
	],
	// Finance：全业务读写 + 审计/导出（导出需二次验证），不管理成员与组织设置
	FINANCE: [
		"organization.read",
		"member.read",
		"settings.read",
		"account.read",
		"plan.read",
		"plan.create",
		"plan.adjust",
		"transaction.read",
		"transaction.create",
		"usage.read",
		"usage.create",
		"correction.read",
		"correction.preview",
		"correction.apply",
		"report.read",
		"audit.read",
		"data.export",
		"agent.use",
		"agent.business_read",
		"agent.draft",
	],
	// Operator：可建/调计划与草稿，不记录买入、使用和更正，无审计与数据操作
	OPERATOR: [
		"organization.read",
		"member.read",
		"settings.read",
		"account.read",
		"plan.read",
		"plan.create",
		"plan.adjust",
		"transaction.read",
		"usage.read",
		"correction.read",
		"report.read",
		"agent.use",
		"agent.business_read",
		"agent.draft",
	],
	// Viewer：纯只读；Agent 仅 business_read，无 agent.draft
	VIEWER: [
		"organization.read",
		"member.read",
		"settings.read",
		"account.read",
		"plan.read",
		"transaction.read",
		"usage.read",
		"correction.read",
		"report.read",
		"agent.use",
		"agent.business_read",
	],
};

/** 集中权限判定：未知角色 / 未知权限一律 false（fail-closed） */
export function can(
	role: OrganizationRole,
	permission: Permission,
): boolean {
	const granted = ROLE_PERMISSIONS[role];
	if (!granted) return false;
	return granted.includes(permission);
}

/** 成员管理动作（邀请 / 角色调整与禁用 / 移除） */
export type MemberManageAction = "invite" | "update" | "remove";

/**
 * 成员管理资格判定（需求 §7.1/§7.2）：
 * - 目标为 OWNER 一律拒绝：Admin 不可邀请/提升/修改/移除 Owner；
 *   Owner 对 Owner（含自身自降）也拒绝——所有权变更只走转移通道；
 * - Owner 可管理全部非 Owner 成员；
 * - Admin 仅可管理普通角色（Finance/Operator/Viewer），Admin 之间互不管理；
 * - 其余角色无 member.* 权限，直接拒绝。
 */
export function canManage(
	actorRole: OrganizationRole,
	targetRole: OrganizationRole,
	_action: MemberManageAction,
): boolean {
	if (targetRole === "OWNER") return false;
	if (actorRole === "OWNER") return true;
	if (actorRole === "ADMIN") {
		return (
			targetRole === "FINANCE" ||
			targetRole === "OPERATOR" ||
			targetRole === "VIEWER"
		);
	}
	return false;
}

/** 邮箱规范化（技术方案 §5.1：统一 trim + 小写后比较） */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/** 邀请状态快照（纯数据入参，由调用方从 OrganizationInvitation 行构造） */
export interface InvitationSnapshot {
	expiresAt: Date;
	acceptedAt: Date | null;
	declinedAt: Date | null;
	revokedAt: Date | null;
}

/**
 * 邀请接受资格判定（技术方案 §6.3）：
 * 邮箱规范化严格匹配 + 未接受/未拒绝/未撤回 + 未过期（now === expiresAt 视为已过期）。
 */
export function canAcceptInvitation(
	actorEmail: string,
	invitationEmail: string,
	now: Date,
	invitation: InvitationSnapshot,
): boolean {
	if (normalizeEmail(actorEmail) !== normalizeEmail(invitationEmail)) {
		return false;
	}
	if (invitation.acceptedAt !== null) return false;
	if (invitation.declinedAt !== null) return false;
	if (invitation.revokedAt !== null) return false;
	return now.getTime() < invitation.expiresAt.getTime();
}

/** 所有权转移目标成员视图（调用方从 Membership 行构造） */
export interface OwnershipTransferTarget {
	userId: string;
	status: MembershipStatus;
}

/**
 * 所有权转移资格判定（需求 §7.2）：
 * 仅当前 Owner 可发起；仅 ACTIVE 成员可接任；Owner 转己禁止（自降走转移后自动 ADMIN）。
 */
export function canTransferOwnership(
	actor: { userId: string; role: OrganizationRole },
	targetMembership: OwnershipTransferTarget,
): boolean {
	if (actor.role !== "OWNER") return false;
	if (targetMembership.userId === actor.userId) return false;
	return targetMembership.status === "ACTIVE";
}

/**
 * 组织删除资格判定（需求 §6.3.2 / DATA-01）：
 * 仅 Owner 可发起，且组织当前无进行中的清空/导出/删除锁（冲突状态一律阻断）。
 */
export function canDeleteOrganization(
	actor: { role: OrganizationRole },
	organizationLock: { active: boolean },
): boolean {
	return actor.role === "OWNER" && !organizationLock.active;
}
