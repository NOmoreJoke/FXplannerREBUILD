import type { Prisma } from "@prisma/client";
import { sanitizeAuditDetail } from "../audit/audit-sanitizer";

type Tx = Prisma.TransactionClient;

/** 默认组织名（需求 ORG-01.3：「用户名称/邮箱前缀的工作台」） */
export function defaultOrganizationName(user: {
	name: string | null;
	email: string | null;
}): string {
	const base = user.name?.trim() || (user.email?.split("@")[0] ?? "").trim();
	return `${base || "我的"}的工作台`;
}

/**
 * 同一组织内全部成员/所有权/邀请消费变更的事务级互斥（评审 I-06/I-07）。
 *
 * 先取锁再读成员与邀请状态：READ COMMITTED 下「读到目标 ACTIVE → 并发 leave →
 * 仍把已 DISABLED 的目标升为 OWNER」这类读后写竞态由此串行化消除；锁随事务
 * 结束自动释放（沿用 otp.service / data-request.service 的
 * pg_advisory_xact_lock 先例；连接池无会话粘滞，禁用会话级锁）。
 * 调用方必须在本函数返回后才读取业务状态并执行条件更新。
 */
export async function lockOrganizationMembership(
	tx: Tx,
	organizationId: string,
): Promise<void> {
	const key = `membership:${organizationId}`;
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/**
 * 新用户默认组织兜底（ORG-01.2：密码注册与 OTP 首登共用；同事务）：
 * Organization + OWNER/ACTIVE Membership + organization.create 审计。
 * 不建 OrganizationSettings——新组织保持待建账语义（与 MIG-B §12.2.3 一致）。
 * 纯函数式（无 Nest DI），auth 模块直接调用以避免 Auth ↔ Audit 模块循环依赖。
 */
export async function bootstrapDefaultOrganization(
	tx: Tx,
	user: { id: string; name: string | null; email: string | null },
	requestId?: string | null,
): Promise<{ organizationId: string; name: string; createdAt: Date }> {
	const organization = await tx.organization.create({
		data: {
			name: defaultOrganizationName(user),
			memberships: {
				create: { userId: user.id, role: "OWNER", status: "ACTIVE" },
			},
		},
		select: { id: true, name: true, createdAt: true },
	});
	await tx.auditLog.create({
		data: {
			organizationId: organization.id,
			actorUserId: user.id,
			actorType: "USER",
			action: "organization.create",
			targetType: "organization",
			targetId: organization.id,
			result: "SUCCESS",
			requestId: requestId ?? null,
			detail: sanitizeAuditDetail({
				name: organization.name,
				source: "registration-bootstrap",
			}) as Prisma.InputJsonValue,
		},
	});
	return {
		organizationId: organization.id,
		name: organization.name,
		createdAt: organization.createdAt,
	};
}
