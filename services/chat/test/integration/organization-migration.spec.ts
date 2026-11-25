import { beforeAll, afterAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
	BackfillAnomalyError,
	backfillDefaultOrganizations,
} from "../../src/organization/organization-backfill";
import { reconcileMigration } from "../../src/organization/organization-reconcile";
import { resolveDefaultOrganizationId } from "../../src/authorization/default-organization";
import { cleanupUser } from "../helpers/test-app";

/**
 * MIG-B 集成测试（技术方案 §14.3.4；Goal #3A W15；评审 I-15/I-16 回归）：
 *
 * 1. 构造完整存量个人账本用户（多币种持仓/交易/计划+分配+批次/使用+分摊/
 *    更正/已读与未读提醒/AI 会话/EXPORT-CLEAR-DELETION 数据请求）+ 无设置新用户；
 * 2. 第 1 次回填（userIds 分片，避免触碰本地库其他用户）→ §12.3 核对 0 差异 →
 *    第 2 次重复回填（幂等）→ 无新增组织/无重复记录；
 * 3. 构造父缺失/跨组织异常行 → 预检阻断/核对显式报差异，绝不静默跳过；
 * 4. 评审回归：updated_at 逐行不变、核对负向用例逐类命中（防「查询写错 → 恒 0」
 *    的空过）、仅未挂组织的存量数据请求被映射、dry-run 估算 = 实际写入、
 *    分片事务、多组织用户回填到「最早」的 OWNER 组织。
 */

const RUN = `migmig-${Date.now()}`;
const db = new PrismaClient();
type CleanupDb = Parameters<typeof cleanupUser>[0];

let fullUserId = "";
let noSettingsUserId = "";
let chunkUserId = "";
let earliestOwnerUserId = "";
/** 孤儿异常用例的独立用户与其脏数据 id */
let orphanUserId = "";
let orphanUsageId = "";
let orphanPlanAllocationId = "";
/** 跨组织演练用的「组织 B」（第 6 个用例创建；后续负向用例把行改写到它上面） */
let crossOrgId = "";
/** 本次测试创建/关联的组织 id（afterAll 统一清理） */
const managedOrgIds: string[] = [];

/** 完整用户夹具里可用于破坏性核对的具体行 id */
const fixture = {
	planId: "",
	usageId: "",
	initialUsdLotId: "",
	purchaseLotId: "",
	readReminderId: "",
	unreadReminderId: "",
};

const T0 = new Date("2026-01-05T00:00:00.000Z");

async function seedFullUser(): Promise<string> {
	const user = await db.user.create({
		data: {
			email: `${RUN}-full@example.com`,
			passwordHash: "test-hash",
			name: "迁移验收张三",
		},
	});
	await db.userSettings.create({
		data: {
			userId: user.id,
			baseCurrency: "CNY",
			locale: "zh-CN",
			region: "CN",
			prepPreference: "balanced",
			reminderEnabled: true,
			ledgerStartedAt: T0,
		},
	});
	// 多币种账户
	await db.account.createMany({
		data: [
			{ userId: user.id, currencyCode: "USD", balance: "1000.5000" },
			{ userId: user.id, currencyCode: "EUR", balance: "200.2500" },
			{ userId: user.id, currencyCode: "JPY", balance: "0.0000" },
		],
	});
	// 初始持仓（对应 CostLot INITIAL）
	for (const [code, amount, cost, remaining] of [
		["USD", "500.0000", "3600.0000", "450.0000"],
		["EUR", "100.0000", "790.0000", "100.0000"],
	] as const) {
		const holding = await db.initialHolding.create({
			data: {
				userId: user.id,
				currencyCode: code,
				amount,
				rate: "7.2000000000",
				rawRate: "7.2000000000",
				rateSource: "identity",
				rateObservedAt: T0,
				cost,
				confirmedAt: T0,
			},
		});
		const lot = await db.costLot.create({
			data: {
				userId: user.id,
				currencyCode: code,
				sourceType: "INITIAL",
				sourceId: holding.id,
				quantity: amount,
				// 批次守恒：quantity − Σ已分摊 = remaining_qty（USD 已分摊 50）
				remainingQty: remaining,
				unitCost: "7.2000000000",
				totalCost: cost,
				acquiredAt: T0,
			},
		});
		if (code === "USD") fixture.initialUsdLotId = lot.id;
	}
	// 计划 + 分配 + 批次 + 变更日志
	const plan = await db.plan.create({
		data: {
			userId: user.id,
			targetCurrency: "USD",
			targetAmount: "300.0000",
			expectUseDate: new Date("2026-06-01T00:00:00.000Z"),
			prepLeadDays: 3,
			latestPrepDate: new Date("2026-05-25T00:00:00.000Z"),
			status: "ACTIVE",
		},
	});
	fixture.planId = plan.id;
	await db.planAllocation.create({
		data: { planId: plan.id, amount: "300.0000", usedAmount: "50.0000" },
	});
	for (const seq of [1, 2, 3]) {
		await db.planInstallment.create({
			data: {
				planId: plan.id,
				seq,
				scheduledAt: new Date(2026, 2, seq * 10),
				amount: "100.0000",
			},
		});
	}
	await db.planChangeLog.create({
		data: {
			planId: plan.id,
			changeType: "ALLOCATION_ADJUSTED",
			beforeTarget: "300.0000",
			afterTarget: "300.0000",
			beforeAlloc: "250.0000",
			afterAlloc: "300.0000",
			releasedAmount: "0.0000",
			beforeSnapshot: { amount: "250.0000" },
			afterSnapshot: { amount: "300.0000" },
		},
	});
	// 买入交易（PURCHASE CostLot）
	const txn = await db.transaction.create({
		data: {
			userId: user.id,
			currencyCode: "USD",
			quantity: "20.0000",
			principalAmount: "144.0000",
			feeAmount: "2.0000",
			exchangeRate: "7.2000000000",
			rateSource: "identity",
			rateObservedAt: new Date("2026-02-01T00:00:00.000Z"),
			transactedAt: new Date("2026-02-01T00:00:00.000Z"),
			planId: plan.id,
		},
	});
	const purchaseLot = await db.costLot.create({
		data: {
			userId: user.id,
			currencyCode: "USD",
			sourceType: "PURCHASE",
			sourceId: txn.id,
			quantity: "20.0000",
			remainingQty: "20.0000",
			unitCost: "7.2000000000",
			totalCost: "144.0000",
			acquiredAt: new Date("2026-02-01T00:00:00.000Z"),
		},
	});
	fixture.purchaseLotId = purchaseLot.id;
	// 使用 + FIFO 分摊（50 全部来自 INITIAL 批次，守恒）
	const usage = await db.usageRecord.create({
		data: {
			userId: user.id,
			planId: plan.id,
			currencyCode: "USD",
			amount: "50.0000",
			usedAt: new Date("2026-03-01T00:00:00.000Z"),
		},
	});
	fixture.usageId = usage.id;
	await db.usageLotAllocation.create({
		data: {
			usageId: usage.id,
			lotId: fixture.initialUsdLotId,
			quantity: "50.0000",
			cost: "360.0000",
		},
	});
	// 更正（APPLIED + FAILED 两种终态）
	await db.correction.create({
		data: {
			userId: user.id,
			targetType: "TRANSACTION",
			targetId: txn.id,
			reason: "手续费误录",
			beforeSnapshot: { feeAmount: "2.0000" },
			afterSnapshot: { feeAmount: "1.5000" },
			status: "APPLIED",
		},
	});
	await db.correction.create({
		data: {
			userId: user.id,
			targetType: "TRANSACTION",
			targetId: `${RUN}-missing`,
			reason: "演练失败行",
			beforeSnapshot: {},
			afterSnapshot: {},
			status: "FAILED",
			failReason: "目标不存在",
		},
	});
	// 提醒：一条已读 + 一条未读
	const [readReminder, unreadReminder] = await Promise.all([
		db.reminder.create({
			data: {
				userId: user.id,
				type: "PLAN_DUE",
				planId: plan.id,
				dedupKey: `${RUN}-due`,
				scheduledFor: new Date("2026-05-25T00:00:00.000Z"),
				readAt: new Date("2026-05-26T08:00:00.000Z"),
			},
		}),
		db.reminder.create({
			data: {
				userId: user.id,
				type: "PLAN_PREP",
				planId: plan.id,
				dedupKey: `${RUN}-prep`,
				scheduledFor: new Date("2026-05-22T00:00:00.000Z"),
			},
		}),
	]);
	fixture.readReminderId = readReminder.id;
	fixture.unreadReminderId = unreadReminder.id;
	// AI 会话
	await db.aiConversation.create({
		data: {
			userId: user.id,
			title: "迁移验收会话",
			lastMessageAt: new Date("2026-03-01T00:00:00.000Z"),
		},
	});
	// 数据请求：EXPORT（终态）/ DELETION（终态），均为个人域存量行。
	// W26 起「未挂组织的 CLEAR」被 DB CHECK data_requests_scope_type_org_check 排除，
	// 历史 CLEAR → 默认组织的映射已由迁移 20261125180000 的规范化 SQL 承接
	// （见 test/prisma.spec.ts），MIG-B 回填对数据请求恒为 no-op，此处不再构造。
	await db.dataRequest.createMany({
		data: [
			{
				userId: user.id,
				type: "EXPORT",
				status: "COMPLETED",
				requestedAt: new Date("2026-03-10T00:00:00.000Z"),
				dueAt: new Date("2026-03-24T00:00:00.000Z"),
			},
			{
				userId: user.id,
				type: "DELETION",
				status: "CANCELLED",
				requestedAt: new Date("2026-03-12T00:00:00.000Z"),
				dueAt: new Date("2026-03-26T00:00:00.000Z"),
			},
		],
	});
	return user.id;
}

async function createUser(label: string, name: string): Promise<string> {
	const user = await db.user.create({
		data: {
			email: `${RUN}-${label}@example.com`,
			passwordHash: "test-hash",
			name,
		},
	});
	return user.id;
}

beforeAll(async () => {
	fullUserId = await seedFullUser();
	noSettingsUserId = await createUser("noset", "待建账新用户");
	orphanUserId = await createUser("orphan", "孤儿演练用户");
	chunkUserId = await createUser("chunk", "分片事务演练用户");
	earliestOwnerUserId = await createUser("earliest", "多组织默认组织演练用户");
});

afterAll(async () => {
	// 孤儿演练脏数据（派生行先行，防裸外键阻塞用户级联删除）
	if (orphanUsageId) {
		await db.usageLotAllocation
			.deleteMany({ where: { usageId: orphanUsageId } })
			.catch(() => {});
	}
	if (orphanPlanAllocationId) {
		await db.planAllocation
			.deleteMany({ where: { id: orphanPlanAllocationId } })
			.catch(() => {});
	}
	// 本测试创建的组织（org 删除级联 memberships/settings/invitations）
	await db.organization.deleteMany({ where: { id: { in: managedOrgIds } } });
	for (const userId of [
		fullUserId,
		noSettingsUserId,
		orphanUserId,
		chunkUserId,
		earliestOwnerUserId,
	]) {
		if (userId) await cleanupUser(db as CleanupDb, userId);
	}
	await db.$disconnect();
});

/** 行集恒等核对的 10 张表：取该用户一行、把 organization_id 改写/还原所需的最小委托 */
interface OrgStammable {
	findFirst(args: {
		where: unknown;
	}): Promise<{ id: string } | null>;
	findMany(args: {
		where: unknown;
		select: { id: true; updatedAt: true };
	}): Promise<Array<{ id: string; updatedAt: Date }>>;
	update(args: {
		where: { id: string };
		data: { organizationId: string | null };
	}): Promise<unknown>;
}

type RowMappedTable =
	| "accounts"
	| "transactions"
	| "initial_holdings"
	| "cost_lots"
	| "plans"
	| "usage_records"
	| "corrections"
	| "reminders"
	| "ai_conversations"
	| "plan_change_logs";

const ROW_MAPPED_TABLES: ReadonlyArray<RowMappedTable> = [
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
];

function delegateFor(table: RowMappedTable): OrgStammable {
	const delegates: Record<RowMappedTable, OrgStammable> = {
		accounts: db.account as unknown as OrgStammable,
		transactions: db.transaction as unknown as OrgStammable,
		initial_holdings: db.initialHolding as unknown as OrgStammable,
		cost_lots: db.costLot as unknown as OrgStammable,
		plans: db.plan as unknown as OrgStammable,
		usage_records: db.usageRecord as unknown as OrgStammable,
		corrections: db.correction as unknown as OrgStammable,
		reminders: db.reminder as unknown as OrgStammable,
		ai_conversations: db.aiConversation as unknown as OrgStammable,
		plan_change_logs: db.planChangeLog as unknown as OrgStammable,
	};
	return delegates[table];
}

function rowsOf(table: RowMappedTable, userId: string): unknown {
	// PlanChangeLog 无 userId 列：经父 Plan 归属
	return table === "plan_change_logs" ? { plan: { userId } } : { userId };
}

/** 有 updated_at 列的 9 张业务表（PlanChangeLog 只有 created_at，单列快照） */
const TIMESTAMPED_TABLES: ReadonlyArray<Exclude<RowMappedTable, "plan_change_logs">> = [
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

/** 该用户在业务表 + data_requests 的全部行时间戳快照（表:行 → 毫秒） */
async function snapshotUpdatedAt(userId: string): Promise<Array<[string, number]>> {
	const snapshot: Array<[string, number]> = [];
	for (const table of TIMESTAMPED_TABLES) {
		const rows = await delegateFor(table).findMany({
			where: { userId },
			select: { id: true, updatedAt: true },
		});
		for (const row of rows) {
			snapshot.push([`${table}:${row.id}`, row.updatedAt.getTime()]);
		}
	}
	// PlanChangeLog 只有 created_at：回填不得删除重建（行 id 与创建时刻都不变）
	const changeLogs = await db.planChangeLog.findMany({
		where: { plan: { userId } },
		select: { id: true, createdAt: true },
	});
	for (const log of changeLogs) {
		snapshot.push([`plan_change_logs:${log.id}`, log.createdAt.getTime()]);
	}
	const requests = await db.dataRequest.findMany({
		where: { userId },
		select: { id: true, updatedAt: true },
	});
	for (const request of requests) {
		snapshot.push([`data_requests:${request.id}`, request.updatedAt.getTime()]);
	}
	return snapshot.sort((left, right) => (left[0] < right[0] ? -1 : 1));
}

describe("MIG-B 默认组织回填与核对", () => {
	const scopeUserIds = (): string[] =>
		[fullUserId, noSettingsUserId, orphanUserId].filter((id) => id !== "");
	const allUserIds = (): string[] => [
		...scopeUserIds(),
		chunkUserId,
		earliestOwnerUserId,
	];

	async function defaultOrgIdOf(userId: string): Promise<string> {
		const membership = await db.membership.findFirst({
			where: { userId, role: "OWNER", status: "ACTIVE" },
		});
		if (!membership) throw new Error(`用户 ${userId} 无默认组织`);
		return membership.organizationId;
	}

	/** 破坏 → 核对命中指定 scope → 还原 → 恢复 0 diffs（防破坏残留污染后续用例） */
	async function expectDiffWhile(
		scope: string,
		userIds: string[],
		corrupt: () => Promise<void>,
		restore: () => Promise<void>,
	): Promise<void> {
		await corrupt();
		let scopes: string[] = [];
		try {
			const result = await reconcileMigration(db, { userIds });
			scopes = result.diffs.map((diff) => diff.scope);
		} finally {
			await restore();
		}
		expect(scopes).toContain(scope);
		const restored = await reconcileMigration(db, { userIds });
		expect(restored.diffs).toEqual([]);
	}

	test("第 1 次回填：完整用户与无设置用户全量映射；updated_at 逐行不变", async () => {
		// 回填前快照：9 张带 updated_at 的业务表 + PlanChangeLog(created_at)
		// + data_requests 的全部行。夹具共 19 行；逐表核对，防止快照静默漏表
		const before = await snapshotUpdatedAt(fullUserId);
		expect(before).toHaveLength(19);
		expect([...new Set(before.map(([key]) => key.split(":")[0]))].sort()).toEqual(
			[...TIMESTAMPED_TABLES, "plan_change_logs", "data_requests"].sort(),
		);

		const firstRun = await backfillDefaultOrganizations(db, {
			userIds: scopeUserIds(),
		});
		// 孤儿演练用户在预检时……注意：此时库内无孤儿行（孤儿在第 5 个用例才构造），
		// 三个用户全部新建组织
		expect(firstRun.organizationsCreated).toBe(3);
		expect(firstRun.ownerMembershipsCreated).toBe(3);
		expect(firstRun.usersSkippedIdempotent).toBe(0);
		expect(firstRun.usersProcessed).toBe(3);
		expect(firstRun.chunksCommitted).toBe(1);

		// 评审 I-15：§12.2.6「时间戳不改」——除租户列外不得触碰任何既有行
		const after = await snapshotUpdatedAt(fullUserId);
		expect(after).toEqual(before);

		// 记录托管组织 id 供 afterAll 清理
		const memberships = await db.membership.findMany({
			where: {
				userId: { in: scopeUserIds() },
				role: "OWNER",
				status: "ACTIVE",
			},
			select: { organizationId: true },
		});
		for (const m of memberships) {
			if (!managedOrgIds.includes(m.organizationId)) {
				managedOrgIds.push(m.organizationId);
			}
		}

		// 完整用户：组织名 = 「用户名的工作台」+ OWNER + 设置复制 + 全部业务行映射
		const org = await db.membership.findFirst({
			where: { userId: fullUserId, role: "OWNER", status: "ACTIVE" },
			include: { organization: true },
		});
		expect(org?.organization.name).toBe("迁移验收张三的工作台");
		const orgId = org?.organizationId;
		expect(orgId).toBeDefined();

		const settings = await db.organizationSettings.findUnique({
			where: { organizationId: orgId ?? "" },
		});
		expect(settings?.baseCurrency).toBe("CNY");
		expect(settings?.ledgerStartedAt?.toISOString()).toBe(T0.toISOString());

		const backfilled = await db.account.findFirst({
			where: { userId: fullUserId, currencyCode: "USD" },
		});
		expect(backfilled?.organizationId).toBe(orgId);
		expect(backfilled?.createdById).toBe(fullUserId);
		expect(backfilled?.balance.toFixed(4)).toBe("1000.5000");

		const changelog = await db.planChangeLog.findFirst({
			where: { plan: { userId: fullUserId } },
		});
		expect(changelog?.organizationId).toBe(orgId);
		expect(changelog?.actorUserId).toBe(fullUserId);

		// 已读提醒 → ReminderRead（未读不建）
		const readStates = await db.reminderRead.findMany({
			where: { userId: fullUserId },
		});
		expect(readStates).toHaveLength(1);
		const unread = await db.reminder.findFirst({
			where: { userId: fullUserId, dedupKey: `${RUN}-prep` },
		});
		expect(unread?.readAt).toBeNull();

		// DataRequest（§12.2.7；W26 后口径）：个人域存量行 EXPORT/DELETION 保持 PERSONAL
		// 且不挂组织，状态机字段与时间戳一律不动；回填对数据请求恒为 no-op（0 行）
		expect(firstRun.dataRequestsRescoped).toBe(0);
		const exportReq = await db.dataRequest.findFirst({
			where: { userId: fullUserId, type: "EXPORT" },
		});
		expect(exportReq?.scope).toBe("PERSONAL");
		expect(exportReq?.organizationId).toBeNull();
		expect(exportReq?.status).toBe("COMPLETED");
		const deletionReq = await db.dataRequest.findFirst({
			where: { userId: fullUserId, type: "DELETION" },
		});
		expect(deletionReq?.scope).toBe("PERSONAL");
		expect(deletionReq?.status).toBe("CANCELLED");

		// 无设置用户：组织与 OWNER 建立但不虚构 OrganizationSettings（§12.2.3）
		const bareOrg = await db.membership.findFirst({
			where: { userId: noSettingsUserId, role: "OWNER" },
		});
		expect(bareOrg).toBeDefined();
		const bareSettings = await db.organizationSettings.findUnique({
			where: { organizationId: bareOrg?.organizationId ?? "" },
		});
		expect(bareSettings).toBeNull();
	});

	test("§12.3 核对：分片模式 0 差异；检查项齐全（防查询写错导致的空过）", async () => {
		const result = await reconcileMigration(db, { userIds: scopeUserIds() });
		expect(result.sharded).toBe(true);
		// 分片模式评估 25 项：默认组织 1 + 行集映射 10 + 可归属不变量 7
		// + 数据请求 1 + 提醒已读 1 + 设置同构 2 + 双写冲突 3。数量写死：任何一项的 SQL
		// 列名写错都会让该项「恒 0」静默通过，数量对不上即暴露。
		expect(result.checks).toBe(25);
		expect(result.diffs).toEqual([]);

		// 空分片：不评估任何行，同样不得回落到全库
		const empty = await reconcileMigration(db, { userIds: [] });
		expect(empty).toMatchObject({ sharded: true, checks: 25, diffs: [] });

		// 全量模式：额外评估 4 类无法归属到用户的孤儿派生行（共享本地库可能有
		// 其他用例残留，故只断言检查项数量与模式，不断言 0 diffs）
		const whole = await reconcileMigration(db);
		expect(whole.sharded).toBe(false);
		expect(whole.checks).toBe(29);
	});

	test("第 2 次回填：幂等（无新增组织/无重复记录/零重复回填）", async () => {
		const orgCountBefore = await db.organization.count({
			where: { id: { in: managedOrgIds } },
		});
		const secondRun = await backfillDefaultOrganizations(db, {
			userIds: scopeUserIds(),
		});
		const orgCountAfter = await db.organization.count({
			where: { id: { in: managedOrgIds } },
		});
		expect(orgCountAfter).toBe(orgCountBefore);
		expect(secondRun.organizationsCreated).toBe(0);
		expect(secondRun.ownerMembershipsCreated).toBe(0);
		expect(secondRun.organizationSettingsCreated).toBe(0);
		for (const [table, count] of Object.entries(secondRun.rowsBackfilled)) {
			expect(`${table}=${count}`, `表 ${table} 重复回填`).toBe(`${table}=0`);
		}
		expect(secondRun.reminderReadsCreated).toBe(0);
		expect(secondRun.dataRequestsRescoped).toBe(0);
		const readStates = await db.reminderRead.findMany({
			where: { userId: fullUserId },
		});
		expect(readStates).toHaveLength(1);
	});

	test("§12.3 核对（幂等后）：仍 0 差异", async () => {
		const result = await reconcileMigration(db, { userIds: scopeUserIds() });
		expect(result.diffs).toEqual([]);
	});

	test("孤儿派生行：回填预检显式阻断（§12.2.5）", async () => {
		// UsageRecord.planId 无外键 → 可构造父缺失行
		const orphanUsage = await db.usageRecord.create({
			data: {
				userId: orphanUserId,
				planId: `${RUN}-missing-plan`,
				currencyCode: "USD",
				amount: "10.0000",
				usedAt: new Date(),
			},
		});
		orphanUsageId = orphanUsage.id;
		const blocked = backfillDefaultOrganizations(db, {
			userIds: scopeUserIds(),
		});
		await expect(blocked).rejects.toBeInstanceOf(BackfillAnomalyError);
		await expect(blocked).rejects.toMatchObject({
			details: expect.objectContaining({ usage_records: 1 }),
		});
		// 预检为全局只读闸门（孤儿行不属于任何用户分片）：阻断即零写入，
		// 第 1 次回填已建的组织不受影响、无半写
		const orgForOrphan = await db.membership.findFirst({
			where: { userId: orphanUserId, role: "OWNER" },
		});
		expect(orgForOrphan).toBeDefined();
		const orgCountStable = await db.organization.count({
			where: { id: { in: managedOrgIds } },
		});
		expect(orgCountStable).toBe(managedOrgIds.length);

		// PlanAllocation 父缺失同样阻断
		const orphanAlloc = await db.planAllocation.create({
			data: {
				planId: `${RUN}-missing-plan`,
				amount: "1.0000",
				usedAmount: "0.0000",
			},
		});
		orphanPlanAllocationId = orphanAlloc.id;
		const blockedAgain = backfillDefaultOrganizations(db, {
			userIds: scopeUserIds(),
		});
		await expect(blockedAgain).rejects.toBeInstanceOf(BackfillAnomalyError);
		await expect(blockedAgain).rejects.toMatchObject({
			details: expect.objectContaining({
				usage_records: 1,
				plan_allocations: 1,
			}),
		});

		// CostLot 来源孤儿（PURCHASE 无交易行）同样在预检阶段阻断
		const orphanLot = await db.costLot.create({
			data: {
				userId: orphanUserId,
				currencyCode: "USD",
				sourceType: "PURCHASE",
				sourceId: `${RUN}-missing-tx`,
				quantity: "1.0000",
				remainingQty: "1.0000",
				unitCost: "7.00000000",
				totalCost: "7.0000",
				acquiredAt: new Date(),
			},
		});
		try {
			await expect(
				backfillDefaultOrganizations(db, { userIds: scopeUserIds() }),
			).rejects.toMatchObject({
				details: expect.objectContaining({ cost_lots: 1 }),
			});
		} finally {
			await db.costLot.delete({ where: { id: orphanLot.id } });
		}
	});

	test("跨组织父子不一致：核对显式报差异（§12.3.7）", async () => {
		// 清理孤儿行，恢复可回填状态
		await db.usageLotAllocation.deleteMany({
			where: { usageId: orphanUsageId },
		});
		await db.usageRecord.delete({ where: { id: orphanUsageId } });
		await db.planAllocation.delete({ where: { id: orphanPlanAllocationId } });

		// 构造跨组织异常：usage.organizationId 指向组织 B，而其 plan 属组织 A
		const orgAOrgId = await defaultOrgIdOf(fullUserId);
		const orgB = await db.organization.create({
			data: { name: `MIG-B 跨组织演练组织 ${RUN}` },
		});
		managedOrgIds.push(orgB.id);
		crossOrgId = orgB.id;
		const usage = await db.usageRecord.findFirst({
			where: { userId: fullUserId, organizationId: orgAOrgId },
		});
		expect(usage).toBeDefined();
		await db.usageRecord.update({
			where: { id: usage?.id ?? "" },
			data: { organizationId: orgB.id },
		});
		const result = await reconcileMigration(db, { userIds: scopeUserIds() });
		const scopes = result.diffs.map((d) => d.scope);
		expect(scopes).toContain("usage_record.plan_org_consistency");
		// 还原异常行，恢复 0 diffs 基线（防污染后续套件）
		await db.usageRecord.update({
			where: { id: usage?.id ?? "" },
			data: { organizationId: orgAOrgId },
		});
		const restored = await reconcileMigration(db, {
			userIds: scopeUserIds(),
		});
		expect(restored.diffs).toEqual([]);
	});

	test("核对负向用例·行集映射：10 张表逐张改错组织都必须被报出", async () => {
		const orgAOrgId = await defaultOrgIdOf(fullUserId);
		const orgBId = crossOrgId;
		for (const table of ROW_MAPPED_TABLES) {
			const delegate = delegateFor(table);
			const row = await delegate.findFirst({ where: rowsOf(table, fullUserId) });
			if (!row) throw new Error(`夹具缺 ${table} 行`);
			const rowId: string = row.id;
			await expectDiffWhile(
				`row_mapping.${table}`,
				scopeUserIds(),
				() => delegate.update({ where: { id: rowId }, data: { organizationId: orgBId } }),
				() => delegate.update({ where: { id: rowId }, data: { organizationId: orgAOrgId } }),
			);
		}
	});

	test("核对负向用例·不变量专项：逐类破坏 → 命中 → 还原归零", async () => {
		const orgAOrgId = await defaultOrgIdOf(fullUserId);
		const orgBId = crossOrgId;
		const users = scopeUserIds();

		// FIFO：使用量与分摊量合计不等
		await expectDiffWhile(
			"fifo_conservation.usage_allocations",
			users,
			() => db.usageRecord.update({ where: { id: fixture.usageId }, data: { amount: "49.0000" } }),
			() => db.usageRecord.update({ where: { id: fixture.usageId }, data: { amount: "50.0000" } }),
		);
		// 批次守恒：quantity − Σ已分摊 ≠ remaining_qty
		await expectDiffWhile(
			"batch_conservation.cost_lots",
			users,
			() => db.costLot.update({ where: { id: fixture.initialUsdLotId }, data: { remainingQty: "449.0000" } }),
			() => db.costLot.update({ where: { id: fixture.initialUsdLotId }, data: { remainingQty: "450.0000" } }),
		);
		// 批次与来源记录不同组织
		await expectDiffWhile(
			"cost_lot.source_org_consistency",
			users,
			() => db.costLot.update({ where: { id: fixture.purchaseLotId }, data: { organizationId: orgBId } }),
			() => db.costLot.update({ where: { id: fixture.purchaseLotId }, data: { organizationId: orgAOrgId } }),
		);
		// 使用分摊双父（Usage × CostLot）不同组织
		await expectDiffWhile(
			"usage_lot_allocation.parent_org_consistency",
			users,
			() => db.costLot.update({ where: { id: fixture.initialUsdLotId }, data: { organizationId: orgBId } }),
			() => db.costLot.update({ where: { id: fixture.initialUsdLotId }, data: { organizationId: orgAOrgId } }),
		);
		// 使用记录缺父计划 / 批次来源孤儿
		await expectDiffWhile(
			"usage_record.orphan_plan",
			users,
			() => db.usageRecord.create({
				data: { userId: fullUserId, planId: `${RUN}-no-plan`, currencyCode: "USD", amount: "1.0000", usedAt: T0 },
			}),
			() => db.usageRecord.deleteMany({ where: { userId: fullUserId, planId: `${RUN}-no-plan` } }),
		);
		await expectDiffWhile(
			"cost_lot.orphan_source",
			users,
			() => db.costLot.create({
				data: {
					userId: fullUserId, currencyCode: "USD", sourceType: "PURCHASE", sourceId: `${RUN}-no-txn`,
					quantity: "1.0000", remainingQty: "1.0000", unitCost: "7.2000000000", totalCost: "7.2000", acquiredAt: T0,
				},
			}),
			() => db.costLot.deleteMany({ where: { userId: fullUserId, sourceId: `${RUN}-no-txn` } }),
		);
		// DataRequest 语义映射（W26 后）：合法形态由 DB CHECK data_requests_scope_type_org_check
		// 兜底，已映射用户的请求无法再经 ORM 改成违约形态 → 本项对已回填用户恒为 0 差异
		expect(
			(await reconcileMigration(db, { userIds: users })).diffs.map((diff) => diff.scope),
		).not.toContain("data_request.scope_mapping");
		// ReminderRead 对账：已读提醒缺成员级已读行
		await expectDiffWhile(
			"reminder_read.parity",
			users,
			() => db.reminder.update({ where: { id: fixture.unreadReminderId }, data: { readAt: T0 } }),
			() => db.reminder.update({ where: { id: fixture.unreadReminderId }, data: { readAt: null } }),
		);
		// 设置同构：值不一致 / 组织设置缺失
		await expectDiffWhile(
			"settings_parity.value_mismatch",
			users,
			() => db.organizationSettings.update({ where: { organizationId: orgAOrgId }, data: { baseCurrency: "USD" } }),
			() => db.organizationSettings.update({ where: { organizationId: orgAOrgId }, data: { baseCurrency: "CNY" } }),
		);
		await expectDiffWhile(
			"settings_parity.missing",
			users,
			() => db.organizationSettings.delete({ where: { organizationId: orgAOrgId } }),
			() => db.organizationSettings.create({
				data: {
					organizationId: orgAOrgId, baseCurrency: "CNY", prepPreference: "balanced",
					reminderEnabled: true, ledgerStartedAt: T0,
				},
			}),
		);
		// 默认组织缺失：无任何 OWNER 成员关系的用户
		const strayUserId = await createUser("stray", "无组织演练用户");
		try {
			const result = await reconcileMigration(db, {
				userIds: [...users, strayUserId],
			});
			expect(result.diffs).toEqual([
				{ scope: "default_org.missing", left: 0, right: 1 },
			]);
		} finally {
			await db.user.delete({ where: { id: strayUserId } });
		}
	});

	test("评审 I-15：ToB R1 组织级数据请求不被回填重跑改写", async () => {
		const orgBId = crossOrgId;
		const requestBase = {
			userId: fullUserId,
			status: "PENDING",
			requestedAt: T0,
			dueAt: new Date("2026-06-30T00:00:00.000Z"),
		};
		const orgScoped = await db.dataRequest.createMany({
			data: [
				{ ...requestBase, type: "CLEAR", scope: "ORGANIZATION", organizationId: orgBId },
				{ ...requestBase, type: "EXPORT", scope: "ORGANIZATION", organizationId: orgBId },
				{ ...requestBase, type: "DELETION", scope: "ORGANIZATION", organizationId: orgBId },
			],
		});
		expect(orgScoped.count).toBe(3);
		try {
			const run = await backfillDefaultOrganizations(db, {
				userIds: scopeUserIds(),
			});
			// 既不改写到默认组织，也不重置为 PERSONAL，更不计入映射行数
			expect(run.dataRequestsRescoped).toBe(0);
			const after = await db.dataRequest.findMany({
				where: { userId: fullUserId, organizationId: orgBId },
				orderBy: { type: "asc" },
			});
			expect(after.map((r) => [r.type, r.scope])).toEqual([
				["CLEAR", "ORGANIZATION"],
				["DELETION", "ORGANIZATION"],
				["EXPORT", "ORGANIZATION"],
			]);
			// W26 双域拆分后核对口径：合法的组织数据请求（EXPORT / CLEAR / DELETION，
			// 且可落在非默认组织）不是映射差异——此前会按「CLEAR 必在默认组织」误报
			const reconciled = await reconcileMigration(db, { userIds: scopeUserIds() });
			expect(reconciled.diffs.map((diff) => diff.scope)).not.toContain(
				"data_request.scope_mapping",
			);
		} finally {
			await db.dataRequest.deleteMany({
				where: { userId: fullUserId, organizationId: orgBId },
			});
		}
	});

	test("评审 I-15：dry-run 估算 = 实际写入；分片事务逐片提交", async () => {
		// 分片演练用户：存量个人行（2 账户 / 1 计划 / 1 变更日志），无组织
		//（历史 CLEAR 请求不再构造：未挂组织的 CLEAR 已被 W26 的 DB CHECK 排除）
		await db.userSettings.create({
			data: {
				userId: chunkUserId, baseCurrency: "USD", locale: "en", region: "HK",
				prepPreference: "cautious", reminderEnabled: false, ledgerStartedAt: T0,
			},
		});
		await db.account.createMany({
			data: [
				{ userId: chunkUserId, currencyCode: "USD", balance: "10.0000" },
				{ userId: chunkUserId, currencyCode: "EUR", balance: "20.0000" },
			],
		});
		const plan = await db.plan.create({
			data: {
				userId: chunkUserId, targetCurrency: "JPY", targetAmount: "1000.0000",
				expectUseDate: T0, latestPrepDate: T0,
			},
		});
		await db.planChangeLog.create({
			data: {
				planId: plan.id, changeType: "COMPLETED", beforeTarget: "1000.0000", afterTarget: "1000.0000",
				beforeAlloc: "1000.0000", afterAlloc: "1000.0000", beforeSnapshot: {}, afterSnapshot: {},
			},
		});

		const expectedRows = {
			accounts: 2,
			transactions: 0,
			initialHoldings: 0,
			costLots: 0,
			plans: 1,
			usageRecords: 0,
			corrections: 0,
			reminders: 0,
			aiConversations: 0,
			// PlanChangeLog 无 userId 列：此前 dry-run 把 userId 当作其列传入 → 运行时校验错误
			planChangeLogs: 1,
		};

		const dry = await backfillDefaultOrganizations(db, {
			dryRun: true,
			userIds: [chunkUserId],
		});
		expect(dry).toMatchObject({
			usersProcessed: 1,
			organizationsCreated: 1,
			usersSkippedIdempotent: 0,
			organizationSettingsCreated: 1,
			reminderReadsCreated: 0,
			dataRequestsRescoped: 0,
			chunksCommitted: 0,
		});
		expect(dry.rowsBackfilled).toEqual(expectedRows);
		// dry-run 零写入
		expect(await db.account.count({ where: { userId: chunkUserId, organizationId: null } })).toBe(2);
		expect(await db.membership.count({ where: { userId: chunkUserId } })).toBe(0);

		// chunkSize=1：每个用户一个事务；其余 3 个用户已回填 → 幂等跳过、零行写入。
		// （多组织演练用户不在此列：他的组织由下一个用例显式构造）
		const chunkedUserIds = [...scopeUserIds(), chunkUserId];
		const run = await backfillDefaultOrganizations(db, {
			userIds: chunkedUserIds,
			chunkSize: 1,
		});
		expect(run.chunksCommitted).toBe(4);
		expect(run).toMatchObject({
			usersProcessed: 4,
			organizationsCreated: 1,
			usersSkippedIdempotent: 3,
			organizationSettingsCreated: 1,
			reminderReadsCreated: 0,
			dataRequestsRescoped: 0,
		});
		expect(run.rowsBackfilled).toEqual(expectedRows);

		const chunkOrgId = await defaultOrgIdOf(chunkUserId);
		const chunkPlan = await db.planChangeLog.findFirst({
			where: { plan: { userId: chunkUserId } },
		});
		expect(chunkPlan?.organizationId).toBe(chunkOrgId);
		// 非法 chunkSize 显式报错，不静默回落
		await expect(
			backfillDefaultOrganizations(db, { userIds: [chunkUserId], chunkSize: 0 }),
		).rejects.toThrow(/chunkSize/);

		const result = await reconcileMigration(db, { userIds: chunkedUserIds });
		expect(result.diffs).toEqual([]);
	});

	test("评审 I-15 / R2-I03：多组织用户回填到其「创建得最早」的组织（与运行时默认组织同口径）", async () => {
		const later = new Date("2026-02-01T00:00:00.000Z");
		// 先插入「较晚加入」的组织（物理顺序在前），再插入「最早加入」的组织：
		// 不带 orderBy 的 findFirst 通常按物理顺序返回较晚者 → 映射到错误的组织
		const laterOrg = await db.organization.create({
			data: {
				name: "较晚创建的组织",
				memberships: {
					create: { userId: earliestOwnerUserId, role: "OWNER", status: "ACTIVE", joinedAt: later },
				},
			},
		});
		const earliestOrg = await db.organization.create({
			data: {
				name: "最早加入的组织",
				memberships: {
					create: { userId: earliestOwnerUserId, role: "OWNER", status: "ACTIVE", joinedAt: T0 },
				},
			},
		});
		managedOrgIds.push(laterOrg.id, earliestOrg.id);
		const account = await db.account.create({
			data: { userId: earliestOwnerUserId, currencyCode: "GBP", balance: "5.0000" },
		});

		// 运行时与回填同口径：都是创建得最早的组织
		expect(await resolveDefaultOrganizationId(db, earliestOwnerUserId)).toBe(earliestOrg.id);

		const run = await backfillDefaultOrganizations(db, {
			userIds: [earliestOwnerUserId],
		});
		expect(run.organizationsCreated).toBe(0);
		expect(run.ownerMembershipsCreated).toBe(0);
		expect(run.usersSkippedIdempotent).toBe(1);
		const mapped = await db.account.findUnique({ where: { id: account.id } });
		expect(mapped?.organizationId).toBe(earliestOrg.id);
		// 回填不得为「已有个人工作台」的用户再建组织
		expect(await db.membership.count({ where: { userId: earliestOwnerUserId } })).toBe(2);

		// 全部演练用户收尾：行集恒等（多组织用户的存量行归默认组织，而非任一 OWNER 组织）
		const result = await reconcileMigration(db, { userIds: allUserIds() });
		expect(result.diffs).toEqual([]);
	});

	test("R2-I03：默认组织 = 用户创建的最早组织——受邀加入不算；所有权转移后不漂移", async () => {
		const userId = await createUser("creator", "创建者演练用户");
		const managed: string[] = [];
		try {
			// 尚无个人工作台：解析为 null（fail-closed——不回落，回填时新建）
			expect(await resolveDefaultOrganizationId(db, userId)).toBeNull();

			// 先受邀加入他人组织（crossOrgId 由前面的用例在数秒前创建）：成员关系晚于
			// 组织创建 → 不是默认组织
			const invited = await db.membership.create({
				data: { organizationId: crossOrgId, userId, role: "FINANCE", status: "ACTIVE" },
			});
			const hostRow = await db.organization.findUniqueOrThrow({ where: { id: crossOrgId } });
			expect(invited.createdAt.getTime()).toBeGreaterThan(hostRow.createdAt.getTime());
			expect(await resolveDefaultOrganizationId(db, userId)).toBeNull();

			// 回填为其新建个人工作台：存量行归入新组织，而不是受邀组织
			const account = await db.account.create({
				data: { userId, currencyCode: "USD", balance: "8.0000" },
			});
			const run = await backfillDefaultOrganizations(db, { userIds: [userId] });
			expect(run).toMatchObject({ organizationsCreated: 1, ownerMembershipsCreated: 1 });
			const workspaceId = await resolveDefaultOrganizationId(db, userId);
			expect(workspaceId).not.toBeNull();
			expect(workspaceId).not.toBe(crossOrgId);
			managed.push(workspaceId!);
			expect(
				(await db.account.findUniqueOrThrow({ where: { id: account.id } })).organizationId,
			).toBe(workspaceId);

			// 不变量：个人工作台的首个成员关系与组织同事务创建（默认组织判定的依据）
			const workspaceMembership = await db.membership.findFirstOrThrow({
				where: { userId, organizationId: workspaceId! },
				include: { organization: true },
			});
			expect(workspaceMembership.createdAt.getTime()).toBe(
				workspaceMembership.organization.createdAt.getTime(),
			);

			// 所有权转移：用户降为 ADMIN、他人接任 OWNER → 默认组织不漂移
			const successorId = await createUser("successor", "接任演练用户");
			try {
				await db.$transaction([
					db.membership.updateMany({
						where: { userId, organizationId: workspaceId!, role: "OWNER", status: "ACTIVE" },
						data: { role: "ADMIN" },
					}),
					db.membership.create({
						data: { organizationId: workspaceId!, userId: successorId, role: "OWNER", status: "ACTIVE" },
					}),
				]);
				expect(
					(await db.membership.findFirst({ where: { userId, organizationId: workspaceId! } }))?.role,
				).toBe("ADMIN");
				// 用户随后新建组织并成为其 OWNER：旧口径（最早的 ACTIVE OWNER）会漂移到它
				const laterOrg = await db.organization.create({
					data: {
						name: `转移后新建的组织 ${RUN}`,
						memberships: {
							create: { userId, role: "OWNER", status: "ACTIVE" },
						},
					},
				});
				managed.push(laterOrg.id);
				expect(await resolveDefaultOrganizationId(db, userId)).toBe(workspaceId);

				// 回填重跑：幂等，不新建组织；存量行仍归个人工作台
				const rerun = await backfillDefaultOrganizations(db, { userIds: [userId] });
				expect(rerun).toMatchObject({ organizationsCreated: 0, ownerMembershipsCreated: 0 });
				expect(
					(await db.account.findUniqueOrThrow({ where: { id: account.id } })).organizationId,
				).toBe(workspaceId);
				// dry-run 估算与之一致（无待建组织）
				const dry = await backfillDefaultOrganizations(db, {
					dryRun: true,
					userIds: [userId],
				});
				expect(dry).toMatchObject({
					organizationsCreated: 0,
					ownerMembershipsCreated: 0,
					usersSkippedIdempotent: 1,
				});
				expect(await reconcileMigration(db, { userIds: [userId] })).toMatchObject({ diffs: [] });
			} finally {
				await db.membership.deleteMany({ where: { userId: successorId } });
				await db.user.delete({ where: { id: successorId } }).catch(() => {});
			}
		} finally {
			await db.membership.deleteMany({ where: { userId, organizationId: crossOrgId } });
			await db.organization.deleteMany({ where: { id: { in: managed } } }).catch(() => {});
			await cleanupUser(db as CleanupDb, userId);
		}
	});

	test("R2-I03：创建者判定排除「组织创建的同一瞬间后插入」的成员（第一个成员条件）", async () => {
		const creatorId = await createUser("same-ms-creator", "同毫秒创建者");
		const latecomerId = await createUser("same-ms-late", "同毫秒后来者");
		try {
			const sharedOrg = await db.organization.create({
				data: {
					name: `同毫秒插入演练 ${RUN}`,
					memberships: {
						create: { userId: creatorId, role: "OWNER", status: "ACTIVE" },
					},
				},
			});
			// 确定性复现「组织创建的同一毫秒内又插入了另一名成员」：直写库的夹具 / 种子
			// 常见。仅凭 created_at 相等会把后来者误判为创建者；创建者的 id 先生成，
			// 后来者按 (created_at, id) 排在其后，不是第一个成员
			await db.membership.create({
				data: {
					organizationId: sharedOrg.id,
					userId: latecomerId,
					role: "FINANCE",
					status: "ACTIVE",
					createdAt: sharedOrg.createdAt,
					joinedAt: sharedOrg.createdAt,
				},
			});
			const creatorMembership = await db.membership.findFirstOrThrow({
				where: { organizationId: sharedOrg.id, userId: creatorId },
			});
			const latecomerMembership = await db.membership.findFirstOrThrow({
				where: { organizationId: sharedOrg.id, userId: latecomerId },
			});
			expect(latecomerMembership.createdAt.getTime()).toBe(
				creatorMembership.createdAt.getTime(),
			);

			expect(await resolveDefaultOrganizationId(db, latecomerId)).toBeNull();
			expect(await resolveDefaultOrganizationId(db, creatorId)).toBe(sharedOrg.id);
			// dry-run 与真实回填同口径：只为后来者新建个人工作台
			const dry = await backfillDefaultOrganizations(db, {
				dryRun: true,
				userIds: [creatorId, latecomerId],
			});
			expect(dry).toMatchObject({ organizationsCreated: 1, usersSkippedIdempotent: 1 });
			const run = await backfillDefaultOrganizations(db, {
				userIds: [creatorId, latecomerId],
			});
			expect(run).toMatchObject({ organizationsCreated: 1, ownerMembershipsCreated: 1 });
			expect(await resolveDefaultOrganizationId(db, latecomerId)).not.toBe(sharedOrg.id);
			expect(await resolveDefaultOrganizationId(db, creatorId)).toBe(sharedOrg.id);
			expect(
				await reconcileMigration(db, { userIds: [creatorId, latecomerId] }),
			).toMatchObject({ diffs: [] });
		} finally {
			await cleanupUser(db as CleanupDb, creatorId);
			await cleanupUser(db as CleanupDb, latecomerId);
		}
	});

	test("R2-I05：全库 dry-run 不按用户 id 绑定参数，且零写入", async () => {
		const [orgCountBefore, membershipCountBefore] = await Promise.all([
			db.organization.count(),
			db.membership.count(),
		]);
		const dry = await backfillDefaultOrganizations(db, { dryRun: true });
		// 全库模式：处理全部用户；组织与首个 OWNER 成员关系 1:1（此前恒 0）
		expect(dry.chunksCommitted).toBe(0);
		expect(dry.usersProcessed).toBeGreaterThanOrEqual(allUserIds().length);
		expect(dry.ownerMembershipsCreated).toBe(dry.organizationsCreated);
		expect(dry.organizationsCreated + dry.usersSkippedIdempotent).toBe(dry.usersProcessed);
		expect(Object.values(dry.rowsBackfilled).every((count) => Number.isInteger(count) && count >= 0)).toBe(true);

		// dry-run 零写入
		expect(await db.organization.count()).toBe(orgCountBefore);
		expect(await db.membership.count()).toBe(membershipCountBefore);
	});

	test("R2-I05：dry-run 估算与实际写入逐项一致（含此前漂移的 4 处）", async () => {
		const driftUserId = await createUser("drift", "估算漂移演练用户");
		const otherUserId = await createUser("drift-other", "他人已读演练用户");
		const foreignOrg = await db.organization.create({
			data: { name: `父计划已挂的其他组织 ${RUN}` },
		});
		const T1 = new Date("2026-03-01T00:00:00.000Z");
		try {
			// ①「scope 已是 ORGANIZATION 但尚未挂组织的历史 CLEAR」不再构造：该形态已被
			//   W26 的 DB CHECK 排除，估算与写入对数据请求恒为 0（见下方 expected）
			// ② 已读提醒：他人已有已读行、行主本人没有（此前 dry-run 用「无任何已读行」估算 → 漏计）
			const reminder = await db.reminder.create({
				data: {
					userId: driftUserId, type: "PLAN_DUE", dedupKey: `${RUN}-drift-due`,
					scheduledFor: T1, readAt: T1,
				},
			});
			await db.reminderRead.create({
				data: { reminderId: reminder.id, userId: otherUserId, readAt: T1 },
			});

			const expected = {
				organizationsCreated: 1,
				ownerMembershipsCreated: 1, // ③ 此前 dry-run 恒为 0
				usersSkippedIdempotent: 0,
				organizationSettingsCreated: 0,
				reminderReadsCreated: 1,
				dataRequestsRescoped: 0,
			};
			const dry = await backfillDefaultOrganizations(db, { dryRun: true, userIds: [driftUserId] });
			expect(dry).toMatchObject(expected);
			expect(dry.rowsBackfilled.planChangeLogs).toBe(0);
			const run = await backfillDefaultOrganizations(db, { userIds: [driftUserId] });
			expect(run).toMatchObject(expected);
			expect(run.rowsBackfilled.planChangeLogs).toBe(0);
			expect(
				(await db.reminderRead.findFirst({ where: { reminderId: reminder.id, userId: driftUserId } })),
			).not.toBeNull();

			// ④ PlanChangeLog 经父计划归属：父计划已挂其他组织的不写入也不计入；
			//    父计划已挂默认组织的（回填重跑）写入并计入
			const workspaceId = await resolveDefaultOrganizationId(db, driftUserId);
			expect(workspaceId).not.toBeNull();
			const planBase = {
				userId: driftUserId, targetCurrency: "USD", targetAmount: "1.0000",
				expectUseDate: T1, latestPrepDate: T1,
			};
			const logBase = {
				changeType: "COMPLETED", beforeTarget: "1.0000", afterTarget: "1.0000",
				beforeAlloc: "0.0000", afterAlloc: "0.0000", beforeSnapshot: {}, afterSnapshot: {},
			};
			const foreignPlan = await db.plan.create({
				data: { ...planBase, organizationId: foreignOrg.id },
			});
			const foreignLog = await db.planChangeLog.create({
				data: { ...logBase, planId: foreignPlan.id },
			});
			const ownPlan = await db.plan.create({
				data: { ...planBase, organizationId: workspaceId! },
			});
			const ownLog = await db.planChangeLog.create({
				data: { ...logBase, planId: ownPlan.id },
			});

			const dryAgain = await backfillDefaultOrganizations(db, {
				dryRun: true,
				userIds: [driftUserId],
			});
			expect(dryAgain.rowsBackfilled.planChangeLogs).toBe(1);
			const rerun = await backfillDefaultOrganizations(db, { userIds: [driftUserId] });
			expect(rerun.rowsBackfilled.planChangeLogs).toBe(1);
			expect((await db.planChangeLog.findUniqueOrThrow({ where: { id: ownLog.id } })).organizationId).toBe(workspaceId);
			expect((await db.planChangeLog.findUniqueOrThrow({ where: { id: foreignLog.id } })).organizationId).toBeNull();

			// 清理「已挂其他组织」的演练行（它们按设计不属于默认组织，不参与行集恒等）
			await db.planChangeLog.delete({ where: { id: foreignLog.id } });
			await db.plan.delete({ where: { id: foreignPlan.id } });
			expect(await reconcileMigration(db, { userIds: [driftUserId] })).toMatchObject({ diffs: [] });
		} finally {
			await db.organization.delete({ where: { id: foreignOrg.id } }).catch(() => {});
			await cleanupUser(db as CleanupDb, driftUserId);
			await cleanupUser(db as CleanupDb, otherUserId);
		}
	});

	test("R2-I05：核对不再静默丢弃无默认组织用户的行——误标 / 未映射 / 缺设置逐项报出", async () => {
		const strayId = await createUser("stray-rows", "无组织带数据演练用户");
		const foreignOrg = await db.organization.create({
			data: { name: `被误标的组织 ${RUN}` },
		});
		const T1 = new Date("2026-03-01T00:00:00.000Z");
		try {
			await db.userSettings.create({
				data: {
					userId: strayId, baseCurrency: "CNY", locale: "zh-CN", region: "CN",
					prepPreference: "balanced", reminderEnabled: true, ledgerStartedAt: T1,
				},
			});
			await db.account.createMany({
				data: [
					// 误标到其他组织
					{ userId: strayId, currencyCode: "USD", balance: "1.0000", organizationId: foreignOrg.id },
					// 尚未映射
					{ userId: strayId, currencyCode: "CHF", balance: "2.0000" },
				],
			});
			await db.dataRequest.create({
				data: {
					userId: strayId, type: "EXPORT", scope: "PERSONAL", status: "COMPLETED",
					requestedAt: T1, dueAt: T1,
				},
			});

			const result = await reconcileMigration(db, { userIds: [strayId] });
			// 此前 INNER JOIN defaults 把该用户全部行丢弃，只报得出 default_org.missing
			const byScope = Object.fromEntries(result.diffs.map((diff) => [diff.scope, diff.right]));
			expect(byScope).toMatchObject({
				"default_org.missing": 1,
				"row_mapping.accounts": 2,
				"data_request.scope_mapping": 1,
				"settings_parity.missing": 1,
			});

			// 回填后：新建个人工作台 + 复制设置 + 行归位（误标行不改写，仍如实报出）
			const run = await backfillDefaultOrganizations(db, { userIds: [strayId] });
			expect(run.organizationsCreated).toBe(1);
			const workspaceId = await resolveDefaultOrganizationId(db, strayId);
			expect(workspaceId).not.toBe(foreignOrg.id);
			const after = await reconcileMigration(db, { userIds: [strayId] });
			expect(after.diffs).toEqual([
				{ scope: "row_mapping.accounts", left: 0, right: 1 },
			]);
		} finally {
			await db.account.deleteMany({ where: { userId: strayId } });
			await db.organization.delete({ where: { id: foreignOrg.id } }).catch(() => {});
			await cleanupUser(db as CleanupDb, strayId);
		}
	});

	test("W22 个人占位行（baseCurrency=\"\"）不触发 MIG-B 复制 OrganizationSettings 且核对零误报", async () => {
		const placeholderUserId = await createUser("placeholder", "个人占位演练用户");
		try {
			await db.userSettings.create({
				data: {
					userId: placeholderUserId,
					baseCurrency: "",
					locale: "en",
					region: "HK",
				},
			});

			const dry = await backfillDefaultOrganizations(db, {
				dryRun: true,
				userIds: [placeholderUserId],
			});
			expect(dry.organizationSettingsCreated).toBe(0);

			const run = await backfillDefaultOrganizations(db, {
				userIds: [placeholderUserId],
			});
			expect(run.organizationSettingsCreated).toBe(0);
			const orgId = await resolveDefaultOrganizationId(db, placeholderUserId);
			expect(orgId).not.toBeNull();
			expect(
				await db.organizationSettings.findUnique({
					where: { organizationId: orgId! },
				}),
			).toBeNull();

			const reconcile = await reconcileMigration(db, {
				userIds: [placeholderUserId],
			});
			expect(reconcile.diffs).toEqual([]);
		} finally {
			await cleanupUser(db as CleanupDb, placeholderUserId);
		}
	});

	test("I-2 双写冲突防护：reconcile 检出 dualAccountRows，backfill 合并双行 Account（保留 updatedAt）、去重 Reminder 并阻断冲突 InitialHolding", async () => {
		const dualUserId = await createUser("i2-dual", "双写冲突演练用户");
		const T1 = new Date("2026-04-01T00:00:00.000Z");
		try {
			const org = await db.organization.create({
				data: {
					name: `双写冲突测试组织 ${RUN}`,
					memberships: {
						create: { userId: dualUserId, role: "OWNER", status: "ACTIVE" },
					},
				},
			});
			const orgAccount = await db.account.create({
				data: {
					userId: dualUserId,
					organizationId: org.id,
					createdById: dualUserId,
					currencyCode: "USD",
					balance: "20.0000",
				},
			});
			// 存量 NULL 同币种账户 + 独立 EUR NULL 账户
			await db.account.createMany({
				data: [
					{ userId: dualUserId, currencyCode: "USD", balance: "50.0000" },
					{ userId: dualUserId, currencyCode: "EUR", balance: "15.0000" },
				],
			});
			// 冲突 Reminder：组织行与 NULL 行同 (dedupKey, scheduledFor)，NULL 行已读
			const orgReminder = await db.reminder.create({
				data: {
					userId: dualUserId,
					organizationId: org.id,
					type: "PLAN_DUE",
					dedupKey: `${RUN}-dual-rem`,
					scheduledFor: T1,
				},
			});
			await db.reminder.create({
				data: {
					userId: dualUserId,
					type: "PLAN_DUE",
					dedupKey: `${RUN}-dual-rem`,
					scheduledFor: T1,
					readAt: T1,
				},
			});

			const beforeReconcile = await reconcileMigration(db, {
				userIds: [dualUserId],
			});
			const beforeByScope = Object.fromEntries(
				beforeReconcile.diffs.map((d) => [d.scope, d.right]),
			);
			expect(beforeByScope["dual_rows.accounts"]).toBe(1);
			expect(beforeByScope["dual_rows.reminders"]).toBe(1);

			const run = await backfillDefaultOrganizations(db, {
				userIds: [dualUserId],
			});
			expect(run.rowsBackfilled.accounts).toBe(2);
			expect(run.rowsBackfilled.reminders).toBe(1);

			const survivingUsd = await db.account.findUniqueOrThrow({
				where: { id: orgAccount.id },
			});
			expect(survivingUsd.balance.toFixed(4)).toBe("70.0000");
			expect(survivingUsd.updatedAt.getTime()).toBe(orgAccount.updatedAt.getTime());
			expect(
				await db.account.count({
					where: { userId: dualUserId, organizationId: null },
				}),
			).toBe(0);
			// 冲突提醒删除后，原 NULL 行已读态保留至存活组织提醒
			expect(
				await db.reminderRead.findUnique({
					where: {
						reminderId_userId: {
							reminderId: orgReminder.id,
							userId: dualUserId,
						},
					},
				}),
			).not.toBeNull();

			const afterReconcile = await reconcileMigration(db, {
				userIds: [dualUserId],
			});
			expect(afterReconcile.diffs).toEqual([]);

			// 冲突 InitialHolding：必须 fail-closed 抛 BackfillAnomalyError 阻断
			await db.initialHolding.create({
				data: {
					userId: dualUserId,
					organizationId: org.id,
					createdById: dualUserId,
					currencyCode: "USD",
					amount: "10.0000",
					rate: "7.2000000000",
					rawRate: "7.2000000000",
					rateSource: "identity",
					rateObservedAt: T1,
					cost: "72.0000",
					confirmedAt: T1,
				},
			});
			await db.initialHolding.create({
				data: {
					userId: dualUserId,
					currencyCode: "USD",
					amount: "20.0000",
					rate: "7.2000000000",
					rawRate: "7.2000000000",
					rateSource: "identity",
					rateObservedAt: T1,
					cost: "144.0000",
					confirmedAt: T1,
				},
			});
			const ihReconcile = await reconcileMigration(db, {
				userIds: [dualUserId],
			});
			expect(
				ihReconcile.diffs.find((d) => d.scope === "dual_rows.initial_holdings")?.right,
			).toBe(1);
			await expect(
				backfillDefaultOrganizations(db, { userIds: [dualUserId] }),
			).rejects.toThrow(BackfillAnomalyError);
		} finally {
			await cleanupUser(db as CleanupDb, dualUserId);
		}
	});
});
