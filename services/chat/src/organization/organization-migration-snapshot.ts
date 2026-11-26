/**
 * MIG-C 迁移快照（技术方案 §12.3 七类口径；Goal #3C W29）。
 *
 * 用途：迁移前后按用户 / 默认组织采集同一套口径并逐项比对，证明
 * `MIG-A → MIG-B → MIG-C` 全程**只改租户列、不改业务事实**。
 *
 * 七类口径（与 §12.3 逐条对应）：
 * 1. 每币种 `Account.balance` 合计；
 * 2. 每计划 `targetAmount`、`PlanAllocation.{amount,usedAmount}`、`status`、
 *    `PlanInstallment` 数量与金额合计；
 * 3. `Transaction` / `UsageRecord` / `Correction` 计数、`version` 合计与金额合计；
 * 4. `CostLot` `remainingQty` / `unitCost` / `totalCost` 与 `UsageLotAllocation`
 *    数量 / 成本合计；
 * 5. 报告口径输入（每计划目标额 + 已用数量）与 FIFO 汇总（已消耗成本、
 *    剩余批次成本、未知费用标记数）；
 * 6. 组织设置与个人设置（`baseCurrency` / `prepPreference` / `reminderEnabled` /
 *    `ledgerStartedAt`）；
 * 7. 100% 派生行 `child.organizationId === parent.organizationId` 与 0 孤儿行。
 *
 * 采集口径的两条硬约定（决定了「前后可比」）：
 * - **归属键（ownerKey）**：MIG-F 前按 `user_id`（业务表保留个人列到 MIG-F），
 *   MIG-F 后按 `organization_id`；两者都在同一阶段内稳定，前后可比。
 * - **有效设置（口径 6）**：取「默认组织的组织设置；若不存在则取个人设置」。
 *   迁移前个人用户通常还没有组织设置，迁移后组织设置由个人设置逐字段复制而来，
 *   因此**有效值在迁移前后恒等**，而「组织设置是否存在」这种结构性变化
 *   由 `organization-reconcile.ts` 的 `settings_parity.*` 单独负责。
 *
 * 作用域约定：口径 1–6 按采集范围（分片用户 / 全库）限定；口径 7 的父子一致性
 * 按范围限定，而**孤儿行计数为全库口径**——孤儿行按定义无法归属到任何组织，
 * 与 `reconcileMigration` 全量模式的孤儿检查同口径。
 *
 * MIG-F 前瞻：MIG-F 删除 `user_id` / `user_settings` legacy 列后，
 * 本模块自动切换到组织维度采集（`ownerKind = ORGANIZATION`），不引用被删列。
 *
 * SQL 纪律：仅「默认组织解析」与「孤儿行计数」两处使用静态 SQL + 绑定参数；
 * 其余走 Prisma ORM（参数化，无标识符拼接），无 N+1 写放大。
 */

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
	detectMigrationSchemaCapabilities,
} from "./migration-schema-capabilities";

/** 快照采集所用的数据库句柄（PrismaClient 或事务客户端） */
export type MigrationSnapshotDb = PrismaClient | Prisma.TransactionClient;

/** 归属键种类：MIG-F 前按用户，MIG-F 后按默认组织 */
export type MigrationSnapshotOwnerKind = "USER" | "ORGANIZATION";

/** 口径 1：每（归属键, 币种）的账户余额合计 */
export interface MigrationSnapshotAccountBalance {
	ownerKey: string;
	currencyCode: string;
	balance: string;
}

/** 口径 2：每计划的目标 / 分配 / 状态 / 批次 */
export interface MigrationSnapshotPlan {
	planId: string;
	ownerKey: string;
	targetAmount: string;
	status: string;
	/** 计划分配汇总（1:1；缺失为 null） */
	allocationAmount: string | null;
	allocationUsedAmount: string | null;
	/** 排期批次数量与金额合计 */
	installmentCount: number;
	installmentAmountSum: string;
}

/** 口径 3：流水类计数 / version 合计 / 金额合计 */
export interface MigrationSnapshotLedger {
	count: number;
	/** `version` 列合计（该表无 version 列时为 null） */
	versionSum: string | null;
	/** 金额合计（该表无金额列时为 null） */
	amountSum: string | null;
}

/** 口径 4：成本批次（逐批次精确值） */
export interface MigrationSnapshotCostLot {
	lotId: string;
	ownerKey: string;
	currencyCode: string;
	quantity: string;
	remainingQty: string;
	unitCost: string;
	totalCost: string;
}

/** 口径 4：使用分摊合计 */
export interface MigrationSnapshotAllocation {
	count: number;
	quantitySum: string;
	costSum: string;
}

/** 口径 5：报告口径输入与 FIFO 汇总 */
export interface MigrationSnapshotReport {
	/** 报告输入：每计划目标额 + 已用数量 */
	planInputs: Array<{
		planId: string;
		targetAmount: string;
		usedQuantity: string;
	}>;
	/** 已消耗成本（Σ 分摊 cost） */
	consumedCost: string;
	/** 剩余批次成本（Σ 批次 remaining_qty × unit_cost） */
	remainingLotCost: string;
	/** 未知费用标记数（分摊批次来源为买入且来源交易手续费未明确的分摊行数） */
	unknownFeeFlags: number;
	/** 来源拆分：初始持仓 */
	initialQuantity: string;
	initialCost: string;
	/** 来源拆分：买入 */
	purchaseQuantity: string;
	purchaseCost: string;
}

/** 口径 6：有效设置（组织设置优先，其次个人设置） */
export interface MigrationSnapshotSetting {
	ownerKey: string;
	baseCurrency: string | null;
	prepPreference: string | null;
	reminderEnabled: boolean | null;
	/** ISO 时间戳字符串 */
	ledgerStartedAt: string | null;
}

/** 口径 7：一条派生关系的统计 */
export interface MigrationSnapshotRelation {
	/** 派生行总数 */
	total: number;
	/** `child.organizationId` 与 `parent.organizationId` 不一致的行数（目标 0） */
	violations: number;
}

/** 口径 7：派生行父子组织一致性与孤儿行 */
export interface MigrationSnapshotDerivedRows {
	relations: {
		usageRecordPlan: MigrationSnapshotRelation;
		costLotInitialHolding: MigrationSnapshotRelation;
		costLotTransaction: MigrationSnapshotRelation;
		usageLotAllocationUsage: MigrationSnapshotRelation;
		usageLotAllocationCostLot: MigrationSnapshotRelation;
		planChangeLogPlan: MigrationSnapshotRelation;
	};
	/** 孤儿行（父缺失）计数（全库口径） */
	orphans: {
		planAllocations: number;
		planInstallments: number;
		usageLotAllocations: number;
		planChangeLogs: number;
		usageRecords: number;
		costLots: number;
	};
}

/** 一份迁移快照（迁移前 / 迁移后各一份） */
export interface MigrationSnapshot {
	/** 采集时的库阶段能力（前后两份必须同阶段，否则比对无意义） */
	capabilities: {
		migF: boolean;
		hasUserSettingsLegacyColumns: boolean;
		hasReminderReadAtColumn: boolean;
	};
	/** 是否为分片采集 */
	scoped: boolean;
	/** 归属键种类 */
	ownerKind: MigrationSnapshotOwnerKind;
	accountBalances: MigrationSnapshotAccountBalance[];
	plans: MigrationSnapshotPlan[];
	transactions: MigrationSnapshotLedger;
	usageRecords: MigrationSnapshotLedger;
	corrections: MigrationSnapshotLedger;
	costLots: MigrationSnapshotCostLot[];
	usageLotAllocations: MigrationSnapshotAllocation;
	report: MigrationSnapshotReport;
	settings: MigrationSnapshotSetting[];
	derivedRows: MigrationSnapshotDerivedRows;
}

/** 快照差异结构（与核对模块的 ReconcileDiff 同形） */
export interface MigrationSnapshotDiff {
	scope: string;
	left: unknown;
	right: unknown;
}

/** 快照比对结果 */
export interface MigrationSnapshotComparison {
	/** 已比对项总数 */
	checks: number;
	/** 差异清单（目标 0；left = 迁移前取值，right = 迁移后取值） */
	diffs: MigrationSnapshotDiff[];
}

/** Decimal → 稳定字符串（保留有效小数位，避免指数记法造成伪差异） */
function decimalToString(value: Prisma.Decimal | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return value.toFixed(value.decimalPlaces());
}

/**
 * 绑定参数分片上限：PostgreSQL 单条语句的绑定参数上限为 32,767，
 * 全库快照的 id 集合可能远超该数 → 按批查询后合并，避免「too many arguments」。
 */
const ID_CHUNK_SIZE = 5_000;

/** 按批查询（`id IN (...)` / `planId IN (...)`），返回合并结果 */
async function findInChunks<T>(
	ids: readonly string[],
	column: "id" | "planId" | "usageId",
	query: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
	if (ids.length === 0) return [];
	const result: T[] = [];
	for (let index = 0; index < ids.length; index += ID_CHUNK_SIZE) {
		const chunk = ids.slice(index, index + ID_CHUNK_SIZE);
		result.push(...(await query(chunk)));
	}
	return result;
}

function decimalToStringOrZero(value: Prisma.Decimal | null | undefined): string {
	return decimalToString(value ?? new Prisma.Decimal(0)) ?? "0";
}

/** 解析分片用户的默认组织（与运行时 resolveDefaultOrganizationId 同口径） */
async function resolveDefaultOrganizations(
	db: MigrationSnapshotDb,
	userIds: string[],
	scoped: boolean,
): Promise<Map<string, string>> {
	const rows = await db.$queryRaw<Array<{ userId: string; organizationId: string }>>`
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
		SELECT user_id AS "userId", organization_id AS "organizationId"
		FROM defaults
		WHERE (NOT ${scoped} OR user_id = ANY(${userIds}::text[]))`;
	return new Map(rows.map((row) => [row.userId, row.organizationId]));
}

/** 孤儿派生行计数（全库只读；与 reconcileMigration 全量模式同口径） */
async function countOrphanRows(db: MigrationSnapshotDb): Promise<{
	planAllocations: number;
	planInstallments: number;
	usageLotAllocations: number;
	planChangeLogs: number;
	usageRecords: number;
	costLots: number;
}> {
	const [row] = await db.$queryRaw<
		Array<{
			plan_allocations: bigint;
			plan_installments: bigint;
			usage_lot_allocations: bigint;
			plan_change_logs: bigint;
			usage_records: bigint;
			cost_lots: bigint;
		}>
	>`
		SELECT
			(SELECT count(*) FROM plan_allocations a
				LEFT JOIN plans p ON p.id = a.plan_id
				WHERE p.id IS NULL) AS plan_allocations,
			(SELECT count(*) FROM plan_installments i
				LEFT JOIN plans p ON p.id = i.plan_id
				WHERE p.id IS NULL) AS plan_installments,
			(SELECT count(*) FROM usage_lot_allocations x
				LEFT JOIN usage_records u ON u.id = x.usage_id
				LEFT JOIN cost_lots l ON l.id = x.lot_id
				WHERE u.id IS NULL OR l.id IS NULL) AS usage_lot_allocations,
			(SELECT count(*) FROM plan_change_logs c
				LEFT JOIN plans p ON p.id = c.plan_id
				WHERE p.id IS NULL) AS plan_change_logs,
			(SELECT count(*) FROM usage_records u
				LEFT JOIN plans p ON p.id = u.plan_id
				WHERE p.id IS NULL) AS usage_records,
			(SELECT count(*) FROM cost_lots l
				WHERE (l.source_type = 'INITIAL' AND NOT EXISTS (
						SELECT 1 FROM initial_holdings h WHERE h.id = l.source_id))
					OR (l.source_type = 'PURCHASE' AND NOT EXISTS (
						SELECT 1 FROM transactions t WHERE t.id = l.source_id))) AS cost_lots`;
	return {
		planAllocations: Number(row?.plan_allocations ?? 0n),
		planInstallments: Number(row?.plan_installments ?? 0n),
		usageLotAllocations: Number(row?.usage_lot_allocations ?? 0n),
		planChangeLogs: Number(row?.plan_change_logs ?? 0n),
		usageRecords: Number(row?.usage_records ?? 0n),
		costLots: Number(row?.cost_lots ?? 0n),
	};
}

/**
 * 采集迁移快照。
 *
 * @param db             Prisma 客户端（或事务客户端）
 * @param options.userIds 可选分片；缺省采集全库
 */
export async function captureMigrationSnapshot(
	db: MigrationSnapshotDb,
	options: { userIds?: string[] } = {},
): Promise<MigrationSnapshot> {
	const capabilities = await detectMigrationSchemaCapabilities(db);
	const legacy = !capabilities.migF;
	const scoped = options.userIds !== undefined;
	const userIds = options.userIds ?? [];
	const ownerKind: MigrationSnapshotOwnerKind = legacy ? "USER" : "ORGANIZATION";

	const defaultOrgByUser = await resolveDefaultOrganizations(db, userIds, scoped);

	// 归属范围：MIG-F 前按 user_id，MIG-F 后按默认组织
	let scopeOrgIds: string[] = [];
	if (!legacy) {
		scopeOrgIds = scoped
			? [...new Set([...defaultOrgByUser.values()])]
			: (await db.organization.findMany({ select: { id: true } })).map((o) => o.id);
	}

	// ── 口径 1：每（归属键, 币种）账户余额合计 ──────────────────────────
	const accountRows = legacy
		? (
				await db.account.findMany({
					where: scoped ? { userId: { in: userIds } } : {},
					select: { userId: true, currencyCode: true, balance: true },
				})
			).map((row) => ({
				ownerKey: row.userId,
				currencyCode: row.currencyCode,
				balance: row.balance,
			}))
		: (
				await db.account.findMany({
					where: scoped ? { organizationId: { in: scopeOrgIds } } : {},
					select: { organizationId: true, currencyCode: true, balance: true },
				})
			).map((row) => ({
				ownerKey: row.organizationId ?? "",
				currencyCode: row.currencyCode,
				balance: row.balance,
			}));
	const accountBalanceMap = new Map<
		string,
		{ ownerKey: string; currencyCode: string; balance: Prisma.Decimal }
	>();
	for (const row of accountRows) {
		const key = `${row.ownerKey} ${row.currencyCode}`;
		const existing = accountBalanceMap.get(key);
		accountBalanceMap.set(key, {
			ownerKey: row.ownerKey,
			currencyCode: row.currencyCode,
			balance: (existing?.balance ?? new Prisma.Decimal(0)).add(row.balance),
		});
	}
	const accountBalances: MigrationSnapshotAccountBalance[] = [
		...accountBalanceMap.values(),
	]
		.map((entry) => ({
			ownerKey: entry.ownerKey,
			currencyCode: entry.currencyCode,
			balance: decimalToStringOrZero(entry.balance),
		}))
		.sort((left, right) =>
			left.ownerKey === right.ownerKey
				? left.currencyCode.localeCompare(right.currencyCode)
				: left.ownerKey.localeCompare(right.ownerKey),
		);

	// ── 口径 2：计划 + 分配 + 排期批次 ────────────────────────────────
	// 计划行先归一为同一形状（MIG-F 前 ownerKey = userId，MIG-F 后 = organizationId），
	// 避免下游出现分支类型断言。
	const planCore: Array<{
		id: string;
		ownerKey: string;
		organizationId: string | null;
		targetAmount: Prisma.Decimal;
		status: string;
	}> = legacy
		? (
				await db.plan.findMany({
					where: scoped ? { userId: { in: userIds } } : {},
					select: {
						id: true,
						userId: true,
						organizationId: true,
						targetAmount: true,
						status: true,
					},
				})
			).map((row) => ({
				id: row.id,
				ownerKey: row.userId,
				organizationId: row.organizationId,
				targetAmount: row.targetAmount,
				status: row.status,
			}))
		: (
				await db.plan.findMany({
					where: scoped ? { organizationId: { in: scopeOrgIds } } : {},
					select: {
						id: true,
						organizationId: true,
						targetAmount: true,
						status: true,
					},
				})
			).map((row) => ({
				id: row.id,
				ownerKey: row.organizationId ?? "",
				organizationId: row.organizationId,
				targetAmount: row.targetAmount,
				status: row.status,
			}));
	const planIds = planCore.map((row) => row.id);
	const planAllocations = await findInChunks(
		planIds,
		"planId",
		(chunk) =>
			db.planAllocation.findMany({
				where: { planId: { in: chunk } },
				select: { planId: true, amount: true, usedAmount: true },
			}),
	);
	const planInstallments = await findInChunks(
		planIds,
		"planId",
		(chunk) =>
			db.planInstallment.findMany({
				where: { planId: { in: chunk } },
				select: { planId: true, amount: true },
			}),
	);
	const allocationByPlan = new Map(
		planAllocations.map((row) => [row.planId, row] as const),
	);
	const installmentAggByPlan = new Map<
		string,
		{ count: number; amount: Prisma.Decimal }
	>();
	for (const row of planInstallments) {
		const existing = installmentAggByPlan.get(row.planId);
		installmentAggByPlan.set(row.planId, {
			count: (existing?.count ?? 0) + 1,
			amount: (existing?.amount ?? new Prisma.Decimal(0)).add(row.amount),
		});
	}
	const plans: MigrationSnapshotPlan[] = planCore
		.map((row) => {
			const allocation = allocationByPlan.get(row.id);
			const installments = installmentAggByPlan.get(row.id);
			return {
				planId: row.id,
				ownerKey: row.ownerKey,
				targetAmount: decimalToStringOrZero(row.targetAmount),
				status: row.status,
				allocationAmount: decimalToString(allocation?.amount),
				allocationUsedAmount: decimalToString(allocation?.usedAmount),
				installmentCount: installments?.count ?? 0,
				installmentAmountSum: decimalToStringOrZero(installments?.amount),
			};
		})
		.sort((left, right) => left.planId.localeCompare(right.planId));

	// ── 口径 3：交易 / 使用 / 更正 ─────────────────────────────────────
	const transactionRows = await db.transaction.findMany({
		where: legacy
			? scoped
				? { userId: { in: userIds } }
				: {}
			: scoped
				? { organizationId: { in: scopeOrgIds } }
				: {},
		select: { id: true, version: true, principalAmount: true, feeAmount: true },
	});
	const transactionAmount = transactionRows.reduce(
		(total, row) =>
			total.add(row.principalAmount).add(row.feeAmount ?? new Prisma.Decimal(0)),
		new Prisma.Decimal(0),
	);
	const transactionVersionSum = transactionRows.reduce(
		(total, row) => total.add(row.version),
		new Prisma.Decimal(0),
	);
	const transactions: MigrationSnapshotLedger = {
		count: transactionRows.length,
		versionSum: decimalToString(transactionVersionSum),
		amountSum: decimalToString(transactionAmount),
	};

	const usageRows = await db.usageRecord.findMany({
		where: legacy
			? scoped
				? { userId: { in: userIds } }
				: {}
			: scoped
				? { organizationId: { in: scopeOrgIds } }
				: {},
		select: {
			id: true,
			planId: true,
			amount: true,
			version: true,
			organizationId: true,
		},
	});
	const usageAmount = usageRows.reduce(
		(total, row) => total.add(row.amount),
		new Prisma.Decimal(0),
	);
	const usageVersionSum = usageRows.reduce(
		(total, row) => total.add(row.version),
		new Prisma.Decimal(0),
	);
	const usageRecords: MigrationSnapshotLedger = {
		count: usageRows.length,
		versionSum: decimalToString(usageVersionSum),
		amountSum: decimalToString(usageAmount),
	};

	const correctionCount = await db.correction.count({
		where: legacy
			? scoped
				? { userId: { in: userIds } }
				: {}
			: scoped
				? { organizationId: { in: scopeOrgIds } }
				: {},
	});
	const corrections: MigrationSnapshotLedger = {
		count: correctionCount,
		// Correction 无 version 列、无金额列（金额承载在 before/after JSON 快照里，
		// 逐笔比对不属于 §12.3 的聚合口径）
		versionSum: null,
		amountSum: null,
	};

	// ── 口径 4：成本批次 + 使用分摊 ───────────────────────────────────
	const costLotCore: Array<{
		id: string;
		ownerKey: string;
		organizationId: string | null;
		currencyCode: string;
		sourceType: string;
		sourceId: string;
		quantity: Prisma.Decimal;
		remainingQty: Prisma.Decimal;
		unitCost: Prisma.Decimal;
		totalCost: Prisma.Decimal;
	}> = legacy
		? (
				await db.costLot.findMany({
					where: scoped ? { userId: { in: userIds } } : {},
					select: {
						id: true,
						userId: true,
						organizationId: true,
						currencyCode: true,
						sourceType: true,
						sourceId: true,
						quantity: true,
						remainingQty: true,
						unitCost: true,
						totalCost: true,
					},
				})
			).map((row) => ({
				id: row.id,
				ownerKey: row.userId,
				organizationId: row.organizationId,
				currencyCode: row.currencyCode,
				sourceType: row.sourceType,
				sourceId: row.sourceId,
				quantity: row.quantity,
				remainingQty: row.remainingQty,
				unitCost: row.unitCost,
				totalCost: row.totalCost,
			}))
		: (
				await db.costLot.findMany({
					where: scoped ? { organizationId: { in: scopeOrgIds } } : {},
					select: {
						id: true,
						organizationId: true,
						currencyCode: true,
						sourceType: true,
						sourceId: true,
						quantity: true,
						remainingQty: true,
						unitCost: true,
						totalCost: true,
					},
				})
			).map((row) => ({
				id: row.id,
				ownerKey: row.organizationId ?? "",
				organizationId: row.organizationId,
				currencyCode: row.currencyCode,
				sourceType: row.sourceType,
				sourceId: row.sourceId,
				quantity: row.quantity,
				remainingQty: row.remainingQty,
				unitCost: row.unitCost,
				totalCost: row.totalCost,
			}));
	const costLots: MigrationSnapshotCostLot[] = costLotCore
		.map((row) => ({
			lotId: row.id,
			ownerKey: row.ownerKey,
			currencyCode: row.currencyCode,
			quantity: decimalToStringOrZero(row.quantity),
			remainingQty: decimalToStringOrZero(row.remainingQty),
			unitCost: decimalToStringOrZero(row.unitCost),
			totalCost: decimalToStringOrZero(row.totalCost),
		}))
		.sort((left, right) => left.lotId.localeCompare(right.lotId));

	const usageIds = usageRows.map((row) => row.id);
	const allocationRows = await findInChunks(
		usageIds,
		"usageId",
		(chunk) =>
			db.usageLotAllocation.findMany({
				where: { usageId: { in: chunk } },
				select: { usageId: true, lotId: true, quantity: true, cost: true },
			}),
	);
	const usageLotAllocations: MigrationSnapshotAllocation = {
		count: allocationRows.length,
		quantitySum: decimalToStringOrZero(
			allocationRows.reduce(
				(total, row) => total.add(row.quantity),
				new Prisma.Decimal(0),
			),
		),
		costSum: decimalToStringOrZero(
			allocationRows.reduce(
				(total, row) => total.add(row.cost),
				new Prisma.Decimal(0),
			),
		),
	};

	// ── 口径 5：报告口径输入与 FIFO 汇总 ──────────────────────────────
	const usedQuantityByPlan = new Map<string, Prisma.Decimal>();
	for (const row of usageRows) {
		usedQuantityByPlan.set(
			row.planId,
			(usedQuantityByPlan.get(row.planId) ?? new Prisma.Decimal(0)).add(
				row.amount,
			),
		);
	}

	// 作用域外的关联批次补查（对抗审 R1-I2）：使用记录可能关联到**不在采集范围内**的
	// CostLot（跨组织分摊）。若只按范围内批次建索引，分摊行会因 `if (!lot) continue`
	// 被静默漏计——口径 5（来源拆分 / 未知费用标记）与口径 7（分摊双父同组织）双双失真，
	// 且跨组织违约（usage.organizationId ≠ lot.organizationId）根本不会被报出。
	// 这些批次只用于口径 5 / 7 的父记录解析，**不进入口径 4 的批次清单**（口径 4 按
	// 采集范围限定）。
	const scopedLotIds = new Set(costLotCore.map((row) => row.id));
	const extraAllocationLots = (
		await findInChunks(
			[...new Set(allocationRows.map((row) => row.lotId))].filter(
				(id) => !scopedLotIds.has(id),
			),
			"id",
			(chunk) =>
				db.costLot.findMany({
					where: { id: { in: chunk } },
					select: {
						id: true,
						organizationId: true,
						currencyCode: true,
						sourceType: true,
						sourceId: true,
						quantity: true,
						remainingQty: true,
						unitCost: true,
						totalCost: true,
					},
				}),
		)
	).map((row) => ({
		id: row.id,
		ownerKey: "",
		organizationId: row.organizationId,
		currencyCode: row.currencyCode,
		sourceType: row.sourceType,
		sourceId: row.sourceId,
		quantity: row.quantity,
		remainingQty: row.remainingQty,
		unitCost: row.unitCost,
		totalCost: row.totalCost,
	}));

	// 来源交易（买入批次的手续费来源）——按批次 sourceId 精确取，不依赖是否落在范围内
	const purchaseTransactionIds = [
		...new Set(
			[...costLotCore, ...extraAllocationLots]
				.filter((row) => row.sourceType === "PURCHASE")
				.map((row) => row.sourceId),
		),
	];
	const purchaseTransactions = await findInChunks(
		purchaseTransactionIds,
		"id",
		(chunk) =>
			db.transaction.findMany({
				where: { id: { in: chunk } },
				select: { id: true, organizationId: true, feeAmount: true },
			}),
	);
	const purchaseTransactionById = new Map(
		purchaseTransactions.map((row) => [row.id, row] as const),
	);

	const report: MigrationSnapshotReport = {
		planInputs: plans
			.map((plan) => ({
				planId: plan.planId,
				targetAmount: plan.targetAmount,
				usedQuantity: decimalToStringOrZero(usedQuantityByPlan.get(plan.planId)),
			}))
			.sort((left, right) => left.planId.localeCompare(right.planId)),
		consumedCost: usageLotAllocations.costSum,
		remainingLotCost: decimalToStringOrZero(
			costLotCore.reduce(
				(total, row) => total.add(row.remainingQty.mul(row.unitCost)),
				new Prisma.Decimal(0),
			),
		),
		unknownFeeFlags: 0,
		initialQuantity: "0",
		initialCost: "0",
		purchaseQuantity: "0",
		purchaseCost: "0",
	};

	// 未知费用标记 + 来源拆分（按分摊批次的 sourceType 归类）
	// 批次索引 = 范围内批次 ∪ 作用域外关联批次（否则分摊行会被静默漏计，对抗审 R1-I2）
	const lotById = new Map(
		[...costLotCore, ...extraAllocationLots].map((row) => [row.id, row] as const),
	);
	let unknownFeeFlags = 0;
	let initialQuantity = new Prisma.Decimal(0);
	let initialCost = new Prisma.Decimal(0);
	let purchaseQuantity = new Prisma.Decimal(0);
	let purchaseCost = new Prisma.Decimal(0);
	for (const allocation of allocationRows) {
		const lot = lotById.get(allocation.lotId);
		if (!lot) continue;
		if (lot.sourceType === "INITIAL") {
			initialQuantity = initialQuantity.add(allocation.quantity);
			initialCost = initialCost.add(allocation.cost);
		} else {
			purchaseQuantity = purchaseQuantity.add(allocation.quantity);
			purchaseCost = purchaseCost.add(allocation.cost);
			const source = purchaseTransactionById.get(lot.sourceId);
			if (!source || source.feeAmount === null) {
				unknownFeeFlags += 1;
			}
		}
	}
	report.unknownFeeFlags = unknownFeeFlags;
	report.initialQuantity = decimalToStringOrZero(initialQuantity);
	report.initialCost = decimalToStringOrZero(initialCost);
	report.purchaseQuantity = decimalToStringOrZero(purchaseQuantity);
	report.purchaseCost = decimalToStringOrZero(purchaseCost);

	// ── 口径 6：有效设置（组织设置优先，其次个人设置） ────────────────
	const orgSettings = await db.organizationSettings.findMany({
		select: {
			organizationId: true,
			baseCurrency: true,
			prepPreference: true,
			reminderEnabled: true,
			ledgerStartedAt: true,
		},
	});
	const orgSettingsById = new Map(
		orgSettings.map((row) => [row.organizationId, row] as const),
	);
	const personalSettingsByUser = new Map<
		string,
		{
			baseCurrency: string;
			prepPreference: string;
			reminderEnabled: boolean;
			ledgerStartedAt: Date | null;
		}
	>();
	if (capabilities.hasUserSettingsLegacyColumns) {
		const personal = await db.userSettings.findMany({
			select: {
				userId: true,
				baseCurrency: true,
				prepPreference: true,
				reminderEnabled: true,
				ledgerStartedAt: true,
			},
		});
		for (const row of personal) {
			personalSettingsByUser.set(row.userId, row);
		}
	}
	const scopeUsers = scoped
		? userIds
		: (await db.user.findMany({ select: { id: true } })).map((row) => row.id);
	const settings: MigrationSnapshotSetting[] = [];
	if (legacy) {
		for (const userId of scopeUsers) {
			const orgId = defaultOrgByUser.get(userId);
			const org = orgId ? orgSettingsById.get(orgId) : undefined;
			const personal = personalSettingsByUser.get(userId);
			const effective = org ?? personal;
			settings.push({
				ownerKey: userId,
				baseCurrency: effective?.baseCurrency ?? null,
				prepPreference: effective?.prepPreference ?? null,
				reminderEnabled: effective?.reminderEnabled ?? null,
				ledgerStartedAt: effective?.ledgerStartedAt
					? effective.ledgerStartedAt.toISOString()
					: null,
			});
		}
	} else {
		for (const orgId of scopeOrgIds) {
			const org = orgSettingsById.get(orgId);
			settings.push({
				ownerKey: orgId,
				baseCurrency: org?.baseCurrency ?? null,
				prepPreference: org?.prepPreference ?? null,
				reminderEnabled: org?.reminderEnabled ?? null,
				ledgerStartedAt: org?.ledgerStartedAt
					? org.ledgerStartedAt.toISOString()
					: null,
			});
		}
	}
	settings.sort((left, right) => left.ownerKey.localeCompare(right.ownerKey));

	// ── 口径 7：派生行父子组织一致性与孤儿行 ──────────────────────────
	const planById = new Map(
		planCore.map((row) => [
			row.id,
			{ id: row.id, organizationId: row.organizationId },
		] as const),
	);
	const usageParentPlanIds = [...new Set(usageRows.map((row) => row.planId))];
	const usageParentPlans = await findInChunks(
		usageParentPlanIds,
		"id",
		(chunk) =>
			db.plan.findMany({
				where: { id: { in: chunk } },
				select: { id: true, organizationId: true },
			}),
	);
	const usageParentById = new Map(
		usageParentPlans.map((row) => [row.id, row] as const),
	);
	const initialHoldingIds = [
		...new Set(
			costLotCore
				.filter((row) => row.sourceType === "INITIAL")
				.map((row) => row.sourceId),
		),
	];
	const initialHoldings = await findInChunks(
		initialHoldingIds,
		"id",
		(chunk) =>
			db.initialHolding.findMany({
				where: { id: { in: chunk } },
				select: { id: true, organizationId: true },
			}),
	);
	const initialHoldingById = new Map(
		initialHoldings.map((row) => [row.id, row] as const),
	);
	const planChangeLogs = await findInChunks(
		planIds,
		"planId",
		(chunk) =>
			db.planChangeLog.findMany({
				where: { planId: { in: chunk } },
				select: { planId: true, organizationId: true },
			}),
	);
	const usageById = new Map(
		usageRows.map((row) => [row.id, row] as const),
	);

	const relations = buildRelationStats({
		usageRows,
		usageParentById,
		costLotCore,
		initialHoldingById,
		purchaseTransactionById,
		allocationRows,
		usageById,
		lotById,
		planChangeLogs,
		planById,
	});
	const orphans = await countOrphanRows(db);

	return {
		capabilities: {
			migF: capabilities.migF,
			hasUserSettingsLegacyColumns: capabilities.hasUserSettingsLegacyColumns,
			hasReminderReadAtColumn: capabilities.hasReminderReadAtColumn,
		},
		scoped,
		ownerKind,
		accountBalances,
		plans,
		transactions,
		usageRecords,
		corrections,
		costLots,
		usageLotAllocations,
		report,
		settings,
		derivedRows: { relations, orphans },
	};
}

interface RelationStatsInput {
	usageRows: Array<{ id: string; planId: string; organizationId: string | null }>;
	usageParentById: Map<string, { id: string; organizationId: string | null }>;
	costLotCore: Array<{
		id: string;
		sourceType: string;
		sourceId: string;
		organizationId: string | null;
	}>;
	initialHoldingById: Map<string, { id: string; organizationId: string | null }>;
	purchaseTransactionById: Map<
		string,
		{ id: string; organizationId: string | null }
	>;
	allocationRows: Array<{ usageId: string; lotId: string }>;
	usageById: Map<string, { id: string; organizationId: string | null }>;
	lotById: Map<string, { id: string; organizationId: string | null }>;
	planChangeLogs: Array<{ planId: string; organizationId: string | null }>;
	planById: Map<string, { id: string; organizationId: string | null }>;
}

/**
 * 父子组织一致性判定（**快照口径，宽于 reconcile 的 IS DISTINCT FROM**）：
 * - 两侧都非空且不相等 → 真正的跨组织错配（计为 violations）；
 * - **单侧为空**（迁移前的存量 NULL 行 vs 已挂组织的双写行）→ **不判为跨组织冲突**，
 *   只算「过渡态」：迁移前后的快照必须可比，而过渡态正是「迁移正在把 NULL 行挂上
 *   组织」这一合法中间态；迁移完成后两侧皆非空，此时任何不一致都会被计入；
 * - 两侧都为空 → 一致（迁移前两侧都未挂组织）。
 *
 * 与核对模块的分工（两者口径**故意不同**，不要混用）：
 * - 快照（本函数）回答「迁移有没有改动既有事实」——单侧 NULL 的过渡态必须放过，
 *   否则同一份数据在迁移前后会因组织列的填充而产生伪差异；
 * - `reconcileMigration` 用 `IS DISTINCT FROM` 做**迁移闸门**的严格判定——NULL 与
 *   非 NULL 也算不一致（迁移完成后两侧必须完全一致）。因此单侧 NULL 的行会在
 *   reconcile 中被判为差异、在快照中则不算，两者的差异清单不可互相替代。
 */
function isCrossOrganizationMismatch(
	left: string | null | undefined,
	right: string | null | undefined,
): boolean {
	const leftOrg = left ?? null;
	const rightOrg = right ?? null;
	if (leftOrg === null || rightOrg === null) return false;
	return leftOrg !== rightOrg;
}

/** 口径 7 的父子组织一致性统计（按采集范围限定） */
function buildRelationStats(input: RelationStatsInput): {
	usageRecordPlan: MigrationSnapshotRelation;
	costLotInitialHolding: MigrationSnapshotRelation;
	costLotTransaction: MigrationSnapshotRelation;
	usageLotAllocationUsage: MigrationSnapshotRelation;
	usageLotAllocationCostLot: MigrationSnapshotRelation;
	planChangeLogPlan: MigrationSnapshotRelation;
} {
	// UsageRecord ↔ Plan
	const usagePlan = { total: input.usageRows.length, violations: 0 };
	for (const row of input.usageRows) {
		const parent = input.usageParentById.get(row.planId);
		if (!parent) continue;
		if (isCrossOrganizationMismatch(row.organizationId, parent.organizationId)) {
			usagePlan.violations += 1;
		}
	}

	// CostLot ↔ InitialHolding / Transaction
	const costLotInitial = { total: 0, violations: 0 };
	const costLotTransaction = { total: 0, violations: 0 };
	for (const row of input.costLotCore) {
		if (row.sourceType === "INITIAL") {
			const parent = input.initialHoldingById.get(row.sourceId);
			if (!parent) continue;
			costLotInitial.total += 1;
			if (isCrossOrganizationMismatch(row.organizationId, parent.organizationId)) {
				costLotInitial.violations += 1;
			}
		} else if (row.sourceType === "PURCHASE") {
			const parent = input.purchaseTransactionById.get(row.sourceId);
			if (!parent) continue;
			costLotTransaction.total += 1;
			if (isCrossOrganizationMismatch(row.organizationId, parent.organizationId)) {
				costLotTransaction.violations += 1;
			}
		}
	}

	// UsageLotAllocation ↔ UsageRecord / CostLot
	const allocationUsage = { total: 0, violations: 0 };
	const allocationLot = { total: 0, violations: 0 };
	for (const row of input.allocationRows) {
		const usage = input.usageById.get(row.usageId);
		if (usage) {
			allocationUsage.total += 1;
		}
		const lot = input.lotById.get(row.lotId);
		if (lot) {
			allocationLot.total += 1;
		}
		if (usage && lot) {
			if (isCrossOrganizationMismatch(usage.organizationId, lot.organizationId)) {
				allocationUsage.violations += 1;
				allocationLot.violations += 1;
			}
		}
	}

	// PlanChangeLog ↔ Plan
	const planChangeLogPlan = {
		total: input.planChangeLogs.length,
		violations: 0,
	};
	for (const row of input.planChangeLogs) {
		const parent = input.planById.get(row.planId);
		if (!parent) continue;
		if (isCrossOrganizationMismatch(row.organizationId, parent.organizationId)) {
			planChangeLogPlan.violations += 1;
		}
	}

	return {
		usageRecordPlan: usagePlan,
		costLotInitialHolding: costLotInitial,
		costLotTransaction: costLotTransaction,
		usageLotAllocationUsage: allocationUsage,
		usageLotAllocationCostLot: allocationLot,
		planChangeLogPlan: planChangeLogPlan,
	};
}

// ───────────────────────── 快照比对 ─────────────────────────

function deepEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (left === null || right === null) return false;
	if (typeof left !== typeof right) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right)) return false;
		if (left.length !== right.length) return false;
		return left.every((item, index) => deepEqual(item, right[index]));
	}
	if (typeof left === "object" && typeof right === "object") {
		const leftKeys = Object.keys(left as Record<string, unknown>).sort();
		const rightKeys = Object.keys(right as Record<string, unknown>).sort();
		if (leftKeys.length !== rightKeys.length) return false;
		if (!leftKeys.every((key, index) => key === rightKeys[index])) return false;
		return leftKeys.every((key) =>
			deepEqual(
				(left as Record<string, unknown>)[key],
				(right as Record<string, unknown>)[key],
			),
		);
	}
	return false;
}

/**
 * 比对两份迁移快照（迁移前 / 迁移后）。
 *
 * 逐字段比对：集合型口径按稳定键（ownerKey+currencyCode / planId / lotId / ownerKey）
 * 配对，缺一侧即报差异；标量口径直接比值。目标 0 差异。
 */
export function compareMigrationSnapshots(
	before: MigrationSnapshot,
	after: MigrationSnapshot,
): MigrationSnapshotComparison {
	const diffs: MigrationSnapshotDiff[] = [];
	let checks = 0;

	function check(scope: string, left: unknown, right: unknown): void {
		checks += 1;
		if (!deepEqual(left, right)) {
			diffs.push({ scope, left, right });
		}
	}

	function compareKeyed<T>(
		scope: string,
		left: T[],
		right: T[],
		keyOf: (item: T) => string,
	): void {
		const leftMap = new Map(left.map((item) => [keyOf(item), item]));
		const rightMap = new Map(right.map((item) => [keyOf(item), item]));
		const keys = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort();
		for (const key of keys) {
			const leftItem = leftMap.get(key);
			const rightItem = rightMap.get(key);
			if (leftItem === undefined || rightItem === undefined) {
				check(`${scope}[${key}]`, leftItem ?? null, rightItem ?? null);
				continue;
			}
			const leftRecord = leftItem as unknown as Record<string, unknown>;
			const rightRecord = rightItem as unknown as Record<string, unknown>;
			for (const field of Object.keys(leftRecord).sort()) {
				check(`${scope}[${key}].${field}`, leftRecord[field], rightRecord[field]);
			}
		}
	}

	check("snapshot.capabilities.migF", before.capabilities.migF, after.capabilities.migF);
	check("snapshot.scoped", before.scoped, after.scoped);
	check("snapshot.ownerKind", before.ownerKind, after.ownerKind);

	// 口径 1
	compareKeyed(
		"snapshot.accountBalances",
		before.accountBalances,
		after.accountBalances,
		(item) => `${item.ownerKey}|${item.currencyCode}`,
	);
	// 口径 2
	compareKeyed(
		"snapshot.plans",
		before.plans,
		after.plans,
		(item) => item.planId,
	);
	// 口径 3
	check(
		"snapshot.transactions.count",
		before.transactions.count,
		after.transactions.count,
	);
	check(
		"snapshot.transactions.versionSum",
		before.transactions.versionSum,
		after.transactions.versionSum,
	);
	check(
		"snapshot.transactions.amountSum",
		before.transactions.amountSum,
		after.transactions.amountSum,
	);
	check(
		"snapshot.usageRecords.count",
		before.usageRecords.count,
		after.usageRecords.count,
	);
	check(
		"snapshot.usageRecords.versionSum",
		before.usageRecords.versionSum,
		after.usageRecords.versionSum,
	);
	check(
		"snapshot.usageRecords.amountSum",
		before.usageRecords.amountSum,
		after.usageRecords.amountSum,
	);
	check(
		"snapshot.corrections.count",
		before.corrections.count,
		after.corrections.count,
	);
	check(
		"snapshot.corrections.versionSum",
		before.corrections.versionSum,
		after.corrections.versionSum,
	);
	check(
		"snapshot.corrections.amountSum",
		before.corrections.amountSum,
		after.corrections.amountSum,
	);
	// 口径 4
	compareKeyed(
		"snapshot.costLots",
		before.costLots,
		after.costLots,
		(item) => item.lotId,
	);
	check(
		"snapshot.usageLotAllocations.count",
		before.usageLotAllocations.count,
		after.usageLotAllocations.count,
	);
	check(
		"snapshot.usageLotAllocations.quantitySum",
		before.usageLotAllocations.quantitySum,
		after.usageLotAllocations.quantitySum,
	);
	check(
		"snapshot.usageLotAllocations.costSum",
		before.usageLotAllocations.costSum,
		after.usageLotAllocations.costSum,
	);
	// 口径 5
	compareKeyed(
		"snapshot.report.planInputs",
		before.report.planInputs,
		after.report.planInputs,
		(item) => item.planId,
	);
	check(
		"snapshot.report.consumedCost",
		before.report.consumedCost,
		after.report.consumedCost,
	);
	check(
		"snapshot.report.remainingLotCost",
		before.report.remainingLotCost,
		after.report.remainingLotCost,
	);
	check(
		"snapshot.report.unknownFeeFlags",
		before.report.unknownFeeFlags,
		after.report.unknownFeeFlags,
	);
	check(
		"snapshot.report.initialQuantity",
		before.report.initialQuantity,
		after.report.initialQuantity,
	);
	check(
		"snapshot.report.initialCost",
		before.report.initialCost,
		after.report.initialCost,
	);
	check(
		"snapshot.report.purchaseQuantity",
		before.report.purchaseQuantity,
		after.report.purchaseQuantity,
	);
	check(
		"snapshot.report.purchaseCost",
		before.report.purchaseCost,
		after.report.purchaseCost,
	);
	// 口径 6
	compareKeyed(
		"snapshot.settings",
		before.settings,
		after.settings,
		(item) => item.ownerKey,
	);
	// 口径 7
	for (const relation of [
		"usageRecordPlan",
		"costLotInitialHolding",
		"costLotTransaction",
		"usageLotAllocationUsage",
		"usageLotAllocationCostLot",
		"planChangeLogPlan",
	] as const) {
		check(
			`snapshot.derivedRows.relations.${relation}.total`,
			before.derivedRows.relations[relation].total,
			after.derivedRows.relations[relation].total,
		);
		check(
			`snapshot.derivedRows.relations.${relation}.violations`,
			before.derivedRows.relations[relation].violations,
			after.derivedRows.relations[relation].violations,
		);
	}
	for (const orphan of [
		"planAllocations",
		"planInstallments",
		"usageLotAllocations",
		"planChangeLogs",
		"usageRecords",
		"costLots",
	] as const) {
		check(
			`snapshot.derivedRows.orphans.${orphan}`,
			before.derivedRows.orphans[orphan],
			after.derivedRows.orphans[orphan],
		);
	}

	return { checks, diffs };
}
