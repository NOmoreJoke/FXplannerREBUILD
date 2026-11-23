import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { canManage } from "../authorization/permission-policy";
import { PermissionDeniedException } from "../authorization/authorization.errors";
import type { ActorContext } from "../authorization/authorization.types";
import { isLastActiveOwner, isValidRole } from "./organization-rules";
import {
	InvalidRoleException,
	LastOwnerRequiredException,
	MemberNotFoundException,
} from "./organization.errors";

/**
 * 成员生命周期服务（需求 MEM-02 / ORG-03.3；技术方案 §6.3/§7.2；W19）。
 *
 * 纪律：
 * - 移除 = DISABLED（保留历史归属与审计快照），不物理删除；
 * - 角色调整/移除资格统一走 canManage（Admin 不可管 Owner/Admin 互管）；
 * - 最后 Owner 退出/移除/降权一律 409 LAST_OWNER_REQUIRED；
 * - 所有权转移事务顺序：**先降原 Owner 为 ADMIN，再升目标为 OWNER**
 *   （memberships_single_active_owner_uidx 部分唯一索引，GOAL W19 显式要求）；
 * - 全部变更同事务写审计。
 */
@Injectable()
export class MemberService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(AuditService) private readonly auditService: AuditService,
	) {}

	/** 成员列表（member.read；含用户显示名/邮箱） */
	async listMembers(organizationId: string) {
		const memberships = await this.prisma.membership.findMany({
			where: { organizationId },
			orderBy: [{ status: "asc" }, { joinedAt: "asc" }],
			select: {
				id: true,
				userId: true,
				role: true,
				status: true,
				joinedAt: true,
				user: { select: { name: true, email: true } },
			},
		});
		return memberships.map((m) => ({
			id: m.id,
			userId: m.userId,
			name: m.user.name,
			email: m.user.email,
			role: m.role,
			status: m.status,
			joinedAt: m.joinedAt,
		}));
	}

	/** 角色调整（member.update）：资格 canManage + 目标角色形状 + 最后 Owner 保护 */
	async updateRole(
		actor: ActorContext,
		membershipId: string,
		newRole: string,
	): Promise<{ id: string; role: string; status: string }> {
		if (!isValidRole(newRole) || newRole === "OWNER") {
			throw new InvalidRoleException("目标角色非法（禁止直接调整为 OWNER）");
		}
		return this.prisma.$transaction(async (tx) => {
			const target = await tx.membership.findFirst({
				where: { id: membershipId, organizationId: actor.organizationId },
			});
			if (!target) throw new MemberNotFoundException();

			if (!canManage(actor.role, target.role as never, "update")) {
				throw new PermissionDeniedException(
					"当前角色无权调整该成员（Admin 不可管理 Owner/Admin）",
				);
			}
			const activeOwners = await tx.membership.count({
				where: {
					organizationId: actor.organizationId,
					role: "OWNER",
					status: "ACTIVE",
				},
			});
			if (isLastActiveOwner(activeOwners, target.role, target.status)) {
				throw new LastOwnerRequiredException();
			}

			const updated = await tx.membership.update({
				where: { id: membershipId },
				data: { role: newRole },
				select: { id: true, role: true, status: true },
			});
			await this.auditService.recordInTx(tx, {
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				actorType: "USER",
				action: "member.update",
				targetType: "membership",
				targetId: membershipId,
				result: "SUCCESS",
				detail: { before: { role: target.role }, after: { role: newRole } },
			});
			return updated;
		});
	}

	/** 移除成员（member.remove）：DISABLED 保留历史（MEM-02.3/02.4） */
	async removeMember(
		actor: ActorContext,
		membershipId: string,
	): Promise<{ id: string; status: string }> {
		return this.prisma.$transaction(async (tx) => {
			const target = await tx.membership.findFirst({
				where: { id: membershipId, organizationId: actor.organizationId },
			});
			if (!target) throw new MemberNotFoundException();

			if (!canManage(actor.role, target.role as never, "remove")) {
				throw new PermissionDeniedException(
					"当前角色无权移除该成员（Admin 不可管理 Owner/Admin）",
				);
			}
			const activeOwners = await tx.membership.count({
				where: {
					organizationId: actor.organizationId,
					role: "OWNER",
					status: "ACTIVE",
				},
			});
			if (isLastActiveOwner(activeOwners, target.role, target.status)) {
				throw new LastOwnerRequiredException();
			}

			const updated = await tx.membership.update({
				where: { id: membershipId },
				data: { status: "DISABLED" },
				select: { id: true, status: true },
			});
			await this.auditService.recordInTx(tx, {
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				actorType: "USER",
				action: "member.remove",
				targetType: "membership",
				targetId: membershipId,
				result: "SUCCESS",
				detail: { role: target.role },
			});
			return updated;
		});
	}

	/** 主动退出（MEM-02.5）：最后 Owner 409；其余 DISABLED 自身成员关系 */
	async leave(actor: ActorContext): Promise<{ status: string }> {
		return this.prisma.$transaction(async (tx) => {
			const activeOwners = await tx.membership.count({
				where: {
					organizationId: actor.organizationId,
					role: "OWNER",
					status: "ACTIVE",
				},
			});
			const self = await tx.membership.findUnique({
				where: { id: actor.membershipId },
			});
			if (!self || self.organizationId !== actor.organizationId) {
				throw new MemberNotFoundException();
			}
			if (isLastActiveOwner(activeOwners, self.role, self.status)) {
				throw new LastOwnerRequiredException();
			}
			await tx.membership.update({
				where: { id: actor.membershipId },
				data: { status: "DISABLED" },
			});
			await this.auditService.recordInTx(tx, {
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				actorType: "USER",
				action: "member.leave",
				targetType: "membership",
				targetId: actor.membershipId,
				result: "SUCCESS",
				detail: null,
			});
			return { status: "DISABLED" };
		});
	}

	/**
	 * 所有权转移（owner.transfer，MEM-02.2）：原 Owner 降为 ADMIN、目标升为 OWNER。
	 * 事务内**先降后升**（部分唯一索引顺序；并发下违反即回滚，索引兜底双保险）。
	 */
	async transferOwnership(
		actor: ActorContext,
		targetMembershipId: string,
	): Promise<{ promotedId: string; demotedId: string }> {
		if (actor.role !== "OWNER") {
			throw new PermissionDeniedException("仅所有者可转移所有权");
		}
		return this.prisma.$transaction(async (tx) => {
			const target = await tx.membership.findFirst({
				where: {
					id: targetMembershipId,
					organizationId: actor.organizationId,
				},
			});
			if (!target) throw new MemberNotFoundException();
			if (target.userId === actor.userId) {
				throw new InvalidRoleException("不能转移给自己（自降请走成员管理）");
			}
			if (target.status !== "ACTIVE") {
				throw new InvalidRoleException("仅有效成员可接任所有权");
			}

			// 先降原 Owner（释放部分唯一索引槽位），再升目标
			await tx.membership.update({
				where: { id: actor.membershipId },
				data: { role: "ADMIN" },
			});
			await tx.membership.update({
				where: { id: targetMembershipId },
				data: { role: "OWNER" },
			});
			await this.auditService.recordInTx(tx, {
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				actorType: "USER",
				action: "owner.transfer",
				targetType: "membership",
				targetId: targetMembershipId,
				result: "SUCCESS",
				detail: {
					fromMembershipId: actor.membershipId,
					toMembershipId: targetMembershipId,
					toUserId: target.userId,
				},
			});
			return { promotedId: targetMembershipId, demotedId: actor.membershipId };
		});
	}
}
