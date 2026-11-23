import { beforeAll, afterAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
	BackfillAnomalyError,
	backfillDefaultOrganizations,
} from "../../src/organization/organization-backfill";
import { reconcileMigration } from "../../src/organization/organization-reconcile";
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
	// 数据请求：EXPORT / CLEAR（终态）/ DELETION（终态）
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
				type: "CLEAR",
				status: "COMPLETED",
				requestedAt: new Date("2026-03-11T00:00:00.000Z"),
				dueAt: new Date("2026-03-25T00:00:00.000Z"),
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
		// + data_requests 的全部行。夹具共 20 行；逐表核对，防止快照静默漏表
		const before = await snapshotUpdatedAt(fullUserId);
		expect(before).toHaveLength(20);
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

		// DataRequest 语义映射（§12.2.7）：EXPORT/DELETION→PERSONAL(null org)；
		// CLEAR→ORGANIZATION(默认组织)；状态机字段一律不动。
		// 仅未挂组织的存量行计入：EXPORT/DELETION 本就是 PERSONAL → 不计
		expect(firstRun.dataRequestsRescoped).toBe(1);
		const exportReq = await db.dataRequest.findFirst({
			where: { userId: fullUserId, type: "EXPORT" },
		});
		expect(exportReq?.scope).toBe("PERSONAL");
		expect(exportReq?.organizationId).toBeNull();
		expect(exportReq?.status).toBe("COMPLETED");
		const clearReq = await db.dataRequest.findFirst({
			where: { userId: fullUserId, type: "CLEAR" },
		});
		expect(clearReq?.scope).toBe("ORGANIZATION");
		expect(clearReq?.organizationId).toBe(orgId);
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
		// 分片模式评估 22 项：默认组织 1 + 行集映射 10 + 可归属不变量 7
		// + 数据请求 1 + 提醒已读 1 + 设置同构 2。数量写死：任何一项的 SQL
		// 列名写错都会让该项「恒 0」静默通过，数量对不上即暴露。
		expect(result.checks).toBe(22);
		expect(result.diffs).toEqual([]);

		// 空分片：不评估任何行，同样不得回落到全库
		const empty = await reconcileMigration(db, { userIds: [] });
		expect(empty).toMatchObject({ sharded: true, checks: 22, diffs: [] });

		// 全量模式：额外评估 4 类无法归属到用户的孤儿派生行（共享本地库可能有
		// 其他用例残留，故只断言检查项数量与模式，不断言 0 diffs）
		const whole = await reconcileMigration(db);
		expect(whole.sharded).toBe(false);
		expect(whole.checks).toBe(26);
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
		// DataRequest 语义映射
		await expectDiffWhile(
			"data_request.scope_mapping",
			users,
			() => db.dataRequest.updateMany({
				where: { userId: fullUserId, type: "CLEAR" },
				data: { scope: "PERSONAL" },
			}),
			() => db.dataRequest.updateMany({
				where: { userId: fullUserId, type: "CLEAR" },
				data: { scope: "ORGANIZATION" },
			}),
		);
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
			],
		});
		expect(orgScoped.count).toBe(2);
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
				["EXPORT", "ORGANIZATION"],
			]);
		} finally {
			await db.dataRequest.deleteMany({
				where: { userId: fullUserId, organizationId: orgBId },
			});
		}
	});

	test("评审 I-15：dry-run 估算 = 实际写入；分片事务逐片提交", async () => {
		// 分片演练用户：存量个人行（2 账户 / 1 计划 / 1 变更日志 / 1 历史 CLEAR 请求），无组织
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
		await db.dataRequest.create({
			data: {
				userId: chunkUserId, type: "CLEAR", status: "COMPLETED", requestedAt: T0, dueAt: T0,
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
			dataRequestsRescoped: 1,
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
			dataRequestsRescoped: 1,
		});
		expect(run.rowsBackfilled).toEqual(expectedRows);

		const chunkOrgId = await defaultOrgIdOf(chunkUserId);
		const chunkPlan = await db.planChangeLog.findFirst({
			where: { plan: { userId: chunkUserId } },
		});
		expect(chunkPlan?.organizationId).toBe(chunkOrgId);
		const chunkRequest = await db.dataRequest.findFirst({
			where: { userId: chunkUserId },
		});
		expect([chunkRequest?.scope, chunkRequest?.organizationId]).toEqual([
			"ORGANIZATION",
			chunkOrgId,
		]);
		// 非法 chunkSize 显式报错，不静默回落
		await expect(
			backfillDefaultOrganizations(db, { userIds: [chunkUserId], chunkSize: 0 }),
		).rejects.toThrow(/chunkSize/);

		const result = await reconcileMigration(db, { userIds: chunkedUserIds });
		expect(result.diffs).toEqual([]);
	});

	test("评审 I-15：多组织用户回填到「最早」的 OWNER 组织（与运行时默认组织同口径）", async () => {
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

		const run = await backfillDefaultOrganizations(db, {
			userIds: [earliestOwnerUserId],
		});
		expect(run.organizationsCreated).toBe(0);
		expect(run.usersSkippedIdempotent).toBe(1);
		const mapped = await db.account.findUnique({ where: { id: account.id } });
		expect(mapped?.organizationId).toBe(earliestOrg.id);
		// 回填不得为「已有 OWNER 组织」的用户再建组织
		expect(await db.membership.count({ where: { userId: earliestOwnerUserId } })).toBe(2);

		// 全部演练用户收尾：行集恒等（多组织用户的存量行归默认组织，而非任一 OWNER 组织）
		const result = await reconcileMigration(db, { userIds: allUserIds() });
		expect(result.diffs).toEqual([]);
	});
});
