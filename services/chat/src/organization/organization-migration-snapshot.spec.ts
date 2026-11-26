import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
	captureMigrationSnapshot,
	compareMigrationSnapshots,
	type MigrationSnapshot,
} from "./organization-migration-snapshot";

/**
 * 迁移快照口径单测（Goal #3C W29；技术方案 §12.3）。
 *
 * 覆盖：
 * - `compareMigrationSnapshots` 的差异检出能力（**负向**：人为改动任一口径都必须
 *   被报出——防「比对恒 0 差异」的同义反复测试）；
 * - 集合型口径按稳定键配对（缺一侧即报差异）；
 * - 标量口径逐字段比对。
 *
 * 本文件不触碰数据库：快照结构由夹具直接构造（快照是纯数据结构，采集逻辑由
 * integration/organization-migration.spec.ts 在真实库上验证）。
 */

function baseSnapshot(): MigrationSnapshot {
	return {
		capabilities: {
			migF: false,
			hasUserSettingsLegacyColumns: true,
			hasReminderReadAtColumn: true,
		},
		scoped: true,
		ownerKind: "USER",
		accountBalances: [
			{ ownerKey: "u1", currencyCode: "USD", balance: "1000.5000" },
			{ ownerKey: "u1", currencyCode: "EUR", balance: "200.2500" },
		],
		plans: [
			{
				planId: "p1",
				ownerKey: "u1",
				targetAmount: "300.0000",
				status: "ACTIVE",
				allocationAmount: "300.0000",
				allocationUsedAmount: "50.0000",
				installmentCount: 3,
				installmentAmountSum: "300.0000",
			},
		],
		transactions: { count: 2, versionSum: "3", amountSum: "290.0000" },
		usageRecords: { count: 1, versionSum: "1", amountSum: "50.0000" },
		corrections: { count: 2, versionSum: null, amountSum: null },
		costLots: [
			{
				lotId: "l1",
				ownerKey: "u1",
				currencyCode: "USD",
				quantity: "500.0000",
				remainingQty: "450.0000",
				unitCost: "7.2000000000",
				totalCost: "3600.0000",
			},
		],
		usageLotAllocations: { count: 1, quantitySum: "50.0000", costSum: "360.0000" },
		report: {
			planInputs: [
				{ planId: "p1", targetAmount: "300.0000", usedQuantity: "50.0000" },
			],
			consumedCost: "360.0000",
			remainingLotCost: "3240.0000",
			unknownFeeFlags: 0,
			initialQuantity: "50.0000",
			initialCost: "360.0000",
			purchaseQuantity: "0",
			purchaseCost: "0",
		},
		settings: [
			{
				ownerKey: "u1",
				baseCurrency: "CNY",
				prepPreference: "balanced",
				reminderEnabled: true,
				ledgerStartedAt: "2026-01-05T00:00:00.000Z",
			},
		],
		derivedRows: {
			relations: {
				usageRecordPlan: { total: 1, violations: 0 },
				costLotInitialHolding: { total: 1, violations: 0 },
				costLotTransaction: { total: 1, violations: 0 },
				usageLotAllocationUsage: { total: 1, violations: 0 },
				usageLotAllocationCostLot: { total: 1, violations: 0 },
				planChangeLogPlan: { total: 1, violations: 0 },
			},
			orphans: {
				planAllocations: 0,
				planInstallments: 0,
				usageLotAllocations: 0,
				planChangeLogs: 0,
				usageRecords: 0,
				costLots: 0,
			},
		},
	};
}

describe("compareMigrationSnapshots（§12.3 七类口径比对）", () => {
	it("同一份快照前后比对：0 差异", () => {
		const snapshot = baseSnapshot();
		const comparison = compareMigrationSnapshots(snapshot, snapshot);
		expect(comparison.diffs).toEqual([]);
		expect(comparison.checks).toBeGreaterThan(0);
	});

	it("深拷贝的同一份快照仍为 0 差异（结构等价即可，不要求同一引用）", () => {
		const before = baseSnapshot();
		const after = JSON.parse(
			JSON.stringify(before),
		) as MigrationSnapshot;
		expect(compareMigrationSnapshots(before, after).diffs).toEqual([]);
	});

	it("口径 1：币种余额合计变化必须被报出", () => {
		const before = baseSnapshot();
		const after = baseSnapshot();
		after.accountBalances[0] = { ...after.accountBalances[0], balance: "999.0000" };
		const comparison = compareMigrationSnapshots(before, after);
		expect(comparison.diffs.map((diff) => diff.scope)).toContain(
			"snapshot.accountBalances[u1|USD].balance",
		);
	});

	it("口径 1：归属键/币种集合缺一侧即报差异（多出或丢失的币种不能被静默吞掉）", () => {
		const before = baseSnapshot();
		const after = baseSnapshot();
		after.accountBalances = after.accountBalances.filter(
			(row) => row.currencyCode !== "EUR",
		);
		const comparison = compareMigrationSnapshots(before, after);
		const scopes = comparison.diffs.map((diff) => diff.scope);
		expect(scopes).toContain("snapshot.accountBalances[u1|EUR]");
	});

	it("口径 2：计划目标额 / 分配 / 状态 / 批次数量逐项可检出", () => {
		const mutations: Array<(plan: MigrationSnapshot["plans"][number]) => void> = [
			(plan) => {
				plan.targetAmount = "301.0000";
			},
			(plan) => {
				plan.allocationUsedAmount = "51.0000";
			},
			(plan) => {
				plan.status = "CANCELLED";
			},
			(plan) => {
				plan.installmentCount = 2;
			},
		];
		for (const mutate of mutations) {
			const before = baseSnapshot();
			const after = baseSnapshot();
			mutate(after.plans[0]);
			const comparison = compareMigrationSnapshots(before, after);
			expect(comparison.diffs.length).toBe(1);
		}
	});

	it("口径 3：计数 / version 合计 / 金额合计逐项可检出", () => {
		const before = baseSnapshot();
		const after = baseSnapshot();
		after.transactions = { count: 3, versionSum: "4", amountSum: "290.0000" };
		const scopes = compareMigrationSnapshots(before, after).diffs.map(
			(diff) => diff.scope,
		);
		expect(scopes).toContain("snapshot.transactions.count");
		expect(scopes).toContain("snapshot.transactions.versionSum");
		expect(scopes).not.toContain("snapshot.transactions.amountSum");
	});

	it("口径 4：批次剩余量 / 单位成本 / 分摊合计逐项可检出", () => {
		const before = baseSnapshot();
		const after = baseSnapshot();
		after.costLots[0] = { ...after.costLots[0], remainingQty: "449.0000" };
		after.usageLotAllocations = {
			count: 1,
			quantitySum: "50.0000",
			costSum: "361.0000",
		};
		const scopes = compareMigrationSnapshots(before, after).diffs.map(
			(diff) => diff.scope,
		);
		expect(scopes).toContain("snapshot.costLots[l1].remainingQty");
		expect(scopes).toContain("snapshot.usageLotAllocations.costSum");
	});

	it("口径 5：报告输入与 FIFO 汇总逐项可检出", () => {
		const before = baseSnapshot();
		const after = baseSnapshot();
		after.report.consumedCost = "361.0000";
		after.report.remainingLotCost = "3239.0000";
		after.report.unknownFeeFlags = 1;
		after.report.planInputs[0] = {
			...after.report.planInputs[0],
			usedQuantity: "51.0000",
		};
		const scopes = compareMigrationSnapshots(before, after).diffs.map(
			(diff) => diff.scope,
		);
		expect(scopes).toContain("snapshot.report.consumedCost");
		expect(scopes).toContain("snapshot.report.remainingLotCost");
		expect(scopes).toContain("snapshot.report.unknownFeeFlags");
		expect(scopes).toContain("snapshot.report.planInputs[p1].usedQuantity");
	});

	it("口径 6：设置值变化可检出；个人设置与组织设置来源不同不产生伪差异", () => {
		const before = baseSnapshot();
		const after = baseSnapshot();
		after.settings[0] = { ...after.settings[0], baseCurrency: "USD" };
		expect(
			compareMigrationSnapshots(before, after).diffs.map((diff) => diff.scope),
		).toContain("snapshot.settings[u1].baseCurrency");
	});

	it("口径 7：派生行违规数与孤儿行计数变化可检出", () => {
		const before = baseSnapshot();
		const after = baseSnapshot();
		after.derivedRows.relations.usageRecordPlan = { total: 1, violations: 1 };
		after.derivedRows.orphans.usageRecords = 1;
		const scopes = compareMigrationSnapshots(before, after).diffs.map(
			(diff) => diff.scope,
		);
		expect(scopes).toContain(
			"snapshot.derivedRows.relations.usageRecordPlan.violations",
		);
		expect(scopes).toContain("snapshot.derivedRows.orphans.usageRecords");
	});

	it("采集范围与归属键口径不一致时报差异（防止拿两阶段快照互比）", () => {
		const before = baseSnapshot();
		const after = baseSnapshot();
		after.scoped = false;
		after.ownerKind = "ORGANIZATION";
		const scopes = compareMigrationSnapshots(before, after).diffs.map(
			(diff) => diff.scope,
		);
		expect(scopes).toContain("snapshot.scoped");
		expect(scopes).toContain("snapshot.ownerKind");
	});

	it("Decimal 精度不被吞掉：0.1 + 0.2 与 0.3 不等价", () => {
		const before = baseSnapshot();
		const after = baseSnapshot();
		before.report.consumedCost = new Prisma.Decimal(0.1)
			.add(new Prisma.Decimal(0.2))
			.toFixed(20);
		after.report.consumedCost = "0.3";
		expect(
			compareMigrationSnapshots(before, after).diffs.map((diff) => diff.scope),
		).toContain("snapshot.report.consumedCost");
	});
});

/**
 * 跨作用域 `UsageRecord → UsageLotAllocation → CostLot` 不静默漏计
 * （对抗审 R1-I2）。
 *
 * 场景：采集范围限定为 user A，但 A 的使用记录分摊自**范围外**（user B / 组织 B）
 * 的成本批次。修复前：批次索引只由范围内批次构成 → 分摊行因 `if (!lot) continue`
 * 被静默丢弃 → 口径 5（来源拆分 / 未知费用标记）与口径 7（分摊双父同组织）双双
 * 失真，且跨组织违约根本不会被报出。
 *
 * 本用例用假 Prisma 客户端精确复现该场景，并断言修复后的三条结果：
 * 1. 口径 5 的来源拆分计入该分摊（purchaseQuantity / initialQuantity）；
 * 2. 口径 5 的未知费用标记按其来源交易的手续费状态计入；
 * 3. 口径 7 的 `usageLotAllocationCostLot` 关系数到该分摊，并报出跨组织违约。
 */
describe("captureMigrationSnapshot 的跨作用域批次解析（对抗审 R1-I2）", () => {
	const IN_SCOPE_USER = "user-a";
	const OUT_OF_SCOPE_LOT = "lot-b";
	const OUT_OF_SCOPE_TXN = "txn-b";

	function fakeSnapshotClient() {
		const costLotQueries: Array<Record<string, unknown>> = [];
		const prisma = {
			$queryRaw: async (query: unknown) => {
				const sql = Array.isArray(query)
					? (query as string[]).join(" ")
					: ((query as { sql?: string }).sql ?? "");
				if (sql.includes("information_schema.columns")) {
					return [
						{ tableName: "accounts", columnName: "user_id" },
						{ tableName: "plans", columnName: "user_id" },
						{ tableName: "usage_records", columnName: "user_id" },
						{ tableName: "cost_lots", columnName: "user_id" },
						{ tableName: "transactions", columnName: "user_id" },
						{ tableName: "initial_holdings", columnName: "user_id" },
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
				}
				// 默认组织解析 / 孤儿计数：空库
				return [];
			},
			account: { findMany: async () => [] },
			plan: {
				findMany: async () => [],
			},
			planAllocation: { findMany: async () => [] },
			planInstallment: { findMany: async () => [] },
			transaction: {
				findMany: async (args: unknown) => {
					const where = (args as { where?: { id?: { in?: string[] } } }).where;
					// 来源交易补查（按批次 sourceId 取手续费来源）
					if (where?.id?.in?.includes(OUT_OF_SCOPE_TXN)) {
						return [
							{
								id: OUT_OF_SCOPE_TXN,
								organizationId: "org-b",
								feeAmount: null,
							},
						];
					}
					return [];
				},
			},
			usageRecord: {
				findMany: async () => [
					{
						id: "usage-a",
						planId: "plan-a",
						amount: "5.0000",
						version: 1,
						organizationId: "org-a",
					},
				],
			},
			correction: { count: async () => 0 },
			costLot: {
				findMany: async (args: unknown) => {
					const where = (
						args as { where?: { id?: { in?: string[] } } }
					).where;
					costLotQueries.push((where ?? {}) as Record<string, unknown>);
					// 范围内批次查询（按 user_id 限定）→ 空（该批次在范围外）
					if (!where?.id) return [];
					// 作用域外关联批次补查（按 id 限定）
					return [
						{
							id: OUT_OF_SCOPE_LOT,
							organizationId: "org-b",
							currencyCode: "USD",
							sourceType: "PURCHASE",
							sourceId: OUT_OF_SCOPE_TXN,
							quantity: "20.0000",
							remainingQty: "20.0000",
							unitCost: "7.2000000000",
							totalCost: "144.0000",
						},
					];
				},
			},
			usageLotAllocation: {
				findMany: async () => [
					{
						usageId: "usage-a",
						lotId: OUT_OF_SCOPE_LOT,
						quantity: "5.0000",
						cost: "36.0000",
					},
				],
			},
			organizationSettings: { findMany: async () => [] },
			userSettings: { findMany: async () => [] },
			user: { findMany: async () => [] },
			organization: { findMany: async () => [] },
			initialHolding: { findMany: async () => [] },
			planChangeLog: { findMany: async () => [] },
		};
		return { prisma, costLotQueries };
	}

	it("跨作用域批次被补查：口径 5 不漏计、口径 7 报出跨组织违约", async () => {
		const { prisma, costLotQueries } = fakeSnapshotClient();
		const snapshot = await captureMigrationSnapshot(prisma as never, {
			userIds: [IN_SCOPE_USER],
		});

		// 修复点：确实按分摊行的 lotId 补查了范围外批次
		expect(
			costLotQueries.some((where) =>
				JSON.stringify(where).includes(OUT_OF_SCOPE_LOT),
			),
			"未按 lotId 补查范围外批次",
		).toBe(true);

		// 口径 5：来源拆分计入该分摊（买入来源），不再被静默跳过
		expect(Number(snapshot.report.purchaseQuantity)).toBe(5);
		expect(Number(snapshot.report.purchaseCost)).toBe(36);
		expect(Number(snapshot.report.initialQuantity)).toBe(0);
		// 未知费用标记：来源交易手续费未明确 → 计入 1
		expect(snapshot.report.unknownFeeFlags).toBe(1);
		// 已消耗成本仍按分摊事实汇总
		expect(Number(snapshot.report.consumedCost)).toBe(36);

		// 口径 7：分摊双父关系数到该行，并报出跨组织违约（org-a ≠ org-b）
		const relation = snapshot.derivedRows.relations.usageLotAllocationCostLot;
		expect(relation.total).toBe(1);
		expect(relation.violations).toBe(1);
	});
});
