/**
 * MIG-B 一致性核对（技术方案 §12.3；Goal #3A W15；评审 I-16 重写为集合式 SQL）。
 *
 * 原理：MIG-B 只把存量个人行映射到用户默认组织（userId 列保留、金额不动、
 * updated_at 不动），因此核对的核心是**行集恒等**——对每张带租户列的业务表，
 * 任意行的 organization_id 必须等于「该行 user_id 对应的默认组织」。行集一旦恒等，
 * §12.3 的各聚合口径（每币种余额、计划金额/分配、交易/使用/更正的数量与金额、
 * 批次剩余与成本）在「按 userId 视角」与「按 organizationId 视角」下必然相等，
 * 无需逐用户逐表发查询（原实现每用户约 20 条查询，且漏检 4 张表）。
 *
 * 在行集恒等之上叠加数据自身的不变量专项：父子组织一致、孤儿行、FIFO 消耗守恒、
 * 批次守恒、DataRequest 语义映射、ReminderRead 对账、组织设置与个人设置同构。
 * 任何差异进 diffs（结构化清单），目标 0 diffs。
 *
 * 适用时点：**迁移闸门**——在停写窗口内对备份副本/生产库执行（CLI verify）。
 * R1 上线后业务数据可在非默认组织演进、组织偏好可独立修改，全量 verify 不再是
 * 运行期不变量，请勿当作常驻巡检使用。
 *
 * 分片（options.userIds，测试/演练用）：映射类与可归属到用户的不变量只核对指定
 * 用户，保证集成测试不受共享库其他数据的干扰；无法归属到用户的孤儿检查
 * （计划分配/使用分摊/变更日志/排期缺父）仅在全量模式下评估——它们在回填前由
 * assertNoOrphanRows（全库只读闸门）兜底。
 *
 * SQL 纪律：全部为静态 SQL + 绑定参数（分片用 `= ANY($ids::text[])`），不拼接
 * 表名/列名、不使用 Prisma.raw——迁移核对工具跑在真实数据上，不得留任何拼接面。
 *
 * 复用方式：integration 测试直接调用；CLI verify 子命令见
 * prisma/tob-r1-migration/backfill.ts（0 diffs 退出 0，否则退出 1）。
 */

import type { Prisma } from "@prisma/client";

/** 单条核对差异（scope 描述差异位置；left = 期望值 0，right = 实际差异计数） */
export interface ReconcileDiff {
	scope: string;
	left: unknown;
	right: unknown;
}

export interface ReconcileResult {
	/** 已评估的核对项总数 */
	checks: number;
	/** 差异清单（目标 0） */
	diffs: ReconcileDiff[];
	/** 是否为分片核对（true = 未评估无法归属到用户的孤儿检查） */
	sharded: boolean;
}

type QueryRunner = Prisma.TransactionClient["$queryRaw"];

/** 行集恒等核对的表（与下方静态 SQL 的各标量子查询列一一对应） */
const ROW_MAPPED_TABLES = [
	"accounts",
	"transactions",
	"initial_holdings",
	"cost_lots",
	"plans",
	"usage_records",
	"corrections",
	"reminders",
	"ai_conversations",
	"plan_change_logs",
] as const;

type RowMappedCounts = Record<(typeof ROW_MAPPED_TABLES)[number], bigint>;

interface IntegrityCounts {
	usage_plan: bigint;
	lot_source: bigint;
	ula_parents: bigint;
	usage_orphan_plan: bigint;
	lot_orphan_source: bigint;
	fifo: bigint;
	batch: bigint;
}

/**
 * §12.3 全量一致性核对。
 * userIds：可选分片；缺省核对全库。
 */
export async function reconcileMigration(
	db: { $queryRaw: QueryRunner },
	options: { userIds?: string[] } = {},
): Promise<ReconcileResult> {
	const diffs: ReconcileDiff[] = [];
	let checks = 0;
	const sharded = options.userIds !== undefined;
	const ids = options.userIds ?? [];

	function expectZero(scope: string, count: bigint | number): void {
		checks += 1;
		if (Number(count) !== 0) {
			diffs.push({ scope, left: 0, right: Number(count) });
		}
	}

	// 1. 默认组织映射完整性：每个用户都有默认组织（回填前 = 全部用户，属预期）。
	//    默认组织 = 用户创建的最早组织（组织的第一个成员，且成员关系与组织同事务
	//    创建），与运行时 resolveDefaultOrganizationId 同口径；defaults CTE 在本文件
	//    出现 4 次，改一处须同步其余与运行时函数。
	//    评审 R2-I05：以下各项一律 LEFT JOIN defaults——无默认组织的用户，其行不得被
	//    内连接静默丢弃（此前整批假报 0 差异），一律计为未映射。
	const [missingDefault] = await db.$queryRaw<Array<{ n: bigint }>>`
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
		SELECT count(*) AS n FROM users u
		LEFT JOIN defaults d ON d.user_id = u.id
		WHERE d.user_id IS NULL
			AND (NOT ${sharded} OR u.id = ANY(${ids}::text[]))`;
	expectZero("default_org.missing", missingDefault?.n ?? 0n);

	// 2. 行集恒等（§12.3.1–5、§12.3.7）：每张表的 organization_id 必须等于行用户的默认组织
	const [mapped] = await db.$queryRaw<Array<RowMappedCounts>>`
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
		SELECT
			(SELECT count(*) FROM accounts t LEFT JOIN defaults d ON d.user_id = t.user_id
				WHERE (d.organization_id IS NULL OR t.organization_id IS DISTINCT FROM d.organization_id)
					AND (NOT ${sharded} OR t.user_id = ANY(${ids}::text[]))) AS accounts,
			(SELECT count(*) FROM transactions t LEFT JOIN defaults d ON d.user_id = t.user_id
				WHERE (d.organization_id IS NULL OR t.organization_id IS DISTINCT FROM d.organization_id)
					AND (NOT ${sharded} OR t.user_id = ANY(${ids}::text[]))) AS transactions,
			(SELECT count(*) FROM initial_holdings t LEFT JOIN defaults d ON d.user_id = t.user_id
				WHERE (d.organization_id IS NULL OR t.organization_id IS DISTINCT FROM d.organization_id)
					AND (NOT ${sharded} OR t.user_id = ANY(${ids}::text[]))) AS initial_holdings,
			(SELECT count(*) FROM cost_lots t LEFT JOIN defaults d ON d.user_id = t.user_id
				WHERE (d.organization_id IS NULL OR t.organization_id IS DISTINCT FROM d.organization_id)
					AND (NOT ${sharded} OR t.user_id = ANY(${ids}::text[]))) AS cost_lots,
			(SELECT count(*) FROM plans t LEFT JOIN defaults d ON d.user_id = t.user_id
				WHERE (d.organization_id IS NULL OR t.organization_id IS DISTINCT FROM d.organization_id)
					AND (NOT ${sharded} OR t.user_id = ANY(${ids}::text[]))) AS plans,
			(SELECT count(*) FROM usage_records t LEFT JOIN defaults d ON d.user_id = t.user_id
				WHERE (d.organization_id IS NULL OR t.organization_id IS DISTINCT FROM d.organization_id)
					AND (NOT ${sharded} OR t.user_id = ANY(${ids}::text[]))) AS usage_records,
			(SELECT count(*) FROM corrections t LEFT JOIN defaults d ON d.user_id = t.user_id
				WHERE (d.organization_id IS NULL OR t.organization_id IS DISTINCT FROM d.organization_id)
					AND (NOT ${sharded} OR t.user_id = ANY(${ids}::text[]))) AS corrections,
			(SELECT count(*) FROM reminders t LEFT JOIN defaults d ON d.user_id = t.user_id
				WHERE (d.organization_id IS NULL OR t.organization_id IS DISTINCT FROM d.organization_id)
					AND (NOT ${sharded} OR t.user_id = ANY(${ids}::text[]))) AS reminders,
			(SELECT count(*) FROM ai_conversations t LEFT JOIN defaults d ON d.user_id = t.user_id
				WHERE (d.organization_id IS NULL OR t.organization_id IS DISTINCT FROM d.organization_id)
					AND (NOT ${sharded} OR t.user_id = ANY(${ids}::text[]))) AS ai_conversations,
			(SELECT count(*) FROM plan_change_logs c
				JOIN plans p ON p.id = c.plan_id
				LEFT JOIN defaults d ON d.user_id = p.user_id
				WHERE (d.organization_id IS NULL OR c.organization_id IS DISTINCT FROM d.organization_id)
					AND (NOT ${sharded} OR p.user_id = ANY(${ids}::text[]))) AS plan_change_logs`;
	for (const table of ROW_MAPPED_TABLES) {
		expectZero(`row_mapping.${table}`, mapped?.[table] ?? 0n);
	}

	// 3. 可归属到用户的不变量（§5.3.2 父子组织一致 / §12.2.5 孤儿 / §12.3.3–4 守恒）：
	//    分片模式按对应用户列限定，一条语句取回全部计数
	const [integrity] = await db.$queryRaw<Array<IntegrityCounts>>`
		SELECT
			-- 使用记录与其计划同组织
			(SELECT count(*) FROM usage_records u JOIN plans p ON p.id = u.plan_id
				WHERE u.organization_id IS DISTINCT FROM p.organization_id
					AND (NOT ${sharded} OR u.user_id = ANY(${ids}::text[]))) AS usage_plan,
			-- 批次与其来源记录同组织（初始持仓 / 买入）
			(SELECT count(*) FROM cost_lots l
				JOIN initial_holdings h ON l.source_type = 'INITIAL' AND h.id = l.source_id
				WHERE l.organization_id IS DISTINCT FROM h.organization_id
					AND (NOT ${sharded} OR l.user_id = ANY(${ids}::text[])))
			+ (SELECT count(*) FROM cost_lots l
				JOIN transactions t ON l.source_type = 'PURCHASE' AND t.id = l.source_id
				WHERE l.organization_id IS DISTINCT FROM t.organization_id
					AND (NOT ${sharded} OR l.user_id = ANY(${ids}::text[]))) AS lot_source,
			-- 使用分摊双父（Usage × CostLot）同组织
			(SELECT count(*) FROM usage_lot_allocations x
				JOIN usage_records u ON u.id = x.usage_id
				JOIN cost_lots l ON l.id = x.lot_id
				WHERE u.organization_id IS DISTINCT FROM l.organization_id
					AND (NOT ${sharded} OR u.user_id = ANY(${ids}::text[]))) AS ula_parents,
			-- 使用记录缺父计划（usage_records.plan_id 无外键）
			(SELECT count(*) FROM usage_records u
				LEFT JOIN plans p ON p.id = u.plan_id
				WHERE p.id IS NULL
					AND (NOT ${sharded} OR u.user_id = ANY(${ids}::text[]))) AS usage_orphan_plan,
			-- 批次来源孤儿（INITIAL 无持仓行 / PURCHASE 无交易行）
			(SELECT count(*) FROM cost_lots l
				WHERE ((l.source_type = 'INITIAL' AND NOT EXISTS (
							SELECT 1 FROM initial_holdings h WHERE h.id = l.source_id))
					OR (l.source_type = 'PURCHASE' AND NOT EXISTS (
							SELECT 1 FROM transactions t WHERE t.id = l.source_id)))
					AND (NOT ${sharded} OR l.user_id = ANY(${ids}::text[]))) AS lot_orphan_source,
			-- FIFO：每笔使用的分摊量合计 = 使用量
			(SELECT count(*) FROM usage_records u
				WHERE u.amount <> COALESCE((
						SELECT SUM(x.quantity) FROM usage_lot_allocations x
						WHERE x.usage_id = u.id), 0)
					AND (NOT ${sharded} OR u.user_id = ANY(${ids}::text[]))) AS fifo,
			-- 批次：quantity − Σ已分摊 = remaining_qty
			(SELECT count(*) FROM cost_lots l
				WHERE l.quantity - COALESCE((
						SELECT SUM(x.quantity) FROM usage_lot_allocations x
						WHERE x.lot_id = l.id), 0) <> l.remaining_qty
					AND (NOT ${sharded} OR l.user_id = ANY(${ids}::text[]))) AS batch`;
	expectZero(
		"usage_record.plan_org_consistency",
		integrity?.usage_plan ?? 0n,
	);
	expectZero("cost_lot.source_org_consistency", integrity?.lot_source ?? 0n);
	expectZero(
		"usage_lot_allocation.parent_org_consistency",
		integrity?.ula_parents ?? 0n,
	);
	expectZero("usage_record.orphan_plan", integrity?.usage_orphan_plan ?? 0n);
	expectZero("cost_lot.orphan_source", integrity?.lot_orphan_source ?? 0n);
	expectZero("fifo_conservation.usage_allocations", integrity?.fifo ?? 0n);
	expectZero("batch_conservation.cost_lots", integrity?.batch ?? 0n);

	// 4. 无法归属到用户的孤儿派生行：仅全量模式评估（分片模式见文件头说明）
	if (!sharded) {
		const [orphans] = await db.$queryRaw<
			Array<{
				plan_allocations: bigint;
				usage_lot_allocations: bigint;
				plan_change_logs: bigint;
				plan_installments: bigint;
			}>
		>`
			SELECT
				(SELECT count(*) FROM plan_allocations a
					LEFT JOIN plans p ON p.id = a.plan_id
					WHERE p.id IS NULL) AS plan_allocations,
				(SELECT count(*) FROM usage_lot_allocations x
					LEFT JOIN usage_records u ON u.id = x.usage_id
					LEFT JOIN cost_lots l ON l.id = x.lot_id
					WHERE u.id IS NULL OR l.id IS NULL) AS usage_lot_allocations,
				(SELECT count(*) FROM plan_change_logs c
					LEFT JOIN plans p ON p.id = c.plan_id
					WHERE p.id IS NULL) AS plan_change_logs,
				(SELECT count(*) FROM plan_installments i
					LEFT JOIN plans p ON p.id = i.plan_id
					WHERE p.id IS NULL) AS plan_installments`;
		for (const [table, count] of Object.entries(orphans ?? {})) {
			expectZero(`derived_rows.orphans.${table}`, count);
		}
	}

	// 5. DataRequest 语义映射（§12.2.7）：EXPORT/DELETION 为 PERSONAL 且不挂组织；
	//    历史 CLEAR 归属默认组织（scope=ORGANIZATION）。
	//    defaults CTE 同第 1 项口径；无默认组织的用户的数据请求计为未映射（R2-I05）
	const [dataRequests] = await db.$queryRaw<Array<{ n: bigint }>>`
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
		SELECT count(*) AS n FROM data_requests r
		LEFT JOIN defaults d ON d.user_id = r.user_id
		WHERE (d.organization_id IS NULL
			OR ((r.type IN ('EXPORT', 'DELETION')
					AND (r.scope <> 'PERSONAL' OR r.organization_id IS NOT NULL))
				OR (r.type = 'CLEAR'
					AND (r.scope <> 'ORGANIZATION'
						OR r.organization_id IS DISTINCT FROM d.organization_id))))
			AND (NOT ${sharded} OR r.user_id = ANY(${ids}::text[]))`;
	expectZero("data_request.scope_mapping", dataRequests?.n ?? 0n);

	// 6. ReminderRead 对账（§12.2.5 / LEDGER-03）：存量已读提醒必有行主的成员级已读行
	const [reminderReads] = await db.$queryRaw<Array<{ n: bigint }>>`
		SELECT count(*) AS n FROM reminders r
		WHERE r.read_at IS NOT NULL
			AND NOT EXISTS (
				SELECT 1 FROM reminder_reads rr
				WHERE rr.reminder_id = r.id AND rr.user_id = r.user_id)
			AND (NOT ${sharded} OR r.user_id = ANY(${ids}::text[]))`;
	expectZero("reminder_read.parity", reminderReads?.n ?? 0n);

	// 7. 组织设置与记账起点（§12.3.6）：有 UserSettings 的用户，其默认组织必有
	//    同值的 OrganizationSettings（迁移复制不丢不改）。
	//    defaults CTE 同第 1 项口径；无默认组织的用户的个人设置计为「缺组织设置」
	//    （回填会为其新建组织并复制，与 dry-run 的 organizationSettingsCreated 同口径，R2-I05）
	const [settings] = await db.$queryRaw<Array<{ mismatch: bigint; missing: bigint }>>`
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
		SELECT
			(SELECT count(*) FROM user_settings s
				LEFT JOIN defaults d ON d.user_id = s.user_id
				JOIN organization_settings o ON o.organization_id = d.organization_id
				WHERE (o.base_currency <> s.base_currency
						OR o.prep_preference <> s.prep_preference
						OR o.reminder_enabled <> s.reminder_enabled
						OR o.ledger_started_at IS DISTINCT FROM s.ledger_started_at)
					AND (NOT ${sharded} OR s.user_id = ANY(${ids}::text[]))) AS mismatch,
			(SELECT count(*) FROM user_settings s
				LEFT JOIN defaults d ON d.user_id = s.user_id
				WHERE (d.organization_id IS NULL OR NOT EXISTS (
						SELECT 1 FROM organization_settings o
						WHERE o.organization_id = d.organization_id))
					AND (NOT ${sharded} OR s.user_id = ANY(${ids}::text[]))) AS missing`;
	expectZero("settings_parity.value_mismatch", settings?.mismatch ?? 0n);
	expectZero("settings_parity.missing", settings?.missing ?? 0n);

	return { checks, diffs, sharded };
}
