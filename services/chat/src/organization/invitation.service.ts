import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { canManage, normalizeEmail } from "../authorization/permission-policy";
import { PermissionDeniedException } from "../authorization/authorization.errors";
import type { ActorContext } from "../authorization/authorization.types";
import {
	generateInvitationToken,
	hashInvitationToken,
	invitationExpiresAt,
	invitationStatus,
	isInvitationOpen,
	type InvitationRecord,
} from "./invitation-rules";
import {
	InvitationEmailMismatchException,
	InvitationNotAcceptableException,
	InvitationNotFoundException,
} from "./organization.errors";

/**
 * 邀请生命周期服务（需求 MEM-01；技术方案 §6.3/§13.2；W19）。
 *
 * 纪律：
 * - 原始 token 只在创建响应出现一次；库中仅存 SHA-256 hash，审计 detail 不含 token；
 * - 重复邀请同邮箱：存在有效未过期邀请时幂等返回既有（reused=true，token 不重复发放）；
 * - 接受：邮箱规范化严格匹配 + 状态开放 + 事务内条件消费（防并发双抢）+
 *   Membership upsert/恢复（DISABLED 成员重新获邀按新角色恢复 ACTIVE）；
 * - 并发接受唯一 Membership 由 @@unique([organizationId, userId]) 与
 *   acceptedAt 条件更新双保险兜底。
 */
@Injectable()
export class InvitationService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(AuditService) private readonly auditService: AuditService,
	) {}

	private toRecord(row: {
		id: string;
		organizationId: string;
		email: string;
		role: string;
		expiresAt: Date;
		acceptedAt: Date | null;
		declinedAt: Date | null;
		revokedAt: Date | null;
	}): InvitationRecord {
		return row;
	}

	/** 创建/幂等复用邀请（member.invite；禁邀 OWNER） */
	async create(
		actor: ActorContext,
		input: { email: string; role: string },
	): Promise<{
		id: string;
		email: string;
		role: string;
		expiresAt: string;
		token: string;
		reused: boolean;
	}> {
		const email = normalizeEmail(input.email);
		// 资格：目标位按将加入后的角色判定（邀请 OWNER 一律拒绝，需求 7.1.1）
		if (input.role === "OWNER" || !canManage(actor.role, input.role as never, "invite")) {
			throw new PermissionDeniedException(
				"当前角色不可发出该角色的邀请（禁邀 OWNER；Admin 仅可邀请普通角色）",
			);
		}

		const now = new Date();
		// 幂等复用：同 (org, email) 有效未过期邀请（MEM-01.5）
		const existingRows = await this.prisma.organizationInvitation.findMany({
			where: { organizationId: actor.organizationId, email },
		});
		const reusable = existingRows
			.map((row) => this.toRecord(row))
			.find((record) => isInvitationOpen(record, now));
		if (reusable) {
			// 复用不重发 token（原 token 已一次性发放；提示邀请人既有邀请仍有效）
			return {
				id: reusable.id,
				email,
				role: reusable.role,
				expiresAt: reusable.expiresAt.toISOString(),
				token: "",
				reused: true,
			};
		}

		const token = generateInvitationToken();
		const created = await this.prisma.$transaction(async (tx) => {
			const row = await tx.organizationInvitation.create({
				data: {
					organizationId: actor.organizationId,
					email,
					role: input.role,
					tokenHash: hashInvitationToken(token),
					invitedById: actor.userId,
					expiresAt: invitationExpiresAt(now),
				},
			});
			await this.auditService.recordInTx(tx, {
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				actorType: "USER",
				action: "invitation.create",
				targetType: "invitation",
				targetId: row.id,
				result: "SUCCESS",
				detail: { email, role: input.role },
			});
			return row;
		});
		return {
			id: created.id,
			email,
			role: created.role,
			expiresAt: created.expiresAt.toISOString(),
			token,
			reused: false,
		};
	}

	/** 当前组织邀请列表（member.read；不回吐 tokenHash；邀请人名内存 join——
	 *  invitedById 为操作者快照，无 FK 关系（W14 schema 语义）） */
	async list(actor: ActorContext) {
		const rows = await this.prisma.organizationInvitation.findMany({
			where: { organizationId: actor.organizationId },
			orderBy: { createdAt: "desc" },
			take: 100,
			select: {
				id: true,
				organizationId: true,
				email: true,
				role: true,
				expiresAt: true,
				acceptedAt: true,
				declinedAt: true,
				revokedAt: true,
				invitedById: true,
			},
		});
		const inviterIds = [...new Set(rows.map((row) => row.invitedById))];
		const inviters =
			inviterIds.length > 0
				? await this.prisma.user.findMany({
						where: { id: { in: inviterIds } },
						select: { id: true, name: true },
					})
				: [];
		const nameById = new Map(inviters.map((u) => [u.id, u.name]));
		const now = new Date();
		return rows.map((row) => ({
			id: row.id,
			email: row.email,
			role: row.role,
			invitedByName: nameById.get(row.invitedById) ?? null,
			expiresAt: row.expiresAt.toISOString(),
			status: invitationStatus(this.toRecord(row), now),
			acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
		}));
	}

	/** 撤回有效邀请（member.invite） */
	async revoke(
		actor: ActorContext,
		invitationId: string,
	): Promise<{ status: string }> {
		if (!canManage(actor.role, "VIEWER", "invite")) {
			throw new PermissionDeniedException("当前角色不可管理邀请");
		}
		return this.prisma.$transaction(async (tx) => {
			const row = await tx.organizationInvitation.findFirst({
				where: { id: invitationId, organizationId: actor.organizationId },
			});
			if (!row) throw new InvitationNotFoundException();
			if (!isInvitationOpen(this.toRecord(row), new Date())) {
				throw new InvitationNotAcceptableException("邀请已结束（接受/拒绝/撤回/过期）");
			}
			await tx.organizationInvitation.update({
				where: { id: invitationId },
				data: { revokedAt: new Date() },
			});
			await this.auditService.recordInTx(tx, {
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				actorType: "USER",
				action: "invitation.revoke",
				targetType: "invitation",
				targetId: invitationId,
				result: "SUCCESS",
				detail: { email: row.email },
			});
			return { status: "REVOKED" };
		});
	}

	/** 按 token hash 找邀请行（个人端点共用；邀请人名内存 join） */
	private async findByToken(token: string) {
		const row = await this.prisma.organizationInvitation.findUnique({
			where: { tokenHash: hashInvitationToken(token) },
		});
		if (!row) return null;
		const [organization, inviter] = await Promise.all([
			this.prisma.organization.findUnique({
				where: { id: row.organizationId },
				select: { id: true, name: true },
			}),
			this.prisma.user.findUnique({
				where: { id: row.invitedById },
				select: { name: true },
			}),
		]);
		return { row, organization, inviterName: inviter?.name ?? null };
	}

	/** 受邀摘要（登录个人端点；脱敏——无任何账户余额或业务明细，MEM-01.7） */
	async getSummary(token: string) {
		const found = await this.findByToken(token);
		if (!found || !found.organization) throw new InvitationNotFoundException();
		const { row, organization, inviterName } = found;
		return {
			organizationId: organization.id,
			organizationName: organization.name,
			email: row.email,
			role: row.role,
			invitedByName: inviterName,
			expiresAt: row.expiresAt.toISOString(),
			status: invitationStatus(this.toRecord(row), new Date()),
		};
	}

	/**
	 * 接受邀请（登录 + 邮箱严格匹配）：事务内条件消费 + Membership upsert/恢复。
	 * 并发双抢：两并发仅一方 updateMany 命中（acceptedAt IS NULL 条件），败方 409。
	 */
	async accept(
		token: string,
		user: { id: string; email: string | null },
	): Promise<{ membershipId: string; role: string }> {
		const found = await this.findByToken(token);
		if (!found) throw new InvitationNotFoundException();
		const row = found.row;
		if (normalizeEmail(user.email ?? "") !== normalizeEmail(row.email)) {
			throw new InvitationEmailMismatchException();
		}
		if (!isInvitationOpen(this.toRecord(row), new Date())) {
			throw new InvitationNotAcceptableException(
				"邀请已接受、被拒绝、被撤回或已过期",
			);
		}

		return this.prisma.$transaction(async (tx) => {
			// 条件消费：acceptedAt IS NULL 才置位（并发第二事务 0 命中 → 409）
			const consumed = await tx.organizationInvitation.updateMany({
				where: { id: row.id, acceptedAt: null },
				data: { acceptedAt: new Date() },
			});
			if (consumed.count === 0) {
				throw new InvitationNotAcceptableException("邀请已被使用");
			}

			// upsert/恢复 Membership：唯一 (organizationId, userId)；DISABLED 恢复为 ACTIVE + 新角色
			const membership = await tx.membership.upsert({
				where: {
					organizationId_userId: {
						organizationId: row.organizationId,
						userId: user.id,
					},
				},
				create: {
					organizationId: row.organizationId,
					userId: user.id,
					role: row.role,
					status: "ACTIVE",
				},
				update: { role: row.role, status: "ACTIVE" },
			});
			await this.auditService.recordInTx(tx, {
				organizationId: row.organizationId,
				actorUserId: user.id,
				actorType: "USER",
				action: "invitation.accept",
				targetType: "invitation",
				targetId: row.id,
				result: "SUCCESS",
				detail: { role: row.role },
			});
			return { membershipId: membership.id, role: membership.role };
		});
	}

	/** 拒绝邀请（登录 + 邮箱匹配；拒绝不自动加入组织，MEM-01.6） */
	async decline(
		token: string,
		user: { id: string; email: string | null },
	): Promise<{ status: string }> {
		const found = await this.findByToken(token);
		if (!found) throw new InvitationNotFoundException();
		const row = found.row;
		if (normalizeEmail(user.email ?? "") !== normalizeEmail(row.email)) {
			throw new InvitationEmailMismatchException();
		}
		if (row.declinedAt !== null) return { status: "DECLINED" };
		if (!isInvitationOpen(this.toRecord(row), new Date())) {
			throw new InvitationNotAcceptableException("邀请已结束，无法拒绝");
		}
		await this.prisma.$transaction(async (tx) => {
			const updated = await tx.organizationInvitation.updateMany({
				where: { id: row.id, declinedAt: null, acceptedAt: null },
				data: { declinedAt: new Date() },
			});
			if (updated.count === 0) {
				throw new InvitationNotAcceptableException("邀请状态已变化");
			}
			await this.auditService.recordInTx(tx, {
				organizationId: row.organizationId,
				actorUserId: user.id,
				actorType: "USER",
				action: "invitation.decline",
				targetType: "invitation",
				targetId: row.id,
				result: "SUCCESS",
				detail: null,
			});
		});
		return { status: "DECLINED" };
	}
}
