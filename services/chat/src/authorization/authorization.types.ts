/**
 * ToB R1 授权层类型真源（技术方案 §4.2 / §6.1；需求 §7.3 固定角色矩阵）。
 *
 * 本文件仅含类型与字面量常量：零 IO、零外部依赖；
 * 权限决策逻辑一律走 permission-policy.ts 纯函数，禁止在业务模块内复制角色判断。
 */

/** 组织固定五角色（无自定义角色；组织内没有逐记录授权） */
export const ORGANIZATION_ROLES = [
	"OWNER",
	"ADMIN",
	"FINANCE",
	"OPERATOR",
	"VIEWER",
] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/**
 * 运行时角色合法性校验（评审 I-13）：memberships.role 为非约束 TEXT，
 * Guard 构造 ActorContext 前必须校验——库内任何非法/未知角色值一律
 * fail-closed（不进入权限判定），防止 `as OrganizationRole` 断言放行全量业务读。
 */
export function isOrganizationRole(value: unknown): value is OrganizationRole {
	return (
		typeof value === "string" &&
		(ORGANIZATION_ROLES as readonly string[]).includes(value)
	);
}

/**
 * 权限点全量枚举（技术方案 §6.1，28 项）。
 * 运行时数组供策略表与测试矩阵迭代；新增权限点必须同步
 * permission-policy.spec.ts 的期望矩阵与需求 §7.3 角色表。
 */
export const PERMISSIONS = [
	"organization.read",
	"organization.update",
	"organization.delete",
	"member.read",
	"member.invite",
	"member.update",
	"member.remove",
	"owner.transfer",
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
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Membership 状态（组织成员只有有效/禁用两态；移除 = DISABLED，保留历史归属） */
export type MembershipStatus = "ACTIVE" | "DISABLED";

/** 操作者身份类型（审计与 Agent 调用记录携带；权限判定只看 OrganizationRole） */
export type ActorAuthMethod = "USER" | "API";

/**
 * 请求级授权上下文（技术方案 §4.2）：
 * 由 OrganizationContextGuard 实时查询 Membership 后构造，
 * 业务 Service 以 actor 替代裸 userId 作为数据范围与权限来源。
 * Agent 不构造另一个高权限 Actor——工具调用复用当前请求 Actor。
 *
 * W30（MIG-D）：兼容窗口关闭后组织上下文**唯一**——`organizationId` 即租户边界，
 * 不再存在「默认组织兜底 / 存量 NULL 行回落」的第二语义，故本上下文不再携带
 * `isDefaultOrganization` 标记。
 */
export interface ActorContext {
	userId: string;
	organizationId: string;
	membershipId: string;
	role: OrganizationRole;
	authMethod: ActorAuthMethod;
}
