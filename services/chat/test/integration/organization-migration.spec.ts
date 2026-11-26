import { beforeAll, afterAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
	BackfillAnomalyError,
	backfillDefaultOrganizations,
} from "../../src/organization/organization-backfill";
import {
	reconcileMigration,
	captureMigrationSnapshot,
	compareMigrationSnapshots,
} from "../../src/organization/organization-reconcile";
import { detectMigrationSchemaCapabilities } from "../../src/organization/migration-schema-capabilities";
import { deleteOrganizationsCascadeLedger } from "../helpers/test-app";

/**
 * ToB 组织迁移演练（Goal #3C W30 · MIG-D/E/F）。
 *
 * ## 为什么在隔离 schema 里演练
 *
 * MIG-B 回填 / §12.3 核对的对象是 **pre-MIG-E 的库形态**：
 * `organization_id` 可空、8 张共享账本表仍有 `user_id` 列归属个人、
 * `user_settings` 仍有 4 个 legacy 设置列、`reminders` 仍有 `read_at`、
 * `data_requests` 仍是 `user_id`。
 *
 * W30（MIG-E / MIG-F）落地后主库已是 post-MIG-F 形态，上述列全部消失、
 * `organization_id` 已是 NOT NULL——**主库上再也无法重放「回填 / 核对」**
 * （迁移工具在 post-MIG-F 上退化为 no-op，核对改走组织维度分支）。
 *
 * 因此本文件用**独立隔离的 PostgreSQL schema** 承载演练：
 *
 * 1. 用仓库自身的迁移历史（`services/chat/prisma/migrations/**`）在隔离 schema 里
 *    **重建 pre-MIG-E 的 DDL**——按时间顺序逐条执行迁移 SQL，到 MIG-C 为止
 *    （MIG-E / MIG-F 不执行）。这是「pre-MIG-E DDL」的**构造性**保证，
 *    不是手写近似：部分唯一索引、CHECK 约束、FK 语义都来自真实迁移。
 * 2. 在隔离 schema 里灌入 legacy 个人账本（个人行的租户列为 NULL）。
 * 3. 对隔离 schema 跑**真实的** `backfillDefaultOrganizations` /
 *    `reconcileMigration`（源码零改动），断言 §12.3 零差异与父子组织一致性。
 * 4. 再在同一个隔离 schema 里依次执行 W26 / MIG-E / MIG-F 迁移，
 *    验证迁移工具在 post-MIG-F 上仍可运行且退化为 no-op。
 *
 * 隔离 schema 名带本用例专属前缀，结束时 `DROP SCHEMA ... CASCADE` 清理，
 * **全程不触碰 `public` schema**。
 *
 * ## 保留的核心断言（不得削弱）
 *
 * - §12.3 全量核对 0 差异，且核对项数量写死（防「查询写错 → 恒 0」的空过）；
 * - 父子组织一致性（UsageRecord↔Plan、CostLot↔来源、UsageLotAllocation↔双父、
 *   PlanChangeLog↔Plan）零跨组织；
 * - 回填只改租户列：业务事实（余额 / 计划 / 流水 / 批次 / 分摊 / 报告口径 / 设置）
 *   逐项不变，`updated_at` 逐行不变；
 * - 幂等重跑零变化；dry-run 估算 == 实际写入；
 * - 孤儿预检与跨组织异常被**显式报出**（绝不静默跳过）。
 */

/** 本用例专属的隔离 schema 前缀（不得与其它用例/库对象冲突） */
const DRILL_SCHEMA_PREFIX = "migdrill_w30";
/** 仓库迁移历史目录（pre-MIG-E DDL 的唯一来源） */
const MIGRATIONS_DIR = path.resolve(__dirname, "../../prisma/migrations");
/** MIG-E / MIG-F：演练库先停在 MIG-C，二者留到演练后段显式执行 */
const MIG_E_DIR = "20261126190000_tob_r1_mig_e_tighten_constraints";
const MIG_F_DIR = "20261126191000_tob_r1_mig_f_drop_legacy_columns";
/** W26：DataRequest 双域拆分的规范化 + CHECK 约束迁移 */
const W26_DIR = "20261125180000_tob_r1_data_request_scope_check";
/** 迁移历史里最后一个「pre-MIG-E」的迁移（MIG-C 之后即 W26 / MIG-E / MIG-F） */
const LAST_PRE_MIG_E_DIR = "20261125094500_tob_r1_mig_c_org_unique_indexes";

const RUN = `migdrill-${Date.now()}`;
const DRILL_SCHEMA = `${DRILL_SCHEMA_PREFIX}_${Date.now()}_${Math.random()
	.toString(36)
	.slice(2, 8)}`;

const main = new PrismaClient();
/** 隔离 schema 的客户端（search_path 指向 DRILL_SCHEMA，全程不碰 public） */
let drill: PrismaClient;

/** 主库侧用例（post-MIG-F 契约）创建的组织与用户 */
const mainOrgIds: string[] = [];
const mainUserIds: string[] = [];

/** 演练库里的用户 id（按角色区分） */
const drillUsers = {
	/** 完整个人账本用户（无默认组织 → 由 MIG-B 回填创建） */
	full: "",
	/** 有个人设置但无默认组织 */
	withSettings: "",
	/** 无个人设置（不得虚构 OrganizationSettings） */
	bare: "",
	/** 已有默认组织的用户（回填应复用，不新建） */
	existing: "",
};

/** 演练库里的行 id（供破坏 / 还原用例定位） */
const drillRows = {
	planId: "",
	usageId: "",
	initialUsdLotId: "",
	purchaseLotId: "",
	readReminderId: "",
	unreadReminderId: "",
	accountUsdId: "",
};

const T0 = new Date("2026-01-05T00:00:00.000Z");

/** 回填**前**的业务事实快照（按 user_id 归属）；回填后按 organization_id 归属并比对 */
let factsBeforeBackfill: Record<string, string[]> = {};
/** 回填**前**的时间戳快照（表:行 → 毫秒）；回填不得触碰任何既有行的时间戳 */
let updatedAtBeforeBackfill: Array<[string, number]> = [];

// ─────────────────────────── SQL 语句拆分 ───────────────────────────

/**
 * 把迁移 SQL 拆成单条语句。
 *
 * Prisma 的 `$executeRawUnsafe` 走扩展协议（prepared statement），一条调用只能带
 * 一条语句（多语句报 `42601 cannot insert multiple commands into a prepared statement`），
 * 因此逐条执行前必须自己切分。切分需正确跳过：行注释、块注释、`'...'` 字符串
 * （`''` 转义）、`"..."` 标识符（`""` 转义）、`$$...$$` / `$tag$...$tag$` 美元引用。
 *
 * 切分错误不会静默通过——语句执行失败会直接让用例红。
 */
function splitSqlStatements(sql: string): string[] {
	const statements: string[] = [];
	let buffer = "";
	let index = 0;

	const flush = () => {
		const trimmed = buffer.trim();
		if (trimmed.length > 0) statements.push(trimmed);
		buffer = "";
	};

	while (index < sql.length) {
		const char = sql[index]!;
		const next = sql[index + 1];

		if (char === "-" && next === "-") {
			while (index < sql.length && sql[index] !== "\n") index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (
				index < sql.length &&
				!(sql[index] === "*" && sql[index + 1] === "/")
			)
				index += 1;
			index += 2;
			continue;
		}
		if (char === "'") {
			buffer += char;
			index += 1;
			while (index < sql.length) {
				if (sql[index] === "'") {
					if (sql[index + 1] === "'") {
						buffer += "''";
						index += 2;
						continue;
					}
					buffer += "'";
					index += 1;
					break;
				}
				buffer += sql[index];
				index += 1;
			}
			continue;
		}
		if (char === '"') {
			buffer += char;
			index += 1;
			while (index < sql.length) {
				if (sql[index] === '"') {
					if (sql[index + 1] === '"') {
						buffer += '""';
						index += 2;
						continue;
					}
					buffer += '"';
					index += 1;
					break;
				}
				buffer += sql[index];
				index += 1;
			}
			continue;
		}
		if (char === "$") {
			const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index));
			if (tag) {
				const marker = tag[0];
				const end = sql.indexOf(marker, index + marker.length);
				const stop = end === -1 ? sql.length : end + marker.length;
				buffer += sql.slice(index, stop);
				index = stop;
				continue;
			}
		}
		if (char === ";") {
			flush();
			index += 1;
			continue;
		}
		buffer += char;
		index += 1;
	}
	flush();
	return statements;
}

/** 迁移历史目录（按时间排序） */
function migrationDirs(): string[] {
	return readdirSync(MIGRATIONS_DIR)
		.filter((entry) => statSync(path.join(MIGRATIONS_DIR, entry)).isDirectory())
		.sort();
}

/** 在隔离 schema 里执行一份迁移（逐条语句；BEGIN/COMMIT 交由每条语句的隐式事务承担） */
async function applyMigration(db: PrismaClient, dir: string): Promise<number> {
	const sql = readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8");
	const statements = splitSqlStatements(sql).filter(
		(statement) => !/^(BEGIN|COMMIT|ROLLBACK)$/i.test(statement),
	);
	for (const statement of statements) {
		await db.$executeRawUnsafe(statement);
	}
	return statements.length;
}

/** 隔离 schema 的连接串（Prisma 按 ?schema= 设置 search_path） */
function drillUrl(): string {
	const url = new URL(process.env.DATABASE_URL!);
	url.searchParams.set("schema", DRILL_SCHEMA);
	return url.toString();
}

// ─────────────────────────── legacy 数据灌入 ───────────────────────────

interface LegacyUserSeed {
	email: string;
	name: string;
	/** 已有默认组织（组织与首个 OWNER 成员同事务创建） */
	withDefaultOrg?: boolean;
	/** 个人设置（pre-MIG-F 的 user_settings 4 个 legacy 列） */
	settings?: {
		baseCurrency: string;
		prepPreference: string;
		reminderEnabled: boolean;
		ledgerStartedAt: Date | null;
	};
}

/**
 * 灌入一个 legacy 个人用户。
 *
 * 全部走裸 SQL：pre-MIG-E 的账本表带 NOT NULL 的 `user_id`，而当前 Prisma client
 * 的 datamodel 已是 post-MIG-F（无 `user_id` 字段），ORM 无法表达这种行。
 */
async function seedLegacyUser(seed: LegacyUserSeed): Promise<string> {
	const user = await drill.user.create({
		data: { email: seed.email, passwordHash: "test-hash", name: seed.name },
		select: { id: true },
	});
	const userId = user.id;

	if (seed.withDefaultOrg) {
		// 组织与其首个 OWNER 成员关系同事务创建（created_at 恒等 = 「创建者」口径）
		await drill.organization.create({
			data: {
				name: `${seed.name}的工作台`,
				memberships: { create: { userId, role: "OWNER", status: "ACTIVE" } },
			},
			select: { id: true },
		});
	}

	if (seed.settings) {
		await drill.$executeRawUnsafe(
			`INSERT INTO user_settings
				(id, user_id, locale, region, base_currency, prep_preference, reminder_enabled, ledger_started_at, created_at, updated_at)
			 VALUES ($1, $2, 'zh-CN', 'CN', $3, $4, $5, $6::timestamp, now(), now())`,
			`${RUN}-settings-${userId}`,
			userId,
			seed.settings.baseCurrency,
			seed.settings.prepPreference,
			seed.settings.reminderEnabled,
			seed.settings.ledgerStartedAt,
		);
	}
	return userId;
}

/** 灌入完整个人账本（多币种账户 / 持仓 / 批次 / 计划 / 分配 / 排期 / 变更日志 / 交易 / 使用 / 分摊 / 更正 / 提醒 / AI 会话 / 数据请求） */
async function seedLegacyLedger(userId: string): Promise<void> {
	const iso = (value: Date) => value.toISOString();
	// 账户（多币种）
	for (const [code, balance] of [
		["USD", "1000.5000"],
		["EUR", "200.2500"],
		["JPY", "0.0000"],
	] as const) {
		await drill.$executeRawUnsafe(
			`INSERT INTO accounts (id, user_id, organization_id, created_by_id, currency_code, balance, created_at, updated_at)
			 VALUES ($1, $2, NULL, NULL, $3, $4::numeric, now(), now())`,
			`${RUN}-acc-${code}`,
			userId,
			code,
			balance,
		);
	}
	// 初始持仓 + INITIAL 批次
	for (const [code, amount, cost, remaining] of [
		["USD", "500.0000", "3600.0000", "450.0000"],
		["EUR", "100.0000", "790.0000", "100.0000"],
	] as const) {
		const holdingId = `${RUN}-ih-${code}`;
		await drill.$executeRawUnsafe(
			`INSERT INTO initial_holdings
				(id, user_id, organization_id, created_by_id, currency_code, amount, rate, raw_rate, rate_source, rate_observed_at, cost, confirmed_at, created_at, updated_at)
			 VALUES ($1, $2, NULL, NULL, $3, $4::numeric, 7.2000000000, 7.2000000000, 'identity', $5::timestamp, $6::numeric, $5::timestamp, now(), now())`,
			holdingId,
			userId,
			code,
			amount,
			iso(T0),
			cost,
		);
		const lotId = `${RUN}-lot-initial-${code}`;
		await drill.$executeRawUnsafe(
			`INSERT INTO cost_lots
				(id, user_id, organization_id, currency_code, source_type, source_id, quantity, remaining_qty, unit_cost, total_cost, acquired_at, created_at, updated_at)
			 VALUES ($1, $2, NULL, $3, 'INITIAL', $4, $5::numeric, $6::numeric, 7.2000000000, $7::numeric, $8::timestamp, now(), now())`,
			lotId,
			userId,
			code,
			holdingId,
			amount,
			remaining,
			cost,
			iso(T0),
		);
		if (code === "USD") drillRows.initialUsdLotId = lotId;
	}
	// 计划 + 分配 + 排期 + 变更日志
	const planId = `${RUN}-plan`;
	drillRows.planId = planId;
	await drill.$executeRawUnsafe(
		`INSERT INTO plans
			(id, user_id, organization_id, created_by_id, name, pace_preference, target_currency, target_amount, expect_use_date, prep_lead_days, latest_prep_date, plan_start_date, status, created_at, updated_at)
		 VALUES ($1, $2, NULL, NULL, NULL, 'balanced', 'USD', 300.0000, $3::timestamp, 3, $4::timestamp, NULL, 'ACTIVE', now(), now())`,
		planId,
		userId,
		iso(new Date("2026-06-01T00:00:00.000Z")),
		iso(new Date("2026-05-25T00:00:00.000Z")),
	);
	await drill.$executeRawUnsafe(
		`INSERT INTO plan_allocations (id, plan_id, amount, used_amount, created_at, updated_at)
		 VALUES ($1, $2, 300.0000, 50.0000, now(), now())`,
		`${RUN}-alloc`,
		planId,
	);
	for (const seq of [1, 2, 3]) {
		await drill.$executeRawUnsafe(
			`INSERT INTO plan_installments (id, plan_id, seq, scheduled_at, amount)
			 VALUES ($1, $2, $3, $4::timestamp, 100.0000)`,
			`${RUN}-inst-${seq}`,
			planId,
			seq,
			iso(new Date(Date.UTC(2026, 2, seq * 10))),
		);
	}
	await drill.$executeRawUnsafe(
		`INSERT INTO plan_change_logs
			(id, plan_id, organization_id, actor_user_id, change_type, before_target, after_target, before_alloc, after_alloc, released_amount, before_snapshot, after_snapshot, created_at)
		 VALUES ($1, $2, NULL, NULL, 'ALLOCATION_ADJUSTED', 300.0000, 300.0000, 250.0000, 300.0000, 0.0000, '{"amount":"250.0000"}'::jsonb, '{"amount":"300.0000"}'::jsonb, now())`,
		`${RUN}-changelog`,
		planId,
	);
	// 买入交易 + PURCHASE 批次
	const txnId = `${RUN}-txn`;
	await drill.$executeRawUnsafe(
		`INSERT INTO transactions
			(id, user_id, organization_id, created_by_id, currency_code, quantity, principal_amount, fee_amount, exchange_rate, rate_source, rate_observed_at, plan_id, transacted_at, version, created_at, updated_at)
		 VALUES ($1, $2, NULL, NULL, 'USD', 20.0000, 144.0000, 2.0000, 7.2000000000, 'identity', $3::timestamp, $4, $3::timestamp, 1, now(), now())`,
		txnId,
		userId,
		iso(new Date("2026-02-01T00:00:00.000Z")),
		planId,
	);
	const purchaseLotId = `${RUN}-lot-purchase`;
	drillRows.purchaseLotId = purchaseLotId;
	await drill.$executeRawUnsafe(
		`INSERT INTO cost_lots
			(id, user_id, organization_id, currency_code, source_type, source_id, quantity, remaining_qty, unit_cost, total_cost, acquired_at, created_at, updated_at)
		 VALUES ($1, $2, NULL, 'USD', 'PURCHASE', $3, 20.0000, 20.0000, 7.2000000000, 144.0000, $4::timestamp, now(), now())`,
		purchaseLotId,
		userId,
		txnId,
		iso(new Date("2026-02-01T00:00:00.000Z")),
	);
	// 使用 + FIFO 分摊（50 全部来自 INITIAL 批次，守恒）
	const usageId = `${RUN}-usage`;
	drillRows.usageId = usageId;
	await drill.$executeRawUnsafe(
		`INSERT INTO usage_records
			(id, user_id, organization_id, created_by_id, plan_id, currency_code, amount, used_at, remark, version, created_at, updated_at)
		 VALUES ($1, $2, NULL, NULL, $3, 'USD', 50.0000, $4::timestamp, NULL, 1, now(), now())`,
		usageId,
		userId,
		planId,
		iso(new Date("2026-03-01T00:00:00.000Z")),
	);
	await drill.$executeRawUnsafe(
		`INSERT INTO usage_lot_allocations (id, usage_id, lot_id, quantity, cost, created_at, updated_at)
		 VALUES ($1, $2, $3, 50.0000, 360.0000, now(), now())`,
		`${RUN}-ula`,
		usageId,
		drillRows.initialUsdLotId,
	);
	// 更正（APPLIED + FAILED）
	await drill.$executeRawUnsafe(
		`INSERT INTO corrections
			(id, user_id, organization_id, actor_user_id, target_type, target_id, reason, before_snapshot, after_snapshot, status, fail_reason, created_at, updated_at)
		 VALUES ($1, $2, NULL, NULL, 'TRANSACTION', $3, '手续费误录', '{"feeAmount":"2.0000"}'::jsonb, '{"feeAmount":"1.5000"}'::jsonb, 'APPLIED', NULL, now(), now())`,
		`${RUN}-corr-ok`,
		userId,
		txnId,
	);
	await drill.$executeRawUnsafe(
		`INSERT INTO corrections
			(id, user_id, organization_id, actor_user_id, target_type, target_id, reason, before_snapshot, after_snapshot, status, fail_reason, created_at, updated_at)
		 VALUES ($1, $2, NULL, NULL, 'TRANSACTION', $3, '演练失败行', '{}'::jsonb, '{}'::jsonb, 'FAILED', '目标不存在', now(), now())`,
		`${RUN}-corr-failed`,
		userId,
		`${RUN}-missing`,
	);
	// 提醒：一条已读（read_at）+ 一条未读
	await drill.$executeRawUnsafe(
		`INSERT INTO reminders
			(id, user_id, organization_id, type, plan_id, dedup_key, scheduled_for, read_at, created_at, updated_at)
		 VALUES ($1, $2, NULL, 'PLAN_DUE', $3, $4, $5::timestamp, $6::timestamp, now(), now())`,
		`${RUN}-rem-due`,
		userId,
		planId,
		`${RUN}-due`,
		iso(new Date("2026-05-25T00:00:00.000Z")),
		iso(new Date("2026-05-26T08:00:00.000Z")),
	);
	drillRows.readReminderId = `${RUN}-rem-due`;
	await drill.$executeRawUnsafe(
		`INSERT INTO reminders
			(id, user_id, organization_id, type, plan_id, dedup_key, scheduled_for, read_at, created_at, updated_at)
		 VALUES ($1, $2, NULL, 'PLAN_PREP', $3, $4, $5::timestamp, NULL, now(), now())`,
		`${RUN}-rem-prep`,
		userId,
		planId,
		`${RUN}-prep`,
		iso(new Date("2026-05-22T00:00:00.000Z")),
	);
	drillRows.unreadReminderId = `${RUN}-rem-prep`;
	// AI 会话（个人所有，user_id 保留）
	await drill.$executeRawUnsafe(
		`INSERT INTO ai_conversations (id, user_id, organization_id, title, last_message_at, created_at, updated_at)
		 VALUES ($1, $2, NULL, '迁移验收会话', $3::timestamp, now(), now())`,
		`${RUN}-conv`,
		userId,
		iso(new Date("2026-03-01T00:00:00.000Z")),
	);
	// 数据请求：EXPORT（终态）/ DELETION（终态），个人域存量行
	await drill.$executeRawUnsafe(
		`INSERT INTO data_requests
			(id, user_id, organization_id, scope, type, status, requested_at, due_at, created_at, updated_at)
		 VALUES ($1, $2, NULL, 'PERSONAL', 'EXPORT', 'COMPLETED', $3::timestamp, $4::timestamp, now(), now()),
			   ($5, $2, NULL, 'PERSONAL', 'DELETION', 'CANCELLED', $6::timestamp, $7::timestamp, now(), now()),
			   ($8, $2, NULL, 'PERSONAL', 'CLEAR', 'PENDING', $9::timestamp, $10::timestamp, now(), now())`,
		`${RUN}-req-export`,
		userId,
		iso(new Date("2026-03-10T00:00:00.000Z")),
		iso(new Date("2026-03-24T00:00:00.000Z")),
		`${RUN}-req-deletion`,
		iso(new Date("2026-03-12T00:00:00.000Z")),
		iso(new Date("2026-03-26T00:00:00.000Z")),
		`${RUN}-req-clear`,
		iso(new Date("2026-03-15T00:00:00.000Z")),
		iso(new Date("2026-03-29T00:00:00.000Z")),
	);
}

// ─────────────────────────── 业务事实采集（§12.3 七类口径） ───────────────────────────

/**
 * 按 §12.3 的口径采集「业务事实」。
 *
 * 只采集**业务事实**（余额 / 计划 / 流水 / 批次 / 分摊 / 报告输入 / 设置），
 * 不含租户列——回填只允许改租户列，因此该快照在回填前后必须逐项相等。
 * 归属键在回填前是 `user_id`、回填后是 `organization_id`，由调用方映射后比较。
 */
async function businessFacts(
	db: PrismaClient,
	ownerColumn: "user_id" | "organization_id",
): Promise<Record<string, string[]>> {
	const owner = ownerColumn;
	const balances = await db.$queryRawUnsafe<Array<{ owner: string; c: string; b: string }>>(
		`SELECT ${owner} AS owner, currency_code AS c,
			trim(to_char(SUM(balance), 'FM99999999999999999990.0000')) AS b
		 FROM accounts GROUP BY 1, 2 ORDER BY 1, 2`,
	);
	const plans = await db.$queryRawUnsafe<Array<{ owner: string; line: string }>>(
		`SELECT ${owner} AS owner,
			concat_ws('|', p.target_currency, p.target_amount::text, p.status,
				COALESCE((SELECT a.amount::text FROM plan_allocations a WHERE a.plan_id = p.id), 'NULL'),
				COALESCE((SELECT a.used_amount::text FROM plan_allocations a WHERE a.plan_id = p.id), 'NULL'),
				(SELECT count(*)::text FROM plan_installments i WHERE i.plan_id = p.id),
				COALESCE((SELECT SUM(i.amount)::text FROM plan_installments i WHERE i.plan_id = p.id), '0')
			) AS line
		 FROM plans p ORDER BY p.id`,
	);
	const ledger = await db.$queryRawUnsafe<Array<{ owner: string; line: string }>>(
		`SELECT ${owner} AS owner, 'txn|' || count(*)::text || '|' ||
			COALESCE(SUM(principal_amount)::text, '0') || '|' || COALESCE(SUM(version)::text, '0') AS line
		 FROM transactions GROUP BY 1
		 UNION ALL
		 SELECT ${owner}, 'usage|' || count(*)::text || '|' ||
			COALESCE(SUM(amount)::text, '0') || '|' || COALESCE(SUM(version)::text, '0')
		 FROM usage_records GROUP BY 1
		 UNION ALL
		 SELECT ${owner}, 'correction|' || count(*)::text FROM corrections GROUP BY 1
		 ORDER BY 1, 2`,
	);
	const lots = await db.$queryRawUnsafe<Array<{ owner: string; line: string }>>(
		`SELECT ${owner} AS owner,
			concat_ws('|', source_type, quantity::text, remaining_qty::text, unit_cost::text, total_cost::text) AS line
		 FROM cost_lots ORDER BY id`,
	);
	const allocations = await db.$queryRawUnsafe<Array<{ owner: string; line: string }>>(
		`SELECT u.${owner} AS owner,
			concat_ws('|', count(*)::text,
				COALESCE(SUM(x.quantity)::text, '0'),
				COALESCE(SUM(x.cost)::text, '0')) AS line
		 FROM usage_lot_allocations x JOIN usage_records u ON u.id = x.usage_id
		 GROUP BY 1 ORDER BY 1`,
	);
	const report = await db.$queryRawUnsafe<Array<{ owner: string; line: string }>>(
		`WITH alloc AS (
			SELECT u.${owner} AS owner, x.cost, x.quantity, l.source_type,
				COALESCE(t.fee_amount, -1) AS fee_amount
			FROM usage_lot_allocations x
			JOIN usage_records u ON u.id = x.usage_id
			JOIN cost_lots l ON l.id = x.lot_id
			LEFT JOIN transactions t ON l.source_type = 'PURCHASE' AND t.id = l.source_id
		)
		 SELECT owner,
			concat_ws('|',
				trim(to_char(COALESCE(SUM(cost), 0), 'FM99999999999999999990.0000')),
				trim(to_char(COALESCE(SUM(CASE WHEN source_type = 'INITIAL' THEN cost ELSE 0 END), 0), 'FM99999999999999999990.0000')),
				trim(to_char(COALESCE(SUM(CASE WHEN source_type = 'PURCHASE' THEN cost ELSE 0 END), 0), 'FM99999999999999999990.0000')),
				trim(to_char(COALESCE(SUM(CASE WHEN source_type = 'INITIAL' THEN quantity ELSE 0 END), 0), 'FM99999999999999999990.0000')),
				trim(to_char(COALESCE(SUM(CASE WHEN source_type = 'PURCHASE' THEN quantity ELSE 0 END), 0), 'FM99999999999999999990.0000')),
				count(*) FILTER (WHERE source_type = 'PURCHASE' AND fee_amount < 0)::text
			) AS line
		 FROM alloc GROUP BY owner ORDER BY owner`,
	);
	const planInputs = await db.$queryRawUnsafe<Array<{ owner: string; line: string }>>(
		`SELECT ${owner} AS owner,
			concat_ws('|', p.id, p.target_amount::text,
				COALESCE((SELECT SUM(u.amount)::text FROM usage_records u WHERE u.plan_id = p.id), '0')) AS line
		 FROM plans p ORDER BY p.id`,
	);
	const settings =
		owner === "user_id"
			? await db.$queryRawUnsafe<Array<{ owner: string; line: string }>>(
					`SELECT user_id AS owner,
						concat_ws('|', COALESCE(base_currency, 'NULL'), prep_preference,
							reminder_enabled::text,
							COALESCE(to_char(ledger_started_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS'), 'NULL')) AS line
					 FROM user_settings ORDER BY user_id`,
				)
			: await db.$queryRawUnsafe<Array<{ owner: string; line: string }>>(
					`SELECT organization_id AS owner,
						concat_ws('|', COALESCE(base_currency, 'NULL'), prep_preference,
							reminder_enabled::text,
							COALESCE(to_char(ledger_started_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS'), 'NULL')) AS line
					 FROM organization_settings ORDER BY organization_id`,
				);
	return {
		balances: balances.map((row) => `${row.owner}|${row.c}|${row.b}`).sort(),
		plans: plans.map((row) => `${row.owner}|${row.line}`).sort(),
		ledger: ledger.map((row) => `${row.owner}|${row.line}`).sort(),
		lots: lots.map((row) => `${row.owner}|${row.line}`).sort(),
		allocations: allocations.map((row) => `${row.owner}|${row.line}`).sort(),
		report: report.map((row) => `${row.owner}|${row.line}`).sort(),
		planInputs: planInputs.map((row) => `${row.owner}|${row.line}`).sort(),
		settings: settings.map((row) => `${row.owner}|${row.line}`).sort(),
	};
}

/** 把「按 user_id 归属」的事实改写成「按 organization_id 归属」（回填后的形态） */
function remapFacts(
	facts: Record<string, string[]>,
	userToOrg: Map<string, string>,
): Record<string, string[]> {
	const remapped: Record<string, string[]> = {};
	for (const [key, lines] of Object.entries(facts)) {
		remapped[key] = lines
			.map((line) => {
				const separator = line.indexOf("|");
				const owner = line.slice(0, separator);
				const org = userToOrg.get(owner);
				return `${org ?? owner}${line.slice(separator)}`;
			})
			.sort();
	}
	return remapped;
}

/** 演练库里「用户 → 默认组织」映射 */
async function userToDefaultOrg(): Promise<Map<string, string>> {
	const rows = await drill.$queryRawUnsafe<Array<{ userId: string; organizationId: string }>>(
		`WITH first_members AS (
			SELECT DISTINCT ON (m.organization_id)
				m.organization_id, m.user_id, m.created_at, m.id
			FROM memberships m
			ORDER BY m.organization_id, m.created_at ASC, m.id ASC
		)
		SELECT DISTINCT f.user_id AS "userId", f.organization_id AS "organizationId"
		FROM first_members f
		JOIN organizations o ON o.id = f.organization_id
		WHERE f.created_at = o.created_at
		ORDER BY f.user_id`,
	);
	return new Map(rows.map((row) => [row.userId, row.organizationId]));
}


/**
 * 回填前的时间戳快照（§12.2.6「时间戳不改」）。
 *
 * 覆盖 9 张带 `updated_at` 的业务表 + `plan_change_logs`（只有 `created_at`，
 * 回填不得删除重建）+ `data_requests`（created / updated / requested / due）。
 */
async function updatedAtSnapshot(db: PrismaClient): Promise<Array<[string, number]>> {
	const snapshot: Array<[string, number]> = [];
	for (const table of [
		"accounts",
		"transactions",
		"initial_holdings",
		"cost_lots",
		"plans",
		"usage_records",
		"corrections",
		"reminders",
		"ai_conversations",
	]) {
		const rows = await db.$queryRawUnsafe<Array<{ id: string; updated_at: Date }>>(
			`SELECT id, updated_at FROM ${table}`,
		);
		for (const row of rows) {
			snapshot.push([`${table}:${row.id}`, row.updated_at.getTime()]);
		}
	}
	const logs = await db.$queryRawUnsafe<Array<{ id: string; created_at: Date }>>(
		`SELECT id, created_at FROM plan_change_logs`,
	);
	for (const row of logs) {
		snapshot.push([`plan_change_logs:${row.id}`, row.created_at.getTime()]);
	}
	const requests = await db.$queryRawUnsafe<
		Array<{
			id: string;
			created_at: Date;
			updated_at: Date;
			requested_at: Date;
			due_at: Date;
		}>
	>(`SELECT id, created_at, updated_at, requested_at, due_at FROM data_requests`);
	for (const row of requests) {
		snapshot.push([`data_requests:${row.id}:created`, row.created_at.getTime()]);
		snapshot.push([`data_requests:${row.id}:updated`, row.updated_at.getTime()]);
		snapshot.push([`data_requests:${row.id}:requested`, row.requested_at.getTime()]);
		snapshot.push([`data_requests:${row.id}:due`, row.due_at.getTime()]);
	}
	return snapshot.sort((left, right) => (left[0] < right[0] ? -1 : 1));
}

// ─────────────────────────── 生命周期 ───────────────────────────

beforeAll(async () => {
	// 1. 建隔离 schema
	await main.$executeRawUnsafe(`CREATE SCHEMA "${DRILL_SCHEMA}"`);
	drill = new PrismaClient({ datasources: { db: { url: drillUrl() } } });

	// 2. 用仓库迁移历史在隔离 schema 里重建 pre-MIG-E 的 DDL
	for (const dir of migrationDirs()) {
		if (dir === MIG_E_DIR || dir === MIG_F_DIR) continue;
		if (dir > LAST_PRE_MIG_E_DIR) break; // 到 MIG-C 为止（W26 / MIG-E / MIG-F 稍后显式执行）
		await applyMigration(drill, dir);
	}

	// 3. 灌入 legacy 个人数据
	drillUsers.full = await seedLegacyUser({
		email: `${RUN}-full@example.com`,
		name: "迁移验收张三",
	});
	await seedLegacyLedger(drillUsers.full);

	drillUsers.withSettings = await seedLegacyUser({
		email: `${RUN}-settings@example.com`,
		name: "有个人设置用户",
		settings: {
			baseCurrency: "USD",
			prepPreference: "cautious",
			reminderEnabled: false,
			ledgerStartedAt: T0,
		},
	});

	drillUsers.bare = await seedLegacyUser({
		email: `${RUN}-bare@example.com`,
		name: "无设置用户",
	});

	drillUsers.existing = await seedLegacyUser({
		email: `${RUN}-existing@example.com`,
		name: "已有默认组织用户",
		withDefaultOrg: true,
	});

	// 回填前的业务事实快照（§12.3 七类口径，按 user_id 归属）
	factsBeforeBackfill = await businessFacts(drill, "user_id");
	// 回填前的时间戳快照（§12.2.6：回填不得触碰任何既有行的时间戳）
	updatedAtBeforeBackfill = await updatedAtSnapshot(drill);
}, 180_000);

afterAll(async () => {
	if (drill) await drill.$disconnect();
	// 隔离 schema 一律 CASCADE 清理；public schema 不受影响
	await main.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${DRILL_SCHEMA}" CASCADE`);
	// 主库侧用例的清理（账本子表 → 组织 → 用户）
	await main.$transaction(async (tx) => {
		await deleteOrganizationsCascadeLedger(tx, mainOrgIds);
		await tx.organization.deleteMany({ where: { id: { in: mainOrgIds } } });
	});
	if (mainUserIds.length > 0) {
		await main.user.deleteMany({ where: { id: { in: mainUserIds } } });
	}
	await main.$disconnect();
});

// ─────────────────────────── 隔离 schema 演练 ───────────────────────────

describe("隔离 schema：pre-MIG-E 的 MIG-B 回填与 §12.3 核对", () => {
	test("隔离 schema 建成 pre-MIG-E 形态：organization_id 可空、user_id 列在、legacy 部分唯一索引与 CHECK 前置状态齐备", async () => {
		const columns = await drill.$queryRawUnsafe<
			Array<{ table_name: string; column_name: string; is_nullable: string }>
		>(
			`SELECT table_name, column_name, is_nullable
			 FROM information_schema.columns
			 WHERE table_schema = current_schema()
				AND (
					(table_name IN ('accounts','transactions','initial_holdings','cost_lots','plans','usage_records','corrections','reminders') AND column_name = 'user_id')
					OR (table_name = 'user_settings' AND column_name IN ('base_currency','prep_preference','reminder_enabled','ledger_started_at'))
					OR (table_name = 'reminders' AND column_name = 'read_at')
					OR (table_name = 'data_requests' AND column_name = 'user_id')
					OR (table_name = 'accounts' AND column_name = 'organization_id')
				)
			 ORDER BY table_name, column_name`,
		);
		const byKey = new Map(
			columns.map((row) => [`${row.table_name}.${row.column_name}`, row]),
		);
		// 8 张共享账本表的 user_id 仍在（NOT NULL）
		for (const table of [
			"accounts",
			"transactions",
			"initial_holdings",
			"cost_lots",
			"plans",
			"usage_records",
			"corrections",
			"reminders",
		]) {
			expect(byKey.get(`${table}.user_id`)?.is_nullable, table).toBe("NO");
		}
		// organization_id 仍可空（pre-MIG-E）
		expect(byKey.get("accounts.organization_id")?.is_nullable).toBe("YES");
		// user_settings 的 4 个 legacy 设置列仍在
		for (const column of [
			"base_currency",
			"prep_preference",
			"reminder_enabled",
			"ledger_started_at",
		]) {
			expect(byKey.has(`user_settings.${column}`), column).toBe(true);
		}
		// reminders.read_at 仍在；data_requests 仍是 user_id
		expect(byKey.has("reminders.read_at")).toBe(true);
		expect(byKey.get("data_requests.user_id")?.is_nullable).toBe("NO");

		// 过渡期部分唯一索引仍在（MIG-C 引入、MIG-E 删除）
		const indexes = await drill.$queryRawUnsafe<Array<{ indexname: string }>>(
			`SELECT indexname FROM pg_indexes
			 WHERE schemaname = current_schema()
				AND indexname IN ('accounts_legacy_user_currency_uidx','initial_holdings_legacy_user_currency_uidx','reminders_legacy_user_dedup_scheduled_uidx')`,
		);
		expect(indexes.map((row) => row.indexname).sort()).toEqual([
			"accounts_legacy_user_currency_uidx",
			"initial_holdings_legacy_user_currency_uidx",
			"reminders_legacy_user_dedup_scheduled_uidx",
		]);

		// 库阶段能力探测：仍在 MIG-F 之前
		const capabilities = await detectMigrationSchemaCapabilities(drill);
		expect(capabilities.migF).toBe(false);
		expect(capabilities.hasUserSettingsLegacyColumns).toBe(true);
		expect(capabilities.hasReminderReadAtColumn).toBe(true);
		expect(capabilities.legacyUserIdTables.has("accounts")).toBe(true);
		expect(capabilities.legacyUserIdTables.has("data_requests")).toBe(true);
	});

	test("回填前：§12.3 核对显式报出差异（核对不是恒 0 的空过）", async () => {
		const result = await reconcileMigration(drill);
		const scopes = result.diffs.map((diff) => diff.scope);
		// 无默认组织的用户 → default_org.missing
		expect(scopes).toContain("default_org.missing");
		// 存量个人行尚未归组 → 10 张表的行集映射全部报出
		for (const table of [
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
		]) {
			expect(scopes, table).toContain(`row_mapping.${table}`);
		}
		// 已读提醒尚未落成员级已读行
		expect(scopes).toContain("reminder_read.parity");
		// 组织设置尚未复制
		expect(scopes).toContain("settings_parity.missing");
		expect(result.sharded).toBe(false);
	});

	test("回填：生产 dry-run == 实际写入（逐项一致，含分片 dry-run）；时间戳逐行不变", async () => {
		const estimate = await backfillDefaultOrganizations(drill, { dryRun: true });
		const shardedFullDry = await backfillDefaultOrganizations(drill, {
			dryRun: true,
			userIds: [drillUsers.full],
		});
		const shardedExistingDry = await backfillDefaultOrganizations(drill, {
			dryRun: true,
			userIds: [drillUsers.existing],
		});
		expect(shardedFullDry).toMatchObject({
			usersProcessed: 1,
			organizationsCreated: 1,
			ownerMembershipsCreated: 1,
			usersSkippedIdempotent: 0,
			dataRequestsRescoped: 1,
			rowsBackfilled: estimate.rowsBackfilled,
		});
		expect(shardedExistingDry).toMatchObject({
			usersProcessed: 1,
			organizationsCreated: 0,
			ownerMembershipsCreated: 0,
			usersSkippedIdempotent: 1,
			dataRequestsRescoped: 0,
		});

		const orgCountBefore = await drill.organization.count();
		const settingsCountBefore = await drill.organizationSettings.count();

		const actual = await backfillDefaultOrganizations(drill);

		// 估算 == 实际写入（逐项）
		expect(actual.organizationsCreated).toBe(estimate.organizationsCreated);
		expect(actual.ownerMembershipsCreated).toBe(estimate.ownerMembershipsCreated);
		expect(actual.organizationSettingsCreated).toBe(estimate.organizationSettingsCreated);
		expect(actual.reminderReadsCreated).toBe(estimate.reminderReadsCreated);
		expect(actual.dataRequestsRescoped).toBe(estimate.dataRequestsRescoped);
		expect(actual.rowsBackfilled).toEqual(estimate.rowsBackfilled);

		// 有默认组织的用户被复用（不新建），无默认组织的用户新建
		expect(actual.organizationsCreated).toBe(3);
		expect(actual.ownerMembershipsCreated).toBe(3);
		expect(actual.usersSkippedIdempotent).toBe(1);
		expect(actual.usersProcessed).toBe(4);
		// 有个人设置的用户的设置被复制；无设置的用户的组织设置不虚构
		expect(actual.organizationSettingsCreated).toBe(1);
		// 已读提醒 → 成员级已读行
		expect(actual.reminderReadsCreated).toBe(1);
		// 历史 CLEAR → 默认组织的 ORGANIZATION 请求（§12.2.7）
		expect(actual.dataRequestsRescoped).toBe(1);
		// 各表待回填行数（organization_id IS NULL）
		expect(actual.rowsBackfilled).toEqual({
			accounts: 3,
			transactions: 1,
			initialHoldings: 2,
			costLots: 3,
			plans: 1,
			usageRecords: 1,
			corrections: 2,
			reminders: 2,
			aiConversations: 1,
			planChangeLogs: 1,
		});

		// §12.2.6：回填只改租户列，任何既有行的时间戳都不动
		expect(await updatedAtSnapshot(drill)).toEqual(updatedAtBeforeBackfill);
		// 写入确实落库（组织 / 组织设置从无到有）
		expect(await drill.organization.count()).toBeGreaterThan(orgCountBefore);
		expect(await drill.organizationSettings.count()).toBeGreaterThan(settingsCountBefore);
	});

	test("回填结果：组织 / OWNER 成员 / 组织设置建成，账本行全部归组（行集恒等）", async () => {
		// 回填后的行集恒等：每张业务表的 organization_id = 该用户的默认组织
		const mapping = await userToDefaultOrg();
		for (const userId of [
			drillUsers.full,
			drillUsers.withSettings,
			drillUsers.bare,
		]) {
			const organizationId = mapping.get(userId);
			expect(organizationId, userId).toBeTruthy();
			const tables = [
				"accounts",
				"transactions",
				"initial_holdings",
				"cost_lots",
				"plans",
				"usage_records",
				"corrections",
				"reminders",
				"ai_conversations",
			];
			for (const table of tables) {
				const [row] = await drill.$queryRawUnsafe<Array<{ n: bigint }>>(
					`SELECT count(*) AS n FROM ${table}
					 WHERE user_id = $1 AND organization_id IS DISTINCT FROM $2`,
					userId,
					organizationId,
				);
				expect(Number(row?.n ?? 0n), `${table} 行集恒等`).toBe(0);
			}
			// PlanChangeLog 经父计划归属
			const [logRow] = await drill.$queryRawUnsafe<Array<{ n: bigint }>>(
				`SELECT count(*) AS n FROM plan_change_logs c JOIN plans p ON p.id = c.plan_id
				 WHERE p.user_id = $1 AND c.organization_id IS DISTINCT FROM $2`,
				userId,
				organizationId,
			);
			expect(Number(logRow?.n ?? 0n), "plan_change_logs 行集恒等").toBe(0);
		}

		// 作者列回填为原用户（操作者快照）
		const [authored] = await drill.$queryRawUnsafe<
			Array<{ created_by_id: string; organization_id: string }>
		>(`SELECT created_by_id, organization_id FROM accounts WHERE id = $1`, `${RUN}-acc-USD`);
		expect(authored?.created_by_id).toBe(drillUsers.full);
		expect(authored?.organization_id).toBe(mapping.get(drillUsers.full));

		// 组织名 = 「用户名的工作台」；组织设置逐字段复制
		const [org] = await drill.$queryRawUnsafe<
			Array<{ name: string; base_currency: string; prep_preference: string; reminder_enabled: boolean }>
		>(
			`SELECT o.name, s.base_currency, s.prep_preference, s.reminder_enabled
			 FROM organizations o JOIN organization_settings s ON s.organization_id = o.id
			 WHERE o.id = $1`,
			mapping.get(drillUsers.withSettings),
		);
		expect(org?.name).toBe("有个人设置用户的工作台");
		expect(org?.base_currency).toBe("USD");
		expect(org?.prep_preference).toBe("cautious");
		expect(org?.reminder_enabled).toBe(false);

		// 无个人设置的用户：有组织、无组织设置（不虚构本位币）
		const bareSettings = await drill.organizationSettings.findUnique({
			where: { organizationId: mapping.get(drillUsers.bare)! },
		});
		expect(bareSettings).toBeNull();

		// 已读提醒 → 成员级已读行（未读不建）
		const reads = await drill.$queryRawUnsafe<Array<{ n: bigint }>>(
			`SELECT count(*) AS n FROM reminder_reads WHERE reminder_id = $1`,
			drillRows.readReminderId,
		);
		expect(Number(reads[0]?.n ?? 0n)).toBe(1);
		const unreadReads = await drill.$queryRawUnsafe<Array<{ n: bigint }>>(
			`SELECT count(*) AS n FROM reminder_reads WHERE reminder_id = $1`,
			drillRows.unreadReminderId,
		);
		expect(Number(unreadReads[0]?.n ?? 0n)).toBe(0);
	});

	test("§12.3 核对：全量 0 差异；核对项数量写死（防「查询写错 → 恒 0」的空过）", async () => {
		const result = await reconcileMigration(drill);
		expect(result.diffs).toEqual([]);
		// 全量模式评估 29 项：默认组织 1 + 行集映射 10 + 可归属不变量 7
		// + 数据请求 1 + 提醒已读 1 + 设置同构 2 + 双写冲突 3 + 无法归属孤儿 4
		expect(result.checks).toBe(29);
		expect(result.sharded).toBe(false);

		// 空分片：不评估任何行，同样不得回落到全库
		const empty = await reconcileMigration(drill, { userIds: [] });
		expect(empty).toMatchObject({ sharded: true, checks: 25, diffs: [] });
	});

	test("父子组织一致性：UsageRecord↔Plan / CostLot↔来源 / 分摊双父 / PlanChangeLog↔Plan 全部同组织", async () => {
		const checks: Array<{ scope: string; sql: string; params: unknown[] }> = [
			{
				scope: "usage_record.plan_org_consistency",
				sql: `SELECT count(*) AS n FROM usage_records u JOIN plans p ON p.id = u.plan_id
					WHERE u.organization_id IS DISTINCT FROM p.organization_id`,
				params: [],
			},
			{
				scope: "cost_lot.source_org_consistency",
				sql: `SELECT count(*) AS n FROM cost_lots l
					JOIN initial_holdings h ON l.source_type = 'INITIAL' AND h.id = l.source_id
					WHERE l.organization_id IS DISTINCT FROM h.organization_id`,
				params: [],
			},
			{
				scope: "cost_lot.source_org_consistency(purchase)",
				sql: `SELECT count(*) AS n FROM cost_lots l
					JOIN transactions t ON l.source_type = 'PURCHASE' AND t.id = l.source_id
					WHERE l.organization_id IS DISTINCT FROM t.organization_id`,
				params: [],
			},
			{
				scope: "usage_lot_allocation.parent_org_consistency",
				sql: `SELECT count(*) AS n FROM usage_lot_allocations x
					JOIN usage_records u ON u.id = x.usage_id
					JOIN cost_lots l ON l.id = x.lot_id
					WHERE u.organization_id IS DISTINCT FROM l.organization_id`,
				params: [],
			},
			{
				scope: "plan_change_log.plan_org_consistency",
				sql: `SELECT count(*) AS n FROM plan_change_logs c JOIN plans p ON p.id = c.plan_id
					WHERE c.organization_id IS DISTINCT FROM p.organization_id`,
				params: [],
			},
		];
		for (const check of checks) {
			const rows = await drill.$queryRawUnsafe<Array<{ n: bigint }>>(check.sql, ...check.params);
			expect(Number(rows[0]?.n ?? 0n), check.scope).toBe(0);
		}
	});

	test("回填只改租户列：业务事实逐项不变（§12.3 七类口径，回填前后逐项相等）", async () => {
		// 回填前（按 user_id 归属）→ 映射到默认组织 → 与回填后（按 organization_id 归属）逐项相等
		const facts = await businessFacts(drill, "organization_id");
		const mapping = await userToDefaultOrg();
		const remappedBefore = remapFacts(factsBeforeBackfill, mapping);
		expect(remappedBefore).toEqual(facts);

		const fullOrg = mapping.get(drillUsers.full)!;

		// 口径 1：每币种账户余额合计
		expect(facts.balances).toContain(`${fullOrg}|USD|1000.5000`);
		expect(facts.balances).toContain(`${fullOrg}|EUR|200.2500`);
		expect(facts.balances).toContain(`${fullOrg}|JPY|0.0000`);

		// 口径 2：计划目标 / 分配 / 排期
		expect(facts.plans).toContain(
			`${fullOrg}|USD|300.0000|ACTIVE|300.0000|50.0000|3|300.0000`,
		);
		// 口径 3：流水计数与金额
		expect(facts.ledger).toContain(`${fullOrg}|txn|1|144.0000|1`);
		expect(facts.ledger).toContain(`${fullOrg}|usage|1|50.0000|1`);
		expect(facts.ledger).toContain(`${fullOrg}|correction|2`);
		// 口径 4：批次与分摊
		expect(facts.lots).toContain(`${fullOrg}|INITIAL|500.0000|450.0000|7.2000000000|3600.0000`);
		expect(facts.lots).toContain(`${fullOrg}|INITIAL|100.0000|100.0000|7.2000000000|790.0000`);
		expect(facts.lots).toContain(`${fullOrg}|PURCHASE|20.0000|20.0000|7.2000000000|144.0000`);
		expect(facts.allocations).toContain(`${fullOrg}|1|50.0000|360.0000`);
		// 口径 5：报告口径输入与 FIFO 汇总
		expect(facts.planInputs).toContain(`${fullOrg}|${drillRows.planId}|300.0000|50.0000`);
		expect(facts.report).toContain(`${fullOrg}|360.0000|360.0000|0.0000|50.0000|0.0000|0`);
		// 口径 6：组织设置逐字段复制个人设置（时区敏感的时间戳改为与个人设置逐字段比对）
		const settingsOrg = mapping.get(drillUsers.withSettings)!;
		expect(
			facts.settings.some(
				(line) =>
					line.startsWith(`${settingsOrg}|USD|cautious|false|`) &&
					line.split("|").length === 5,
			),
			facts.settings.join(" / "),
		).toBe(true);
		const [personalSettings] = await drill.$queryRawUnsafe<Array<{ v: string }>>(
			`SELECT to_char(ledger_started_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS v
			 FROM user_settings WHERE user_id = $1`,
			drillUsers.withSettings,
		);
		const [orgSettings] = await drill.$queryRawUnsafe<Array<{ v: string }>>(
			`SELECT to_char(ledger_started_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS v
			 FROM organization_settings WHERE organization_id = $1`,
			settingsOrg,
		);
		expect(orgSettings?.v).toBe(personalSettings?.v);
	});

	test("幂等：第 2 次回填零变化；核对仍 0 差异", async () => {
		const orgCountBefore = await drill.organization.count();
		const secondRun = await backfillDefaultOrganizations(drill);
		expect(await drill.organization.count()).toBe(orgCountBefore);
		expect(secondRun.organizationsCreated).toBe(0);
		expect(secondRun.ownerMembershipsCreated).toBe(0);
		expect(secondRun.organizationSettingsCreated).toBe(0);
		expect(secondRun.reminderReadsCreated).toBe(0);
		expect(secondRun.dataRequestsRescoped).toBe(0);
		for (const [table, count] of Object.entries(secondRun.rowsBackfilled)) {
			expect(`${table}=${count}`, `表 ${table} 重复回填`).toBe(`${table}=0`);
		}
		const result = await reconcileMigration(drill);
		expect(result.diffs).toEqual([]);
	});

	test("孤儿派生行：回填预检显式阻断（§12.2.5），零写入", async () => {
		const orphanUsageId = `${RUN}-orphan-usage`;
		await drill.$executeRawUnsafe(
			`INSERT INTO usage_records
				(id, user_id, organization_id, created_by_id, plan_id, currency_code, amount, used_at, remark, version, created_at, updated_at)
			 VALUES ($1, $2, NULL, NULL, $3, 'USD', 10.0000, now(), NULL, 1, now(), now())`,
			orphanUsageId,
			drillUsers.bare,
			`${RUN}-missing-plan`,
		);
		try {
			await expect(backfillDefaultOrganizations(drill)).rejects.toBeInstanceOf(
				BackfillAnomalyError,
			);
			await expect(backfillDefaultOrganizations(drill)).rejects.toMatchObject({
				details: expect.objectContaining({ usage_records: 1 }),
			});
		} finally {
			await drill.$executeRawUnsafe(`DELETE FROM usage_records WHERE id = $1`, orphanUsageId);
		}
		// 预检阻断期间零写入：组织数不变
		expect(await drill.organization.count()).toBeGreaterThan(0);
		const restored = await reconcileMigration(drill);
		expect(restored.diffs).toEqual([]);
	});

	test("跨组织父子不一致：核对显式报差异（§12.3.7），还原后归零", async () => {
		const mapping = await userToDefaultOrg();
		const orgA = mapping.get(drillUsers.full)!;
		const otherOrg = await drill.organization.create({
			data: { name: `${RUN} 跨组织演练组织` },
			select: { id: true },
		});
		try {
			await drill.$executeRawUnsafe(
				`UPDATE usage_records SET organization_id = $1 WHERE id = $2`,
				otherOrg.id,
				drillRows.usageId,
			);
			const result = await reconcileMigration(drill);
			expect(result.diffs.map((diff) => diff.scope)).toContain(
				"usage_record.plan_org_consistency",
			);
			await drill.$executeRawUnsafe(
				`UPDATE usage_records SET organization_id = $1 WHERE id = $2`,
				orgA,
				drillRows.usageId,
			);
			const restored = await reconcileMigration(drill);
			expect(restored.diffs).toEqual([]);
		} finally {
			await drill.organization.delete({ where: { id: otherOrg.id } });
		}
	});

	test("行集映射负向：10 张表逐张改错组织都必须被报出", async () => {
		const mapping = await userToDefaultOrg();
		const orgA = mapping.get(drillUsers.full)!;
		const otherOrg = await drill.organization.create({
			data: { name: `${RUN} 行集映射演练组织` },
			select: { id: true },
		});
		try {
			const targets: Array<{ table: string; sql: string; params: unknown[] }> = [
				{
					table: "accounts",
					sql: `UPDATE accounts SET organization_id = $1 WHERE id = $2`,
					params: [`${RUN}-acc-USD`],
				},
				{
					table: "transactions",
					sql: `UPDATE transactions SET organization_id = $1 WHERE id = $2`,
					params: [`${RUN}-txn`],
				},
				{
					table: "initial_holdings",
					sql: `UPDATE initial_holdings SET organization_id = $1 WHERE id = $2`,
					params: [`${RUN}-ih-USD`],
				},
				{
					table: "cost_lots",
					sql: `UPDATE cost_lots SET organization_id = $1 WHERE id = $2`,
					params: [drillRows.initialUsdLotId],
				},
				{
					table: "plans",
					sql: `UPDATE plans SET organization_id = $1 WHERE id = $2`,
					params: [drillRows.planId],
				},
				{
					table: "usage_records",
					sql: `UPDATE usage_records SET organization_id = $1 WHERE id = $2`,
					params: [drillRows.usageId],
				},
				{
					table: "corrections",
					sql: `UPDATE corrections SET organization_id = $1 WHERE id = $2`,
					params: [`${RUN}-corr-ok`],
				},
				{
					table: "reminders",
					sql: `UPDATE reminders SET organization_id = $1 WHERE id = $2`,
					params: [drillRows.readReminderId],
				},
				{
					table: "ai_conversations",
					sql: `UPDATE ai_conversations SET organization_id = $1 WHERE id = $2`,
					params: [`${RUN}-conv`],
				},
				{
					table: "plan_change_logs",
					sql: `UPDATE plan_change_logs SET organization_id = $1 WHERE id = $2`,
					params: [`${RUN}-changelog`],
				},
			];
			for (const target of targets) {
				await drill.$executeRawUnsafe(
					`UPDATE ${target.table} SET organization_id = $1 WHERE id = $2`,
					otherOrg.id,
					...target.params,
				);
				const result = await reconcileMigration(drill);
				expect(result.diffs.map((diff) => diff.scope), target.table).toContain(
					`row_mapping.${target.table}`,
				);
				await drill.$executeRawUnsafe(
					`UPDATE ${target.table} SET organization_id = $1 WHERE id = $2`,
					orgA,
					...target.params,
				);
				const restored = await reconcileMigration(drill);
				expect(restored.diffs, `${target.table} 还原`).toEqual([]);
			}
		} finally {
			await drill.organization.delete({ where: { id: otherOrg.id } });
		}
	});

	test("不变量负向：FIFO / 批次守恒 / 来源孤儿 / 已读对账 / 设置同构 / 默认组织缺失 逐类命中", async () => {
		const mapping = await userToDefaultOrg();
		const orgA = mapping.get(drillUsers.full)!;

		const expectDiffWhile = async (
			scope: string,
			corrupt: () => Promise<void>,
			restore: () => Promise<void>,
		) => {
			await corrupt();
			let scopes: string[] = [];
			try {
				scopes = (await reconcileMigration(drill)).diffs.map((diff) => diff.scope);
			} finally {
				await restore();
			}
			expect(scopes, scope).toContain(scope);
			expect((await reconcileMigration(drill)).diffs).toEqual([]);
		};

		// FIFO：使用量 ≠ 分摊量合计
		await expectDiffWhile(
			"fifo_conservation.usage_allocations",
			async () => {
				await drill.$executeRawUnsafe(
					`UPDATE usage_records SET amount = 49.0000 WHERE id = $1`,
					drillRows.usageId,
				);
			},
			async () => {
				await drill.$executeRawUnsafe(
					`UPDATE usage_records SET amount = 50.0000 WHERE id = $1`,
					drillRows.usageId,
				);
			},
		);
		// 批次守恒：quantity − Σ分摊 ≠ remaining_qty
		await expectDiffWhile(
			"batch_conservation.cost_lots",
			async () => {
				await drill.$executeRawUnsafe(
					`UPDATE cost_lots SET remaining_qty = 449.0000 WHERE id = $1`,
					drillRows.initialUsdLotId,
				);
			},
			async () => {
				await drill.$executeRawUnsafe(
					`UPDATE cost_lots SET remaining_qty = 450.0000 WHERE id = $1`,
					drillRows.initialUsdLotId,
				);
			},
		);
		// 批次来源孤儿（PURCHASE 无对应交易）
		await expectDiffWhile(
			"cost_lot.orphan_source",
			async () => {
				await drill.$executeRawUnsafe(
					`INSERT INTO cost_lots
						(id, user_id, organization_id, currency_code, source_type, source_id, quantity, remaining_qty, unit_cost, total_cost, acquired_at, created_at, updated_at)
					 VALUES ($1, $2, $3, 'USD', 'PURCHASE', $4, 1.0000, 1.0000, 7.2000000000, 7.2000, now(), now(), now())`,
					`${RUN}-orphan-lot`,
					drillUsers.full,
					orgA,
					`${RUN}-no-txn`,
				);
			},
			async () => {
				await drill.$executeRawUnsafe(
					`DELETE FROM cost_lots WHERE id = $1`,
					`${RUN}-orphan-lot`,
				);
			},
		);
		// ReminderRead 对账：已读提醒缺成员级已读行
		await expectDiffWhile(
			"reminder_read.parity",
			async () => {
				await drill.$executeRawUnsafe(
					`DELETE FROM reminder_reads WHERE reminder_id = $1`,
					drillRows.readReminderId,
				);
			},
			async () => {
				await drill.$executeRawUnsafe(
					`INSERT INTO reminder_reads (id, reminder_id, user_id, read_at)
					 VALUES ($1, $2, $3, $4::timestamp)`,
					`${RUN}-read-restore`,
					drillRows.readReminderId,
					drillUsers.full,
					new Date("2026-05-26T08:00:00.000Z"),
				);
			},
		);
		// 设置同构：组织设置缺失
		const settingsOrg = mapping.get(drillUsers.withSettings)!;
		await expectDiffWhile(
			"settings_parity.missing",
			async () => {
				await drill.$executeRawUnsafe(
					`DELETE FROM organization_settings WHERE organization_id = $1`,
					settingsOrg,
				);
			},
			async () => {
				await drill.$executeRawUnsafe(
					`INSERT INTO organization_settings
						(id, organization_id, base_currency, prep_preference, reminder_enabled, ledger_started_at, created_at, updated_at)
					 VALUES ($1, $2, 'USD', 'cautious', false, $3::timestamp, now(), now())`,
					`${RUN}-settings-restore`,
					settingsOrg,
					T0,
				);
			},
		);
		// 默认组织缺失：没有任何成员关系的用户
		const stray = await drill.user.create({
			data: {
				email: `${RUN}-stray@example.com`,
				passwordHash: "test-hash",
				name: "无组织演练用户",
			},
			select: { id: true },
		});
		try {
			const result = await reconcileMigration(drill);
			expect(result.diffs).toContainEqual({
				scope: "default_org.missing",
				left: 0,
				right: 1,
			});
		} finally {
			await drill.user.delete({ where: { id: stray.id } });
		}
	});
});

// ─────────────────────────── 演练库内的后续迁移 ───────────────────────────

describe("隔离 schema：W26 / MIG-E / MIG-F 落地后迁移工具仍可运行", () => {
	test("W26 迁移落地：DataRequest CHECK 约束生效并拒绝违约写入", async () => {
		const before = await drill.$queryRawUnsafe<Array<{ conname: string }>>(
			`SELECT c.conname FROM pg_constraint c
			 JOIN pg_namespace n ON n.oid = c.connamespace
			 WHERE n.nspname = current_schema()
				AND c.conname = 'data_requests_scope_type_org_check'`,
		);
		expect(before).toEqual([]);

		await applyMigration(drill, W26_DIR);

		const [constraint] = await drill.$queryRawUnsafe<
			Array<{ convalidated: boolean }>
		>(
			`SELECT c.convalidated FROM pg_constraint c
			 JOIN pg_namespace n ON n.oid = c.connamespace
			 WHERE n.nspname = current_schema()
			 AND c.conname = 'data_requests_scope_type_org_check'`,
		);
		expect(constraint?.convalidated).toBe(true);

		// 违约写入被拒绝：PERSONAL + CLEAR
		await expect(
			drill.$executeRawUnsafe(
				`INSERT INTO data_requests
					(id, user_id, organization_id, scope, type, status, requested_at, due_at, created_at, updated_at)
				 VALUES ($1, $2, NULL, 'PERSONAL', 'CLEAR', 'PENDING', now(), now(), now(), now())`,
				`${RUN}-violating-clear`,
				drillUsers.bare,
			),
		).rejects.toThrow(/data_requests_scope_type_org_check/);

		// 回填与核对在 CHECK 落地后仍 0 差异
		const result = await reconcileMigration(drill);
		expect(result.diffs).toEqual([]);
	});

	test("MIG-E 落地：organization_id NOT NULL、账本表解绑 User 级联并直连 Organization(RESTRICT)", async () => {
		await applyMigration(drill, MIG_E_DIR);

		const columns = await drill.$queryRawUnsafe<
			Array<{ table_name: string; is_nullable: string }>
		>(
			`SELECT table_name, is_nullable FROM information_schema.columns
			 WHERE table_schema = current_schema() AND column_name = 'organization_id'
				AND table_name IN ('accounts','transactions','initial_holdings','cost_lots','plans','plan_change_logs','usage_records','corrections','reminders','ai_conversations')`,
		);
		expect(columns).toHaveLength(10);
		expect(columns.filter((row) => row.is_nullable !== "NO")).toEqual([]);

		// 账本表已不再直连 users（无 user_id 级联外键），改为直连 organizations
		const userFks = await drill.$queryRawUnsafe<Array<{ conname: string }>>(
			`SELECT conname FROM pg_constraint
			 WHERE contype = 'f' AND conrelid IN ('accounts'::regclass,'transactions'::regclass,'initial_holdings'::regclass,'cost_lots'::regclass,'plans'::regclass,'usage_records'::regclass,'corrections'::regclass,'reminders'::regclass)
				AND confrelid = 'users'::regclass`,
		);
		expect(userFks.map((row) => row.conname).sort()).toEqual([
			"accounts_created_by_id_fkey",
			"corrections_actor_user_id_fkey",
			"initial_holdings_created_by_id_fkey",
			"plans_created_by_id_fkey",
			"transactions_created_by_id_fkey",
			"usage_records_created_by_id_fkey",
		]);
		const orgFks = await drill.$queryRawUnsafe<Array<{ conname: string; def: string }>>(
			`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
			 WHERE contype = 'f' AND conrelid = 'accounts'::regclass
				AND confrelid = 'organizations'::regclass`,
		);
		expect(orgFks).toHaveLength(1);
		expect(orgFks[0]?.def).toContain("ON DELETE RESTRICT");

		// 核对在 MIG-E 后仍 0 差异（此时仍在 MIG-F 之前，走 legacy 分支）
		const result = await reconcileMigration(drill);
		expect(result.diffs).toEqual([]);
		expect(result.checks).toBe(29);
	});

	test("MIG-F 落地：legacy 列彻底下线；迁移工具退化为 no-op 且不崩溃", async () => {
		await applyMigration(drill, MIG_F_DIR);

		// 旧列下线
		const dropped = await drill.$queryRawUnsafe<
			Array<{ table_name: string; column_name: string }>
		>(
			`SELECT table_name, column_name FROM information_schema.columns
			 WHERE table_schema = current_schema()
				AND (
					(column_name = 'user_id' AND table_name IN ('accounts','transactions','initial_holdings','cost_lots','plans','usage_records','corrections','reminders','data_requests'))
					OR (table_name = 'reminders' AND column_name = 'read_at')
					OR (table_name = 'user_settings' AND column_name IN ('base_currency','prep_preference','reminder_enabled','ledger_started_at'))
				)`,
		);
		expect(dropped).toEqual([]);

		// 库阶段能力：已进入 MIG-F
		const capabilities = await detectMigrationSchemaCapabilities(drill);
		expect(capabilities.migF).toBe(true);
		expect(capabilities.hasUserSettingsLegacyColumns).toBe(false);
		expect(capabilities.hasReminderReadAtColumn).toBe(false);
		expect(capabilities.legacyUserIdTables.has("accounts")).toBe(false);

		// 核对改走组织维度分支，仍 0 差异
		const result = await reconcileMigration(drill);
		expect(result.diffs).toEqual([]);
		expect(result.checks).toBe(13);
		expect(result.capabilities?.migF).toBe(true);

		// 回填退化为 no-op：不再新建组织、不再回填任何行，且不因列缺失而崩溃
		const run = await backfillDefaultOrganizations(drill);
		expect(run.organizationsCreated).toBe(0);
		expect(run.ownerMembershipsCreated).toBe(0);
		expect(run.organizationSettingsCreated).toBe(0);
		expect(run.reminderReadsCreated).toBe(0);
		expect(run.dataRequestsRescoped).toBe(0);
		for (const [table, count] of Object.entries(run.rowsBackfilled)) {
			expect(`${table}=${count}`, `表 ${table} 不应再回填`).toBe(`${table}=0`);
		}
	});

	test("MIG-C 快照工具在 post-MIG-F 上仍可运行（组织维度归属）", async () => {
		const before = await captureMigrationSnapshot(drill);
		const after = await captureMigrationSnapshot(drill);
		const comparison = compareMigrationSnapshots(before, after);
		expect(comparison.diffs).toEqual([]);
		expect(comparison.checks).toBeGreaterThan(0);
		// post-MIG-F：归属键按组织（不再是用户）
		expect(before.ownerKind).toBe("ORGANIZATION");
		expect(after.ownerKind).toBe("ORGANIZATION");
	});
});

// ─────────────────────────── 主库 post-MIG-F 契约 ───────────────────────────

describe("主库（post-MIG-F）契约：迁移工具与核对在真实库上仍可运行", () => {
	test("库阶段能力探测：已进入 MIG-F，legacy 列全部下线", async () => {
		const capabilities = await detectMigrationSchemaCapabilities(main);
		expect(capabilities.migF).toBe(true);
		expect(capabilities.hasUserSettingsLegacyColumns).toBe(false);
		expect(capabilities.hasReminderReadAtColumn).toBe(false);
		// 只有个人所有的 ai_conversations 仍保留 user_id
		expect(capabilities.legacyUserIdTables.has("ai_conversations")).toBe(true);
		for (const table of [
			"accounts",
			"transactions",
			"initial_holdings",
			"cost_lots",
			"plans",
			"usage_records",
			"corrections",
			"reminders",
			"data_requests",
		]) {
			expect(capabilities.legacyUserIdTables.has(table), table).toBe(false);
		}
	});

	test("§12.3 核对（组织维度分支）：分片 0 差异 + 父子组织一致性", async () => {
		const user = await main.user.create({
			data: {
				email: `${RUN}-main@example.com`,
				passwordHash: "test-hash",
				name: "主库演练用户",
			},
			select: { id: true },
		});
		mainUserIds.push(user.id);
		const org = await main.organization.create({
			data: {
				name: `${RUN} 主库演练组织`,
				memberships: { create: { userId: user.id, role: "OWNER", status: "ACTIVE" } },
			},
			select: { id: true },
		});
		mainOrgIds.push(org.id);

		// 一条自洽的组织账本：账户 + 计划 + 使用 + 批次 + 分摊（父子同组织）
		await main.account.create({
			data: { organizationId: org.id, currencyCode: "MN", balance: "100.0000" },
		});
		const plan = await main.plan.create({
			data: {
				organizationId: org.id,
				targetCurrency: "MN",
				targetAmount: "100.0000",
				expectUseDate: new Date(Date.UTC(2026, 1, 1)),
				latestPrepDate: new Date(Date.UTC(2026, 0, 25)),
			},
		});
		const holding = await main.initialHolding.create({
			data: {
				organizationId: org.id,
				currencyCode: "MN",
				amount: "100.0000",
				rate: "7.0000000000",
				rawRate: "7.0000000000",
				rateSource: "identity",
				rateObservedAt: T0,
				cost: "700.0000",
				confirmedAt: T0,
			},
		});
		const lot = await main.costLot.create({
			data: {
				organizationId: org.id,
				currencyCode: "MN",
				sourceType: "INITIAL",
				sourceId: holding.id,
				quantity: "100.0000",
				remainingQty: "90.0000",
				unitCost: "7.0000000000",
				totalCost: "700.0000",
				acquiredAt: T0,
			},
		});
		const usage = await main.usageRecord.create({
			data: {
				organizationId: org.id,
				planId: plan.id,
				currencyCode: "MN",
				amount: "10.0000",
				usedAt: T0,
			},
		});
		await main.usageLotAllocation.create({
			data: { usageId: usage.id, lotId: lot.id, quantity: "10.0000", cost: "70.0000" },
		});

		const result = await reconcileMigration(main, { userIds: [user.id] });
		expect(result.sharded).toBe(true);
		expect(result.diffs).toEqual([]);
		// 分片模式评估 9 项：默认组织 1 + 组织维度不变量 8
		expect(result.checks).toBe(9);
		expect(result.capabilities?.migF).toBe(true);

		// 父子组织一致性显式复核
		const parents = await main.$queryRawUnsafe<
			Array<{ usage_plan: bigint; lot_source: bigint; ula_parents: bigint }>
		>(
			`SELECT
				(SELECT count(*) FROM usage_records u JOIN plans p ON p.id = u.plan_id
				 WHERE u.organization_id IS DISTINCT FROM p.organization_id) AS usage_plan,
				(SELECT count(*) FROM cost_lots l JOIN initial_holdings h ON l.source_type = 'INITIAL' AND h.id = l.source_id
				 WHERE l.organization_id IS DISTINCT FROM h.organization_id) AS lot_source,
				(SELECT count(*) FROM usage_lot_allocations x JOIN usage_records u ON u.id = x.usage_id JOIN cost_lots l ON l.id = x.lot_id
				 WHERE u.organization_id IS DISTINCT FROM l.organization_id) AS ula_parents`,
		);
		expect(Number(parents[0]?.usage_plan ?? 0n)).toBe(0);
		expect(Number(parents[0]?.lot_source ?? 0n)).toBe(0);
		expect(Number(parents[0]?.ula_parents ?? 0n)).toBe(0);

		// 跨组织挂载必须被核对显式报出（负向：核对不是恒 0 的空过）
		const otherOrg = await main.organization.create({
			data: { name: `${RUN} 主库跨组织演练组织` },
			select: { id: true },
		});
		mainOrgIds.push(otherOrg.id);
		try {
			// post-MIG-F 的分片核对按「子行的 organization_id ∈ 分片组织集合」限定，
			// 故把**父行**（计划）挪到别的组织、子行留在分片组织内，父子才真正不一致
			await main.plan.update({
				where: { id: plan.id },
				data: { organizationId: otherOrg.id },
			});
			const broken = await reconcileMigration(main, { userIds: [user.id] });
			expect(broken.diffs.map((diff) => diff.scope)).toContain(
				"usage_record.plan_org_consistency",
			);
		} finally {
			await main.plan.update({
				where: { id: plan.id },
				data: { organizationId: org.id },
			});
			const restored = await reconcileMigration(main, { userIds: [user.id] });
			expect(restored.diffs).toEqual([]);
		}
	});
});
