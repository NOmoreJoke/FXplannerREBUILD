import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { ActorContext } from "../authorization/authorization.types";
import {
	buildCapabilities,
	isValidOrganizationName,
	normalizeOrganizationName,
} from "./organization-rules";
import {
	OrganizationNotFoundException,
	PermissionDeniedException,
} from "../authorization/authorization.errors";
import { can } from "../authorization/permission-policy";
import { InvalidOrganizationNameException } from "./organization.errors";
import { resolveOrganizationPreferences } from "./organization-preferences";
import { lockOrganizationForActor } from "./default-organization";
import { ACTIVE_STATUSES } from "../data-request/data-request-rules";

/**
 * 组织与当前组织视图服务（技术方案 §7.2；Goal #3A W17）。
 *
 * 职责：
 * - 个人端点：GET /organizations（本人有效组织）、POST /organizations
 *   （创建组织 + OWNER Membership + 空设置待建账 + 同事务审计，ORG-01.4/5）；
 * - 组织上下文端点：GET/PATCH /organizations/current（经 Guard 链鉴权后消费
 *   ActorContext，组织读取本身即限定 organizationId，§4.4.5）；
 * - 新用户默认组织兜底由 auth 模块经 default-organization.ts 在注册/OTP 首登
 *   事务内完成（ORG-01.2；评审 I-09），本服务只负责显式新建与查询。
 */
@Injectable()
export class OrganizationService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(AuditService) private readonly auditService: AuditService,
	) {}

	/** 本人全部 ACTIVE Membership 对应组织（个人端点，不挂组织 Guard） */
	async listForUser(userId: string): Promise<
		Array<{
			id: string;
			name: string;
			role: string;
			baseCurrency: string | null;
			onboardingCompleted: boolean;
			createdAt: string;
		}>
	> {
		const memberships = await this.prisma.membership.findMany({
			where: { userId, status: "ACTIVE" },
			orderBy: { joinedAt: "asc" },
			select: {
				role: true,
				organization: {
					select: { id: true, name: true, createdAt: true },
				},
			},
		});
		const preferencesList = await Promise.all(
			memberships.map((m) =>
				resolveOrganizationPreferences(this.prisma, m.organization.id),
			),
		);
		return memberships.map((m, index) => ({
			id: m.organization.id,
			name: m.organization.name,
			role: m.role,
			// 建账态与本位币以组织偏好为准（OrganizationSettings 优先；默认组织兼容回落
			// 到所有者的个人设置——评审 I-08：用户新建的其他组织绝不回落）
			baseCurrency: preferencesList[index]?.baseCurrency ?? null,
			onboardingCompleted: preferencesList[index] !== null,
			createdAt: m.organization.createdAt.toISOString(),
		}));
	}

	/** 创建组织：org + OWNER/ACTIVE Membership + 空设置（待建账）+ 同事务审计（ORG-01.4/5） */
	async create(
		userId: string,
		input: { name: string },
		requestId?: string,
	): Promise<{ id: string; name: string; role: string; createdAt: string }> {
		const name = this.assertValidName(input.name);
		return this.prisma.$transaction(async (tx) => {
			const organization = await tx.organization.create({
				data: {
					name,
					memberships: {
						create: { userId, role: "OWNER", status: "ACTIVE" },
					},
				},
				select: { id: true, name: true, createdAt: true },
			});
			// 不创建 OrganizationSettings：新组织独立待建账，不复制其他组织数据（ORG-01.5）
			await this.auditService.recordInTx(tx, {
				organizationId: organization.id,
				actorUserId: userId,
				actorType: "USER",
				action: "organization.create",
				targetType: "organization",
				targetId: organization.id,
				result: "SUCCESS",
				requestId: requestId ?? null,
				detail: { name: organization.name },
			});
			return {
				id: organization.id,
				name: organization.name,
				role: "OWNER",
				createdAt: organization.createdAt.toISOString(),
			};
		});
	}

	/** 组织名称形状校验（评审 N-02：纯空白名在 DTO 层放行，服务层兜底拒绝） */
	private assertValidName(raw: string): string {
		const name = normalizeOrganizationName(raw);
		if (!isValidOrganizationName(name)) {
			throw new InvalidOrganizationNameException();
		}
		return name;
	}

	/**
	 * 当前组织详情 + capabilities + 组织锁 + 建账状态（organization.read）。
	 *
	 * 组织锁摘要优先复用 OrganizationLockGuard 挂到 request 上的结果
	 * （技术方案 §9.3：至多 1 条 data_requests 查询——守卫已查过，不再重复查库）；
	 * 缺省时才回落一次查询（守卫未挂载的调用路径）。
	 */
	async getCurrent(
		actor: ActorContext,
		lockSummary?: { active: boolean; type: string | null },
	): Promise<{
		id: string;
		name: string;
		role: string;
		capabilities: Record<string, boolean>;
		onboardingCompleted: boolean;
		baseCurrency: string | null;
		ledgerStartedAt: string | null;
		dataRequestLock: { active: boolean; type: string | null };
	}> {
		const organization = await this.prisma.organization.findUnique({
			where: { id: actor.organizationId },
			select: { id: true, name: true },
		});
		if (!organization) {
			throw new OrganizationNotFoundException();
		}
		// 建账态与本位币以组织偏好为准（评审 I-08：新建组织不回落创建者的个人设置）
		const preferences = await resolveOrganizationPreferences(
			this.prisma,
			actor.organizationId,
		);
		// 组织锁（只读摘要；技术方案 §9 / data-request-rules）：
		// 仅 CLEAR / DELETION 锁定组织账本（EXPORT 不锁写），进行中状态含 FAILED
		// （失败保锁态，ACTIVE_STATUSES 单一真源）——评审 I-14
		// 复用守卫的合并查询结果（评审 N-3）：同一请求至多 1 条 data_requests 查询
		const activeLock = lockSummary
			? lockSummary.active
				? { type: lockSummary.type }
				: null
			: await this.prisma.dataRequest.findFirst({
					where: {
						organizationId: actor.organizationId,
						scope: "ORGANIZATION",
						type: { in: ["CLEAR", "DELETION"] },
						status: { in: [...ACTIVE_STATUSES] },
					},
					orderBy: { requestedAt: "desc" },
					select: { type: true },
				});
		return {
			id: organization.id,
			name: organization.name,
			role: actor.role,
			capabilities: buildCapabilities(actor.role),
			onboardingCompleted: preferences !== null,
			baseCurrency: preferences?.baseCurrency ?? null,
			ledgerStartedAt:
				preferences?.ledgerStartedAt?.toISOString() ?? null,
			dataRequestLock: {
				active: Boolean(activeLock),
				type: activeLock?.type ?? null,
			},
		};
	}

	/** 改名（organization.update；同事务审计） */
	async update(
		actor: ActorContext,
		input: { name: string },
		requestId?: string,
	): Promise<{ id: string; name: string }> {
		const name = this.assertValidName(input.name);
		return this.prisma.$transaction(async (tx) => {
			// 取组织锁后重读操作者（评审 R3-N1）：请求在锁上等待期间，Guard 放行时所依据
			// 的角色可能已被并发的降权 / 移除改写。资格只用此刻的角色判定，不沿用
			// actor.role——已不是有效成员 → 404（lockOrganizationForActor），已无权限 → 403。
			// 与 updateRole / removeMember / invitation 同一纪律（R2-I01）
			const actorRole = await lockOrganizationForActor(tx, actor);
			if (!can(actorRole, "organization.update")) {
				throw new PermissionDeniedException();
			}
			const before = await tx.organization.findUnique({
				where: { id: actor.organizationId },
				select: { name: true },
			});
			if (!before) {
				throw new OrganizationNotFoundException();
			}
			const updated = await tx.organization.update({
				where: { id: actor.organizationId },
				data: { name },
				select: { id: true, name: true },
			});
			await this.auditService.recordInTx(tx, {
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				actorType: "USER",
				action: "organization.update",
				targetType: "organization",
				targetId: actor.organizationId,
				result: "SUCCESS",
				requestId: requestId ?? null,
				detail: { before: { name: before.name }, after: { name } },
			});
			return updated;
		});
	}
}
