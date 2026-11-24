import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { canManage, normalizeEmail } from "../authorization/permission-policy";
import { PermissionDeniedException } from "../authorization/authorization.errors";
import type { ActorContext, OrganizationRole } from "../authorization/authorization.types";
import {
	lockOrganizationForActor,
	lockOrganizationMembership,
} from "./default-organization";
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
	MemberAlreadyActiveException,
} from "./organization.errors";

type Db = PrismaService | Prisma.TransactionClient;

/** 登录用户身份视图（邮箱可能为空：纯 OTP 账号的邮箱在已验证的 OtpIdentity 上） */
export interface InvitedUser {
	id: string;
	email: string | null;
}

/**
 * 邀请生命周期服务（需求 MEM-01；技术方案 §6.3/§13.2；W19）。
 *
 * 纪律：
 * - 原始 token 只在创建响应出现一次；库中仅存 SHA-256 hash，审计 detail 不含 token；
 * - 受邀邮箱匹配 = 登录邮箱（密码账号）或已验证的邮箱 OTP 标识（规范化后比对）
 *   ——摘要/接受/拒绝三端点一律先匹配再返回任何元数据（评审 I-05/I-09）；
 * - 已是组织有效成员的邮箱不可被邀请，接受时也禁止覆写既有 ACTIVE 成员
 *   （尤其严禁借邀请把 OWNER 降级致组织无主，评审 I-02）；DISABLED 成员重新
 *   获邀按新角色恢复 ACTIVE；
 * - 邀请的创建/撤回/接受/拒绝全部在组织级 advisory 锁内完成，状态迁移一律用
 *   「完整开放态」条件更新（acceptedAt/declinedAt/revokedAt 为空且未过期），
 *   消除读后写 TOCTOU（评审 I-07）；并发同邮箱创建由锁串行化（MEM-01.5）；
 * - 撤回资格按邀请自身的角色判定（评审 I-03：Admin 不可撤回 Owner 发出的
 *   Admin 角色邀请）。
 */
@Injectable()
export class InvitationService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(AuditService) private readonly auditService: AuditService,
	) {}

	private toRecord(row: InvitationRecord): InvitationRecord {
		return row;
	}

	/** 受邀邮箱与登录用户是否匹配（密码账号邮箱 ∨ 已验证的邮箱 OTP 标识） */
	private async matchesInvitedEmail(
		db: Db,
		user: InvitedUser,
		invitationEmail: string,
	): Promise<boolean> {
		const target = normalizeEmail(invitationEmail);
		if (user.email !== null && normalizeEmail(user.email) === target) {
			return true;
		}
		const identity = await db.otpIdentity.findFirst({
			where: { userId: user.id, channel: "email", target },
			select: { id: true },
		});
		return identity !== null;
	}

	/** 邮箱对应的账号 id 集合（密码账号按 User.email；OTP 账号按已验证邮箱标识） */
	private async findUserIdsByEmail(
		db: Db,
		email: string,
	): Promise<string[]> {
		const [passwordUser, otpIdentities] = await Promise.all([
			db.user.findUnique({ where: { email }, select: { id: true } }),
			db.otpIdentity.findMany({
				where: { channel: "email", target: email },
				select: { userId: true },
			}),
		]);
		const ids = new Set<string>(otpIdentities.map((row) => row.userId));
		if (passwordUser) ids.add(passwordUser.id);
		return [...ids];
	}

	/** 邀请资格（禁邀 OWNER；Admin 仅可邀请普通角色）——锁前快速拒绝与锁内复验共用 */
	private assertInviteEligibility(
		actorRole: OrganizationRole,
		targetRole: string,
	): void {
		if (
			targetRole === "OWNER" ||
			!canManage(actorRole, targetRole as OrganizationRole, "invite")
		) {
			throw new PermissionDeniedException(
				"当前角色不可发出该角色的邀请（禁邀 OWNER；Admin 仅可邀请普通角色）",
			);
		}
	}

	/**
	 * 创建/幂等复用邀请（member.invite；禁邀 OWNER）。
	 * 组织锁内：已 ACTIVE 成员 → 409；同邮箱有效邀请 → 幂等复用（不重发 token）。
	 */
	async create(
		actor: ActorContext,
		input: { email: string; role: string },
		requestId?: string | null,
	): Promise<{
		id: string;
		email: string;
		role: string;
		expiresAt: string;
		token: string;
		reused: boolean;
	}> {
		const email = normalizeEmail(input.email);
		// 锁前快速拒绝（不产副作用）；锁内以最新角色复验（R2-I01）
		this.assertInviteEligibility(actor.role, input.role);

		const now = new Date();
		const token = generateInvitationToken();
		const result = await this.prisma.$transaction(async (tx) => {
			// 锁内重读操作者：等待锁期间被降权/移除则 403/404（R2-I01）
			const actorRole = await lockOrganizationForActor(tx, actor);
			this.assertInviteEligibility(actorRole, input.role);

			// I-02：已是有效成员 → 拒绝（禁止借邀请覆写既有成员角色）
			const existingUserIds = await this.findUserIdsByEmail(tx, email);
			if (existingUserIds.length > 0) {
				const activeMembership = await tx.membership.findFirst({
					where: {
						organizationId: actor.organizationId,
						userId: { in: existingUserIds },
						status: "ACTIVE",
					},
					select: { id: true },
				});
				if (activeMembership) throw new MemberAlreadyActiveException();
			}

			// 幂等复用：同 (org, email) 有效未过期邀请（MEM-01.5；锁内判定，并发不产生多条）
			const existingRows = await tx.organizationInvitation.findMany({
				where: { organizationId: actor.organizationId, email },
			});
			const reusable = existingRows
				.map((row) => this.toRecord(row))
				.find((record) => isInvitationOpen(record, now));
			if (reusable) {
				return {
					id: reusable.id,
					email,
					role: reusable.role,
					expiresAt: reusable.expiresAt.toISOString(),
					token: "",
					reused: true,
				};
			}

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
				requestId: requestId ?? null,
				detail: { email, role: input.role },
			});
			return {
				id: row.id,
				email,
				role: row.role,
				expiresAt: row.expiresAt.toISOString(),
				token,
				reused: false,
			};
		});
		return result;
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

	/**
	 * 撤回有效邀请（member.invite）：资格按邀请自身角色；锁内以完整开放态条件更新，
	 * 与并发 accept 互斥（同锁串行）且条件互斥（仅一方 0 命中）。
	 */
	async revoke(
		actor: ActorContext,
		invitationId: string,
		requestId?: string | null,
	): Promise<{ status: string }> {
		if (!canManage(actor.role, "VIEWER", "invite")) {
			throw new PermissionDeniedException("当前角色不可管理邀请");
		}
		return this.prisma.$transaction(async (tx) => {
			// 锁内重读操作者：等待锁期间被降权/移除则 403/404（R2-I01）
			const actorRole = await lockOrganizationForActor(tx, actor);
			// 先验总资格再查行：已无邀请管理权者对任意 id 统一 403，不泄露存在性
			if (!canManage(actorRole, "VIEWER", "invite")) {
				throw new PermissionDeniedException("当前角色不可管理邀请");
			}
			const row = await tx.organizationInvitation.findFirst({
				where: { id: invitationId, organizationId: actor.organizationId },
			});
			if (!row) throw new InvitationNotFoundException();
			// I-03：按邀请角色判定资格（Admin 不可撤回 Owner 发出的 Admin 角色邀请）
			if (!canManage(actorRole, row.role as OrganizationRole, "invite")) {
				throw new PermissionDeniedException("当前角色无权撤回该角色的邀请");
			}
			const now = new Date();
			const revoked = await tx.organizationInvitation.updateMany({
				where: {
					id: invitationId,
					organizationId: actor.organizationId,
					acceptedAt: null,
					declinedAt: null,
					revokedAt: null,
					expiresAt: { gt: now },
				},
				data: { revokedAt: now },
			});
			if (revoked.count === 0) {
				throw new InvitationNotAcceptableException(
					"邀请已结束（接受/拒绝/撤回/过期）",
				);
			}
			await this.auditService.recordInTx(tx, {
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				actorType: "USER",
				action: "invitation.revoke",
				targetType: "invitation",
				targetId: invitationId,
				result: "SUCCESS",
				requestId: requestId ?? null,
				detail: { email: row.email, role: row.role },
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

	/**
	 * 受邀摘要（登录个人端点；脱敏——无任何账户余额或业务明细，MEM-01.7）。
	 * 仅返回本人可处理的邀请（技术方案 §7.2）：邮箱不匹配一律 403 且不返回
	 * 任何组织/邀请人元数据（评审 I-05）。
	 */
	async getSummary(token: string, user: InvitedUser) {
		const found = await this.findByToken(token);
		if (!found || !found.organization) throw new InvitationNotFoundException();
		const { row, organization, inviterName } = found;
		if (!(await this.matchesInvitedEmail(this.prisma, user, row.email))) {
			throw new InvitationEmailMismatchException();
		}
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
	 * 接受邀请（登录 + 邮箱匹配）：
	 * 组织锁内以完整开放态条件消费 → 新建 Membership 或恢复 DISABLED 成员；
	 * 已 ACTIVE 成员一律 409（不覆写角色，事务回滚、邀请不被消费）。
	 */
	async accept(
		token: string,
		user: InvitedUser,
		requestId?: string | null,
	): Promise<{ membershipId: string; role: string }> {
		const found = await this.findByToken(token);
		if (!found) throw new InvitationNotFoundException();
		const row = found.row;
		if (!(await this.matchesInvitedEmail(this.prisma, user, row.email))) {
			throw new InvitationEmailMismatchException();
		}

		return this.prisma.$transaction(async (tx) => {
			await lockOrganizationMembership(tx, row.organizationId);
			const now = new Date();
			// 完整开放态条件消费：未接受/未拒绝/未撤回且未过期（I-07 TOCTOU）
			const consumed = await tx.organizationInvitation.updateMany({
				where: {
					id: row.id,
					acceptedAt: null,
					declinedAt: null,
					revokedAt: null,
					expiresAt: { gt: now },
				},
				data: { acceptedAt: now },
			});
			if (consumed.count === 0) {
				throw new InvitationNotAcceptableException(
					"邀请已接受、被拒绝、被撤回或已过期",
				);
			}

			const membershipId = {
				organizationId_userId: {
					organizationId: row.organizationId,
					userId: user.id,
				},
			};
			const existing = await tx.membership.findUnique({ where: membershipId });
			if (existing?.status === "ACTIVE") {
				// I-02：已是有效成员——禁止覆写角色（含 OWNER 降级）；回滚消费
				throw new InvitationNotAcceptableException("你已是该组织的有效成员");
			}

			let membership: { id: string; role: string };
			if (existing) {
				// DISABLED → 按邀请角色恢复 ACTIVE（历史归属保留，MEM-02.4）
				const restored = await tx.membership.updateMany({
					where: { id: existing.id, status: "DISABLED" },
					data: { role: row.role, status: "ACTIVE" },
				});
				if (restored.count === 0) {
					throw new InvitationNotAcceptableException("成员状态已变化，请重试");
				}
				membership = { id: existing.id, role: row.role };
			} else {
				const created = await tx.membership.create({
					data: {
						organizationId: row.organizationId,
						userId: user.id,
						role: row.role,
						status: "ACTIVE",
					},
					select: { id: true, role: true },
				});
				membership = created;
			}
			await this.auditService.recordInTx(tx, {
				organizationId: row.organizationId,
				actorUserId: user.id,
				actorType: "USER",
				action: "invitation.accept",
				targetType: "invitation",
				targetId: row.id,
				result: "SUCCESS",
				requestId: requestId ?? null,
				detail: { role: row.role },
			});
			return { membershipId: membership.id, role: membership.role };
		});
	}

	/** 拒绝邀请（登录 + 邮箱匹配；拒绝不自动加入组织，MEM-01.6；重复拒绝幂等） */
	async decline(
		token: string,
		user: InvitedUser,
		requestId?: string | null,
	): Promise<{ status: string }> {
		const found = await this.findByToken(token);
		if (!found) throw new InvitationNotFoundException();
		const row = found.row;
		if (!(await this.matchesInvitedEmail(this.prisma, user, row.email))) {
			throw new InvitationEmailMismatchException();
		}
		if (row.declinedAt !== null) return { status: "DECLINED" };

		await this.prisma.$transaction(async (tx) => {
			await lockOrganizationMembership(tx, row.organizationId);
			const now = new Date();
			const updated = await tx.organizationInvitation.updateMany({
				where: {
					id: row.id,
					acceptedAt: null,
					declinedAt: null,
					revokedAt: null,
					expiresAt: { gt: now },
				},
				data: { declinedAt: now },
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
				requestId: requestId ?? null,
				detail: null,
			});
		});
		return { status: "DECLINED" };
	}
}
