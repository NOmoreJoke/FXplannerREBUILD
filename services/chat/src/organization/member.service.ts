import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { canManage } from "../authorization/permission-policy";
import { PermissionDeniedException } from "../authorization/authorization.errors";
import {
	isOrganizationRole,
	type ActorContext,
	type OrganizationRole,
} from "../authorization/authorization.types";
import {
	lockOrganizationForActor,
	lockOrganizationMembership,
} from "./default-organization";
import { isLastActiveOwner } from "./organization-rules";
import { materializeLegacyOrganizationSettings } from "./organization-preferences";
import {
	InvalidRoleException,
	LastOwnerRequiredException,
	MembershipConflictException,
	MemberNotActiveException,
	MemberNotFoundException,
	TransferConflictException,
} from "./organization.errors";

/**
 * 成员生命周期服务（需求 MEM-02 / ORG-03.3；技术方案 §6.3/§7.2；W19）。
 *
 * 纪律：
 * - 移除 = DISABLED（保留历史归属与审计快照），不物理删除；
 * - 资格判定对「旧角色」与「新角色」双侧都走 canManage（评审 I-01：Admin 不得
 *   借角色调整把普通成员提拔为自己无权管理的 Admin）；
 * - 目标为 OWNER：单活跃 Owner 不变量下即操作者本人——Owner 自降/自移除 →
 *   409 LAST_OWNER_REQUIRED（§6.3），Admin 对 Owner → 403（评审 I-04）；
 * - 每个变更事务先取组织级 advisory 锁再读状态，并以「期望角色/状态」条件更新
 *   落库（评审 I-06：READ COMMITTED 读后写竞态串行化，0 命中即 409 回滚）；
 * - 操作者资格在锁内以其最新角色复验（评审 R2-I01：等待锁期间被降权/移除的
 *   操作者不得沿用 Guard 放行时的旧角色；经 lockOrganizationForActor 重读）；
 * - 所有权转移事务顺序：**先降原 Owner 为 ADMIN，再升目标为 OWNER**
 *   （memberships_single_active_owner_uidx 部分唯一索引，GOAL W19 显式要求）；
 * - 转移前固化组织偏好：组织设置仍靠所有者个人设置回落时，先落成
 *   OrganizationSettings（评审 R2-I03：回落以所有者为锚，换所有者即失效）；
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
			joinedAt: m.joinedAt.toISOString(),
		}));
	}

	/**
	 * 角色调整（member.update）：
	 * 资格 = canManage(actor → 旧角色) ∧ canManage(actor → 新角色)；禁调为 OWNER；
	 * 目标 OWNER（即本人）→ 409 LAST_OWNER_REQUIRED；已移除成员不可调整（N-06）。
	 */
	async updateRole(
		actor: ActorContext,
		membershipId: string,
		newRole: string,
		requestId?: string | null,
	): Promise<{ id: string; role: string; status: string }> {
		if (!isOrganizationRole(newRole) || newRole === "OWNER") {
			throw new InvalidRoleException("目标角色非法（禁止直接调整为 OWNER）");
		}
		return this.prisma.$transaction(async (tx) => {
			// 锁内重读操作者：资格判定只用此刻的角色（R2-I01）
			const actorRole = await lockOrganizationForActor(tx, actor);
			const target = await tx.membership.findFirst({
				where: { id: membershipId, organizationId: actor.organizationId },
			});
			if (!target) throw new MemberNotFoundException();

			if (target.role === "OWNER") {
				// 单活跃 Owner 不变量：目标 OWNER ⇒ 即操作者本人的自降
				if (actorRole === "OWNER") throw new LastOwnerRequiredException();
				throw new PermissionDeniedException(
					"当前角色无权调整所有者（Admin 不可管理 Owner）",
				);
			}
			if (!canManage(actorRole, target.role as OrganizationRole, "update")) {
				throw new PermissionDeniedException(
					"当前角色无权调整该成员（Admin 不可管理 Owner/Admin）",
				);
			}
			// 新角色侧资格（I-01）：Admin 只能在其可管理范围内调整，不得提拔为 Admin
			if (!canManage(actorRole, newRole, "update")) {
				throw new PermissionDeniedException(
					"当前角色无权将成员调整为该角色（Admin 不可提拔为 Admin）",
				);
			}
			if (target.status !== "ACTIVE") {
				throw new MemberNotActiveException();
			}

			// 条件更新：角色与状态须与持锁后读到的一致（0 命中 = 并发修改）
			const updated = await tx.membership.updateMany({
				where: {
					id: membershipId,
					organizationId: actor.organizationId,
					role: target.role,
					status: target.status,
				},
				data: { role: newRole },
			});
			if (updated.count === 0) throw new MembershipConflictException();
			await this.auditService.recordInTx(tx, {
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				actorType: "USER",
				action: "member.update",
				targetType: "membership",
				targetId: membershipId,
				result: "SUCCESS",
				requestId: requestId ?? null,
				detail: { before: { role: target.role }, after: { role: newRole } },
			});
			return { id: membershipId, role: newRole, status: target.status };
		});
	}

	/** 移除成员（member.remove）：DISABLED 保留历史（MEM-02.3/02.4）；重复移除幂等 */
	async removeMember(
		actor: ActorContext,
		membershipId: string,
		requestId?: string | null,
	): Promise<{ id: string; status: string }> {
		return this.prisma.$transaction(async (tx) => {
			// 锁内重读操作者：资格判定只用此刻的角色（R2-I01）
			const actorRole = await lockOrganizationForActor(tx, actor);
			const target = await tx.membership.findFirst({
				where: { id: membershipId, organizationId: actor.organizationId },
			});
			if (!target) throw new MemberNotFoundException();

			if (target.role === "OWNER") {
				if (actorRole === "OWNER") throw new LastOwnerRequiredException();
				throw new PermissionDeniedException(
					"当前角色无权移除所有者（Admin 不可管理 Owner）",
				);
			}
			if (!canManage(actorRole, target.role as OrganizationRole, "remove")) {
				throw new PermissionDeniedException(
					"当前角色无权移除该成员（Admin 不可管理 Owner/Admin）",
				);
			}
			if (target.status !== "ACTIVE") {
				// 已移除：幂等返回既有状态，不重复写审计
				return { id: membershipId, status: target.status };
			}

			const updated = await tx.membership.updateMany({
				where: {
					id: membershipId,
					organizationId: actor.organizationId,
					role: target.role,
					status: "ACTIVE",
				},
				data: { status: "DISABLED" },
			});
			if (updated.count === 0) throw new MembershipConflictException();
			await this.auditService.recordInTx(tx, {
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				actorType: "USER",
				action: "member.remove",
				targetType: "membership",
				targetId: membershipId,
				result: "SUCCESS",
				requestId: requestId ?? null,
				detail: { role: target.role },
			});
			return { id: membershipId, status: "DISABLED" };
		});
	}

	/** 主动退出（MEM-02.5）：最后 Owner 409；重复退出幂等 */
	async leave(
		actor: ActorContext,
		requestId?: string | null,
	): Promise<{ status: string }> {
		return this.prisma.$transaction(async (tx): Promise<{ status: string }> => {
			await lockOrganizationMembership(tx, actor.organizationId);
			const self = await tx.membership.findUnique({
				where: { id: actor.membershipId },
			});
			if (!self || self.organizationId !== actor.organizationId) {
				throw new MemberNotFoundException();
			}
			if (self.status !== "ACTIVE") {
				return { status: self.status }; // 已退出：幂等
			}
			// 单活跃 Owner 不变量下（memberships_single_active_owner_uidx），
			// 持锁读到的 ACTIVE OWNER 即最后 Owner
			if (isLastActiveOwner(1, self.role, self.status)) {
				throw new LastOwnerRequiredException();
			}
			const updated = await tx.membership.updateMany({
				where: { id: actor.membershipId, role: self.role, status: "ACTIVE" },
				data: { status: "DISABLED" },
			});
			if (updated.count === 0) throw new MembershipConflictException();
			await this.auditService.recordInTx(tx, {
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				actorType: "USER",
				action: "member.leave",
				targetType: "membership",
				targetId: actor.membershipId,
				result: "SUCCESS",
				requestId: requestId ?? null,
				detail: { role: self.role },
			});
			return { status: "DISABLED" };
		});
	}

	/**
	 * 所有权转移（owner.transfer，MEM-02.2）：原 Owner 降为 ADMIN、目标升为 OWNER。
	 * 事务内持组织锁后重读双方状态 → 先降后升（部分唯一索引顺序）；任一侧状态与
	 * 持锁后读到的不一致即 0 命中回滚（并发双提交的败方 409 TRANSFER_CONFLICT）。
	 */
	async transferOwnership(
		actor: ActorContext,
		targetMembershipId: string,
		requestId?: string | null,
	): Promise<{ promotedId: string; demotedId: string }> {
		if (actor.role !== "OWNER") {
			throw new PermissionDeniedException("仅所有者可转移所有权");
		}
		try {
			return await this.prisma.$transaction(async (tx) => {
				await lockOrganizationMembership(tx, actor.organizationId);
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

				// R2-I03：组织偏好若仍靠「所有者个人设置」兼容回落支撑，会随所有权一起
				// 失效（新所有者的个人设置不代表本组织）——转移前先固化为本组织自己的设置
				const settingsMaterialized =
					await materializeLegacyOrganizationSettings(
						tx,
						actor.organizationId,
					);

				// 先降原 Owner（释放部分唯一索引槽位）：须仍为 ACTIVE OWNER，否则并发已变更
				const demoted = await tx.membership.updateMany({
					where: {
						id: actor.membershipId,
						organizationId: actor.organizationId,
						role: "OWNER",
						status: "ACTIVE",
					},
					data: { role: "ADMIN" },
				});
				if (demoted.count === 0) throw new TransferConflictException();
				// 再升目标：角色/状态须与持锁后读到的一致
				const promoted = await tx.membership.updateMany({
					where: {
						id: targetMembershipId,
						organizationId: actor.organizationId,
						role: target.role,
						status: "ACTIVE",
					},
					data: { role: "OWNER" },
				});
				if (promoted.count === 0) throw new TransferConflictException();
				await this.auditService.recordInTx(tx, {
					organizationId: actor.organizationId,
					actorUserId: actor.userId,
					actorType: "USER",
					action: "owner.transfer",
					targetType: "membership",
					targetId: targetMembershipId,
					result: "SUCCESS",
					requestId: requestId ?? null,
					detail: {
						fromMembershipId: actor.membershipId,
						toMembershipId: targetMembershipId,
						toUserId: target.userId,
						settingsMaterialized,
					},
				});
				return {
					promotedId: targetMembershipId,
					demotedId: actor.membershipId,
				};
			});
		} catch (error) {
			// 并发所有权转移：唯一索引兜底违规（P2002）→ 409 而非 500
			if (
				typeof error === "object" &&
				error !== null &&
				(error as { code?: string }).code === "P2002"
			) {
				throw new TransferConflictException();
			}
			throw error;
		}
	}
}
