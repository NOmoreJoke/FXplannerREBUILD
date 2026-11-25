/**
 * 数据请求到期清理的事务内执行器（account-data 技术方案 §5/§6；ToB R1 技术方案 §9；Goal #3B W26）。
 *
 * 本文件只含「持有一个事务客户端」的执行逻辑，不依赖 Nest DI（单测直接在真实事务里
 * 调用）；决策全部来自 data-request-rules 纯函数。调用方（DataRequestService）负责
 * 事务边界、失败置 FAILED、提交后清理导出临时文件。
 *
 * 三类到期执行：
 * - PERSONAL DELETION：条件认领 → 锁定全部相关组织 → 锁内复验最后 Owner →
 *   共享组织行过户给同组织另一位 ACTIVE OWNER → 清理个人域行 → 删除身份。
 *   **绝不级联删除共享组织账本**：`User` 上仍有指向业务表的 ON DELETE CASCADE
 *   外键（解绑留待 Goal #3C MIG-E/F），因此过户走参数化原生 SQL 只改 user_id，删除
 *   身份前再断言「全库已无任何指向该用户的行」，任何遗漏表都令删除响亮失败而非被级联吞掉；
 * - ORGANIZATION CLEAR：条件认领 → 组织锁内复验发起人资格 → 清空当前组织账本 →
 *   重置记账起点 → 同事务审计 → COMPLETED；
 * - ORGANIZATION DELETION：同上资格复验 → 清空账本 → 删组织前统一清理该组织审计
 *   （保留最后一条删除留痕）→ 显式删除组织及其成员关系 / 邀请 / 设置，不删任何成员 User。
 *
 * 到期执行前的资格复验（锁内重读，不信任创建时的角色）：冷静期内发起人被降权 / 移除 /
 * 失去所有权时，不可逆清理不再具备授权 → 请求由系统作废（CANCELLED + DENIED 审计），
 * 而不是置 FAILED——FAILED 不可撤回，会把组织锁死在一个无人能化解的死局。
 */

import { Prisma } from "@prisma/client";
import {
	isOrganizationRole,
	type OrganizationRole,
} from "../authorization/authorization.types";
import { resolveDefaultOrganizationCreatorUserId } from "../authorization/default-organization";
import { can } from "../authorization/permission-policy";
import type { AuditService } from "../audit/audit.service";
import { lockOrganizationMembership } from "../organization/default-organization";
import {
	auditActionOf,
	resolveLastOwnerBlock,
	requiredPermission,
	type BlockingOrganization,
	type OwnershipSnapshot,
} from "./data-request-rules";
import { DataRequestLastOwnerRequiredException } from "./dto/data-request.dto";

type Tx = Prisma.TransactionClient;

/** 清空 / 注销 / 删除的行数统计（进度与审计日志用） */
export type ClearStats = Record<string, number>;

export type CleanupOutcome =
	/** 已被并发认领或已终结：本次不执行（幂等退出） */
	| "skipped"
	| "completed"
	/** 发起人资格在冷静期内失效：系统作废 */
	| "cancelled"
	| "user-deleted";

export interface CleanupResult {
	outcome: CleanupOutcome;
	/** 事务提交后需删除的导出临时文件名（best effort；回滚时调用方不得删除） */
	exportFilesToDelete: string[];
	stats: ClearStats;
}

/** 到期候选请求（守卫单次查询选出的行） */
export interface DueRequest {
	id: string;
	userId: string;
	scope: string;
	organizationId: string | null;
	type: string;
}

/** 审计写入（同事务；单测可注入故障验证整单回滚） */
export type AuditWriter = Pick<AuditService, "recordInTx">;

/** 可被认领的状态：到期推进（PENDING）与失败重试（FAILED） */
const CLAIMABLE_STATUSES = ["PENDING", "FAILED"] as const;

function add(stats: ClearStats, key: string, count: number): void {
	stats[key] = (stats[key] ?? 0) + count;
}

// ─────────────────────────────────────────────────────────────
// 并发条件认领（Goal #2 ④）
// ─────────────────────────────────────────────────────────────

/**
 * 条件原子认领：仅当请求仍处于 PENDING / FAILED 时置为 PROCESSING。
 * - `count === 1`：本事务认领成功，继续执行清理；
 * - `count === 0`：已被并发请求认领（行锁等待后按最新行版本重估 WHERE）或已终结，
 *   调用方立即幂等退出，不重复清理。
 * 认领与清理同事务：清理失败整体回滚，状态回到认领前，供下次读时重试。
 */
export async function claimForProcessing(
	tx: Tx,
	requestId: string,
): Promise<boolean> {
	const claimed = await tx.dataRequest.updateMany({
		where: { id: requestId, status: { in: [...CLAIMABLE_STATUSES] } },
		data: { status: "PROCESSING" },
	});
	return claimed.count === 1;
}

// ─────────────────────────────────────────────────────────────
// 归属快照（最后 Owner 判定的数据来源）
// ─────────────────────────────────────────────────────────────

/**
 * 本人在组织共享业务表中持有行的组织（organization_id 非空）。
 * 不含 ai_conversations：会话是成员个人内容，注销时随账号删除而非过户；
 * 不含 plan_change_logs：该表无 user_id（随父 Plan 存续）。
 */
async function collectSharedOrganizationIds(
	tx: Tx,
	userId: string,
): Promise<string[]> {
	const rows = await tx.$queryRaw<Array<{ organizationId: string }>>`
		SELECT organization_id AS "organizationId" FROM accounts
		WHERE user_id = ${userId} AND organization_id IS NOT NULL
		UNION SELECT organization_id FROM transactions
		WHERE user_id = ${userId} AND organization_id IS NOT NULL
		UNION SELECT organization_id FROM initial_holdings
		WHERE user_id = ${userId} AND organization_id IS NOT NULL
		UNION SELECT organization_id FROM cost_lots
		WHERE user_id = ${userId} AND organization_id IS NOT NULL
		UNION SELECT organization_id FROM plans
		WHERE user_id = ${userId} AND organization_id IS NOT NULL
		UNION SELECT organization_id FROM usage_records
		WHERE user_id = ${userId} AND organization_id IS NOT NULL
		UNION SELECT organization_id FROM corrections
		WHERE user_id = ${userId} AND organization_id IS NOT NULL
		UNION SELECT organization_id FROM reminders
		WHERE user_id = ${userId} AND organization_id IS NOT NULL
		UNION SELECT organization_id FROM data_requests
		WHERE user_id = ${userId} AND organization_id IS NOT NULL`;
	return rows.map((row) => row.organizationId);
}

/** 组织范围 where 片段（各业务模型的 WhereInput 均接受这两个字段） */
export type OrganizationLedgerScope =
	| { organizationId: string }
	| {
			OR: [
				{ organizationId: string },
				{ organizationId: null; userId: string },
			];
	  };

/**
 * 本人在一组组织中的所有权快照（锁内读出后交 resolveLastOwnerBlock 判定）。
 */
async function buildOwnershipSnapshot(
	tx: Tx,
	userId: string,
	organizationIds: readonly string[],
): Promise<OwnershipSnapshot[]> {
	if (organizationIds.length === 0) return [];
	const [memberships, organizations, ownerCounts, sharedOrganizationIds] =
		await Promise.all([
			tx.membership.findMany({
				where: { userId, organizationId: { in: [...organizationIds] } },
				select: { organizationId: true, role: true, status: true },
			}),
			tx.organization.findMany({
				where: { id: { in: [...organizationIds] } },
				select: { id: true, name: true },
			}),
			tx.membership.groupBy({
				by: ["organizationId"],
				where: {
					organizationId: { in: [...organizationIds] },
					role: "OWNER",
					status: "ACTIVE",
					userId: { not: userId },
				},
				_count: { _all: true },
			}),
			collectSharedOrganizationIds(tx, userId),
		]);
	const membershipByOrganization = new Map(
		memberships.map((membership) => [
			membership.organizationId,
			{ role: membership.role, status: membership.status },
		]),
	);
	const nameByOrganization = new Map(
		organizations.map((organization) => [organization.id, organization.name]),
	);
	const ownerCountByOrganization = new Map(
		ownerCounts.map((group) => [group.organizationId, group._count._all]),
	);
	const shared = new Set(sharedOrganizationIds);
	return [...new Set(organizationIds)]
		.sort()
		.map((organizationId) => ({
			organizationId,
			organizationName: nameByOrganization.get(organizationId) ?? organizationId,
			membership: membershipByOrganization.get(organizationId) ?? null,
			otherActiveOwnerCount: ownerCountByOrganization.get(organizationId) ?? 0,
			hasSharedRows: shared.has(organizationId),
		}));
}

/**
 * 创建阶段的最后 Owner 阻塞检查（无组织锁；到期执行时会在锁内重读复验）。
 */
export async function findLastOwnerBlocking(
	tx: Tx,
	userId: string,
): Promise<BlockingOrganization[]> {
	const memberships = await tx.membership.findMany({
		where: { userId },
		select: { organizationId: true },
	});
	return resolveLastOwnerBlock(
		await buildOwnershipSnapshot(
			tx,
			userId,
			memberships.map((membership) => membership.organizationId),
		),
	);
}

/**
 * 锁定与该用户相关的全部组织（成员关系所在组织 ∪ 持有共享行的组织），按 ID 升序
 * 逐一取成员关系锁——统一升序避免两个注销事务互相等待。锁后重读：等待锁期间新加入
 * 的组织继续加锁；每轮至少锁住一个新组织，循环必然终止。返回锁定的组织 ID（升序）。
 */
async function lockRelatedOrganizations(
	tx: Tx,
	userId: string,
): Promise<string[]> {
	const locked = new Set<string>();
	for (;;) {
		const [memberships, sharedOrganizationIds] = await Promise.all([
			tx.membership.findMany({
				where: { userId },
				select: { organizationId: true },
			}),
			collectSharedOrganizationIds(tx, userId),
		]);
		const pending = [
			...new Set([
				...memberships.map((membership) => membership.organizationId),
				...sharedOrganizationIds,
			]),
		]
			.filter((organizationId) => !locked.has(organizationId))
			.sort();
		if (pending.length === 0) break;
		for (const organizationId of pending) {
			await lockOrganizationMembership(tx, organizationId);
			locked.add(organizationId);
		}
	}
	return [...locked].sort();
}

// ─────────────────────────────────────────────────────────────
// 零残留引用断言（防 ON DELETE CASCADE 静默吞掉共享账本）
// ─────────────────────────────────────────────────────────────

/** 指向 User 的外键字段（模型名 + 外键标量字段名） */
export interface UserReference {
	model: string;
	field: string;
}

/**
 * 从 Prisma 生成客户端的 DMMF（schema.prisma 的运行时映像）推导全部指向 User 的外键
 * 字段——新增带 User 外键的模型时自动纳入，无需手工登记；不拼任何 SQL。
 */
export function userReferencesFromSchema(): UserReference[] {
	return Prisma.dmmf.datamodel.models.flatMap((model) =>
		model.fields
			.filter(
				(field) =>
					field.kind === "object" &&
					field.type === "User" &&
					(field.relationFromFields?.length ?? 0) > 0,
			)
			.map((field) => ({
				model: model.name,
				field: field.relationFromFields?.[0] ?? "",
			})),
	);
}

/**
 * 各 User 外键表中对某用户的逐表计数（经类型化 Prisma 委托的参数化 count）。
 */
export async function countUserReferences(
	tx: Tx,
	userId: string,
): Promise<Array<UserReference & { count: number }>> {
	const counts: Array<UserReference & { count: number }> = [];
	for (const reference of userReferencesFromSchema()) {
		const delegate = tx[
			`${reference.model[0]?.toLowerCase()}${reference.model.slice(1)}` as keyof typeof tx
		] as unknown as {
			count(args: { where: Record<string, string> }): Promise<number>;
		};
		counts.push({
			...reference,
			count: await delegate.count({ where: { [reference.field]: userId } }),
		});
	}
	return counts;
}

/**
 * 断言全库已无任何指向该用户的行：让 `user.delete` **不依赖任何级联**。
 * 日后新增带 ON DELETE CASCADE 的业务表而漏改本文件时，删除会在此响亮失败并整体
 * 回滚，而不是把行静默级联吞掉。
 */
export async function assertNoRemainingUserReferences(
	tx: Tx,
	userId: string,
): Promise<void> {
	const remaining = (await countUserReferences(tx, userId)).filter(
		(reference) => reference.count > 0,
	);
	if (remaining.length > 0) {
		throw new Error(
			`[data-request] 个人注销中止：仍存在指向该用户的行（禁止依赖级联删除）: ${remaining
				.map((reference) => `${reference.model}.${reference.field}`)
				.join(", ")}`,
		);
	}
}

// ─────────────────────────────────────────────────────────────
// PERSONAL DELETION
// ─────────────────────────────────────────────────────────────

/** 关闭本人仍可下载的导出链接（事务内置过期），返回待删除的临时文件名 */
async function closeExportLinks(
	tx: Tx,
	userId: string,
	now: Date,
): Promise<string[]> {
	const downloadable = await tx.dataRequest.findMany({
		where: {
			userId,
			type: "EXPORT",
			status: "COMPLETED",
			downloadExpiresAt: { gt: now },
		},
		select: { id: true, fileUrl: true },
	});
	if (downloadable.length === 0) return [];
	await tx.dataRequest.updateMany({
		where: { id: { in: downloadable.map((row) => row.id) } },
		data: { downloadExpiresAt: now },
	});
	return downloadable.flatMap((row) => (row.fileUrl ? [row.fileUrl] : []));
}

/**
 * 共享组织行过户：把本人在各组织内 `organization_id` 非空的行的 user_id 改为该组织
 * 另一位 ACTIVE OWNER（加入时间最早者，确定性）。原生 SQL 只写 user_id——Prisma 的
 * updateMany 会经 @updatedAt 改写 updated_at。**不修改** created_by_id / actor_user_id /
 * updated_at（创建者与操作者审计快照必须保留）。
 * 提醒行同时清空行内 read_at：该列只对行主生效（reminder.service 的存量回退），
 * 不清会让接任者继承本人的已读态而漏看提醒；接任者自己的 ReminderRead 不受影响。
 */
async function transferSharedRowsToOwners(
	tx: Tx,
	userId: string,
	stats: ClearStats,
): Promise<void> {
	const organizationIds = [
		...new Set(await collectSharedOrganizationIds(tx, userId)),
	].sort();
	for (const organizationId of organizationIds) {
		const [owner] = await tx.membership.findMany({
			where: {
				organizationId,
				role: "OWNER",
				status: "ACTIVE",
				userId: { not: userId },
			},
			orderBy: [{ joinedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
			take: 1,
			select: { userId: true },
		});
		if (!owner) {
			// 锁内复验已通过却找不到接任者：不可解释的状态，宁可失败也不删共享账本
			throw new Error(
				`[data-request] 个人注销过户失败：组织 ${organizationId} 无其他 ACTIVE OWNER 可接任`,
			);
		}
		const newOwnerUserId = owner.userId;
		add(
			stats,
			"transferredAccounts",
			Number(
				await tx.$executeRaw`UPDATE accounts SET user_id = ${newOwnerUserId}
					WHERE organization_id = ${organizationId} AND user_id = ${userId}`,
			),
		);
		add(
			stats,
			"transferredTransactions",
			Number(
				await tx.$executeRaw`UPDATE transactions SET user_id = ${newOwnerUserId}
					WHERE organization_id = ${organizationId} AND user_id = ${userId}`,
			),
		);
		add(
			stats,
			"transferredInitialHoldings",
			Number(
				await tx.$executeRaw`UPDATE initial_holdings SET user_id = ${newOwnerUserId}
					WHERE organization_id = ${organizationId} AND user_id = ${userId}`,
			),
		);
		add(
			stats,
			"transferredCostLots",
			Number(
				await tx.$executeRaw`UPDATE cost_lots SET user_id = ${newOwnerUserId}
					WHERE organization_id = ${organizationId} AND user_id = ${userId}`,
			),
		);
		add(
			stats,
			"transferredPlans",
			Number(
				await tx.$executeRaw`UPDATE plans SET user_id = ${newOwnerUserId}
					WHERE organization_id = ${organizationId} AND user_id = ${userId}`,
			),
		);
		add(
			stats,
			"transferredUsageRecords",
			Number(
				await tx.$executeRaw`UPDATE usage_records SET user_id = ${newOwnerUserId}
					WHERE organization_id = ${organizationId} AND user_id = ${userId}`,
			),
		);
		add(
			stats,
			"transferredCorrections",
			Number(
				await tx.$executeRaw`UPDATE corrections SET user_id = ${newOwnerUserId}
					WHERE organization_id = ${organizationId} AND user_id = ${userId}`,
			),
		);
		add(
			stats,
			"transferredReminders",
			Number(
				await tx.$executeRaw`UPDATE reminders SET user_id = ${newOwnerUserId}, read_at = NULL
					WHERE organization_id = ${organizationId} AND user_id = ${userId}`,
			),
		);
		add(
			stats,
			"transferredDataRequests",
			Number(
				await tx.$executeRaw`UPDATE data_requests SET user_id = ${newOwnerUserId}
					WHERE organization_id = ${organizationId} AND user_id = ${userId}`,
			),
		);
	}
}

/**
 * 清理个人域行：本人 `organization_id IS NULL` 的遗留业务行（兼容窗口存量，逻辑上
 * 属个人域，随账号删除）+ 本人个人内容（AI 会话、成员级已读态、个人数据请求）。
 * 裸外键子表先删（usage_lot_allocations / plan_allocations 不依赖数据库级联）。
 */
async function deletePersonalRows(
	tx: Tx,
	userId: string,
	stats: ClearStats,
): Promise<void> {
	const legacyScope = { userId, organizationId: null };
	const [plans, usages, lots] = await Promise.all([
		tx.plan.findMany({ where: legacyScope, select: { id: true } }),
		tx.usageRecord.findMany({ where: legacyScope, select: { id: true } }),
		tx.costLot.findMany({ where: legacyScope, select: { id: true } }),
	]);
	const planIds = plans.map((plan) => plan.id);
	const usageIds = usages.map((usage) => usage.id);
	const lotIds = lots.map((lot) => lot.id);

	if (usageIds.length > 0 || lotIds.length > 0) {
		add(
			stats,
			"usageLotAllocations",
			(
				await tx.usageLotAllocation.deleteMany({
					where: {
						OR: [
							...(usageIds.length > 0 ? [{ usageId: { in: usageIds } }] : []),
							...(lotIds.length > 0 ? [{ lotId: { in: lotIds } }] : []),
						],
					},
				})
			).count,
		);
	}
	if (planIds.length > 0) {
		add(
			stats,
			"planAllocations",
			(await tx.planAllocation.deleteMany({ where: { planId: { in: planIds } } }))
				.count,
		);
		add(
			stats,
			"planChangeLogs",
			(await tx.planChangeLog.deleteMany({ where: { planId: { in: planIds } } }))
				.count,
		);
	}
	// plans 级联 plan_installments（数据库外键）；其余显式删以统计行数
	add(stats, "plans", (await tx.plan.deleteMany({ where: legacyScope })).count);
	add(stats, "usageRecords", (await tx.usageRecord.deleteMany({ where: legacyScope })).count);
	add(stats, "corrections", (await tx.correction.deleteMany({ where: legacyScope })).count);
	add(stats, "reminders", (await tx.reminder.deleteMany({ where: legacyScope })).count);
	add(stats, "reminderReads", (await tx.reminderRead.deleteMany({ where: { userId } })).count);
	add(stats, "costLots", (await tx.costLot.deleteMany({ where: legacyScope })).count);
	add(stats, "transactions", (await tx.transaction.deleteMany({ where: legacyScope })).count);
	add(stats, "initialHoldings", (await tx.initialHolding.deleteMany({ where: legacyScope })).count);
	add(stats, "accounts", (await tx.account.deleteMany({ where: legacyScope })).count);
	// 个人内容：会话级联 ai_messages
	add(stats, "aiConversations", (await tx.aiConversation.deleteMany({ where: { userId } })).count);
	add(
		stats,
		"dataRequests",
		(await tx.dataRequest.deleteMany({ where: { userId, organizationId: null } })).count,
	);
}

/**
 * PERSONAL DELETION 到期执行（事务内）。命中最后 Owner 时抛 409
 * LAST_OWNER_REQUIRED（调用方回滚并处置），绝不删除任何组织账本行。
 */
export async function executePersonalDeletion(
	tx: Tx,
	request: DueRequest,
	ctx: { now: Date },
): Promise<CleanupResult> {
	const stats: ClearStats = {};
	if (!(await claimForProcessing(tx, request.id))) {
		return { outcome: "skipped", exportFilesToDelete: [], stats };
	}
	const userId = request.userId;

	// 1. 锁定全部相关组织（升序），锁内重读并复验最后 Owner——防「检查后、删除前
	//    另一位所有者退出 / 被移除」的并发转移竞态
	const organizationIds = await lockRelatedOrganizations(tx, userId);
	const blocking = resolveLastOwnerBlock(
		await buildOwnershipSnapshot(tx, userId, organizationIds),
	);
	if (blocking.length > 0) {
		throw new DataRequestLastOwnerRequiredException(blocking);
	}

	// 2. 关闭本人导出链接（文件在事务提交后删除）
	const exportFilesToDelete = await closeExportLinks(tx, userId, ctx.now);

	// 3. 共享组织行过户给各组织的另一位 ACTIVE OWNER
	await transferSharedRowsToOwners(tx, userId, stats);

	// 4. 个人域行清理
	await deletePersonalRows(tx, userId, stats);

	// 5. 删除身份：先显式删个人身份行 → 断言零残留引用 → 删用户行（无任何级联发生）
	await tx.membership.deleteMany({ where: { userId } });
	await tx.otpIdentity.deleteMany({ where: { userId } });
	await tx.termsConsent.deleteMany({ where: { userId } });
	await tx.userSettings.deleteMany({ where: { userId } });
	await assertNoRemainingUserReferences(tx, userId);
	await tx.user.deleteMany({ where: { id: userId } });

	return { outcome: "user-deleted", exportFilesToDelete, stats };
}

// ─────────────────────────────────────────────────────────────
// ORGANIZATION CLEAR / DELETION
// ─────────────────────────────────────────────────────────────

/**
 * 组织账本作用域：当前组织的全部行 + 其「默认工作台创建者」尚未迁入组织的存量 NULL 行
 * （compatReadWhere / planReservationWhere 同口径：这些行逻辑上属于本组织，只跟创建者走，
 * 绝不波及其他成员或其他组织）。非默认组织（无默认创建者）只含本组织行。
 * 导出、影响确认、清空、删除四处共用同一作用域。
 */
export async function organizationLedgerScope(
	tx: Pick<Tx, "$queryRaw">,
	organizationId: string,
): Promise<OrganizationLedgerScope> {
	const creatorUserId = await resolveDefaultOrganizationCreatorUserId(
		tx,
		organizationId,
	);
	if (!creatorUserId) return { organizationId };
	return {
		OR: [{ organizationId }, { organizationId: null, userId: creatorUserId }],
	};
}

/**
 * 清空组织账本（单事务、显式按序，失败整体回滚）：裸外键子表先删 → 计划（级联
 * plan_installments）→ 使用/更正/提醒（级联 reminder_reads）→ 批次/交易/持仓/账户。
 * 保留：成员与成员关系、组织设置（除记账起点）、AI 会话、审计、数据请求。
 */
async function deleteOrganizationLedger(
	tx: Tx,
	scope: OrganizationLedgerScope,
	stats: ClearStats,
): Promise<void> {
	const [plans, usages, lots] = await Promise.all([
		tx.plan.findMany({ where: scope, select: { id: true } }),
		tx.usageRecord.findMany({ where: scope, select: { id: true } }),
		tx.costLot.findMany({ where: scope, select: { id: true } }),
	]);
	const planIds = plans.map((plan) => plan.id);
	const usageIds = usages.map((usage) => usage.id);
	const lotIds = lots.map((lot) => lot.id);

	if (usageIds.length > 0 || lotIds.length > 0) {
		add(
			stats,
			"usageLotAllocations",
			(
				await tx.usageLotAllocation.deleteMany({
					where: {
						OR: [
							...(usageIds.length > 0 ? [{ usageId: { in: usageIds } }] : []),
							...(lotIds.length > 0 ? [{ lotId: { in: lotIds } }] : []),
						],
					},
				})
			).count,
		);
	}
	if (planIds.length > 0) {
		add(
			stats,
			"planAllocations",
			(await tx.planAllocation.deleteMany({ where: { planId: { in: planIds } } }))
				.count,
		);
		add(
			stats,
			"planChangeLogs",
			(await tx.planChangeLog.deleteMany({ where: { planId: { in: planIds } } }))
				.count,
		);
	}
	add(stats, "plans", (await tx.plan.deleteMany({ where: scope })).count);
	add(stats, "usageRecords", (await tx.usageRecord.deleteMany({ where: scope })).count);
	add(stats, "corrections", (await tx.correction.deleteMany({ where: scope })).count);
	add(stats, "reminders", (await tx.reminder.deleteMany({ where: scope })).count);
	add(stats, "costLots", (await tx.costLot.deleteMany({ where: scope })).count);
	add(stats, "transactions", (await tx.transaction.deleteMany({ where: scope })).count);
	add(stats, "initialHoldings", (await tx.initialHolding.deleteMany({ where: scope })).count);
	add(stats, "accounts", (await tx.account.deleteMany({ where: scope })).count);
}

/**
 * 清空后重置记账起点：组织设置置 null（清空后的账本无起点）；组织的偏好仍由默认组织
 * 创建者的个人设置兼容回落支撑时（或有非占位个人设置行），同步置 null 保持一致。
 */
async function resetLedgerStartedAt(tx: Tx, organizationId: string): Promise<void> {
	await tx.organizationSettings.updateMany({
		where: { organizationId },
		data: { ledgerStartedAt: null },
	});
	const creatorUserId = await resolveDefaultOrganizationCreatorUserId(
		tx,
		organizationId,
	);
	if (!creatorUserId) return;
	const legacy = await tx.userSettings.findUnique({
		where: { userId: creatorUserId },
		select: { baseCurrency: true },
	});
	if (legacy && legacy.baseCurrency.trim() !== "") {
		await tx.userSettings.update({
			where: { userId: creatorUserId },
			data: { ledgerStartedAt: null },
		});
	}
}

/**
 * 组织锁内重读发起人资格（R2-I01：不沿用创建时的旧角色）：
 * 仍为 ACTIVE 成员且角色具备该请求所需权限点才返回角色，否则 null。
 */
async function lockAndResolveRequesterRole(
	tx: Tx,
	request: { organizationId: string; userId: string },
	type: "CLEAR" | "DELETION",
): Promise<OrganizationRole | null> {
	await lockOrganizationMembership(tx, request.organizationId);
	const requester = await tx.membership.findUnique({
		where: {
			organizationId_userId: {
				organizationId: request.organizationId,
				userId: request.userId,
			},
		},
		select: { role: true, status: true },
	});
	if (!requester || requester.status !== "ACTIVE") return null;
	if (!isOrganizationRole(requester.role)) return null;
	const permission = requiredPermission("ORGANIZATION", type);
	if (!permission || !can(requester.role, permission)) return null;
	return requester.role;
}

/** ORGANIZATION CLEAR / DELETION 到期执行（事务内） */
export async function executeOrganizationRequest(
	tx: Tx,
	request: DueRequest & { organizationId: string },
	ctx: { now: Date; audit: AuditWriter },
): Promise<CleanupResult> {
	const stats: ClearStats = {};
	if (!(await claimForProcessing(tx, request.id))) {
		return { outcome: "skipped", exportFilesToDelete: [], stats };
	}
	const organizationId = request.organizationId;
	if (
		request.scope !== "ORGANIZATION" ||
		(request.type !== "CLEAR" && request.type !== "DELETION")
	) {
		// 到期执行只对组织域 CLEAR / DELETION 有定义（EXPORT 同步生成；scope×type 由 DB CHECK 兜底）
		throw new Error(
			`[data-request] 非法的组织域到期请求 id=${request.id} scope=${request.scope} type=${request.type}`,
		);
	}
	const type = request.type as "CLEAR" | "DELETION";

	// 1. 组织锁内复验发起人资格
	const role = await lockAndResolveRequesterRole(tx, request, type);
	const cancelAction = auditActionOf("ORGANIZATION", type, "cancel");
	if (!role) {
		await tx.dataRequest.update({
			where: { id: request.id },
			data: { status: "CANCELLED" },
		});
		if (cancelAction) {
			await ctx.audit.recordInTx(tx, {
				organizationId,
				actorUserId: request.userId,
				actorType: "USER",
				action: cancelAction,
				targetType: "data_request",
				targetId: request.id,
				result: "DENIED",
				detail: { reason: "REQUESTER_NOT_AUTHORIZED" },
			});
		}
		return { outcome: "cancelled", exportFilesToDelete: [], stats };
	}

	// 2. 清空组织账本（当前组织 + 其默认创建者的存量 NULL 行）
	const ledgerScope = await organizationLedgerScope(tx, organizationId);
	await deleteOrganizationLedger(tx, ledgerScope, stats);

	if (type === "CLEAR") {
		await resetLedgerStartedAt(tx, organizationId);
		const executeAction = auditActionOf("ORGANIZATION", "CLEAR", "execute");
		if (executeAction) {
			await ctx.audit.recordInTx(tx, {
				organizationId,
				actorUserId: request.userId,
				actorType: "USER",
				action: executeAction,
				targetType: "data_request",
				targetId: request.id,
				result: "SUCCESS",
				detail: { rows: stats, role },
			});
		}
		await tx.dataRequest.update({
			where: { id: request.id },
			data: { status: "COMPLETED", processedAt: ctx.now },
		});
		return { outcome: "completed", exportFilesToDelete: [], stats };
	}

	// 3. ORGANIZATION DELETION：清空 → 删组织前统一清理审计 → 显式删除组织及其全部从属行
	//    创建者的存量 NULL 会话逻辑上属本组织：组织删除后其「默认组织」会漂移到创建者的
	//    下一个组织，这些会话不得跟着漂移过去，随本组织一并删除
	const creatorUserId = await resolveDefaultOrganizationCreatorUserId(
		tx,
		organizationId,
	);
	if (creatorUserId) {
		add(
			stats,
			"legacyAiConversations",
			(
				await tx.aiConversation.deleteMany({
					where: { organizationId: null, userId: creatorUserId },
				})
			).count,
		);
	}
	const [organization] = await tx.organization.findMany({
		where: { id: organizationId },
		select: { name: true },
	});
	add(
		stats,
		"aiConversations",
		(await tx.aiConversation.deleteMany({ where: { organizationId } })).count,
	);
	add(
		stats,
		"dataRequests",
		(await tx.dataRequest.deleteMany({ where: { organizationId } })).count,
	);
	add(
		stats,
		"invitations",
		(await tx.organizationInvitation.deleteMany({ where: { organizationId } })).count,
	);
	add(
		stats,
		"auditLogs",
		(await tx.auditLog.deleteMany({ where: { organizationId } })).count,
	);
	add(
		stats,
		"memberships",
		(await tx.membership.deleteMany({ where: { organizationId } })).count,
	);
	add(
		stats,
		"organizationSettings",
		(await tx.organizationSettings.deleteMany({ where: { organizationId } })).count,
	);
	add(
		stats,
		"organizations",
		(await tx.organization.deleteMany({ where: { id: organizationId } })).count,
	);

	// 删除留痕：既有审计已随组织清理，这是该组织唯一留存的一条记录
	const executeAction = auditActionOf("ORGANIZATION", "DELETION", "execute");
	if (executeAction) {
		await ctx.audit.recordInTx(tx, {
			organizationId,
			actorUserId: request.userId,
			actorType: "USER",
			action: executeAction,
			targetType: "organization",
			targetId: organizationId,
			result: "SUCCESS",
			detail: {
				organizationName: organization?.name ?? organizationId,
				rows: stats,
				role,
			},
		});
	}
	return { outcome: "completed", exportFilesToDelete: [], stats };
}
