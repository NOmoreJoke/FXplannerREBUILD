import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { sanitizeAuditDetail } from "./audit-sanitizer";

/**
 * 审计写入与只读查询（技术方案 §5.1 / §13.1 / AUDIT-01..03；Goal #3A W16）。
 *
 * 纪律：
 * - `recordInTx` 强制接收事务客户端，与业务写同事务提交/回滚（§13.1：
 *   审计写失败 = 业务写失败，不允许「业务已改但不知道谁改的」）；
 * - `recordStandalone` 仅用于纯读拒绝审计（如 Viewer 越权被拒 DENIED），
 *   严禁替代事务内审计；
 * - detail 一律经 sanitizeAuditDetail 脱敏后落库；
 * - 本服务不提供任何 update/delete（AUDIT-03.3 审计不可改）。
 */

export interface AuditEntryInput {
	organizationId: string;
	/** NULL = 系统动作 */
	actorUserId?: string | null;
	/** USER / API / AGENT */
	actorType: "USER" | "API" | "AGENT";
	action: string;
	targetType?: string | null;
	targetId?: string | null;
	/** SUCCESS / DENIED / FAILED */
	result: "SUCCESS" | "DENIED" | "FAILED";
	requestId?: string | null;
	agentRunId?: string | null;
	detail?: unknown;
}

function toCreateData(entry: AuditEntryInput): Prisma.AuditLogCreateInput {
	return {
		organizationId: entry.organizationId,
		actorUserId: entry.actorUserId ?? null,
		actorType: entry.actorType,
		action: entry.action,
		targetType: entry.targetType ?? null,
		targetId: entry.targetId ?? null,
		result: entry.result,
		requestId: entry.requestId ?? null,
		agentRunId: entry.agentRunId ?? null,
		detail: sanitizeAuditDetail(entry.detail ?? null) as Prisma.InputJsonValue,
	};
}

@Injectable()
export class AuditService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	/** 业务同事务审计写（§13.1：审计失败随业务事务一起回滚） */
	async recordInTx(
		tx: Prisma.TransactionClient,
		entry: AuditEntryInput,
	): Promise<void> {
		await tx.auditLog.create({ data: toCreateData(entry) });
	}

	/** 独立审计写：仅用于纯读路径的拒绝记录（DENIED），不得用于业务写路径 */
	async recordStandalone(entry: AuditEntryInput): Promise<void> {
		await this.prisma.auditLog.create({ data: toCreateData(entry) });
	}

	/** 只读分页查询（AUDIT-03：时间起止/成员/动作/结果筛选；createdAt desc 稳定序） */
	async listAuditLogs(
		organizationId: string,
		query: {
			page?: number;
			pageSize?: number;
			from?: string;
			to?: string;
			actorUserId?: string;
			action?: string;
			result?: string;
		},
	): Promise<{
		items: Array<{
			id: string;
			organizationId: string;
			actorUserId: string | null;
			actorType: string;
			action: string;
			targetType: string | null;
			targetId: string | null;
			result: string;
			requestId: string | null;
			agentRunId: string | null;
			detail: Record<string, unknown> | null;
			createdAt: string;
		}>;
		page: number;
		pageSize: number;
		total: number;
	}> {
		const page = query.page ?? 1;
		const pageSize = query.pageSize ?? 20;
		const where: Prisma.AuditLogWhereInput = {
			organizationId,
			...(query.from || query.to
				? {
						createdAt: {
							...(query.from ? { gte: new Date(query.from) } : {}),
							...(query.to ? { lte: new Date(query.to) } : {}),
						},
					}
				: {}),
			...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
			...(query.action ? { action: query.action } : {}),
			...(query.result ? { result: query.result } : {}),
		};
		const [rows, total] = await Promise.all([
			this.prisma.auditLog.findMany({
				where,
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			this.prisma.auditLog.count({ where }),
		]);
		return {
			items: rows.map((row) => ({
				id: row.id,
				organizationId: row.organizationId,
				actorUserId: row.actorUserId,
				actorType: row.actorType,
				action: row.action,
				targetType: row.targetType,
				targetId: row.targetId,
				result: row.result,
				requestId: row.requestId,
				agentRunId: row.agentRunId,
				detail:
					(row.detail as Record<string, unknown> | null | undefined) ?? null,
				createdAt: row.createdAt.toISOString(),
			})),
			page,
			pageSize,
			total,
		};
	}
}
