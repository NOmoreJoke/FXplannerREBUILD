import { beforeAll, afterAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
	BackfillAnomalyError,
	backfillDefaultOrganizations,
} from "../../src/organization/organization-backfill";
import { reconcileMigration } from "../../src/organization/organization-reconcile";
import { cleanupUser } from "../helpers/test-app";

/**
 * MIG-B 集成测试（技术方案 §14.3.4；Goal #3A W15）：
 *
 * 1. 构造完整存量个人账本用户（多币种持仓/交易/计划+分配+批次/使用+分摊/
 *    更正/已读与未读提醒/AI 会话/EXPORT-CLEAR-DELETION 数据请求）+ 无设置新用户；
 * 2. 第 1 次回填（userIds 分片，避免触碰本地库其他用户）→ §12.3 核对 0 差异 →
 *    第 2 次重复回填（幂等）→ 无新增组织/无重复记录；
 * 3. 构造父缺失/跨组织异常行 → 预检阻断/核对显式报差异，绝不静默跳过。
 */

const RUN = `migmig-${Date.now()}`;
const db = new PrismaClient();
type CleanupDb = Parameters<typeof cleanupUser>[0];

let fullUserId = "";
let noSettingsUserId = "";
/** 孤儿异常用例的独立用户与其脏数据 id */
let orphanUserId = "";
let orphanUsageId = "";
let orphanPlanAllocationId = "";
/** 本次测试创建/关联的组织 id（afterAll 统一清理） */
const managedOrgIds: string[] = [];

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
			ledgerStartedAt: new Date("2026-01-05T00:00:00.000Z"),
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
	for (const [code, amount, cost] of [
		["USD", "500.0000", "3600.0000"],
		["EUR", "100.0000", "790.0000"],
	] as const) {
		const holding = await db.initialHolding.create({
			data: {
				userId: user.id,
				currencyCode: code,
				amount,
				rate: "7.2000000000",
				rawRate: "7.2000000000",
				rateSource: "identity",
				rateObservedAt: new Date("2026-01-05T00:00:00.000Z"),
				cost,
				confirmedAt: new Date("2026-01-05T00:00:00.000Z"),
			},
		});
		await db.costLot.create({
			data: {
				userId: user.id,
				currencyCode: code,
				sourceType: "INITIAL",
				sourceId: holding.id,
				quantity: amount,
				remainingQty: code === "USD" ? "480.0000" : "100.0000",
				unitCost: "7.2000000000",
				totalCost: cost,
				acquiredAt: new Date("2026-01-05T00:00:00.000Z"),
			},
		});
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
	await db.costLot.create({
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
	const initialLot = await db.costLot.findFirst({
		where: { userId: user.id, currencyCode: "USD", sourceType: "INITIAL" },
	});
	if (!initialLot) throw new Error("fixture 缺少 INITIAL 批次");
	await db.usageLotAllocation.create({
		data: {
			usageId: usage.id,
			lotId: initialLot.id,
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
	await db.reminder.createMany({
		data: [
			{
				userId: user.id,
				type: "PLAN_DUE",
				planId: plan.id,
				dedupKey: `${RUN}-due`,
				scheduledFor: new Date("2026-05-25T00:00:00.000Z"),
				readAt: new Date("2026-05-26T08:00:00.000Z"),
			},
			{
				userId: user.id,
				type: "PLAN_PREP",
				planId: plan.id,
				dedupKey: `${RUN}-prep`,
				scheduledFor: new Date("2026-05-22T00:00:00.000Z"),
			},
		],
	});
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

beforeAll(async () => {
	fullUserId = await seedFullUser();
	const bare = await db.user.create({
		data: {
			email: `${RUN}-noset@example.com`,
			passwordHash: "test-hash",
			name: "待建账新用户",
		},
	});
	noSettingsUserId = bare.id;
	const orphan = await db.user.create({
		data: {
			email: `${RUN}-orphan@example.com`,
			passwordHash: "test-hash",
			name: "孤儿演练用户",
		},
	});
	orphanUserId = orphan.id;
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
	await cleanupUser(db as CleanupDb, fullUserId);
	await cleanupUser(db as CleanupDb, noSettingsUserId);
	await cleanupUser(db as CleanupDb, orphanUserId);
	await db.$disconnect();
});

describe("MIG-B 默认组织回填与核对", () => {
	const scopeUserIds = (): string[] =>
		[fullUserId, noSettingsUserId, orphanUserId].filter((id) => id !== "");

	test("第 1 次回填：完整用户与无设置用户全量映射", async () => {
		const firstRun = await backfillDefaultOrganizations(db, {
			userIds: scopeUserIds(),
		});
		// 孤儿演练用户在预检时……注意：此时库内无孤儿行（孤儿在第 4 个用例才构造），
		// 三个用户全部新建组织
		expect(firstRun.organizationsCreated).toBe(3);
		expect(firstRun.usersSkippedIdempotent).toBe(0);
		expect(firstRun.usersProcessed).toBe(3);

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
		expect(settings?.ledgerStartedAt?.toISOString()).toBe(
			"2026-01-05T00:00:00.000Z",
		);

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

		// DataRequest 语义映射（§12.2.6）：EXPORT/DELETION→PERSONAL(null org)；
		// CLEAR→ORGANIZATION(默认组织)；状态机字段一律不动
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

	test("§12.3 核对：0 差异", async () => {
		const result = await reconcileMigration(db, { userIds: scopeUserIds() });
		expect(result.diffs).toEqual([]);
		expect(result.checks).toBeGreaterThan(0);
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
		await expect(
			backfillDefaultOrganizations(db, { userIds: scopeUserIds() }),
		).rejects.toThrowError(BackfillAnomalyError);
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
		await expect(
			backfillDefaultOrganizations(db, { userIds: scopeUserIds() }),
		).rejects.toThrowError(BackfillAnomalyError);
	});

	test("跨组织父子不一致：核对显式报差异（§12.3.7）", async () => {
		// 清理孤儿行，恢复可回填状态
		await db.usageLotAllocation.deleteMany({
			where: { usageId: orphanUsageId },
		});
		await db.usageRecord.delete({ where: { id: orphanUsageId } });
		await db.planAllocation.delete({ where: { id: orphanPlanAllocationId } });

		// 构造跨组织异常：usage.organizationId 指向组织 B，而其 plan 属组织 A
		const orgA = await db.membership.findFirst({
			where: { userId: fullUserId, role: "OWNER" },
		});
		const orgAOrgId = orgA?.organizationId;
		expect(orgAOrgId).toBeDefined();
		const orgB = await db.organization.create({
			data: { name: `MIG-B 跨组织演练组织 ${RUN}` },
		});
		managedOrgIds.push(orgB.id);
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
			data: { organizationId: orgAOrgId ?? null },
		});
		const restored = await reconcileMigration(db, {
			userIds: scopeUserIds(),
		});
		expect(restored.diffs).toEqual([]);
	});
});
