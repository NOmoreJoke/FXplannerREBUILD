/**
 * MIG-B 默认组织幂等回填（技术方案 §12.2；Goal #3A W15；评审 I-15 加固）。
 *
 * 职责边界：
 * - 仅做「存量个人数据 → 默认组织」的一次性回填，幂等可重复执行；
 * - 不删除、不禁用任何 userId 读路径（兼容窗口在 Goal #3B 收口）；
 * - 金额、ID、版本、时间戳一律不改（§12.2.6）——因此业务行用原生 UPDATE 只写
 *   租户列，绕开 Prisma `@updatedAt` 自动改写 `updated_at`；
 * - 孤儿/父子缺失预检失败即抛错阻断，绝不静默归组（§12.2.5）。
 *
 * 执行模型：全库只读预检 → 按用户分片、每片一个事务（默认 50 用户/片，显式
 * 超时）。分片间不共享事务：某片失败只回滚该片，已提交的分片保持有效；因为
 * 每一步都幂等（仅更新 organizationId IS NULL 的行、设置/已读行跳过重复），
 * 修复问题后重跑即续跑，不会重复建组或覆盖数据。全库单事务在生产数据量下会
 * 超出交互式事务超时，已弃用。
 *
 * 复用方式：integration 测试直接调用本模块函数；CLI 入口见
 * prisma/tob-r1-migration/backfill.ts（dry-run 默认，--apply 需双旗标确认）。
 */

import type { PrismaClient, Prisma } from "@prisma/client";
import { resolveDefaultOrganizationId } from "../authorization/default-organization";
import { defaultOrganizationName } from "./default-organization";

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

/** 回填执行摘要（CLI 以 JSON 输出；测试断言计数） */
export interface BackfillSummary {
	/** 本次实际处理的用户数（含幂等跳过） */
	usersProcessed: number;
	/** 新建组织数（幂等重跑为 0） */
	organizationsCreated: number;
	/** 新建 OWNER Membership 数（幂等重跑为 0） */
	ownerMembershipsCreated: number;
	/** 新建 OrganizationSettings 数（无 UserSettings 的用户不虚构） */
	organizationSettingsCreated: number;
	/** 各表回填行数（仅 organizationId IS NULL 的行） */
	rowsBackfilled: {
		accounts: number;
		transactions: number;
		initialHoldings: number;
		costLots: number;
		plans: number;
		usageRecords: number;
		corrections: number;
		reminders: number;
		aiConversations: number;
		planChangeLogs: number;
	};
	/** 新建 ReminderRead 行数 */
	reminderReadsCreated: number;
	/** DataRequest 语义映射行数（仅未挂组织的存量行） */
	dataRequestsRescoped: number;
	/** 已有 OWNER Membership 而幂等跳过建组的用户数 */
	usersSkippedIdempotent: number;
	/** 已提交的事务分片数 */
	chunksCommitted: number;
}

export interface BackfillOptions {
	dryRun?: boolean;
	/** 仅处理指定用户（测试/演练分片）；缺省全量 */
	userIds?: string[];
	/** 每个事务处理的用户数（默认 50） */
	chunkSize?: number;
}

/** 默认分片大小：每用户约 16 条语句，50 用户/片在百毫秒~秒级完成 */
export const BACKFILL_CHUNK_SIZE = 50;
/** 分片事务参数：显式超时，不依赖 PrismaClient 的默认值（交互式事务默认仅 5s） */
const CHUNK_TX_OPTIONS = { maxWait: 30_000, timeout: 180_000 };

/** 孤儿/父子缺失阻断错误（details 携带各表孤儿计数，绝不静默归组） */
export class BackfillAnomalyError extends Error {
	constructor(
		message: string,
		readonly details: Record<string, number>,
	) {
		super(message);
		this.name = "BackfillAnomalyError";
	}
}

/**
 * MIG-B 写入的生产目标拒绝（技术方案 §12.4「生产执行不由 AI 自动进行」）：
 * 连接串库名含 fxplanner_prod（**大小写不敏感**，评审 I-15）或运行环境为
 * production 即判为生产。任一命中即拒绝——拒绝判定宁可误伤
 * （如 FXPLANNER_PROD_BAK、fxplanner_prod_backup），不可漏放。
 * 只读的 verify 不受此限（停写窗口内的人工核对需要它）。
 */
export function isProductionBackfillTarget(
	databaseUrl: string,
	nodeEnv: string | undefined = undefined,
): boolean {
	return /fxplanner_prod/i.test(databaseUrl) || nodeEnv === "production";
}

/** 孤儿派生行计数（裸外键表无 Prisma 关系，用 LEFT JOIN IS NULL 检测） */
interface OrphanCounts {
	plan_allocations: number;
	usage_lot_allocations: number;
	usage_records: number;
	plan_change_logs: number;
	cost_lots: number;
}

/**
 * MIG-B 孤儿预检（§12.2.5）：父记录缺失即阻断发布，不静默归组。
 * 全库只读闸门——孤儿行不属于任何用户分片，因此不接受 userIds。
 */
export async function assertNoOrphanRows(db: Db): Promise<OrphanCounts> {
	const rows = await db.$queryRaw<
		Array<Record<keyof OrphanCounts, bigint>>
	>`
		SELECT
			(SELECT count(*) FROM plan_allocations a
				LEFT JOIN plans p ON p.id = a.plan_id WHERE p.id IS NULL) AS plan_allocations,
			(SELECT count(*) FROM usage_lot_allocations x
				LEFT JOIN usage_records u ON u.id = x.usage_id
				LEFT JOIN cost_lots l ON l.id = x.lot_id
				WHERE u.id IS NULL OR l.id IS NULL) AS usage_lot_allocations,
			(SELECT count(*) FROM usage_records u
				LEFT JOIN plans p ON p.id = u.plan_id WHERE p.id IS NULL) AS usage_records,
			(SELECT count(*) FROM plan_change_logs c
				LEFT JOIN plans p ON p.id = c.plan_id WHERE p.id IS NULL) AS plan_change_logs,
			(SELECT count(*) FROM cost_lots l
				WHERE (l.source_type = 'INITIAL' AND NOT EXISTS (
						SELECT 1 FROM initial_holdings h WHERE h.id = l.source_id))
					OR (l.source_type = 'PURCHASE' AND NOT EXISTS (
						SELECT 1 FROM transactions t WHERE t.id = l.source_id))) AS cost_lots
	`;
	const counts: OrphanCounts = {
		plan_allocations: Number(rows[0]?.plan_allocations ?? 0n),
		usage_lot_allocations: Number(rows[0]?.usage_lot_allocations ?? 0n),
		usage_records: Number(rows[0]?.usage_records ?? 0n),
		plan_change_logs: Number(rows[0]?.plan_change_logs ?? 0n),
		cost_lots: Number(rows[0]?.cost_lots ?? 0n),
	};
	const total =
		counts.plan_allocations +
		counts.usage_lot_allocations +
		counts.usage_records +
		counts.plan_change_logs +
		counts.cost_lots;
	if (total > 0) {
		throw new BackfillAnomalyError(
			"MIG-B 孤儿派生行阻断：父记录缺失，禁止归组（技术方案 §12.2.5）",
			{ ...counts },
		);
	}
	return counts;
}

/**
 * 幂等回填单个用户的存量个人数据到其默认组织。
 *
 * 仅更新 organization_id IS NULL 的行；created_by_id / actor_user_id 写原 userId
 * （操作者快照）。原生 UPDATE 只触碰租户列——Prisma updateMany 会经 `@updatedAt`
 * 改写 updated_at，违反 §12.2.6「时间戳不改」；MIG-B 相关表上无 updated_at 触发器。
 * SQL 全部静态 + 绑定参数（迁移工具不得留任何拼接面）。
 */
export async function backfillUserRows(
	tx: Tx,
	userId: string,
	organizationId: string,
): Promise<BackfillSummary["rowsBackfilled"]> {
	const accounts = Number(
		await tx.$executeRaw`
			UPDATE accounts
			SET organization_id = ${organizationId}, created_by_id = ${userId}
			WHERE user_id = ${userId} AND organization_id IS NULL`,
	);
	const transactions = Number(
		await tx.$executeRaw`
			UPDATE transactions
			SET organization_id = ${organizationId}, created_by_id = ${userId}
			WHERE user_id = ${userId} AND organization_id IS NULL`,
	);
	const initialHoldings = Number(
		await tx.$executeRaw`
			UPDATE initial_holdings
			SET organization_id = ${organizationId}, created_by_id = ${userId}
			WHERE user_id = ${userId} AND organization_id IS NULL`,
	);
	const costLots = Number(
		await tx.$executeRaw`
			UPDATE cost_lots
			SET organization_id = ${organizationId}
			WHERE user_id = ${userId} AND organization_id IS NULL`,
	);
	const plans = Number(
		await tx.$executeRaw`
			UPDATE plans
			SET organization_id = ${organizationId}, created_by_id = ${userId}
			WHERE user_id = ${userId} AND organization_id IS NULL`,
	);
	const usageRecords = Number(
		await tx.$executeRaw`
			UPDATE usage_records
			SET organization_id = ${organizationId}, created_by_id = ${userId}
			WHERE user_id = ${userId} AND organization_id IS NULL`,
	);
	const corrections = Number(
		await tx.$executeRaw`
			UPDATE corrections
			SET organization_id = ${organizationId}, actor_user_id = ${userId}
			WHERE user_id = ${userId} AND organization_id IS NULL`,
	);
	const reminders = Number(
		await tx.$executeRaw`
			UPDATE reminders
			SET organization_id = ${organizationId}
			WHERE user_id = ${userId} AND organization_id IS NULL`,
	);
	const aiConversations = Number(
		await tx.$executeRaw`
			UPDATE ai_conversations
			SET organization_id = ${organizationId}
			WHERE user_id = ${userId} AND organization_id IS NULL`,
	);
	// PlanChangeLog 按父 Plan 校对回填（§12.2.4）：此时该用户全部 Plan 已回填为
	// 本组织，父缺失行由孤儿预检阻断
	const planChangeLogs = Number(
		await tx.$executeRaw`
			UPDATE plan_change_logs c
			SET organization_id = ${organizationId}, actor_user_id = ${userId}
			FROM plans p
			WHERE p.id = c.plan_id
				AND p.user_id = ${userId}
				AND p.organization_id = ${organizationId}
				AND c.organization_id IS NULL`,
	);
	return {
		accounts,
		transactions,
		initialHoldings,
		costLots,
		plans,
		usageRecords,
		corrections,
		reminders,
		aiConversations,
		planChangeLogs,
	};
}

/**
 * DataRequest 语义映射（§12.2.7，仅限**未挂组织的存量行**）：
 * - EXPORT / DELETION → scope=PERSONAL（保持不挂组织）；
 * - 历史 CLEAR → scope=ORGANIZATION + 默认组织。
 *
 * 评审 I-15：ToB R1 之后新建的组织级请求（organizationId 已指向某个组织）
 * 绝不能被重跑的回填改写到默认组织或重置为 PERSONAL——它们不是存量个人行。
 * 状态机字段一律不动；原生 UPDATE 同样不触碰 updated_at。
 */
async function rescopeLegacyDataRequests(
	tx: Tx,
	userId: string,
	organizationId: string,
): Promise<number> {
	const personal = Number(
		await tx.$executeRaw`
			UPDATE data_requests
			SET scope = 'PERSONAL'
			WHERE user_id = ${userId}
				AND organization_id IS NULL
				AND type IN ('EXPORT', 'DELETION')
				AND scope <> 'PERSONAL'`,
	);
	const cleared = Number(
		await tx.$executeRaw`
			UPDATE data_requests
			SET scope = 'ORGANIZATION', organization_id = ${organizationId}
			WHERE user_id = ${userId}
				AND organization_id IS NULL
				AND type = 'CLEAR'`,
	);
	return personal + cleared;
}

/** 回填单个用户（调用方负责事务边界与计数汇总） */
async function backfillUser(
	tx: Tx,
	user: { id: string; name: string | null; email: string | null },
): Promise<{
	organizationId: string;
	organizationCreated: boolean;
	rows: BackfillSummary["rowsBackfilled"];
	settingsCreated: number;
	reminderReadsCreated: number;
	dataRequestsRescoped: number;
}> {
	// 默认组织 = 用户创建的最早组织（与运行时 resolveDefaultOrganizationId 同口径；
	// 用户可同时创建多个组织，取「最早」才是 MIG-B 的默认组织。受邀加入的组织不算：
	// 尚无个人工作台的存量用户在此解析为 null，由下方新建，fail-closed）
	let organizationId = await resolveDefaultOrganizationId(tx, user.id);
	let organizationCreated = false;
	if (organizationId === null) {
		const organization = await tx.organization.create({
			data: {
				name: defaultOrganizationName(user),
				memberships: {
					create: { userId: user.id, role: "OWNER", status: "ACTIVE" },
				},
			},
			select: { id: true },
		});
		organizationId = organization.id;
		organizationCreated = true;
	}

	// §12.2.3：UserSettings 有则幂等复制到 OrganizationSettings；无则（含个人偏好占位行 baseCurrency=""）保持待建账
	let settingsCreated = 0;
	const userSettings = await tx.userSettings.findUnique({
		where: { userId: user.id },
	});
	if (userSettings && userSettings.baseCurrency.trim() !== "") {
		const existing = await tx.organizationSettings.findUnique({
			where: { organizationId },
		});
		if (!existing) {
			await tx.organizationSettings.create({
				data: {
					organizationId,
					baseCurrency: userSettings.baseCurrency,
					prepPreference: userSettings.prepPreference,
					reminderEnabled: userSettings.reminderEnabled,
					ledgerStartedAt: userSettings.ledgerStartedAt,
				},
			});
			settingsCreated = 1;
		}
	}

	const rows = await backfillUserRows(tx, user.id, organizationId);

	// §12.2.5（LEDGER-03）：已读提醒回填成员级 ReminderRead（唯一约束兜底，重复不重建）
	const readReminders = await tx.reminder.findMany({
		where: { userId: user.id, readAt: { not: null } },
		select: { id: true, userId: true, readAt: true },
	});
	let reminderReadsCreated = 0;
	if (readReminders.length > 0) {
		const created = await tx.reminderRead.createMany({
			data: readReminders.map((r) => ({
				reminderId: r.id,
				userId: r.userId,
				readAt: r.readAt as Date,
			})),
			skipDuplicates: true,
		});
		reminderReadsCreated = created.count;
	}

	const dataRequestsRescoped = await rescopeLegacyDataRequests(
		tx,
		user.id,
		organizationId,
	);

	return {
		organizationId,
		organizationCreated,
		rows,
		settingsCreated,
		reminderReadsCreated,
		dataRequestsRescoped,
	};
}

function emptyRows(): BackfillSummary["rowsBackfilled"] {
	return {
		accounts: 0,
		transactions: 0,
		initialHoldings: 0,
		costLots: 0,
		plans: 0,
		usageRecords: 0,
		corrections: 0,
		reminders: 0,
		aiConversations: 0,
		planChangeLogs: 0,
	};
}

function addRows(
	total: BackfillSummary["rowsBackfilled"],
	rows: BackfillSummary["rowsBackfilled"],
): void {
	for (const table of Object.keys(total) as Array<keyof typeof total>) {
		total[table] += rows[table];
	}
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

/**
 * MIG-B 回填（§12.2 七条规则）。
 *
 * dryRun：全库只读预检 + 估算（将新建的组织数、各表待回填行数、待映射的数据请求），
 * 估算条件与真实写入条件逐项一致。
 *
 * 幂等保证：
 * - 组织/Membership：以「已存在 OWNER Membership」判定复用；
 * - OrganizationSettings：仅当不存在时创建（无 UserSettings 不虚构）；
 * - 业务行：只更新 organizationId IS NULL 的行；
 * - ReminderRead：@@unique([reminderId, userId]) 兜底，重复已读不重建；
 * - DataRequest：只映射未挂组织的存量行（§12.2.7）。
 */
export async function backfillDefaultOrganizations(
	prisma: PrismaClient,
	options: BackfillOptions = {},
): Promise<BackfillSummary> {
	// 孤儿预检在任何写入之前（全库只读），失败即阻断且零写入
	await assertNoOrphanRows(prisma);

	const userWhere = options.userIds ? { id: { in: options.userIds } } : {};
	const sharded = options.userIds !== undefined;
	const users = await prisma.user.findMany({
		where: userWhere,
		select: { id: true, name: true, email: true },
		orderBy: { id: "asc" },
	});
	const userIds = users.map((user) => user.id);
	const userScope = sharded ? { userId: { in: userIds } } : {};

	const summary: BackfillSummary = {
		usersProcessed: users.length,
		organizationsCreated: 0,
		ownerMembershipsCreated: 0,
		organizationSettingsCreated: 0,
		rowsBackfilled: emptyRows(),
		reminderReadsCreated: 0,
		dataRequestsRescoped: 0,
		usersSkippedIdempotent: 0,
		chunksCommitted: 0,
	};

	if (options.dryRun) {
		// 分片绑定参数：全库模式绑定空数组——既不把全库用户 id 展开成绑定参数
		// （超 32,767 个即突破 PostgreSQL 上限，评审 R2-I05），也让 ANY 恒假
		const shardIds = sharded ? userIds : [];
		// 已有默认组织的用户：与 resolveDefaultOrganizationId 同口径（组织的第一个成员，
		// 且成员关系与组织同事务创建 = 创建者）。真实写入对每个尚无默认组织的用户新建
		// 组织 + 首个 OWNER 成员关系
		const withDefault = await prisma.$queryRaw<Array<{ userId: string }>>`
			WITH first_members AS (
				SELECT DISTINCT ON (m.organization_id)
					m.organization_id, m.user_id, m.created_at, m.id
				FROM memberships m
				ORDER BY m.organization_id, m.created_at ASC, m.id ASC
			)
			SELECT DISTINCT f.user_id AS "userId"
			FROM first_members f
			JOIN organizations o ON o.id = f.organization_id
			WHERE f.created_at = o.created_at
				AND (NOT ${sharded} OR f.user_id = ANY(${shardIds}::text[]))`;
		const defaultUserIds = new Set(withDefault.map((row) => row.userId));
		summary.organizationsCreated = users.filter(
			(u) => !defaultUserIds.has(u.id),
		).length;
		summary.usersSkippedIdempotent =
			users.length - summary.organizationsCreated;
		// 组织与首个 OWNER 成员关系 1:1 同建（此前 dry-run 恒为 0，评审 R2-I05）
		summary.ownerMembershipsCreated = summary.organizationsCreated;

		// 待回填行：organizationId IS NULL 的用户行
		const legacyRows = { organizationId: null, ...userScope };
		summary.rowsBackfilled.accounts = await prisma.account.count({
			where: legacyRows,
		});
		summary.rowsBackfilled.transactions = await prisma.transaction.count({
			where: legacyRows,
		});
		summary.rowsBackfilled.initialHoldings =
			await prisma.initialHolding.count({ where: legacyRows });
		summary.rowsBackfilled.costLots = await prisma.costLot.count({
			where: legacyRows,
		});
		summary.rowsBackfilled.plans = await prisma.plan.count({
			where: legacyRows,
		});
		summary.rowsBackfilled.usageRecords = await prisma.usageRecord.count({
			where: legacyRows,
		});
		summary.rowsBackfilled.corrections = await prisma.correction.count({
			where: legacyRows,
		});
		summary.rowsBackfilled.reminders = await prisma.reminder.count({
			where: legacyRows,
		});
		summary.rowsBackfilled.aiConversations =
			await prisma.aiConversation.count({ where: legacyRows });
		// PlanChangeLog 无 userId 列：经父 Plan 归属。与 backfillUserRows 的写入条件逐项
		// 一致——父计划尚未挂组织，或已挂该用户的默认组织（回填重跑）；父计划已挂其他
		// 组织的变更日志不会被写入，也不计入（评审 R2-I05）。defaults CTE 与
		// resolveDefaultOrganizationId 同口径，改一处须同步另一处
		const [changeLogs] = await prisma.$queryRaw<Array<{ n: bigint }>>`
			WITH first_members AS (
				SELECT DISTINCT ON (m.organization_id)
					m.organization_id, m.user_id, m.joined_at, m.created_at, m.id
				FROM memberships m
				ORDER BY m.organization_id, m.created_at ASC, m.id ASC
			),
			defaults AS (
				SELECT DISTINCT ON (f.user_id) f.user_id, f.organization_id
				FROM first_members f
				JOIN organizations o ON o.id = f.organization_id
				WHERE f.created_at = o.created_at
				ORDER BY f.user_id, f.joined_at ASC, f.created_at ASC, f.id ASC
			)
			SELECT count(*) AS n
			FROM plan_change_logs c
			JOIN plans p ON p.id = c.plan_id
			LEFT JOIN defaults d ON d.user_id = p.user_id
			WHERE c.organization_id IS NULL
				AND (p.organization_id IS NULL OR p.organization_id = d.organization_id)
				AND (NOT ${sharded} OR p.user_id = ANY(${shardIds}::text[]))`;
		summary.rowsBackfilled.planChangeLogs = Number(changeLogs?.n ?? 0n);
		// 待映射数据请求：与 rescopeLegacyDataRequests 的写入条件逐项一致——
		// EXPORT/DELETION 且非 PERSONAL；历史 CLEAR 一律映射（含 scope 已是
		// ORGANIZATION 但尚未挂组织的行，此前漏计，评审 R2-I05）
		summary.dataRequestsRescoped = await prisma.dataRequest.count({
			where: {
				organizationId: null,
				...userScope,
				OR: [
					{
						type: { in: ["EXPORT", "DELETION"] },
						scope: { not: "PERSONAL" },
					},
					{ type: "CLEAR" },
				],
			},
		});
		// 待补建的已读行：行主已读、但尚无**行主本人**的成员级已读行（与真实写入的
		// createMany 条件及 reconcileMigration 的 reminder_read.parity 同口径；
		// 此前用「无任何已读行」估算，他人已读时会漏计，评审 R2-I05）
		const [readParity] = await prisma.$queryRaw<Array<{ n: bigint }>>`
			SELECT count(*) AS n FROM reminders r
			WHERE r.read_at IS NOT NULL
				AND NOT EXISTS (
					SELECT 1 FROM reminder_reads rr
					WHERE rr.reminder_id = r.id AND rr.user_id = r.user_id)
				AND (NOT ${sharded} OR r.user_id = ANY(${shardIds}::text[]))`;
		summary.reminderReadsCreated = Number(readParity?.n ?? 0n);
		// 待补建的组织设置：有个人设置、而（尚不存在的）默认组织无组织设置。
		// defaults CTE 与 resolveDefaultOrganizationId 同口径（用户创建的最早组织：
		// 组织的第一个成员且成员关系与组织同事务创建），改一处须同步另一处
		const [settingsToCreate] = await prisma.$queryRaw<Array<{ n: bigint }>>`
			WITH first_members AS (
				SELECT DISTINCT ON (m.organization_id)
					m.organization_id, m.user_id, m.joined_at, m.created_at, m.id
				FROM memberships m
				ORDER BY m.organization_id, m.created_at ASC, m.id ASC
			),
			defaults AS (
				SELECT DISTINCT ON (f.user_id) f.user_id, f.organization_id
				FROM first_members f
				JOIN organizations o ON o.id = f.organization_id
				WHERE f.created_at = o.created_at
				ORDER BY f.user_id, f.joined_at ASC, f.created_at ASC, f.id ASC
			)
			SELECT count(*) AS n FROM user_settings s
			LEFT JOIN defaults d ON d.user_id = s.user_id
			LEFT JOIN organization_settings o ON o.organization_id = d.organization_id
			WHERE o.organization_id IS NULL
				AND COALESCE(btrim(s.base_currency), '') <> ''
				AND (NOT ${sharded} OR s.user_id = ANY(${shardIds}::text[]))`;
		summary.organizationSettingsCreated = Number(settingsToCreate?.n ?? 0n);
		return summary;
	}

	const chunkSize = options.chunkSize ?? BACKFILL_CHUNK_SIZE;
	if (!Number.isInteger(chunkSize) || chunkSize < 1) {
		throw new Error(`chunkSize 必须是正整数，收到: ${chunkSize}`);
	}

	for (const userChunk of chunk(users, chunkSize)) {
		await prisma.$transaction(
			async (tx) => {
				for (const user of userChunk) {
					const result = await backfillUser(tx, user);
					if (result.organizationCreated) {
						summary.organizationsCreated += 1;
						summary.ownerMembershipsCreated += 1;
					} else {
						summary.usersSkippedIdempotent += 1;
					}
					summary.organizationSettingsCreated += result.settingsCreated;
					addRows(summary.rowsBackfilled, result.rows);
					summary.reminderReadsCreated += result.reminderReadsCreated;
					summary.dataRequestsRescoped += result.dataRequestsRescoped;
				}
			},
			CHUNK_TX_OPTIONS,
		);
		summary.chunksCommitted += 1;
	}

	return summary;
}
