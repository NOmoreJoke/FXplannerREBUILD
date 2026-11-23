/**
 * MIG-B 默认组织幂等回填（技术方案 §12.2；Goal #3A W15）。
 *
 * 职责边界：
 * - 仅做「存量个人数据 → 默认组织」的一次性回填，幂等可重复执行；
 * - 不删除、不禁用任何 userId 读路径（兼容窗口在 Goal #3B 收口）；
 * - 金额、ID、版本、时间戳一律不改（§12.2.6）；
 * - 孤儿/父子缺失预检失败即抛错阻断，绝不静默归组（§12.2.5）。
 *
 * 复用方式：integration 测试直接调用本模块函数；CLI 入口见
 * prisma/tob-r1-migration/backfill.ts（dry-run 默认，--apply 需双旗标确认）。
 */

import type { PrismaClient, Prisma } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

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
	/** DataRequest 重置 scope 行数（EXPORT/DELETION→PERSONAL、CLEAR→ORGANIZATION） */
	dataRequestsRescoped: number;
	/** 已有 OWNER Membership 而幂等跳过建组的用户数 */
	usersSkippedIdempotent: number;
}

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

/** 默认组织名（需求 ORG-01.3：「用户名称/邮箱前缀的工作台」） */
export function defaultOrganizationName(user: {
	name: string | null;
	email: string | null;
}): string {
	const base = user.name?.trim() || (user.email?.split("@")[0] ?? "").trim();
	return `${base || "我的"}的工作台`;
}

/** 单用户默认组织视图（回填与核对共用） */
export interface DefaultOrgView {
	userId: string;
	organizationId: string;
}

/**
 * 解析用户的默认组织：已有 OWNER Membership 则幂等复用，否则新建
 * Organization + OWNER/ACTIVE Membership（单活跃 Owner 由
 * memberships_single_active_owner_uidx 兜底）。
 */
export async function resolveDefaultOrganization(
	db: Db,
	user: { id: string; name: string | null; email: string | null },
): Promise<{ organizationId: string; created: boolean }> {
	const existing = await db.membership.findFirst({
		where: { userId: user.id, role: "OWNER", status: "ACTIVE" },
		select: { organizationId: true },
	});
	if (existing) {
		return { organizationId: existing.organizationId, created: false };
	}
	const org = await db.organization.create({
		data: {
			name: defaultOrganizationName(user),
			memberships: {
				create: { userId: user.id, role: "OWNER", status: "ACTIVE" },
			},
		},
		select: { id: true },
	});
	return { organizationId: org.id, created: true };
}

/** 孤儿派生行计数（裸外键表无 Prisma 关系，用 LEFT JOIN IS NULL 检测） */
interface OrphanCounts {
	plan_allocations: number;
	usage_lot_allocations: number;
	usage_records: number;
	plan_change_logs: number;
}

/** MIG-B 孤儿预检（§12.2.5）：父记录缺失即阻断发布，不静默归组 */
export async function assertNoOrphanRows(db: Db): Promise<OrphanCounts> {
	const rows = await db.$queryRaw<Array<{ n: bigint }>>`
		SELECT (
			(SELECT count(*) FROM plan_allocations a
				LEFT JOIN plans p ON p.id = a.plan_id WHERE p.id IS NULL)
			+ (SELECT count(*) FROM usage_lot_allocations x
				LEFT JOIN usage_records u ON u.id = x.usage_id
				LEFT JOIN cost_lots l ON l.id = x.lot_id
				WHERE u.id IS NULL OR l.id IS NULL)
			+ (SELECT count(*) FROM usage_records u
				LEFT JOIN plans p ON p.id = u.plan_id WHERE p.id IS NULL)
			+ (SELECT count(*) FROM plan_change_logs c
				LEFT JOIN plans p ON p.id = c.plan_id WHERE p.id IS NULL)
		) AS n
	`;
	const total = Number(rows[0]?.n ?? 0);
	if (total > 0) {
		// 逐表细分计数，供人类定位（阻止发布语义，不自动修复）
		const detailed = await db.$queryRaw<Array<{ n: bigint }>>`
			SELECT
				(SELECT count(*) FROM plan_allocations a
					LEFT JOIN plans p ON p.id = a.plan_id WHERE p.id IS NULL) AS n
		`;
		const planAllocations = Number(detailed[0]?.n ?? 0);
		const detailedLots = await db.$queryRaw<Array<{ n: bigint }>>`
			SELECT count(*) AS n FROM usage_lot_allocations x
				LEFT JOIN usage_records u ON u.id = x.usage_id
				LEFT JOIN cost_lots l ON l.id = x.lot_id
				WHERE u.id IS NULL OR l.id IS NULL
		`;
		const usageLotAllocations = Number(detailedLots[0]?.n ?? 0);
		const detailedUsages = await db.$queryRaw<Array<{ n: bigint }>>`
			SELECT count(*) AS n FROM usage_records u
				LEFT JOIN plans p ON p.id = u.plan_id WHERE p.id IS NULL
		`;
		const usageRecords = Number(detailedUsages[0]?.n ?? 0);
		const detailedChangeLogs = await db.$queryRaw<Array<{ n: bigint }>>`
			SELECT count(*) AS n FROM plan_change_logs c
				LEFT JOIN plans p ON p.id = c.plan_id WHERE p.id IS NULL
		`;
		const planChangeLogs = Number(detailedChangeLogs[0]?.n ?? 0);
		throw new BackfillAnomalyError(
			"MIG-B 孤儿派生行阻断：父记录缺失，禁止归组（技术方案 §12.2.5）",
			{ plan_allocations: planAllocations, usage_lot_allocations: usageLotAllocations, usage_records: usageRecords, plan_change_logs: planChangeLogs },
		);
	}
	return {
		plan_allocations: 0,
		usage_lot_allocations: 0,
		usage_records: 0,
		plan_change_logs: 0,
	};
}

/**
 * 幂等回填单个用户的存量个人数据到其默认组织。
 * 仅更新 organizationId IS NULL 的行；createdById/actorUserId 写原 userId
 * （操作者快照），金额/ID/版本/时间戳不动。
 */
export async function backfillUserRows(
	db: Db,
	user: { id: string },
	organizationId: string,
): Promise<BackfillSummary["rowsBackfilled"]> {
	const common = { where: { userId: user.id, organizationId: null } };
	const accounts = await db.account.updateMany({
		...common,
		data: { organizationId, createdById: user.id },
	});
	const transactions = await db.transaction.updateMany({
		...common,
		data: { organizationId, createdById: user.id },
	});
	const initialHoldings = await db.initialHolding.updateMany({
		...common,
		data: { organizationId, createdById: user.id },
	});
	const costLots = await db.costLot.updateMany({
		where: { userId: user.id, organizationId: null },
		data: { organizationId },
	});
	const plans = await db.plan.updateMany({
		...common,
		data: { organizationId, createdById: user.id },
	});
	const usageRecords = await db.usageRecord.updateMany({
		...common,
		data: { organizationId, createdById: user.id },
	});
	const corrections = await db.correction.updateMany({
		...common,
		data: { organizationId, actorUserId: user.id },
	});
	const reminders = await db.reminder.updateMany({
		where: { userId: user.id, organizationId: null },
		data: { organizationId },
	});
	const aiConversations = await db.aiConversation.updateMany({
		where: { userId: user.id, organizationId: null },
		data: { organizationId },
	});
	// PlanChangeLog 按父 Plan.organizationId 校对回填（§12.2.4）：
	// 此时该用户全部 Plan 已回填为本组织，父缺失行由孤儿预检阻断
	const planChangeLogs = await db.planChangeLog.updateMany({
		where: {
			organizationId: null,
			plan: { userId: user.id, organizationId },
		},
		data: { organizationId, actorUserId: user.id },
	});
	return {
		accounts: accounts.count,
		transactions: transactions.count,
		initialHoldings: initialHoldings.count,
		costLots: costLots.count,
		plans: plans.count,
		usageRecords: usageRecords.count,
		corrections: corrections.count,
		reminders: reminders.count,
		aiConversations: aiConversations.count,
		planChangeLogs: planChangeLogs.count,
	};
}

/**
 * 全量 MIG-B 回填（§12.2 七条规则；单事务原子执行）。
 *
 * 幂等保证：
 * - 组织/Membership：以「已存在 OWNER Membership」判定复用；
 * - OrganizationSettings：仅当不存在时创建（无 UserSettings 不虚构）；
 * - 业务行：只更新 organizationId IS NULL 的行；
 * - ReminderRead：@@unique([reminderId, userId]) 兜底，重复已读不重建；
 * - DataRequest：重置 scope 为幂等赋值（状态机字段一律不动，§12.2.7）。
 */
export async function backfillDefaultOrganizations(
	prisma: PrismaClient,
	options: { dryRun?: boolean; userIds?: string[] } = {},
): Promise<BackfillSummary> {
	const emptyRows: BackfillSummary["rowsBackfilled"] = {
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
	const summary: BackfillSummary = {
		usersProcessed: 0,
		organizationsCreated: 0,
		ownerMembershipsCreated: 0,
		organizationSettingsCreated: 0,
		rowsBackfilled: emptyRows,
		reminderReadsCreated: 0,
		dataRequestsRescoped: 0,
		usersSkippedIdempotent: 0,
	};

	// 孤儿预检在事务外先行（只读），失败即阻断且零写入
	await assertNoOrphanRows(prisma);

	if (options.dryRun) {
		// dry-run：估算将新建的组织数（无 OWNER Membership 的用户数）与待回填行数；
		// userIds 过滤用于测试/演练分片（CLI 全量执行不传）
		const userWhere = options.userIds
			? { id: { in: options.userIds } }
			: undefined;
		const users = await prisma.user.findMany({
			where: userWhere,
			select: { id: true },
		});
		summary.usersProcessed = users.length;
		const owners = await prisma.membership.findMany({
			where: { role: "OWNER", status: "ACTIVE", userId: { in: users.map((u) => u.id) } },
			select: { userId: true },
		});
		const ownerUserIds = new Set(owners.map((m) => m.userId));
		summary.organizationsCreated = users.filter(
			(u) => !ownerUserIds.has(u.id),
		).length;
		summary.usersSkippedIdempotent = users.filter((u) =>
			ownerUserIds.has(u.id),
		).length;
		const rowScope = options.userIds
			? { organizationId: null, userId: { in: options.userIds } }
			: { organizationId: null };
		summary.rowsBackfilled.accounts = await prisma.account.count({
			where: rowScope,
		});
		summary.rowsBackfilled.transactions = await prisma.transaction.count({
			where: rowScope,
		});
		summary.rowsBackfilled.initialHoldings = await prisma.initialHolding.count(
			{ where: rowScope },
		);
		summary.rowsBackfilled.costLots = await prisma.costLot.count({
			where: rowScope,
		});
		summary.rowsBackfilled.plans = await prisma.plan.count({
			where: rowScope,
		});
		summary.rowsBackfilled.usageRecords = await prisma.usageRecord.count({
			where: rowScope,
		});
		summary.rowsBackfilled.corrections = await prisma.correction.count({
			where: rowScope,
		});
		summary.rowsBackfilled.reminders = await prisma.reminder.count({
			where: rowScope,
		});
		summary.rowsBackfilled.aiConversations = await prisma.aiConversation.count(
			{ where: rowScope },
		);
		summary.rowsBackfilled.planChangeLogs = await prisma.planChangeLog.count({
			where: rowScope,
		});
		summary.dataRequestsRescoped = await prisma.dataRequest.count({
			where: {
				...(options.userIds ? { userId: { in: options.userIds } } : {}),
				OR: [
					{ type: { in: ["EXPORT", "DELETION"] }, scope: { not: "PERSONAL" } },
					{ type: "CLEAR", scope: { not: "ORGANIZATION" } },
				],
			},
		});
		return summary;
	}

	await prisma.$transaction(async (tx) => {
		const users = await tx.user.findMany({
			where: options.userIds ? { id: { in: options.userIds } } : undefined,
			select: { id: true, name: true, email: true },
		});
		summary.usersProcessed = users.length;

		for (const user of users) {
			const { organizationId, created } = await resolveDefaultOrganization(
				tx,
				user,
			);
			if (created) {
				summary.organizationsCreated += 1;
				summary.ownerMembershipsCreated += 1;
			} else {
				summary.usersSkippedIdempotent += 1;
			}

			// §12.2.3：UserSettings 有则幂等复制到 OrganizationSettings；无则保持待建账
			const userSettings = await tx.userSettings.findUnique({
				where: { userId: user.id },
			});
			if (userSettings) {
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
					summary.organizationSettingsCreated += 1;
				}
			}

			const rows = await backfillUserRows(tx, user, organizationId);
			summary.rowsBackfilled.accounts += rows.accounts;
			summary.rowsBackfilled.transactions += rows.transactions;
			summary.rowsBackfilled.initialHoldings += rows.initialHoldings;
			summary.rowsBackfilled.costLots += rows.costLots;
			summary.rowsBackfilled.plans += rows.plans;
			summary.rowsBackfilled.usageRecords += rows.usageRecords;
			summary.rowsBackfilled.corrections += rows.corrections;
			summary.rowsBackfilled.reminders += rows.reminders;
			summary.rowsBackfilled.aiConversations += rows.aiConversations;
			summary.rowsBackfilled.planChangeLogs += rows.planChangeLogs;

			// §12.2.5（LEDGER-03）：已读提醒回填成员级 ReminderRead（幂等）
			const readReminders = await tx.reminder.findMany({
				where: { userId: user.id, readAt: { not: null } },
				select: { id: true, userId: true, readAt: true },
			});
			if (readReminders.length > 0) {
				const created = await tx.reminderRead.createMany({
					data: readReminders.map((r) => ({
						reminderId: r.id,
						userId: r.userId,
						readAt: r.readAt as Date,
					})),
					skipDuplicates: true,
				});
				summary.reminderReadsCreated += created.count;
			}

			// §12.2.6：DataRequest 语义映射（EXPORT/DELETION→PERSONAL；历史 CLEAR→默认组织）
			const rescoped = await tx.dataRequest.updateMany({
				where: { userId: user.id, type: { in: ["EXPORT", "DELETION"] } },
				data: { scope: "PERSONAL", organizationId: null },
			});
			const cleared = await tx.dataRequest.updateMany({
				where: { userId: user.id, type: "CLEAR" },
				data: { scope: "ORGANIZATION", organizationId },
			});
			summary.dataRequestsRescoped += rescoped.count + cleared.count;
		}
	});

	return summary;
}
