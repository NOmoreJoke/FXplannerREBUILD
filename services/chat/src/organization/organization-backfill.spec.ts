import { describe, expect, it } from "vitest";
import {
	backfillDefaultOrganizations,
	isProductionBackfillTarget,
} from "./organization-backfill";

/**
 * MIG-B 写入的生产目标拒绝（评审 I-15；技术方案 §12.4）。
 * 连接串均为无凭据的占位样本。
 */
describe("isProductionBackfillTarget", () => {
	it("库名匹配大小写不敏感：此前 /fxplanner_prod/ 漏放 FXPLANNER_PROD", () => {
		for (const url of [
			"postgresql://db-host:5432/fxplanner_prod",
			"postgresql://db-host:5432/FXPLANNER_PROD",
			"postgresql://db-host:5432/FxPlanner_Prod?schema=public",
		]) {
			expect(isProductionBackfillTarget(url), url).toBe(true);
		}
	});

	it("误伤方向可接受：疑似生产的副本/备份库名同样拒绝", () => {
		for (const url of [
			"postgresql://db-host:5432/fxplanner_prod_backup",
			"postgresql://db-host:5432/restore_of_fxplanner_prod_20261123",
		]) {
			expect(isProductionBackfillTarget(url), url).toBe(true);
		}
	});

	it("NODE_ENV=production：即便库名不像生产也拒绝", () => {
		expect(
			isProductionBackfillTarget(
				"postgresql://db-host:5432/fxplanner_new_db",
				"production",
			),
		).toBe(true);
	});

	it("本地/演练库不误伤", () => {
		for (const [url, nodeEnv] of [
			["postgresql://db-host:5432/fxplanner_new_db_local", undefined],
			["postgresql://db-host:5432/fxplanner_new_db_migbak", "test"],
			["postgresql://db-host:5432/fxplanner_review_4db3_w6_stack_r1", "development"],
		] as const) {
			expect(isProductionBackfillTarget(url, nodeEnv), url).toBe(false);
		}
	});
});

/**
 * MIG-F 阶段降级（对抗审 R1-I1）。
 *
 * MIG-F 删除 `initial_holdings.user_id` 等 legacy 列后，回填工具**不能**再发出
 * 引用这些列的 SQL（否则 Postgres 在解析阶段就报 `column ... does not exist`）。
 * 这里用假库把能力探测固定成「MIG-F 形态」，断言：
 * 1. `backfillDefaultOrganizations({ dryRun: true })` 不抛错（安全降级为 no-op）；
 * 2. **冲突初始持仓预检不再被执行**（其 SQL 引用 `initial_holdings.user_id`）；
 * 3. 正向对照：迁移前形态下该预检**确实会被执行**（证明上一条断言非恒真）。
 */

/** 取出 Prisma 标签模板调用里的 SQL 文本 */
function extractSql(query: unknown): string {
	if (Array.isArray(query)) {
		return (query as string[]).join(" ");
	}
	return (query as { sql?: string }).sql ?? "";
}

const LEGACY_CAPABILITY_ROWS = [
	{ tableName: "accounts", columnName: "user_id" },
	{ tableName: "transactions", columnName: "user_id" },
	{ tableName: "initial_holdings", columnName: "user_id" },
	{ tableName: "cost_lots", columnName: "user_id" },
	{ tableName: "plans", columnName: "user_id" },
	{ tableName: "usage_records", columnName: "user_id" },
	{ tableName: "corrections", columnName: "user_id" },
	{ tableName: "reminders", columnName: "user_id" },
	{ tableName: "reminders", columnName: "read_at" },
	{ tableName: "ai_conversations", columnName: "user_id" },
	{ tableName: "data_requests", columnName: "user_id" },
	{ tableName: "user_settings", columnName: "base_currency" },
	{ tableName: "user_settings", columnName: "prep_preference" },
	{ tableName: "user_settings", columnName: "reminder_enabled" },
	{ tableName: "user_settings", columnName: "ledger_started_at" },
];

/** MIG-F 形态：业务表 user_id / user_settings legacy 列 / reminders.read_at 均已删 */
const MIGRATED_CAPABILITY_ROWS: Array<{
	tableName: string;
	columnName: string;
}> = [];

function fakePrisma(
	capabilityRows: Array<{ tableName: string; columnName: string }>,
) {
	const queries: string[] = [];
	const count = async () => 0;
	const prisma = {
		$queryRaw: async (query: unknown) => {
			const sql = extractSql(query);
			queries.push(sql);
			if (sql.includes("information_schema.columns")) return capabilityRows;
			// 孤儿预检 / 默认组织查询：空库 → 无冲突
			return [];
		},
		user: { findMany: async () => [] },
		account: { count },
		transaction: { count },
		initialHolding: { count },
		costLot: { count },
		plan: { count },
		usageRecord: { count },
		correction: { count },
		reminder: { count },
		aiConversation: { count },
		dataRequest: { count },
	};
	return { prisma, queries };
}

/** 冲突初始持仓预检的 SQL 特征（引用 `initial_holdings.user_id`） */
function hasInitialHoldingConflictPrecheck(queries: string[]): boolean {
	return queries.some(
		(sql) => sql.includes("initial_holdings") && sql.includes("leg.user_id"),
	);
}

describe("backfillDefaultOrganizations 的 MIG-F 降级（对抗审 R1-I1）", () => {
	it("MIG-F 形态：dry-run 安全降级为 no-op，不抛错", async () => {
		const { prisma } = fakePrisma(MIGRATED_CAPABILITY_ROWS);
		const summary = await backfillDefaultOrganizations(prisma as never, {
			dryRun: true,
		});
		expect(summary.rowsBackfilled).toEqual({
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
		});
		expect(summary.chunksCommitted).toBe(0);
		expect(summary.reminderReadsCreated).toBe(0);
		expect(summary.dataRequestsRescoped).toBe(0);
		expect(summary.organizationSettingsCreated).toBe(0);
	});

	it("MIG-F 形态：不发出引用已删列的 SQL（冲突预检 / read_at / user_settings）", async () => {
		const { prisma, queries } = fakePrisma(MIGRATED_CAPABILITY_ROWS);
		await backfillDefaultOrganizations(prisma as never, { dryRun: true });
		expect(hasInitialHoldingConflictPrecheck(queries)).toBe(false);
		for (const sql of queries) {
			if (sql.includes("information_schema.columns")) continue;
			expect(sql).not.toContain("leg.user_id");
			expect(sql).not.toContain("read_at");
			expect(sql).not.toContain("user_settings");
		}
	});

	it("正向对照：迁移前形态下冲突预检确实执行（证明上一条断言非恒真）", async () => {
		const { prisma, queries } = fakePrisma(LEGACY_CAPABILITY_ROWS);
		await backfillDefaultOrganizations(prisma as never, { dryRun: true });
		expect(hasInitialHoldingConflictPrecheck(queries)).toBe(true);
	});
});
