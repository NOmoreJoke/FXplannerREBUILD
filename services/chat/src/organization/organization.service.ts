import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { ActorContext } from "../authorization/authorization.types";
import {
	buildCapabilities,
	normalizeOrganizationName,
} from "./organization-rules";
import { OrganizationNotFoundException } from "../authorization/authorization.errors";

/**
 * 组织与当前组织视图服务（技术方案 §7.2；Goal #3A W17）。
 *
 * 职责：
 * - 个人端点：GET /organizations（本人有效组织）、POST /organizations
 *   （创建组织 + OWNER Membership + 空设置待建账 + 同事务审计，ORG-01.4/5）；
 * - 组织上下文端点：GET/PATCH /organizations/current（经 Guard 链鉴权后消费
 *   ActorContext，组织读取本身即限定 organizationId，§4.4.5）；
 * - 新用户注册的默认组织自动创建属 W22 兼容窗口收口项（GOAL-3A W17.4）：
 *   本期不触碰注册路径，见 Goal #3B。
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
			createdAt: Date;
		}>
	> {
		const memberships = await this.prisma.membership.findMany({
			where: { userId, status: "ACTIVE" },
			orderBy: { joinedAt: "asc" },
			select: {
				role: true,
				organization: {
					select: {
						id: true,
						name: true,
						createdAt: true,
						settings: {
							select: {
								baseCurrency: true,
								ledgerStartedAt: true,
							},
						},
					},
				},
			},
		});
		return memberships.map((m) => ({
			id: m.organization.id,
			name: m.organization.name,
			role: m.role,
			baseCurrency: m.organization.settings?.baseCurrency ?? null,
			onboardingCompleted: Boolean(m.organization.settings?.ledgerStartedAt),
			createdAt: m.organization.createdAt,
		}));
	}

	/** 创建组织：org + OWNER/ACTIVE Membership + 空设置（待建账）+ 同事务审计（ORG-01.4/5） */
	async create(
		userId: string,
		input: { name: string },
		requestId?: string,
	): Promise<{ id: string; name: string; role: string }> {
		const name = normalizeOrganizationName(input.name);
		return this.prisma.$transaction(async (tx) => {
			const organization = await tx.organization.create({
				data: {
					name,
					memberships: {
						create: { userId, role: "OWNER", status: "ACTIVE" },
					},
				},
				select: { id: true, name: true },
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
			return { id: organization.id, name: organization.name, role: "OWNER" };
		});
	}

	/** 当前组织详情 + capabilities + 组织锁 + 建账状态（organization.read） */
	async getCurrent(actor: ActorContext): Promise<{
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
			select: {
				id: true,
				name: true,
				settings: { select: { baseCurrency: true, ledgerStartedAt: true } },
			},
		});
		if (!organization) {
			throw new OrganizationNotFoundException();
		}
		// 组织锁（Goal #3B 拆分后的组织数据请求状态；此处只读摘要）
		const activeLock = await this.prisma.dataRequest.findFirst({
			where: {
				organizationId: actor.organizationId,
				scope: "ORGANIZATION",
				status: { in: ["PENDING", "PROCESSING"] },
			},
			select: { type: true },
		});
		return {
			id: organization.id,
			name: organization.name,
			role: actor.role,
			capabilities: buildCapabilities(actor.role),
			onboardingCompleted: Boolean(organization.settings?.ledgerStartedAt),
			baseCurrency: organization.settings?.baseCurrency ?? null,
			ledgerStartedAt:
				organization.settings?.ledgerStartedAt?.toISOString() ?? null,
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
		const name = normalizeOrganizationName(input.name);
		return this.prisma.$transaction(async (tx) => {
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
