/**
 * 邀请纯函数规则（技术方案 §5.1/§6.3/§13.2；需求 MEM-01；Goal #3A W19）。
 *
 * 纪律：
 * - 高熵 token 仅在创建响应中出现一次；数据库只存 SHA-256 tokenHash，
 *   原始 token 绝不落库、不进审计 detail（AUDIT-02）；
 * - 邮箱统一 trim + 小写后比较（与 permission-policy.normalizeEmail 同源）；
 * - 同 (organizationId, normalizedEmail) 存在有效邀请时幂等复用，不产生
 *   相互冲突的多封有效邀请（MEM-01.5）；
 * - 零 IO：日期由调用方传入。
 */

import { createHash, randomBytes } from "node:crypto";
import { normalizeEmail } from "../authorization/permission-policy";

/** 邀请可分配角色（禁邀 OWNER —— canManage 之外的第二道语义闸） */
export const INVITABLE_ROLES = ["ADMIN", "FINANCE", "OPERATOR", "VIEWER"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/** 默认有效期（天）：需求 MEM-01.2 */
export const INVITATION_TTL_DAYS = 7;

/** 生成高熵邀请 token（43 字符 base64url，256-bit 熵） */
export function generateInvitationToken(): string {
	return randomBytes(32).toString("base64url");
}

/** 单向 SHA-256 落库 hash（hex） */
export function hashInvitationToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** 邀请行视图（调用方从 OrganizationInvitation 行构造） */
export interface InvitationRecord {
	id: string;
	organizationId: string;
	email: string;
	role: string;
	expiresAt: Date;
	acceptedAt: Date | null;
	declinedAt: Date | null;
	revokedAt: Date | null;
}

/** 邀请是否仍可接受（状态 + 有效期；不校验邮箱——邮箱匹配独立判定） */
export function isInvitationOpen(
	invitation: InvitationRecord,
	now: Date,
): boolean {
	if (invitation.acceptedAt !== null) return false;
	if (invitation.declinedAt !== null) return false;
	if (invitation.revokedAt !== null) return false;
	return now.getTime() < invitation.expiresAt.getTime();
}

/**
 * 幂等复用判定（MEM-01.5）：同组织同邮箱存在「有效未过期」邀请时返回它，
 * 否则 null（调用方据此新建）。已接受/拒绝/撤回/过期的历史行不阻断新邀请。
 */
export function findReusableInvitation(
	invitations: InvitationRecord[],
	organizationId: string,
	email: string,
	now: Date,
): InvitationRecord | null {
	const normalized = normalizeEmail(email);
	return (
		invitations.find(
			(invitation) =>
				invitation.organizationId === organizationId &&
				normalizeEmail(invitation.email) === normalized &&
				isInvitationOpen(invitation, now),
		) ?? null
	);
}

/** 受邀摘要（GET /organization-invitations/:token 响应；不含业务数据与 tokenHash） */
export interface InvitationSummaryView {
	organizationId: string;
	organizationName: string;
	email: string;
	role: string;
	invitedByName: string | null;
	expiresAt: string;
	status: "OPEN" | "ACCEPTED" | "DECLINED" | "REVOKED" | "EXPIRED";
}

/** 邀请状态归并（展示态；EXPIRED 优先于历史终态冲突） */
export function invitationStatus(
	invitation: InvitationRecord,
	now: Date,
): InvitationSummaryView["status"] {
	if (invitation.acceptedAt !== null) return "ACCEPTED";
	if (invitation.declinedAt !== null) return "DECLINED";
	if (invitation.revokedAt !== null) return "REVOKED";
	if (now.getTime() >= invitation.expiresAt.getTime()) return "EXPIRED";
	return "OPEN";
}

/** 计算过期时刻（创建时调用方使用） */
export function invitationExpiresAt(now: Date): Date {
	return new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}
