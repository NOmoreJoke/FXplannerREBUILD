/**
 * 数据请求到期清理的事务内执行器（account-data 技术方案 §5/§6；ToB R1 技术方案 §9；Goal #3B W26 / Goal #3C W30）。
 *
 * 本文件只含「持有一个事务客户端」的执行逻辑，不依赖 Nest DI（单测直接在真实事务里
 * 调用）；决策全部来自 data-request-rules 纯函数。调用方（DataRequestService）负责
 * 事务边界、失败置 FAILED、提交后清理导出临时文件。
 *
 * 三类到期执行：
 * - PERSONAL DELETION：条件认领 → 锁定全部相关组织 → 锁内复验最后 Owner →
 *   清理个人域内容 → 回收本人离开后不再有成员的组织 → 删除身份。
 *   **绝不级联删除共享组织账本**：W30（MIG-E/F）后账本表与 `users` 已解绑
 *   （`created_by_id` / `actor_user_id` → ON DELETE SET NULL），删除用户只把作者
 *   置空、组织账本原样留存；组织删除走 `executeOrganizationRequest` 的显式事务清理。
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
import { resolveDefaultOrganizationId } from "../authorization/default-organization";
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
	/**
	 * 发起人（MIG-F：`data_requests.user_id` 更名 `requester_user_id` 并改
	 * ON DELETE SET NULL）。**可空**——发起人账号先被删掉时请求仍在库内。
	 */
	requesterUserId: string | null;
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
 * 组织维度共享账本行所在的组织（本人是成员）。
 *
 * W30（MIG-E/F）口径变更：共享账本表的 `user_id` 已删除，账本行**属于组织**而不再
 * 属于某个用户；作者信息留在 `created_by_id` / `actor_user_id`（ON DELETE SET NULL）。
 * 因此「本人在某组织持有需过户的共享行」不再是个人维度概念，取而代之的不变量是：
 * **组织持有账本数据时不得变成无成员的孤儿组织**。
 *
 * 判定口径：本人是成员的组织中，存在账本行（8 张共享账本表任一有行）或组织域数据
 * 请求的组织。org 无账本数据时本人离开只是少一个成员，组织由他人继续持有或走
 * 「回收孤儿组织」路径（见 deleteOrphanedOrganizations）。
 */
async function collectSharedOrganizationIds(
	tx: Tx,
	userId: string,
): Promise<string[]> {
	const rows = await tx.$queryRaw<Array<{ organizationId: string }>>`
		SELECT DISTINCT m.organization_id AS "organizationId"
		FROM memberships m
		WHERE m.user_id = ${userId}
			AND (
				EXISTS (SELECT 1 FROM accounts a WHERE a.organization_id = m.organization_id)
				OR EXISTS (SELECT 1 FROM transactions t WHERE t.organization_id = m.organization_id)
				OR EXISTS (SELECT 1 FROM initial_holdings h WHERE h.organization_id = m.organization_id)
				OR EXISTS (SELECT 1 FROM cost_lots l WHERE l.organization_id = m.organization_id)
				OR EXISTS (SELECT 1 FROM plans p WHERE p.organization_id = m.organization_id)
				OR EXISTS (SELECT 1 FROM usage_records u WHERE u.organization_id = m.organization_id)
				OR EXISTS (SELECT 1 FROM corrections c WHERE c.organization_id = m.organization_id)
				OR EXISTS (SELECT 1 FROM reminders r WHERE r.organization_id = m.organization_id)
				OR EXISTS (SELECT 1 FROM data_requests d WHERE d.organization_id = m.organization_id)
			)`;
	return rows.map((row) => row.organizationId);
}

/** 该组织是否仍持有账本数据（用于「回收孤儿组织」前的 fail-closed 断言） */
async function organizationHasLedgerRows(
	tx: Tx,
	organizationId: string,
): Promise<boolean> {
	const rows = await tx.$queryRaw<Array<{ n: bigint }>>`
		SELECT (
			(SELECT count(*) FROM accounts WHERE organization_id = ${organizationId})
			+ (SELECT count(*) FROM transactions WHERE organization_id = ${organizationId})
			+ (SELECT count(*) FROM initial_holdings WHERE organization_id = ${organizationId})
			+ (SELECT count(*) FROM cost_lots WHERE organization_id = ${organizationId})
			+ (SELECT count(*) FROM plans WHERE organization_id = ${organizationId})
			+ (SELECT count(*) FROM usage_records WHERE organization_id = ${organizationId})
			+ (SELECT count(*) FROM corrections WHERE organization_id = ${organizationId})
			+ (SELECT count(*) FROM reminders WHERE organization_id = ${organizationId})
		) AS n`;
	return Number(rows[0]?.n ?? 0n) > 0;
}

// ─────────────────────────────────────────────────────────────
// 归属快照
// ─────────────────────────────────────────────────────────────

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
 * 锁定与该用户相关的全部组织（成员关系所在组织 ∪ 持有账本数据的组织），按 ID 升序
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
 * 从 Prisma 生成客户端的 DMMF（schema.prisma 的运行时映像）推导全部**会级联删除行**的
 * 指向 User 的外键字段——新增带 User 外键的模型时自动纳入，无需手工登记；不拼任何 SQL。
 *
 * W30（MIG-E/F）：只统计 `onDelete: Cascade` 的关系。`ON DELETE SET NULL` 的作者列
 * （`created_by_id` / `actor_user_id` / `requester_user_id`）在删用户时**只置空**、
 * 不吞行——它们恰恰是「删除用户不误删企业账本」的保证，不该被断言拦下。
 */
export function userReferencesFromSchema(): UserReference[] {
	return Prisma.dmmf.datamodel.models.flatMap((model) =>
		model.fields
			.filter(
				(field) =>
					field.kind === "object" &&
					field.type === "User" &&
					(field.relationFromFields?.length ?? 0) > 0 &&
					field.relationOnDelete === "Cascade",
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
			// @org-scope-exempt: 个人账号注销前全库外键引用归零断言（countUserReferences 动态遍历 schema 模型）
			count: await delegate.count({ where: { [reference.field]: userId } }),
		});
	}
	return counts;
}

/**
 * 断言全库已无任何**会被级联删除**的指向该用户的行：让 `user.delete` **不依赖任何
 * 级联**。日后新增带 ON DELETE CASCADE 的业务表而漏改本文件时，删除会在此响亮失败
 * 并整体回滚，而不是把行静默级联吞掉。
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
			requesterUserId: userId,
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
 * 清理个人域内容：成员级已读态、AI 会话（级联 ai_messages）、个人域数据请求。
 *
 * W30（MIG-E/F）：共享账本表已无 `user_id`，也没有「organization_id IS NULL 存量行」
 * 这一形态——组织账本**永不属于个人域**，删除个人账号不触碰任何组织账本行。
 */
async function deletePersonalRows(
	tx: Tx,
	userId: string,
	stats: ClearStats,
): Promise<void> {
	add(stats, "reminderReads", (await tx.reminderRead.deleteMany({ where: { userId } })).count);
	// @org-scope-exempt: 个人账号注销按 userId 物理清理本人全部 AI 会话（会话个人所有，随账号删除）
	add(stats, "aiConversations", (await tx.aiConversation.deleteMany({ where: { userId } })).count);
	add(
		stats,
		"dataRequests",
		(
			await tx.dataRequest.deleteMany({
				where: { requesterUserId: userId, scope: "PERSONAL" },
			})
		).count,
	);
}

/**
 * 回收「本人离开后不再有任何成员」的组织。
 *
 * 有账本数据的组织在最后 Owner 判定阶段就已被阻塞（409），不会走到这里；此处的
 * 二次断言是 fail-closed 兜底：一旦发现仍有账本数据，宁可整单回滚，也不删掉一个
 * 还装着数据的组织（组织账本数据的删除权只属于组织域 CLEAR / DELETION）。
 */
async function deleteOrphanedOrganizations(
	tx: Tx,
	organizationIds: readonly string[],
	stats: ClearStats,
): Promise<void> {
	const uniqueOrgIds = [...new Set(organizationIds)];
	if (uniqueOrgIds.length === 0) return;

	const remainingMembers = await tx.membership.groupBy({
		by: ["organizationId"],
		where: { organizationId: { in: uniqueOrgIds } },
		_count: { _all: true },
	});
	const stillHasMembers = new Set(
		remainingMembers
			.filter((group) => group._count._all > 0)
			.map((group) => group.organizationId),
	);
	const orphanIds = uniqueOrgIds.filter((id) => !stillHasMembers.has(id));
	if (orphanIds.length === 0) return;

	for (const organizationId of orphanIds) {
		if (await organizationHasLedgerRows(tx, organizationId)) {
			throw new Error(
				`[data-request] 个人注销中止：组织 ${organizationId} 仍持有账本数据且已无成员（禁止删除个人账号使其成为孤儿组织）`,
			);
		}
	}

	add(
		stats,
		"orphanAgentProposals",
		(
			await tx.agentProposal.deleteMany({
				where: { organizationId: { in: orphanIds } },
			})
		).count,
	);
	add(
		stats,
		"orphanDataRequests",
		(
			await tx.dataRequest.deleteMany({
				where: { organizationId: { in: orphanIds } },
			})
		).count,
	);
	add(
		stats,
		"orphanAuditLogs",
		(await tx.auditLog.deleteMany({ where: { organizationId: { in: orphanIds } } }))
			.count,
	);
	// organization_settings / organization_invitations / ai_conversations 随组织
	// 级联删除（ON DELETE CASCADE）。
	add(
		stats,
		"orphanOrganizations",
		(await tx.organization.deleteMany({ where: { id: { in: orphanIds } } })).count,
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
	// 发起人账号已先被删除（requester_user_id 被置空）→ 无可执行的身份操作，作废。
	if (request.requesterUserId === null) {
		await tx.dataRequest.update({
			where: { id: request.id },
			data: { status: "CANCELLED" },
		});
		return { outcome: "cancelled", exportFilesToDelete: [], stats };
	}
	const userId = request.requesterUserId;

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

	// 3. 清理个人域内容（组织账本一律不动——账本属于组织，不属于个人）
	await deletePersonalRows(tx, userId, stats);

	// 4. 删除身份行：先显式删个人身份行 → 再删用户行（无任何级联发生）
	await tx.membership.deleteMany({ where: { userId } });
	await tx.otpIdentity.deleteMany({ where: { userId } });
	await tx.termsConsent.deleteMany({ where: { userId } });
	await tx.userSettings.deleteMany({ where: { userId } });

	// 5. 回收本人离开后不再有成员的组织（无账本数据；否则第 1 步已阻塞）
	await deleteOrphanedOrganizations(tx, organizationIds, stats);

	// 6. 断言零残留引用 → 删用户行
	await assertNoRemainingUserReferences(tx, userId);
	await tx.user.deleteMany({ where: { id: userId } });

	return { outcome: "user-deleted", exportFilesToDelete, stats };
}

// ─────────────────────────────────────────────────────────────
// ORGANIZATION CLEAR / DELETION
// ─────────────────────────────────────────────────────────────

/**
 * 组织账本作用域：当前组织的全部行。
 *
 * W30（MIG-E/F）：兼容窗口关闭后组织作用域唯一——`organization_id` 恒非空，
 * 不再有「默认组织创建者的存量 NULL 行」这一形态。导出、影响确认、清空、删除
 * 四处共用同一作用域。
 */
export type OrganizationLedgerScope = { organizationId: string };

export async function organizationLedgerScope(
	_tx: Pick<Tx, "$queryRaw">,
	organizationId: string,
): Promise<OrganizationLedgerScope> {
	return { organizationId };
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
	const ledgerWhere = { organizationId: scope.organizationId };
	const [plans, usages, lots] = await Promise.all([
		tx.plan.findMany({ where: ledgerWhere, select: { id: true } }),
		tx.usageRecord.findMany({ where: ledgerWhere, select: { id: true } }),
		tx.costLot.findMany({ where: ledgerWhere, select: { id: true } }),
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
			(
				await tx.planChangeLog.deleteMany({
					where: {
						planId: { in: planIds },
						organizationId: scope.organizationId,
					},
				})
			).count,
		);
	}
	add(stats, "plans", (await tx.plan.deleteMany({ where: ledgerWhere })).count);
	add(stats, "usageRecords", (await tx.usageRecord.deleteMany({ where: ledgerWhere })).count);
	add(stats, "corrections", (await tx.correction.deleteMany({ where: ledgerWhere })).count);
	add(stats, "reminders", (await tx.reminder.deleteMany({ where: ledgerWhere })).count);
	add(stats, "costLots", (await tx.costLot.deleteMany({ where: ledgerWhere })).count);
	add(stats, "transactions", (await tx.transaction.deleteMany({ where: ledgerWhere })).count);
	add(stats, "initialHoldings", (await tx.initialHolding.deleteMany({ where: ledgerWhere })).count);
	add(stats, "accounts", (await tx.account.deleteMany({ where: ledgerWhere })).count);
}

/**
 * 清空后重置记账起点：组织设置置 null（清空后的账本无起点）。
 *
 * W30（MIG-F）：个人设置已不再承载组织偏好（UserSettings 只剩 locale / region），
 * 无需再同步个人行的记账起点。
 */
async function resetLedgerStartedAt(tx: Tx, organizationId: string): Promise<void> {
	await tx.organizationSettings.updateMany({
		where: { organizationId },
		data: { ledgerStartedAt: null },
	});
}

/**
 * 组织锁内重读发起人资格（R2-I01：不沿用创建时的旧角色）：
 * 仍为 ACTIVE 成员且角色具备该请求所需权限点才返回角色，否则 null。
 */
async function lockAndResolveRequesterRole(
	tx: Tx,
	request: { organizationId: string; requesterUserId: string | null },
	type: "CLEAR" | "DELETION",
): Promise<OrganizationRole | null> {
	if (request.requesterUserId === null) return null;
	await lockOrganizationMembership(tx, request.organizationId);
	const requester = await tx.membership.findUnique({
		where: {
			organizationId_userId: {
				organizationId: request.organizationId,
				userId: request.requesterUserId,
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
				actorUserId: request.requesterUserId,
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

	// 2. 清空组织账本（当前组织的全部行；MIG-E 起账本表直连组织，ON DELETE RESTRICT）
	const ledgerScope = await organizationLedgerScope(tx, organizationId);
	await deleteOrganizationLedger(tx, ledgerScope, stats);

	if (type === "CLEAR") {
		await resetLedgerStartedAt(tx, organizationId);
		// W40：CLEAR 严禁删除 ledger_revisions 行（删账本触发器会单调续增），仅失效活跃 Agent 提案
		const invalidatedProposals = (
			await tx.agentProposal.updateMany({
				where: {
					organizationId,
					status: { in: ["PENDING", "STALE"] },
				},
				data: {
					status: "INVALIDATED",
					invalidReason: "ORGANIZATION_CLEARED",
					resolvedAt: ctx.now,
				},
			})
		).count;
		if (invalidatedProposals > 0) {
			add(stats, "invalidatedProposals", invalidatedProposals);
		}
		const executeAction = auditActionOf("ORGANIZATION", "CLEAR", "execute");
		if (executeAction) {
			await ctx.audit.recordInTx(tx, {
				organizationId,
				actorUserId: request.requesterUserId,
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
	const [organization] = await tx.organization.findMany({
		where: { id: organizationId },
		select: { name: true },
	});
	add(
		stats,
		"agentProposals",
		(await tx.agentProposal.deleteMany({ where: { organizationId } })).count,
	);
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
			actorUserId: request.requesterUserId,
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

/** 个人域默认组织解析（供导出 / 清理复用，保持与运行时同口径） */
export async function resolvePersonalDefaultOrganizationId(
	tx: Pick<Tx, "$queryRaw">,
	userId: string,
): Promise<string | null> {
	return resolveDefaultOrganizationId(tx, userId);
}
