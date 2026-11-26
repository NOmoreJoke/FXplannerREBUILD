import { describe, expect, it } from "vitest";
import {
	detectMigrationSchemaCapabilities,
	hasLegacyUserId,
} from "./migration-schema-capabilities";

/**
 * MIG-F 能力探测单测（Goal #3C W29 / W30 前瞻）。
 *
 * 探测结果的**每一个分支**都会改变回填与核对的行为，因此这里用假库把
 * `information_schema.columns` 的返回固定下来，逐个分支断言：
 * - 迁移前（legacy 列齐全）→ migF = false，各表仍可按 user_id 归属；
 * - MIG-F 后（业务表 user_id 已删）→ migF = true，相关分支必须走 no-op。
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

function fakeDb(rows: Array<{ tableName: string; columnName: string }>) {
	const queries: string[] = [];
	const db = {
		$queryRaw: async (query: unknown) => {
			const sql = extractSql(query);
			queries.push(sql);
			if (sql.includes("information_schema.columns")) return rows;
			return [];
		},
	};
	return { db, queries };
}

describe("detectMigrationSchemaCapabilities", () => {
	it("迁移前：legacy 列齐全 → migF = false", async () => {
		const { db } = fakeDb([
			{ tableName: "accounts", columnName: "user_id" },
			{ tableName: "transactions", columnName: "user_id" },
			{ tableName: "initial_holdings", columnName: "user_id" },
			{ tableName: "cost_lots", columnName: "user_id" },
			{ tableName: "plans", columnName: "user_id" },
			{ tableName: "usage_records", columnName: "user_id" },
			{ tableName: "corrections", columnName: "user_id" },
			{ tableName: "reminders", columnName: "user_id" },
			{ tableName: "ai_conversations", columnName: "user_id" },
			{ tableName: "data_requests", columnName: "user_id" },
			{ tableName: "user_settings", columnName: "base_currency" },
			{ tableName: "user_settings", columnName: "prep_preference" },
			{ tableName: "user_settings", columnName: "reminder_enabled" },
			{ tableName: "user_settings", columnName: "ledger_started_at" },
			{ tableName: "reminders", columnName: "read_at" },
		]);
		const capabilities = await detectMigrationSchemaCapabilities(
			db as never,
		);
		expect(capabilities.migF).toBe(false);
		expect(capabilities.hasUserSettingsLegacyColumns).toBe(true);
		expect(capabilities.hasReminderReadAtColumn).toBe(true);
		expect(hasLegacyUserId(capabilities, "accounts")).toBe(true);
		expect(hasLegacyUserId(capabilities, "data_requests")).toBe(true);
	});

	it("MIG-F 后：业务表 user_id 与 legacy 设置列均已删 → migF = true", async () => {
		const { db } = fakeDb([]);
		const capabilities = await detectMigrationSchemaCapabilities(
			db as never,
		);
		expect(capabilities.migF).toBe(true);
		expect(capabilities.hasUserSettingsLegacyColumns).toBe(false);
		expect(capabilities.hasReminderReadAtColumn).toBe(false);
		expect(hasLegacyUserId(capabilities, "accounts")).toBe(false);
		expect(hasLegacyUserId(capabilities, "plans")).toBe(false);
	});

	it("部分表先行删除 user_id：逐表判定（不整库一刀切）", async () => {
		const { db } = fakeDb([
			{ tableName: "plans", columnName: "user_id" },
			{ tableName: "usage_records", columnName: "user_id" },
			{ tableName: "cost_lots", columnName: "user_id" },
		]);
		const capabilities = await detectMigrationSchemaCapabilities(
			db as never,
		);
		// accounts 无 user_id → 已进入 MIG-F 形态
		expect(capabilities.migF).toBe(true);
		expect(hasLegacyUserId(capabilities, "plans")).toBe(true);
		expect(hasLegacyUserId(capabilities, "accounts")).toBe(false);
	});

	it("user_settings 设置列只删一部分 → 判定为「未完整迁移」，整组分支禁用", async () => {
		const { db } = fakeDb([
			{ tableName: "accounts", columnName: "user_id" },
			{ tableName: "user_settings", columnName: "base_currency" },
			{ tableName: "user_settings", columnName: "prep_preference" },
		]);
		const capabilities = await detectMigrationSchemaCapabilities(
			db as never,
		);
		expect(capabilities.hasUserSettingsLegacyColumns).toBe(false);
	});

	it("探测只读 information_schema，不触碰业务表", async () => {
		const { db, queries } = fakeDb([]);
		await detectMigrationSchemaCapabilities(db as never);
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("information_schema.columns");
		expect(queries[0]).toContain("current_schema()");
	});
});
