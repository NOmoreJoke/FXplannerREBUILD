/**
 * MIG-B 一致性核对（技术方案 §12.3；Goal #3A W15）。
 *
 * 原理：MIG-B 只把存量个人行映射到默认组织（userId 列保留、金额不动），
 * 因此「按 userId 聚合」与「按 organizationId 聚合」必须完全一致；
 * 派生行父子 organizationId 必须一致；FIFO 消耗量守恒。
 * 任何差异进 diffs（结构化清单），目标 0 diffs。
 *
 * 复用方式：integration 测试直接调用；CLI verify 子命令见
 * prisma/tob-r1-migration/backfill.ts（0 diffs 退出 0，否则退出 1）。
 */

import type { PrismaClient } from "@prisma/client";

/** 单条核对差异（scope 描述差异位置，left/right 为两侧聚合值） */
export interface ReconcileDiff {
	scope: string;
	left: unknown;
	right: unknown;
}

export interface ReconcileResult {
	/** 核对项总数 */
	checks: number;
	/** 差异清单（目标 0） */
	diffs: ReconcileDiff[];
}

interface AggCell {
	count: number;
	sum: string;
}

function expectEqual(
	diffs: ReconcileDiff[],
	scope: string,
	left: unknown,
	right: unknown,
): void {
	if (JSON.stringify(left) !== JSON.stringify(right)) {
		diffs.push({ scope, left, right });
	}
}

/** Prisma groupBy 聚合行 → 稳定 key → {count,sum} 映射（Decimal 取字符串防浮点） */
function toAggMap(
	rows: Array<{ key: string; count: number; sum: string | null }>,
): Map<string, AggCell> {
	const map = new Map<string, AggCell>();
	for (const row of rows) {
		map.set(row.key, { count: row.count, sum: row.sum ?? "0" });
	}
	return map;
}

/** 按 key 逐格比较 count 与 sum */
function compareAgg(
	diffs: ReconcileDiff[],
	scope: string,
	left: Map<string, AggCell>,
	right: Map<string, AggCell>,
	checks: { value: number },
): void {
	const keys = new Set([...left.keys(), ...right.keys()]);
	for (const key of [...keys].sort()) {
		checks.value += 1;
		const l = left.get(key) ?? { count: 0, sum: "0" };
		const r = right.get(key) ?? { count: 0, sum: "0" };
		expectEqual(
			diffs,
			`${scope}[${key}].count`,
			l.count,
			r.count,
		);
		expectEqual(diffs, `${scope}[${key}].sum`, l.sum, r.sum);
	}
}

/**
 * §12.3 全量一致性核对：以「userId 视角」为 Oracle 与「organizationId 视角」
 * 逐域比对（同一批行、两种过滤条件，任何映射缺失/金额漂移都会产生差异）。
 */
export async function reconcileMigration(
	prisma: PrismaClient,
	options: { userIds?: string[] } = {},
): Promise<ReconcileResult> {
	const diffs: ReconcileDiff[] = [];
	const checks = { value: 0 };

	// 1. 每用户默认组织映射完整性：恰一个 OWNER/ACTIVE Membership
	// （userIds 分片用于测试/演练；CLI 全量核对不传）
	const membershipWhere = options.userIds
		? { role: "OWNER", status: "ACTIVE", userId: { in: options.userIds } }
		: { role: "OWNER", status: "ACTIVE" };
	const memberships = await prisma.membership.findMany({
		where: membershipWhere,
		select: { userId: true, organizationId: true },
	});
	const byUser = new Map<string, string[]>();
	for (const m of memberships) {
		byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), m.organizationId]);
	}
	const users = await prisma.user.findMany({
		where: options.userIds ? { id: { in: options.userIds } } : undefined,
		select: { id: true },
	});
	const userToOrg = new Map<string, string>();
	for (const user of users) {
		checks.value += 1;
		const orgs = byUser.get(user.id) ?? [];
		const organizationId = orgs[0];
		if (orgs.length !== 1 || !organizationId) {
			expectEqual(diffs, `default_org[${user.id}]`, 1, orgs.length);
			continue;
		}
		userToOrg.set(user.id, organizationId);
	}

	for (const [userId, organizationId] of userToOrg) {
		// 2. 每币种 Account.balance（§12.3.1）
		const accountLeft = await prisma.account.groupBy({
			by: ["currencyCode"],
			where: { userId },
			_count: { _all: true },
			_sum: { balance: true },
		});
		const accountRight = await prisma.account.groupBy({
			by: ["currencyCode"],
			where: { organizationId },
			_count: { _all: true },
			_sum: { balance: true },
		});
		compareAgg(
			diffs,
			`account[${userId}]`,
			toAggMap(
				accountLeft.map((r) => ({
					key: r.currencyCode,
					count: r._count._all,
					sum: r._sum.balance?.toString() ?? null,
				})),
			),
			toAggMap(
				accountRight.map((r) => ({
					key: r.currencyCode,
					count: r._count._all,
					sum: r._sum.balance?.toString() ?? null,
				})),
			),
			checks,
		);

		// 3. 每 Plan 状态×金额 + 分配汇总 + 批次（§12.3.2）
		const planLeft = await prisma.plan.groupBy({
			by: ["status"],
			where: { userId },
			_count: { _all: true },
			_sum: { targetAmount: true },
		});
		const planRight = await prisma.plan.groupBy({
			by: ["status"],
			where: { organizationId },
			_count: { _all: true },
			_sum: { targetAmount: true },
		});
		compareAgg(
			diffs,
			`plan[${userId}]`,
			toAggMap(
				planLeft.map((r) => ({
					key: r.status,
					count: r._count._all,
					sum: r._sum.targetAmount?.toString() ?? null,
				})),
			),
			toAggMap(
				planRight.map((r) => ({
					key: r.status,
					count: r._count._all,
					sum: r._sum.targetAmount?.toString() ?? null,
				})),
			),
			checks,
		);
		const planIds = (
			await prisma.plan.findMany({ where: { userId }, select: { id: true } })
		).map((p) => p.id);
		const allocLeft = await prisma.planAllocation.aggregate({
			where: { planId: { in: planIds } },
			_sum: { amount: true, usedAmount: true },
		});
		const orgPlanIds = (
			await prisma.plan.findMany({
				where: { organizationId },
				select: { id: true },
			})
		).map((p) => p.id);
		const allocRight = await prisma.planAllocation.aggregate({
			where: { planId: { in: orgPlanIds } },
			_sum: { amount: true, usedAmount: true },
		});
		checks.value += 1;
		expectEqual(
			diffs,
			`plan_allocation[${userId}]`,
			{
				amount: allocLeft._sum?.amount?.toString() ?? "0",
				usedAmount: allocLeft._sum?.usedAmount?.toString() ?? "0",
			},
			{
				amount: allocRight._sum?.amount?.toString() ?? "0",
				usedAmount: allocRight._sum?.usedAmount?.toString() ?? "0",
			},
		);

		// 4. Transaction / UsageRecord / Correction 数量与金额合计（§12.3.3）
		const txnLeft = await prisma.transaction.aggregate({
			where: { userId },
			_count: { _all: true },
			_sum: { quantity: true, principalAmount: true },
		});
		const txnRight = await prisma.transaction.aggregate({
			where: { organizationId },
			_count: { _all: true },
			_sum: { quantity: true, principalAmount: true },
		});
		checks.value += 1;
		expectEqual(
			diffs,
			`transaction[${userId}]`,
			{
				count: txnLeft._count._all,
				quantity: txnLeft._sum.quantity?.toString() ?? "0",
				principal: txnLeft._sum.principalAmount?.toString() ?? "0",
			},
			{
				count: txnRight._count._all,
				quantity: txnRight._sum.quantity?.toString() ?? "0",
				principal: txnRight._sum.principalAmount?.toString() ?? "0",
			},
		);
		const usageLeft = await prisma.usageRecord.aggregate({
			where: { userId },
			_count: { _all: true },
			_sum: { amount: true, version: true },
		});
		const usageRight = await prisma.usageRecord.aggregate({
			where: { organizationId },
			_count: { _all: true },
			_sum: { amount: true, version: true },
		});
		checks.value += 1;
		expectEqual(
			diffs,
			`usage_record[${userId}]`,
			{
				count: usageLeft._count._all,
				amount: usageLeft._sum.amount?.toString() ?? "0",
				versionSum: usageLeft._sum.version ?? 0,
			},
			{
				count: usageRight._count._all,
				amount: usageRight._sum.amount?.toString() ?? "0",
				versionSum: usageRight._sum.version ?? 0,
			},
		);
		const corrLeft = await prisma.correction.count({ where: { userId } });
		const corrRight = await prisma.correction.count({
			where: { organizationId },
		});
		checks.value += 1;
		expectEqual(diffs, `correction[${userId}].count`, corrLeft, corrRight);

		// 5. CostLot 剩余/成本 与 UsageLotAllocation 数量/成本（§12.3.4）
		const lotLeft = await prisma.costLot.aggregate({
			where: { userId },
			_count: { _all: true },
			_sum: { remainingQty: true, totalCost: true },
		});
		const lotRight = await prisma.costLot.aggregate({
			where: { organizationId },
			_count: { _all: true },
			_sum: { remainingQty: true, totalCost: true },
		});
		checks.value += 1;
		expectEqual(
			diffs,
			`cost_lot[${userId}]`,
			{
				count: lotLeft._count._all,
				remainingQty: lotLeft._sum.remainingQty?.toString() ?? "0",
				totalCost: lotLeft._sum.totalCost?.toString() ?? "0",
			},
			{
				count: lotRight._count._all,
				remainingQty: lotRight._sum.remainingQty?.toString() ?? "0",
				totalCost: lotRight._sum.totalCost?.toString() ?? "0",
			},
		);
		const usageIdsLeft = (
			await prisma.usageRecord.findMany({
				where: { userId },
				select: { id: true },
			})
		).map((u) => u.id);
		const usageIdsRight = (
			await prisma.usageRecord.findMany({
				where: { organizationId },
				select: { id: true },
			})
		).map((u) => u.id);
		const lotAllocLeft = await prisma.usageLotAllocation.aggregate({
			where: { usageId: { in: usageIdsLeft } },
			_sum: { quantity: true, cost: true },
		});
		const lotAllocRight = await prisma.usageLotAllocation.aggregate({
			where: { usageId: { in: usageIdsRight } },
			_sum: { quantity: true, cost: true },
		});
		const lotAllocCountLeft = await prisma.usageLotAllocation.count({
			where: { usageId: { in: usageIdsLeft } },
		});
		const lotAllocCountRight = await prisma.usageLotAllocation.count({
			where: { usageId: { in: usageIdsRight } },
		});
		checks.value += 1;
		expectEqual(
			diffs,
			`usage_lot_allocation[${userId}]`,
			{
				count: lotAllocCountLeft,
				quantity: lotAllocLeft._sum?.quantity?.toString() ?? "0",
				cost: lotAllocLeft._sum?.cost?.toString() ?? "0",
			},
			{
				count: lotAllocCountRight,
				quantity: lotAllocRight._sum?.quantity?.toString() ?? "0",
				cost: lotAllocRight._sum?.cost?.toString() ?? "0",
			},
		);

		// 6. FIFO 消耗守恒：每笔使用的分摊量合计 = 使用量
		const usageRows = await prisma.usageRecord.findMany({
			where: { userId },
			select: { id: true, amount: true },
		});
		for (const usage of usageRows) {
			checks.value += 1;
			const allocated = await prisma.usageLotAllocation.aggregate({
				where: { usageId: usage.id },
				_sum: { quantity: true },
			});
			expectEqual(
				diffs,
				`fifo_conservation[${usage.id}]`,
				usage.amount.toString(),
				allocated._sum.quantity?.toString() ?? "0",
			);
		}

		// 7. 组织设置与记账起点（§12.3.6）：UserSettings ⇔ OrganizationSettings 同构
		const userSettings = await prisma.userSettings.findUnique({
			where: { userId },
		});
		const orgSettings = await prisma.organizationSettings.findUnique({
			where: { organizationId },
		});
		checks.value += 1;
		const toSettingsView = (
			s: {
				baseCurrency: string;
				prepPreference: string;
				reminderEnabled: boolean;
				ledgerStartedAt: Date | null;
			} | null,
		): string | null =>
			s
				? JSON.stringify({
						baseCurrency: s.baseCurrency,
						prepPreference: s.prepPreference,
						reminderEnabled: s.reminderEnabled,
						ledgerStartedAt: s.ledgerStartedAt?.toISOString() ?? null,
					})
				: null;
		expectEqual(
			diffs,
			`settings_parity[${userId}]`,
			toSettingsView(userSettings),
			toSettingsView(orgSettings),
		);
	}

	// 8. 派生行父子 organizationId 一致（§12.3.7）——raw SQL 全表核对值级不一致
	const mismatchRows = (await prisma.$queryRaw<Array<{ n: bigint }>>`
		SELECT
			(SELECT count(*) FROM plan_change_logs c
				JOIN plans p ON p.id = c.plan_id
				WHERE c.organization_id IS DISTINCT FROM p.organization_id) AS n
	`).at(0)?.n ?? 0n;
	checks.value += 1;
	expectEqual(
		diffs,
		"plan_change_logs.parent_org_consistency",
		0,
		Number(mismatchRows),
	);
	const usageMismatchRows = (await prisma.$queryRaw<Array<{ n: bigint }>>`
		SELECT
			(SELECT count(*) FROM usage_records u
				JOIN plans p ON p.id = u.plan_id
				WHERE u.organization_id IS DISTINCT FROM p.organization_id) AS n
	`).at(0)?.n ?? 0n;
	checks.value += 1;
	expectEqual(
		diffs,
		"usage_record.plan_org_consistency",
		0,
		Number(usageMismatchRows),
	);
	const lotSourceMismatchRows = (await prisma.$queryRaw<Array<{ n: bigint }>>`
		SELECT (
			(SELECT count(*) FROM cost_lots l
				JOIN initial_holdings h ON l.source_type = 'INITIAL' AND h.id = l.source_id
				WHERE l.organization_id IS DISTINCT FROM h.organization_id)
			+ (SELECT count(*) FROM cost_lots l
				JOIN transactions t ON l.source_type = 'PURCHASE' AND t.id = l.source_id
				WHERE l.organization_id IS DISTINCT FROM t.organization_id)
		) AS n
	`).at(0)?.n ?? 0n;
	checks.value += 1;
	expectEqual(
		diffs,
		"cost_lot.source_org_consistency",
		0,
		Number(lotSourceMismatchRows),
	);

	// 9. 孤儿派生行（§12.2.5：父缺失阻止发布；裸外键表用 LEFT JOIN IS NULL）
	const orphanRows = (await prisma.$queryRaw<
		Array<{ pa: bigint; ula: bigint; ur: bigint }>
	>`
		SELECT
			(SELECT count(*) FROM plan_allocations a
				LEFT JOIN plans p ON p.id = a.plan_id WHERE p.id IS NULL) AS pa,
			(SELECT count(*) FROM usage_lot_allocations x
				LEFT JOIN usage_records u ON u.id = x.usage_id
				LEFT JOIN cost_lots l ON l.id = x.lot_id
				WHERE u.id IS NULL OR l.id IS NULL) AS ula,
			(SELECT count(*) FROM usage_records u
				LEFT JOIN plans p ON p.id = u.plan_id WHERE p.id IS NULL) AS ur
	`).at(0);
	checks.value += 1;
	expectEqual(diffs, "plan_allocation.orphans", 0, Number(orphanRows?.pa ?? 0));
	checks.value += 1;
	expectEqual(
		diffs,
		"usage_lot_allocation.orphans",
		0,
		Number(orphanRows?.ula ?? 0),
	);
	checks.value += 1;
	expectEqual(diffs, "usage_record.orphans", 0, Number(orphanRows?.ur ?? 0));

	return { checks: checks.value, diffs };
}
