/**
 * MIG-F 前瞻：迁移 schema 能力探测（Goal #3C W29；技术方案 §12.2/§12.3）。
 *
 * 背景：MIG-F（Goal #3C W30）会删除一批 legacy 列——
 *   - 业务共享表上的冗余 `user_id`（`accounts` / `transactions` / `initial_holdings` /
 *     `cost_lots` / `plans` / `usage_records` / `corrections` / `reminders` /
 *     `ai_conversations`）；
 *   - `user_settings` 的 `base_currency` / `prep_preference` / `reminder_enabled` /
 *     `ledger_started_at`；
 *   - `reminders.read_at`（已读态已由成员级 `reminder_reads` 承载）；
 *   - `data_requests.user_id`（MIG-F 重命名为 `requester_user_id`）。
 *
 * 一旦这些列被删除，`organization-backfill.ts` 与 `organization-reconcile.ts` 里
 * 依赖它们的 SQL / ORM 读取就会因「列不存在」直接崩溃——迁移工具在 MIG-F 之后
 * 仍需能跑**基础一致性校验**（组织维度不变量），因此必须先知道当前库处于
 * 哪个阶段。
 *
 * 探测方式：查询 `information_schema.columns`（只读、无拼接、不触碰业务数据）。
 * 判定基准列按 MIG-D/E/F 的落地顺序取三根「信号柱」：
 *   - `accounts.user_id` → 组织账本表已彻底去个人化（MIG-F 的核心标志）；
 *   - `user_settings.base_currency` → 个人设置列已废弃；
 *   - `reminders.read_at` → 提醒已读列已废弃。
 * 三根信号柱之外，另按表逐一探测 `user_id`，让调用方能**逐表**决定跳过哪些
 * 回填/核对分支（部分表可能已先行删除列）。
 *
 * SQL 纪律：静态 SQL + 绑定参数（表名集合走 `= ANY($tables::text[])`），
 * 不拼接表名/列名、不使用 Prisma.raw。
 */

import type { Prisma } from "@prisma/client";

type QueryRunner = Prisma.TransactionClient["$queryRaw"];

/**
 * MIG-F 会删除冗余 `user_id` 的业务表（逐一探测，避免整库一刀切）。
 * `data_requests` 单列——MIG-F 把 `user_id` 重命名为 `requester_user_id`，
 * 其语义映射核对（§12.2.7）在重命名后需要改写列名，故一并探测。
 */
export const LEGACY_USER_ID_TABLES = [
	"accounts",
	"transactions",
	"initial_holdings",
	"cost_lots",
	"plans",
	"usage_records",
	"corrections",
	"reminders",
	"ai_conversations",
	"data_requests",
] as const;

export type LegacyUserIdTable = (typeof LEGACY_USER_ID_TABLES)[number];

/** `user_settings` 在 MIG-F 中被删除的 legacy 设置列 */
export const LEGACY_USER_SETTINGS_COLUMNS = [
	"base_currency",
	"prep_preference",
	"reminder_enabled",
	"ledger_started_at",
] as const;

/** 当前数据库的迁移阶段能力快照 */
export interface MigrationSchemaCapabilities {
	/** 仍保留 legacy `user_id` 列的表名集合（MIG-F 后为空集） */
	legacyUserIdTables: ReadonlySet<string>;
	/** `user_settings` 是否仍有 legacy 设置列（base_currency 等） */
	hasUserSettingsLegacyColumns: boolean;
	/** `reminders` 是否仍有 `read_at` 列 */
	hasReminderReadAtColumn: boolean;
	/** 是否已进入 MIG-F（`accounts.user_id` 已删除 = 组织账本表彻底去个人化） */
	migF: boolean;
}

/**
 * 探测当前库的迁移阶段能力。
 *
 * 只读 `information_schema.columns`；不触碰业务数据、不写库。
 */
export async function detectMigrationSchemaCapabilities(
	db: { $queryRaw: QueryRunner },
): Promise<MigrationSchemaCapabilities> {
	const tables = [...LEGACY_USER_ID_TABLES];
	const rows = await db.$queryRaw<
		Array<{ tableName: string; columnName: string }>
	>`
		SELECT table_name AS "tableName", column_name AS "columnName"
		FROM information_schema.columns
		WHERE table_schema = current_schema()
			AND (
				(column_name = 'user_id' AND table_name = ANY(${tables}::text[]))
				OR (
					table_name = 'user_settings'
					AND column_name = ANY(${[...LEGACY_USER_SETTINGS_COLUMNS]}::text[])
				)
				OR (table_name = 'reminders' AND column_name = 'read_at')
			)
	`;
	const legacyUserIdTables = new Set<string>();
	let userSettingsColumnCount = 0;
	let hasReminderReadAt = false;
	for (const row of rows) {
		if (row.columnName === "user_id") {
			legacyUserIdTables.add(row.tableName);
		} else if (row.tableName === "user_settings") {
			userSettingsColumnCount += 1;
		} else if (row.tableName === "reminders" && row.columnName === "read_at") {
			hasReminderReadAt = true;
		}
	}
	return {
		legacyUserIdTables,
		hasUserSettingsLegacyColumns:
			userSettingsColumnCount === LEGACY_USER_SETTINGS_COLUMNS.length,
		hasReminderReadAtColumn: hasReminderReadAt,
		migF: !legacyUserIdTables.has("accounts"),
	};
}

/** 该表是否仍可按 `user_id` 归属到个人（false = MIG-F 后该表已无此列） */
export function hasLegacyUserId(
	capabilities: MigrationSchemaCapabilities,
	table: LegacyUserIdTable,
): boolean {
	return capabilities.legacyUserIdTables.has(table);
}
