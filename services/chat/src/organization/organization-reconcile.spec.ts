import { describe, expect, it } from "vitest";
import { reconcileMigration } from "./organization-reconcile";

/**
 * 核对模块的 MIG-F 分支单测（Goal #3C W29 / W30 前瞻）。
 *
 * 背景：MIG-F 会删除业务共享表上的冗余 `user_id`、`user_settings` 的 legacy 设置列
 * 与 `reminders.read_at`。核对 SQL 若继续引用这些列，Postgres 会在**解析阶段**
 * 报「列不存在」而整条语句失败——MIG-F 之后连「基础一致性校验」都跑不了。
 *
 * 本测试用假库把 `information_schema.columns` 的返回固定为「MIG-F 形态」，断言：
 * 1. `reconcileMigration` 不抛错、返回 0 差异；
 * 2. **它发出的 SQL 里不含任何已删除列**（正向控制：迁移前形态的 SQL 一定含
 *    `user_settings` / `read_at`，证明断言不是恒真）。
 */

/**
 * 取出 Prisma 标签模板调用里的 SQL 文本。
 * `$queryRaw` 以 tagged-template 形式被调用：第一个参数是字符串数组（其余为绑定值）。
 */
function extractSql(query: unknown): string {
	if (Array.isArray(query)) {
		return (query as string[]).join(" ");
	}
	return (query as { sql?: string }).sql ?? "";
}

/** 假库的「空库」返回行：所有核对项的计数列都存在且为 0（与真实空库一致） */
function zeroRow(): Record<string, bigint> {
	return {
		n: 0n,
		accounts: 0n,
		transactions: 0n,
		initial_holdings: 0n,
		cost_lots: 0n,
		plans: 0n,
		usage_records: 0n,
		corrections: 0n,
		reminders: 0n,
		ai_conversations: 0n,
		plan_change_logs: 0n,
		usage_plan: 0n,
		lot_source: 0n,
		ula_parents: 0n,
		usage_orphan_plan: 0n,
		lot_orphan_source: 0n,
		fifo: 0n,
		batch: 0n,
		mismatch: 0n,
		missing: 0n,
		dualAccountRows: 0n,
		dualInitialHoldingRows: 0n,
		dualReminderRows: 0n,
	};
}

/**
 * 孤儿派生行语句专用的返回行：只含 4 个孤儿计数列。
 * 核对模块按 `Object.entries(orphans)` 逐列评估检查项，因此这一行**不能**混入
 * 其他语句的计数列（否则检查项数量会被假库放大）。
 */
function zeroOrphanRow(): Record<string, bigint> {
	return {
		plan_allocations: 0n,
		usage_lot_allocations: 0n,
		plan_change_logs: 0n,
		plan_installments: 0n,
	};
}

function fakeDb(
	capabilityRows: Array<{ tableName: string; columnName: string }>,
	/** 指定计数列的覆盖值（用于让某一项核对非零，验证差异能被报出） */
	overrides: Record<string, bigint> = {},
) {
	const queries: string[] = [];
	const db = {
		$queryRaw: async (query: unknown) => {
			const sql = extractSql(query);
			queries.push(sql);
			if (sql.includes("information_schema.columns")) return capabilityRows;
			// 孤儿派生行语句按列名逐项评估，必须单独返回
			if (sql.includes("plan_installments")) return [zeroOrphanRow()];
			// 其余核对语句返回「空库」行 → 全部计数为 0 → 0 差异
			return [{ ...zeroRow(), ...overrides }];
		},
	};
	return { db, queries };
}

/** 迁移前形态：legacy 列齐全 */
const LEGACY_CAPABILITIES = [
	{ tableName: "accounts", columnName: "user_id" },
	{ tableName: "plans", columnName: "user_id" },
	{ tableName: "usage_records", columnName: "user_id" },
	{ tableName: "cost_lots", columnName: "user_id" },
	{ tableName: "transactions", columnName: "user_id" },
	{ tableName: "initial_holdings", columnName: "user_id" },
	{ tableName: "corrections", columnName: "user_id" },
	{ tableName: "reminders", columnName: "user_id" },
	{ tableName: "ai_conversations", columnName: "user_id" },
	{ tableName: "data_requests", columnName: "user_id" },
	{ tableName: "user_settings", columnName: "base_currency" },
	{ tableName: "user_settings", columnName: "prep_preference" },
	{ tableName: "user_settings", columnName: "reminder_enabled" },
	{ tableName: "user_settings", columnName: "ledger_started_at" },
	{ tableName: "reminders", columnName: "read_at" },
];

/** MIG-F 形态：业务表 user_id / user_settings legacy 列 / reminders.read_at 均已删 */
const MIGRATED_CAPABILITIES: Array<{ tableName: string; columnName: string }> = [];

describe("reconcileMigration 的 MIG-F 分支", () => {
	it("MIG-F 后：核对不抛错、0 差异（基础一致性校验仍可运行）", async () => {
		const { db } = fakeDb(MIGRATED_CAPABILITIES);
		const result = await reconcileMigration(db as never, { userIds: ["u1"] });
		expect(result.diffs).toEqual([]);
		expect(result.sharded).toBe(true);
		expect(result.capabilities?.migF).toBe(true);
		// 分片模式评估：默认组织 1 + 组织维度不变量 8（含变更日志 ↔ 父计划同组织）
		expect(result.checks).toBe(9);
	});

	it("MIG-F 后：发出的 SQL 不含任何 MIG-F 已删除的列", async () => {
		const { db, queries } = fakeDb(MIGRATED_CAPABILITIES);
		await reconcileMigration(db as never, { userIds: ["u1"] });
		expect(queries.length).toBeGreaterThan(1);
		for (const sql of queries) {
			// 能力探测语句本身按名字列举被删列（information_schema 元数据查询，
			// 不读业务表），不参与下面的断言
			if (sql.includes("information_schema.columns")) continue;
			// user_settings 的 legacy 设置列与 reminders.read_at：整组不可出现
			expect(sql).not.toContain("user_settings");
			expect(sql).not.toContain("read_at");
			// 业务表的 user_id：memberships / defaults CTE 的 user_id 仍存在（不属 MIG-F
			// 删除范围），因此按「业务表别名」逐个排除
			expect(sql).not.toMatch(
				/\b(?:t|p|u|l|r|s|leg|c|x|a|i)\.user_id\b/,
			);
		}
	});

	it("全量模式：MIG-F 后额外评估 4 类孤儿派生行", async () => {
		const { db } = fakeDb(MIGRATED_CAPABILITIES);
		const result = await reconcileMigration(db as never);
		expect(result.sharded).toBe(false);
		expect(result.checks).toBe(13);
		expect(result.diffs).toEqual([]);
	});

	it("MIG-F 后：变更日志与父计划不同组织被报出（对抗审 R1-N2）", async () => {
		const { db, queries } = fakeDb(MIGRATED_CAPABILITIES, { change_log_plan: 1n });
		const result = await reconcileMigration(db as never, { userIds: ["u1"] });
		expect(result.diffs).toEqual([
			{ scope: "plan_change_log.plan_org_consistency", left: 0, right: 1 },
		]);
		// SQL 别名必须与读取键一致（假库不解析 SQL，别名写错时只有这条断言能发现）
		expect(
			queries.some((sql) => /AS change_log_plan\b/.test(sql)),
			"核对 SQL 未输出 change_log_plan 别名（读取键与 SQL 别名不一致）",
		).toBe(true);
	});

	it("正向对照：迁移前形态的核对 SQL 确实引用 legacy 列（证明上一条断言非恒真）", async () => {
		const { db, queries } = fakeDb(LEGACY_CAPABILITIES);
		const result = await reconcileMigration(db as never, { userIds: ["u1"] });
		expect(result.capabilities?.migF).toBe(false);
		// 迁移前形态：分片模式评估 25 项（默认组织 1 + 行集映射 10 + 不变量 7 +
		// 数据请求 1 + 提醒已读 1 + 设置同构 2 + 双写冲突 3）
		expect(result.checks).toBe(25);
		const allSql = queries.join("\n");
		expect(allSql).toContain("user_settings");
		expect(allSql).toContain("read_at");
	});
});
