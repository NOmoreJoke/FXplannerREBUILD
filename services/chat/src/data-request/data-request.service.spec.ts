import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import type { OtpService } from "../auth/otp/otp.service";
import { PrismaService } from "../prisma/prisma.service";
import { runBehindAdvisoryLock } from "../../test/helpers/postgres-lock-barrier";
import {
	cleanupOrgLedgers,
	type OrgLedger,
} from "../../test/helpers/organization-ledger-test-helper";
import type { TestUser } from "../../test/helpers/test-app";
import { DataRequestService } from "./data-request.service";
import {
	assertNoRemainingUserReferences,
	claimForProcessing,
	countUserReferences,
	executeOrganizationRequest,
	executePersonalDeletion,
	findLastOwnerBlocking,
	organizationLedgerScope,
	userReferencesFromSchema,
	type AuditWriter,
	type DueRequest,
} from "./data-request-cleanup";

/**
 * 数据请求到期清理 ↔ src/data-request/data-request-cleanup.ts + data-request.service.ts
 * （Goal #3B W26；技术方案 §9 / §13.1）。真实数据库，不依赖 Nest DI：
 * - 条件认领与并发互斥（行锁等待后按最新行版本重估 WHERE）；
 * - PERSONAL DELETION：创建阶段与锁内复验的最后 Owner 409、共享组织账本过户零丢失；
 * - ORGANIZATION CLEAR / DELETION：作用域隔离、记账起点重置、同事务审计原子性、
 *   发起人资格失效的系统作废；
 * - 零残留引用断言（DMMF 推导的 User 外键集合 = 数据库目录）。
 *
 * 每个用例自建夹具并在 afterEach 回收（组织 + 用户 + 审计留痕），支持 -t 单跑，
 * 测后不新增无成员孤儿组织。
 */

const db = new PrismaClient();
const prisma = db as unknown as PrismaService;
const audit = new AuditService(prisma);
const service = new DataRequestService(
	prisma,
	{} as OtpService,
	audit,
);

/** 与 DataRequestService.CLEANUP_TX_OPTIONS 同值（并发用例显式超时） */
const TX_OPTIONS = { maxWait: 30_000, timeout: 120_000 } as const;
const T0 = new Date("2026-01-01T00:00:00.000Z");
const PAST = new Date("2026-01-09T00:00:00.000Z");

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function createUser(label: string): Promise<{ id: string; email: string }> {
	const email = `w26-${label}-${randomUUID()}@example.com`;
	const user = await db.user.create({
		data: { email, name: label },
		select: { id: true, email: true },
	});
	createdUserIds.push(user.id);
	return { id: user.id, email: user.email ?? email };
}

/** 建组织：组织与首批成员关系同事务创建（创建者 = 首个成员，默认组织识别口径） */
async function createOrg(
	name: string,
	members: ReadonlyArray<{ userId: string; role: string; status?: string }>,
): Promise<{ id: string }> {
	const organization = await db.organization.create({
		data: {
			name,
			memberships: {
				create: members.map((member) => ({
					userId: member.userId,
					role: member.role,
					status: member.status ?? "ACTIVE",
				})),
			},
		},
		select: { id: true },
	});
	createdOrgIds.push(organization.id);
	return organization;
}

async function createRequest(input: {
	userId: string;
	type: "CLEAR" | "DELETION";
	scope: "PERSONAL" | "ORGANIZATION";
	organizationId?: string | null;
	status?: string;
	dueAt?: Date;
}): Promise<DueRequest & { rowId: string }> {
	const row = await db.dataRequest.create({
		data: {
			requesterUserId: input.userId,
			scope: input.scope,
			organizationId:
				input.scope === "ORGANIZATION" ? input.organizationId ?? null : null,
			type: input.type,
			status: input.status ?? "PENDING",
			requestedAt: T0,
			dueAt: input.dueAt ?? PAST,
		},
		select: { id: true },
	});
	return {
		id: row.id,
		rowId: row.id,
		requesterUserId: input.userId,
		scope: input.scope,
		organizationId:
			input.scope === "ORGANIZATION" ? input.organizationId ?? null : null,
		type: input.type,
	};
}

/**
 * 把组织所有权转给另一位已在职的 ACTIVE 成员：先降后升
 * （memberships_single_active_owner_uidx 顺序保护——同一组织只允许一个 ACTIVE OWNER）
 */
async function transferOwnership(
	organizationId: string,
	fromUserId: string,
	toUserId: string,
): Promise<void> {
	const demoted = await db.membership.updateMany({
		where: { organizationId, userId: fromUserId, role: "OWNER", status: "ACTIVE" },
		data: { role: "ADMIN" },
	});
	const promoted = await db.membership.updateMany({
		where: { organizationId, userId: toUserId, status: "ACTIVE", role: { not: "OWNER" } },
		data: { role: "OWNER" },
	});
	expect([demoted.count, promoted.count]).toEqual([1, 1]);
}

/**
 * 组织共享账本夹具：userId 在组织内的全部带 user_id 的共享表各一行（全带 organizationId，
 * 审计快照列 createdById / actorUserId 指向该用户）。同组织仅可调用一次（账户 / 持仓按组织唯一）。
 */
async function seedOrgLedgerRows(
	organizationId: string,
	userId: string,
): Promise<Record<string, string>> {
	await db.account.create({
		data: {
			organizationId,
			createdById: userId,
			currencyCode: "USD",
			balance: "900.0000",
		},
	});
	const holding = await db.initialHolding.create({
		data: {
			organizationId,
			createdById: userId,
			currencyCode: "CAD",
			amount: "100.0000",
			rate: "5.0000000000",
			rawRate: "5.00000000",
			rateSource: "fixture",
			rateObservedAt: T0,
			cost: "500.0000",
			confirmedAt: T0,
		},
	});
	const transaction = await db.transaction.create({
		data: {
			organizationId,
			createdById: userId,
			currencyCode: "USD",
			quantity: "100.0000",
			principalAmount: "720.0000",
			feeAmount: null,
			exchangeRate: "7.2000000000",
			rateSource: "fixture",
			rateObservedAt: T0,
			transactedAt: T0,
		},
	});
	const lot = await db.costLot.create({
		data: {
			organizationId,
			currencyCode: "USD",
			sourceType: "PURCHASE",
			sourceId: transaction.id,
			quantity: "100.0000",
			remainingQty: "60.0000",
			unitCost: "7.2000000000",
			totalCost: "720.0000",
			acquiredAt: T0,
		},
	});
	const plan = await db.plan.create({
		data: {
			organizationId,
			createdById: userId,
			name: "组织计划",
			targetCurrency: "USD",
			targetAmount: "1000.0000",
			expectUseDate: T0,
			prepLeadDays: 3,
			latestPrepDate: T0,
			installments: {
				create: [{ seq: 1, scheduledAt: T0, amount: "400.0000" }],
			},
		},
	});
	await db.planAllocation.create({
		data: { planId: plan.id, amount: "600.0000", usedAmount: "288.0000" },
	});
	const changeLog = await db.planChangeLog.create({
		data: {
			planId: plan.id,
			organizationId,
			actorUserId: userId,
			changeType: "TARGET_ADJUSTED",
			beforeTarget: "900.0000",
			afterTarget: "1000.0000",
			beforeAlloc: "600.0000",
			afterAlloc: "600.0000",
			beforeSnapshot: {},
			afterSnapshot: {},
		},
		select: { id: true },
	});
	const usage = await db.usageRecord.create({
		data: {
			organizationId,
			createdById: userId,
			planId: plan.id,
			currencyCode: "USD",
			amount: "40.0000",
			usedAt: T0,
		},
	});
	await db.usageLotAllocation.create({
		data: { usageId: usage.id, lotId: lot.id, quantity: "40.0000", cost: "288.0000" },
	});
	const correction = await db.correction.create({
		data: {
			organizationId,
			actorUserId: userId,
			targetType: "TRANSACTION",
			targetId: transaction.id,
			reason: "夹具更正",
			beforeSnapshot: { feeAmount: null },
			afterSnapshot: { feeAmount: "10" },
			status: "APPLIED",
		},
		select: { id: true },
	});
	const reminder = await db.reminder.create({
		data: {
			organizationId,
			type: "PREP",
			planId: plan.id,
			dedupKey: `PREP:${plan.id}`,
			scheduledFor: T0,
		},
		select: { id: true },
	});
	await db.reminderRead.create({
		data: { reminderId: reminder.id, userId, readAt: T0 },
	});
	const conversation = await db.aiConversation.create({
		data: {
			userId,
			organizationId,
			title: "组织内会话",
			lastMessageAt: T0,
		},
		select: { id: true },
	});
	await db.aiMessage.create({
		data: { conversationId: conversation.id, role: "user", content: "你好" },
	});
	const request = await db.dataRequest.create({
		data: {
			requesterUserId: userId,
			scope: "ORGANIZATION",
			organizationId,
			type: "EXPORT",
			status: "COMPLETED",
			requestedAt: T0,
			dueAt: T0,
		},
		select: { id: true },
	});
	return {
		holding: holding.id,
		transaction: transaction.id,
		lot: lot.id,
		plan: plan.id,
		changeLog: changeLog.id,
		usage: usage.id,
		correction: correction.id,
		reminder: reminder.id,
		conversation: conversation.id,
		request: request.id,
	};
}

type Rows = Record<string, Array<Record<string, unknown>>>;

/** Prisma 行 → 纯 JSON（Decimal → 字符串、Date → ISO），便于 toEqual 逐字段比对 */
function toJsonRows<T>(rows: readonly T[]): Array<Record<string, unknown>> {
	return JSON.parse(JSON.stringify(rows)) as Array<Record<string, unknown>>;
}

/** 读出若干组织内全部带 organization_id 的行，按表分组、各表按 id 升序 */
async function readOrgRows(organizationIds: readonly string[]): Promise<Rows> {
	const where = { organizationId: { in: [...organizationIds] } };
	const orderBy = { id: "asc" } as const;
	const [accounts, transactions, holdings, lots, plans, changeLogs, usages, corrections, reminders, requests, conversations] =
		await Promise.all([
			db.account.findMany({ where, orderBy }),
			db.transaction.findMany({ where, orderBy }),
			db.initialHolding.findMany({ where, orderBy }),
			db.costLot.findMany({ where, orderBy }),
			db.plan.findMany({ where, orderBy }),
			db.planChangeLog.findMany({ where, orderBy }),
			db.usageRecord.findMany({ where, orderBy }),
			db.correction.findMany({ where, orderBy }),
			db.reminder.findMany({ where, orderBy }),
			db.dataRequest.findMany({ where, orderBy }),
			db.aiConversation.findMany({ where, orderBy }),
		]);
	const planIdFilter = { planId: { in: plans.map((plan) => plan.id) } };
	const [allocations, installments] = await Promise.all([
		db.planAllocation.findMany({ where: planIdFilter, orderBy }),
		db.planInstallment.findMany({ where: planIdFilter, orderBy }),
	]);
	return {
		accounts: toJsonRows(accounts),
		transactions: toJsonRows(transactions),
		initialHoldings: toJsonRows(holdings),
		costLots: toJsonRows(lots),
		plans: toJsonRows(plans),
		planChangeLogs: toJsonRows(changeLogs),
		usageRecords: toJsonRows(usages),
		planAllocations: toJsonRows(allocations),
		corrections: toJsonRows(corrections),
		reminders: toJsonRows(reminders),
		dataRequests: toJsonRows(requests),
		aiConversations: toJsonRows(conversations),
		planInstallments: toJsonRows(installments),
	};
}

/** 去掉指定列（仅这些列允许变化），其余字段原样保留用于比对 */
function stripFields(
	rows: Rows[string],
	fields: readonly string[],
): Array<Record<string, unknown>> {
	return rows.map((row) => {
		const copy = { ...row };
		for (const field of fields) delete copy[field];
		return copy;
	});
}

/**
 * 除作者外键列（createdById / actorUserId / requesterUserId，由 ON DELETE SET NULL
 * 置空）外整行不变——覆盖 updated_at 与全部金额列。
 */
function expectRowsUnchangedExceptAuthor(
	before: Rows,
	after: Rows,
	context: string,
): void {
	expect(Object.keys(after).sort(), context).toEqual(Object.keys(before).sort());
	const authorFields = ["createdById", "actorUserId", "requesterUserId"];
	for (const table of Object.keys(before) as string[]) {
		expect(
			stripFields(after[table] ?? [], authorFields),
			`${context} · ${table}`,
		).toEqual(stripFields(before[table] ?? [], authorFields));
	}
}

/**
 * 账本与会话行零变化；数据请求表中除 excludeRequestId 指定的那一行（请求自身的状态流转）
 * 外其余行原样。
 */
function expectOrganizationUntouched(
	before: Rows,
	after: Rows,
	excludeRequestId: string,
	context: string,
): void {
	const split = (rows: Rows) => {
		const { dataRequests = [], ...ledger } = rows;
		return {
			ledger,
			others: dataRequests.filter((row) => row.id !== excludeRequestId),
		};
	};
	const expected = split(before);
	const actual = split(after);
	expect(actual.ledger, context).toEqual(expected.ledger);
	expect(actual.others, `${context} · 其他数据请求行`).toEqual(expected.others);
}

afterEach(async () => {
	// 回收本用例夹具：先清各组织派生行与审计留痕（含组织删除后保留的那一条），再逐个删用户
	//（cleanupUser 容错已删用户，并回收删后无成员的组织）。orgId 为空串的分组用于无组织用户。
	const users = createdUserIds.map(
		(userId) => ({ userId } as unknown as TestUser),
	);
	const groups: OrgLedger[] = createdOrgIds.map((orgId) => ({
		owner: users[0],
		orgId,
		members: [],
		users,
	}));
	if (users.length > 0) {
		groups.push({ owner: users[0], orgId: "", members: [], users });
	}
	for (const group of groups) {
		await cleanupOrgLedgers(prisma, group);
	}
	createdUserIds.length = 0;
	createdOrgIds.length = 0;
});

// ─────────────────────────────────────────────────────────────
// 条件认领与并发互斥（Goal #2 ④）
// ─────────────────────────────────────────────────────────────

describe("claimForProcessing（并发条件认领）", () => {
	it("PENDING / FAILED 可认领为 PROCESSING；PROCESSING / COMPLETED / CANCELLED 认领 0 行", async () => {
		const user = await createUser("claim");
		const statuses = [
			"PENDING",
			"FAILED",
			"PROCESSING",
			"COMPLETED",
			"CANCELLED",
		] as const;
		const requestIds: Record<(typeof statuses)[number], string> = {
			PENDING: "",
			FAILED: "",
			PROCESSING: "",
			COMPLETED: "",
			CANCELLED: "",
		};
		for (const status of statuses) {
			requestIds[status] = (
				await createRequest({
					userId: user.id,
					type: "DELETION",
					scope: "PERSONAL",
					status,
				})
			).id;
		}
		await db.$transaction(async (tx) => {
			for (const status of statuses) {
				const claimed = await claimForProcessing(tx, requestIds[status]);
				expect(claimed, status).toBe(status === "PENDING" || status === "FAILED");
			}
			// 已被认领（此刻为 PROCESSING）的行不可重复认领；不存在的请求同样 0 行
			expect(await claimForProcessing(tx, requestIds.PENDING)).toBe(false);
			expect(await claimForProcessing(tx, "nonexistent-request")).toBe(false);
			for (const status of statuses) {
				const row = await tx.dataRequest.findUniqueOrThrow({
					where: { id: requestIds[status] },
				});
				expect(row.status, status).toBe(
					status === "PENDING" || status === "FAILED" ? "PROCESSING" : status,
				);
			}
		});
	});

	it("两个事务并发认领同一到期请求：恰一个抢占成功并执行清理，另一个 count=0 幂等退出", async () => {
		// 独立客户端：$use 中间件无法移除，不污染其他用例
		const gated = new PrismaClient();
		try {
			const owner = await createUser("race-owner");
			const org = await createOrg("并发认领组织", [
				{ userId: owner.id, role: "OWNER" },
			]);
			await db.organizationSettings.create({
				data: { organizationId: org.id, baseCurrency: "CNY" },
			});
			await seedOrgLedgerRows(org.id, owner.id);
			const request = await createRequest({
				userId: owner.id,
				type: "CLEAR",
				scope: "ORGANIZATION",
				organizationId: org.id,
			});
			const ctx = { now: new Date(), audit: audit as AuditWriter };

			// 闸门：认领成功的事务停在清理体第一条账户删除之前——此刻它已持有请求行的行锁
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let cleanupEntered = 0;
			gated.$use(async (params, next) => {
				if (params.model === "Account" && params.action === "deleteMany") {
					cleanupEntered += 1;
					await gate;
				}
				return next(params);
			});

			const run = () =>
				gated.$transaction(
					(tx) =>
						executeOrganizationRequest(
							tx,
							{ ...request, organizationId: org.id },
							ctx,
						),
					TX_OPTIONS,
				);
			const first = run();
			// 首事务已认领并进入清理体
			await expect.poll(() => cleanupEntered).toBe(1);

			const second = run();
			// 次事务确实阻塞在首事务持有的请求行锁上：观察到真实锁等待后才放行（零 sleep）
			await expect.poll(
				async () => {
					const [row] = await db.$queryRaw<Array<{ n: number }>>`
						SELECT count(*)::int AS n FROM pg_stat_activity
						WHERE datname = current_database()
							AND wait_event_type = 'Lock'
							AND ltrim(query, chr(9) || chr(10) || chr(13) || ' ') LIKE 'UPDATE%data_requests%'`;
					return row?.n ?? 0;
				},
				{ timeout: 10_000, message: "次事务应阻塞在 data_requests 行锁上" },
			).toBe(1);
			release();

			const [firstResult, secondResult] = await Promise.all([first, second]);
			expect(firstResult.outcome).toBe("completed");
			expect(secondResult.outcome).toBe("skipped");
			// 清理体只被执行一次（次事务 count=0 后未触碰任何账本行）
			expect(cleanupEntered).toBe(1);
			const row = await db.dataRequest.findUniqueOrThrow({
				where: { id: request.id },
			});
			expect(row.status).toBe("COMPLETED");
			expect(row.processedAt).toEqual(ctx.now);
			expect(await db.account.count({ where: { organizationId: org.id } })).toBe(0);
			expect(
				await db.auditLog.count({
					where: { organizationId: org.id, action: "data.clear.execute" },
				}),
			).toBe(1);
		} finally {
			await gated.$disconnect();
		}
	});
});

// ─────────────────────────────────────────────────────────────
// PERSONAL DELETION：最后 Owner 双重拦截
// ─────────────────────────────────────────────────────────────

describe("PERSONAL DELETION 的最后 Owner 保护（创建阶段 + 锁内复验）", () => {
	it("创建阶段检查：唯一 ACTIVE OWNER → 列出阻塞组织；所有权转移后放行", async () => {
		const [owner, successor] = await Promise.all([
			createUser("sole-owner"),
			createUser("successor"),
		]);
			const org = await createOrg("唯一所有者组织", [
				{ userId: owner.id, role: "OWNER" },
				{ userId: successor.id, role: "ADMIN" },
			]);
		const tx = db as unknown as Prisma.TransactionClient;

		expect(await findLastOwnerBlocking(tx, owner.id)).toEqual([
			{
				organizationId: org.id,
				organizationName: "唯一所有者组织",
				role: "OWNER",
			},
		]);
		// 组织里另有 ADMIN 成员不构成「另一位所有者」：仍然阻塞
		expect(await findLastOwnerBlocking(tx, successor.id)).toEqual([]);

		await transferOwnership(org.id, owner.id, successor.id);
		// 已转移所有权（本人降为 ADMIN）→ 不再阻塞；新所有者则成为唯一所有者
		expect(await findLastOwnerBlocking(tx, owner.id)).toEqual([]);
		expect(await findLastOwnerBlocking(tx, successor.id)).toHaveLength(1);
	});

	it("锁内复验：等锁期间成为唯一 Owner → 执行抛 409 LAST_OWNER_REQUIRED 并整体回滚，账本与账号零变化", async () => {
		const [owner, deleting] = await Promise.all([
			createUser("owner-leaves"),
			createUser("deleting"),
		]);
		const org = await createOrg("锁内复验组织", [
			{ userId: owner.id, role: "OWNER" },
			{ userId: deleting.id, role: "ADMIN" },
		]);
		await seedOrgLedgerRows(org.id, deleting.id);
		const tx = db as unknown as Prisma.TransactionClient;
		// 创建阶段（无锁）：本人是 ADMIN，不阻塞
		expect(await findLastOwnerBlocking(tx, deleting.id)).toEqual([]);
		const request = await createRequest({
			userId: deleting.id,
			type: "DELETION",
			scope: "PERSONAL",
		});
		const before = await readOrgRows([org.id]);

		const attempt = runBehindAdvisoryLock(
			db,
			`membership:${org.id}`,
			() =>
				db.$transaction(
					(tx) => executePersonalDeletion(tx, request, { now: new Date() }),
					TX_OPTIONS,
				),
			async () => {
				// 另一条写在本人等锁期间提交：原所有者被移除、本人接任 → 本人成为唯一 ACTIVE OWNER
				//（先移除再晋升，遵守 memberships_single_active_owner_uidx 顺序）
				await db.membership.updateMany({
					where: { organizationId: org.id, userId: owner.id },
					data: { status: "DISABLED" },
				});
				await db.membership.updateMany({
					where: { organizationId: org.id, userId: deleting.id, role: "ADMIN" },
					data: { role: "OWNER" },
				});
			},
		);
		const error: unknown = await attempt.then(
			() => {
				throw new Error("预期执行被 409 拒绝");
			},
			(thrown: unknown) => thrown,
		);
		expect(error).toBeInstanceOf(HttpException);
		expect(error).toMatchObject({ status: 409 });
		expect((error as HttpException).getResponse()).toMatchObject({
			code: "LAST_OWNER_REQUIRED",
			data: {
				blockingOrganizations: [
					{ organizationId: org.id, organizationName: "锁内复验组织", role: "OWNER" },
				],
			},
		});

		// 整体回滚：认领撤销（仍 PENDING）、账号仍在、共享账本原样
		const row = await db.dataRequest.findUniqueOrThrow({ where: { id: request.id } });
		expect(row.status).toBe("PENDING");
		expect(await db.user.findUnique({ where: { id: deleting.id } })).not.toBeNull();
		const after = await readOrgRows([org.id]);
		expect(after).toEqual(before);
	});

	it("到期时已成为唯一 Owner：请求由系统作废（CANCELLED）而非 FAILED，账号锁随之解除、数据零变化", async () => {
		const owner = await createUser("late-sole-owner");
		const org = await createOrg("到期唯一所有者组织", [
			{ userId: owner.id, role: "OWNER" },
		]);
		await seedOrgLedgerRows(org.id, owner.id);
		const request = await createRequest({
			userId: owner.id,
			type: "DELETION",
			scope: "PERSONAL",
		});
		const before = await readOrgRows([org.id]);

		const advanced = await service.advanceAndResolvePersonalLock(owner.id, {
			skipLock: true,
			method: "GET",
		});
		expect(advanced).toEqual({ userDeleted: false, lock: null, lockSubject: null });

		const row = await db.dataRequest.findUniqueOrThrow({ where: { id: request.id } });
		expect(row.status).toBe("CANCELLED");
		expect(await db.user.findUnique({ where: { id: owner.id } })).not.toBeNull();
		expect(await readOrgRows([org.id])).toEqual(before);

		// 账号锁解除：不再有进行中的请求
		expect(
			await service.advanceAndResolvePersonalLock(owner.id, { skipLock: false, method: "POST" }),
		).toEqual({ userDeleted: false, lock: null, lockSubject: null });
	});
});

// ─────────────────────────────────────────────────────────────
// PERSONAL DELETION：共享组织账本过户（零级联误删）
// ─────────────────────────────────────────────────────────────

describe("PERSONAL DELETION：共享组织账本 1 行不丢、余额零变化（ON DELETE SET NULL 作者置空）", () => {
	it("账本行整行留存、作者置空（createdById/actorUserId/requesterUserId → null）；他人作者不变；个人域清空", async () => {
		const [ownerX, deleting, ownerY] = await Promise.all([
			createUser("owner-x"),
			createUser("deleting"),
			createUser("owner-y"),
		]);
		const orgX = await createOrg("共享组织 X", [
			{ userId: ownerX.id, role: "OWNER" },
			{ userId: deleting.id, role: "ADMIN" },
		]);
		const orgY = await createOrg("旁观组织 Y", [
			{ userId: ownerY.id, role: "OWNER" },
			{ userId: deleting.id, role: "VIEWER" },
		]);

		// 组织 X：本人创建全部共享表各一行
		const shared = await seedOrgLedgerRows(orgX.id, deleting.id);
		// 组织 Y：本人创建的一条账户行（VIEWER 写入的历史行，同样留存且作者置空）
		const orgYAccount = await db.account.create({
			data: {
				organizationId: orgY.id,
				createdById: deleting.id,
				currencyCode: "EUR",
				balance: "12.3400",
			},
		});
		// 组织 X 的 Owner 自己创建的一行（本人注销不得置空他人作者）
		const ownerXAccount = await db.account.create({
			data: {
				organizationId: orgX.id,
				createdById: ownerX.id,
				currencyCode: "CHF",
				balance: "1.0000",
			},
		});
		// 接任者自己对同一条提醒的已读态
		await db.reminderRead.create({
			data: { reminderId: shared.reminder, userId: ownerX.id, readAt: T0 },
		});
		// 个人域：条款 + 设置 + OTP 身份 + 个人请求
		await db.termsConsent.create({
			data: { userId: deleting.id, termsVersion: "v1", consentType: "TERMS", consentedAt: T0 },
		});
		await db.userSettings.create({
			data: { userId: deleting.id, locale: "zh-CN", region: "CN" },
		});
		await db.otpIdentity.create({
			data: { userId: deleting.id, channel: "email", target: deleting.email },
		});
		await createRequest({ userId: deleting.id, type: "DELETION", scope: "PERSONAL" });
		// 组织审计：本人作为操作者的历史留痕（个人注销不删组织审计）
		await db.auditLog.createMany({
			data: [
				{
					organizationId: orgX.id,
					actorUserId: deleting.id,
					actorType: "USER",
					action: "plan.create",
					result: "SUCCESS",
				},
				{
					organizationId: orgY.id,
					actorUserId: deleting.id,
					actorType: "USER",
					action: "plan.create",
					result: "SUCCESS",
				},
			],
		});

		const before = await readOrgRows([orgX.id, orgY.id]);
		const auditBefore = await db.auditLog.findMany({
			where: { organizationId: { in: [orgX.id, orgY.id] } },
			orderBy: { id: "asc" },
		});

		const advanced = await service.advanceAndResolvePersonalLock(deleting.id, {
			skipLock: true,
			method: "GET",
		});
		// 守卫契约：本次请求已物理删除用户（守卫据此让同请求的 JwtAuthGuard 返回 401）
		expect(advanced).toEqual({ userDeleted: true, lock: null, lockSubject: null });

		// 1. 共享账本：除作者外键置空外整行不变——行数、主键、updated_at、全部金额逐字段一致。
		//    例外：AI 会话是成员个人内容（按 (userId, organizationId) 私有），随账号删除
		const after = await readOrgRows([orgX.id, orgY.id]);
		const { aiConversations: conversationsBefore, ...ledgerBefore } = before;
		const { aiConversations: conversationsAfter, ...ledgerAfter } = after;
		expect(conversationsBefore).toHaveLength(1);
		expect(conversationsAfter).toEqual([]);
		expect(await db.aiMessage.count({ where: { conversationId: shared.conversation } })).toBe(0);
		expectRowsUnchangedExceptAuthor(ledgerBefore, ledgerAfter, "注销后");
		// 防同义反复：被逐字段比对的账本行确有 12 张表 14 行
		expect(Object.values(ledgerBefore).reduce((sum, rows) => sum + rows.length, 0)).toBe(14);
		expect(Object.keys(ledgerBefore)).toHaveLength(12);

		// 2. 注销用户作为作者的行均被置空（ON DELETE SET NULL），他人作者行保持原值
		expect(
			after.accounts.find((row) => row.id === orgYAccount.id)?.createdById,
		).toBeNull();
		expect(
			after.accounts.find((row) => row.id === ownerXAccount.id)?.createdById,
		).toBe(ownerX.id);
		expect(
			after.dataRequests.find((row) => row.id === shared.request)?.requesterUserId,
		).toBeNull();

		// 3. 提醒：接任者自己的成员级已读行保留，注销用户的已读行随个人清理删除
		const readStates = await db.reminderRead.findMany({
			where: { reminderId: shared.reminder },
		});
		expect(readStates.map((row) => row.userId)).toEqual([ownerX.id]);

		// 4. 个人域清空：账号、成员关系、个人设置、条款、OTP 身份、个人请求
		expect(await db.user.findUnique({ where: { id: deleting.id } })).toBeNull();
		expect(await db.membership.count({ where: { userId: deleting.id } })).toBe(0);
		expect(await db.userSettings.count({ where: { userId: deleting.id } })).toBe(0);
		expect(await db.termsConsent.count({ where: { userId: deleting.id } })).toBe(0);
		expect(await db.otpIdentity.count({ where: { userId: deleting.id } })).toBe(0);
		expect(
			await db.dataRequest.count({
				where: { requesterUserId: deleting.id, scope: "PERSONAL" },
			}),
		).toBe(0);

		// 5. 组织与接任者安然无恙；组织审计一条不少
		expect(await db.organization.count({ where: { id: { in: [orgX.id, orgY.id] } } })).toBe(2);
		expect(await db.user.count({ where: { id: { in: [ownerX.id, ownerY.id] } } })).toBe(2);
		expect(
			(
				await db.auditLog.findMany({
					where: { organizationId: { in: [orgX.id, orgY.id] } },
					orderBy: { id: "asc" },
				})
			 ).map((row) => row.id),
		).toEqual(auditBefore.map((row) => row.id));
	});

	it("零残留引用断言：任何仍指向该用户的级联外键行都令注销响亮失败（user.delete 不依赖级联）", async () => {
		const [owner, member] = await Promise.all([
			createUser("ref-owner"),
			createUser("ref-member"),
		]);
		await createOrg("零残留断言组织", [
			{ userId: owner.id, role: "OWNER" },
			{ userId: member.id, role: "ADMIN" },
		]);
		const tx = db as unknown as Prisma.TransactionClient;

		// 尚有一条成员关系指向该用户 → 抛错并点名该外键
		await expect(assertNoRemainingUserReferences(tx, member.id)).rejects.toThrow(
			/Membership\.userId/,
		);
		// 全部 ON DELETE CASCADE 指向 users 的表都被逐一计数（W30 MIG-E/F 后为 6 张）
		const references = await countUserReferences(tx, member.id);
		expect(references).toHaveLength(6);
		expect(references.filter((reference) => reference.count > 0).map((r) => r.model)).toEqual([
			"Membership",
		]);

		await db.membership.deleteMany({ where: { userId: member.id } });
		await expect(assertNoRemainingUserReferences(tx, member.id)).resolves.toBeUndefined();
	});

	it("无任何组织的纯个人账号：到期直接删除，个人域行全部清空，不建任何组织", async () => {
		const user = await createUser("no-org");
		await db.termsConsent.create({
			data: { userId: user.id, termsVersion: "v1", consentType: "TERMS", consentedAt: T0 },
		});
		await db.userSettings.create({
			data: { userId: user.id, locale: "zh-CN", region: "CN" },
		});
		await db.otpIdentity.create({
			data: { userId: user.id, channel: "email", target: user.email },
		});
		await createRequest({ userId: user.id, type: "DELETION", scope: "PERSONAL" });
		const organizationsBefore = await db.organization.count();

		const advanced = await service.advanceAndResolvePersonalLock(user.id, {
			skipLock: true,
			method: "GET",
		});
		expect(advanced).toEqual({ userDeleted: true, lock: null, lockSubject: null });

		expect(await db.user.findUnique({ where: { id: user.id } })).toBeNull();
		// 6 张 ON DELETE CASCADE 指向 users 的表全部零残留（user.delete 未依赖任何级联）
		const references = await countUserReferences(db as unknown as Prisma.TransactionClient, user.id);
		expect(references).toHaveLength(6);
		expect(references.filter((reference) => reference.count > 0)).toEqual([]);
		expect(
			await db.dataRequest.count({ where: { requesterUserId: user.id } }),
		).toBe(0);
		// 纯个人注销不触碰任何组织
		expect(await db.organization.count()).toBe(organizationsBefore);
	});

	it("唯一成员的空组织：个人注销删除成员关系后仍能回收该空组织（无残留设置/邀请/数据请求/审计）", async () => {
		const user = await createUser("sole-empty-member");
		// 唯一非 OWNER 成员（例如前任 Owner 离场后留下的 ADMIN/VIEWER 或已禁用成员）：
		// 不受 LAST_OWNER_REQUIRED 阻塞，但注销删掉 membership 后组织已无任何成员，应被回收
		const emptyOrg = await createOrg("待回收空组织", [
			{ userId: user.id, role: "ADMIN" },
		]);
		await db.organizationSettings.create({
			data: { organizationId: emptyOrg.id, baseCurrency: "CNY" },
		});
		await db.organizationInvitation.create({
			data: {
				organizationId: emptyOrg.id,
				email: `invite-${Date.now()}@example.com`,
				tokenHash: `hash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				role: "VIEWER",
				invitedById: user.id,
				expiresAt: new Date(Date.now() + 86_400_000),
			},
		});
		await db.auditLog.create({
			data: {
				organizationId: emptyOrg.id,
				actorUserId: user.id,
				actorType: "USER",
				action: "organization.settings.update",
				result: "SUCCESS",
			},
		});
		await createRequest({ userId: user.id, type: "DELETION", scope: "PERSONAL" });

		const advanced = await service.advanceAndResolvePersonalLock(user.id, {
			skipLock: true,
			method: "GET",
		});
		expect(advanced).toEqual({ userDeleted: true, lock: null, lockSubject: null });
		expect(await db.user.findUnique({ where: { id: user.id } })).toBeNull();
		expect(await db.organization.findUnique({ where: { id: emptyOrg.id } })).toBeNull();
		expect(
			await db.organizationSettings.count({ where: { organizationId: emptyOrg.id } }),
		).toBe(0);
		expect(
			await db.organizationInvitation.count({ where: { organizationId: emptyOrg.id } }),
		).toBe(0);
		expect(await db.auditLog.count({ where: { organizationId: emptyOrg.id } })).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────
// ORGANIZATION CLEAR / DELETION
// ─────────────────────────────────────────────────────────────

const NOW = new Date("2026-11-25T00:00:00.000Z");

/**
 * 组织数据请求夹具：
 * - X = 创建者的默认组织（组织 + 首个成员同事务创建），创建者 OWNER、admin ADMIN；
 * - X 的组织化账本由 admin 写入；创建者另有尚未迁入组织的存量 NULL 行（逻辑上属 X）；
 * - admin 自己的个人域 NULL 行不属于 X；
 * - Y = 无关组织（他人 Owner），账本不得被 X 的请求波及。
 */
async function setupOrganizationFixture(label: string) {
	const [creator, admin, outsider] = await Promise.all([
		createUser(`${label}-creator`),
		createUser(`${label}-admin`),
		createUser(`${label}-outsider`),
	]);
	const orgX = await createOrg(`${label} 被操作组织`, [
		{ userId: creator.id, role: "OWNER" },
		{ userId: admin.id, role: "ADMIN" },
	]);
	const orgY = await createOrg(`${label} 无关组织`, [
		{ userId: outsider.id, role: "OWNER" },
	]);
	await db.organizationSettings.create({
		data: { organizationId: orgX.id, baseCurrency: "CNY", ledgerStartedAt: T0 },
	});
	await db.userSettings.create({
		data: {
			userId: creator.id,
			locale: "zh-CN",
			region: "CN",
		},
	});
	await seedOrgLedgerRows(orgX.id, admin.id);
	await seedOrgLedgerRows(orgY.id, outsider.id);
	return { creator, admin, outsider, orgX, orgY };
}

async function runOrganizationRequest(
	request: DueRequest,
	organizationId: string,
	auditWriter: AuditWriter = audit,
) {
	return db.$transaction(
		(tx) =>
			executeOrganizationRequest(
				tx,
				{ ...request, organizationId },
				{ now: NOW, audit: auditWriter },
			),
		TX_OPTIONS,
	);
}

describe("ORGANIZATION CLEAR：只清当前组织账本", () => {
	it("作用域 = 当前组织全部账本行；不动其他组织、会话与数据请求；重置记账起点并同事务审计", async () => {
		const { admin, outsider, orgX, orgY } =
			await setupOrganizationFixture("clear");
		const request = await createRequest({
			userId: admin.id,
			type: "CLEAR",
			scope: "ORGANIZATION",
			organizationId: orgX.id,
		});

		const tx = db as unknown as Prisma.TransactionClient;
		expect(await organizationLedgerScope(tx, orgX.id)).toEqual({
			organizationId: orgX.id,
		});
		const otherBefore = await readOrgRows([orgY.id]);

		const result = await runOrganizationRequest(request, orgX.id);
		expect(result.outcome).toBe("completed");
		expect(result.exportFilesToDelete).toEqual([]);
		expect(result.stats).toEqual({
			usageLotAllocations: 1,
			planAllocations: 1,
			planChangeLogs: 1,
			plans: 1,
			usageRecords: 1,
			corrections: 1,
			reminders: 1,
			costLots: 1,
			transactions: 1,
			initialHoldings: 1,
			accounts: 1,
		});

		// X 的账本清空；会话保留；数据请求保留（原导出 + 本次 CLEAR）
		const rowsX = await readOrgRows([orgX.id]);
		expect(
			Object.fromEntries(
				Object.entries(rowsX).map(([table, rows]) => [table, rows.length]),
			),
		).toEqual({
			accounts: 0,
			transactions: 0,
			initialHoldings: 0,
			costLots: 0,
			plans: 0,
			planChangeLogs: 0,
			usageRecords: 0,
			planAllocations: 0,
			corrections: 0,
			reminders: 0,
			dataRequests: 2,
			aiConversations: 1,
			planInstallments: 0,
		});
		expect(await readOrgRows([orgY.id])).toEqual(otherBefore);
		// 成员关系与账号不受影响
		expect(await db.membership.count({ where: { organizationId: orgX.id } })).toBe(2);

		// 记账起点重置（仅组织设置），本位币不变
		const settings = await db.organizationSettings.findUniqueOrThrow({
			where: { organizationId: orgX.id },
		});
		expect(settings.ledgerStartedAt).toBeNull();
		expect(settings.baseCurrency).toBe("CNY");

		// 请求终态 + 同事务审计留痕（操作者 = 发起人）
		const row = await db.dataRequest.findUniqueOrThrow({ where: { id: request.id } });
		expect(row).toMatchObject({
			status: "COMPLETED",
			scope: "ORGANIZATION",
			organizationId: orgX.id,
		});
		expect(row.processedAt).toEqual(NOW);
		const logs = await db.auditLog.findMany({
			where: { organizationId: orgX.id, action: "data.clear.execute" },
		});
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			actorUserId: admin.id,
			result: "SUCCESS",
			targetType: "data_request",
			targetId: request.id,
		});
		expect(logs[0]?.detail).toMatchObject({ role: "ADMIN", rows: result.stats });
		// 无关组织没有审计写入
		expect(await db.auditLog.count({ where: { organizationId: orgY.id } })).toBe(0);
		expect(outsider.id).toBeTruthy();
	});

	it("审计写入失败 → 整单回滚：账本零变化、记账起点不变、请求仍为 PENDING（§13.1 同事务）", async () => {
		const { admin, orgX, orgY } =
			await setupOrganizationFixture("clear-audit-fail");
		const request = await createRequest({
			userId: admin.id,
			type: "CLEAR",
			scope: "ORGANIZATION",
			organizationId: orgX.id,
		});
		const before = await readOrgRows([orgX.id, orgY.id]);
		const failingAudit: AuditWriter = {
			recordInTx: async () => {
				throw new Error("injected audit outage");
			},
		};

		await expect(runOrganizationRequest(request, orgX.id, failingAudit)).rejects.toThrow(
			/audit outage/,
		);

		expect(await readOrgRows([orgX.id, orgY.id])).toEqual(before);
		expect(
			(
				await db.organizationSettings.findUniqueOrThrow({
					where: { organizationId: orgX.id },
				})
			).ledgerStartedAt,
		).toEqual(T0);
		const row = await db.dataRequest.findUniqueOrThrow({ where: { id: request.id } });
		expect(row.status).toBe("PENDING"); // 认领随事务一并回滚
		expect(await db.auditLog.count({ where: { organizationId: orgX.id } })).toBe(0);
	});

	it.each([
		["被移除（DISABLED）", async (organizationId: string, userId: string) => {
			await db.membership.updateMany({
				where: { organizationId, userId },
				data: { status: "DISABLED" },
			});
		}],
		["降权为 FINANCE（无 data.clear）", async (organizationId: string, userId: string) => {
			await db.membership.updateMany({
				where: { organizationId, userId },
				data: { role: "FINANCE" },
			});
		}],
	] as const)("冷静期内发起人%s → 到期不执行：请求由系统作废并留 DENIED 审计，账本零变化", async (_label, mutate) => {
		const { admin, orgX, orgY } = await setupOrganizationFixture("clear-lapsed");
		const request = await createRequest({
			userId: admin.id,
			type: "CLEAR",
			scope: "ORGANIZATION",
			organizationId: orgX.id,
		});
		const before = await readOrgRows([orgX.id, orgY.id]);
		await mutate(orgX.id, admin.id);

		const result = await runOrganizationRequest(request, orgX.id);
		expect(result.outcome).toBe("cancelled");
		expect(result.stats).toEqual({});

		const row = await db.dataRequest.findUniqueOrThrow({ where: { id: request.id } });
		expect(row.status).toBe("CANCELLED");
		expectOrganizationUntouched(
			before,
			await readOrgRows([orgX.id, orgY.id]),
			request.id,
			"失权作废后",
		);
		const logs = await db.auditLog.findMany({
			where: { organizationId: orgX.id, action: "data.clear.cancel" },
		});
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			actorUserId: admin.id,
			result: "DENIED",
			targetId: request.id,
			detail: { reason: "REQUESTER_NOT_AUTHORIZED" },
		});
	});
});

describe("ORGANIZATION DELETION：删组织不删任何成员 User", () => {
	it("账本 / 成员关系 / 邀请 / 设置 / 数据请求 / 既有审计全部清理并保留一条删除留痕；其他组织零变化", async () => {
		const { creator, admin, orgX, orgY } =
			await setupOrganizationFixture("delete");
		// X 的其余从属数据：邀请、既有审计留痕
		await db.organizationInvitation.create({
			data: {
				organizationId: orgX.id,
				email: `invitee-${randomUUID()}@example.com`,
				role: "VIEWER",
				tokenHash: randomUUID(),
				invitedById: creator.id,
				expiresAt: NOW,
			},
		});
		await db.auditLog.createMany({
			data: ["organization.create", "plan.create", "settings.update"].map(
				(action) => ({
					organizationId: orgX.id,
					actorUserId: creator.id,
					actorType: "USER",
					action,
					result: "SUCCESS",
				}),
			),
		});
		const request = await createRequest({
			userId: creator.id,
			type: "DELETION",
			scope: "ORGANIZATION",
			organizationId: orgX.id,
		});
		const otherBefore = await readOrgRows([orgY.id]);

		const result = await runOrganizationRequest(request, orgX.id);
		expect(result.outcome).toBe("completed");
		expect(result.stats).toMatchObject({
			accounts: 1,
			plans: 1,
			usageLotAllocations: 1,
			aiConversations: 1,
			dataRequests: 2,
			invitations: 1,
			auditLogs: 3,
			memberships: 2,
			organizationSettings: 1,
			organizations: 1,
		});

		// 组织及其全部从属行消失（含裸外键子表随父删除）
		expect(await db.organization.findUnique({ where: { id: orgX.id } })).toBeNull();
		for (const [table, rows] of Object.entries(await readOrgRows([orgX.id]))) {
			expect(rows, table).toEqual([]);
		}
		expect(await db.organizationInvitation.count({ where: { organizationId: orgX.id } })).toBe(0);
		expect(await db.organizationSettings.count({ where: { organizationId: orgX.id } })).toBe(0);
		expect(await db.dataRequest.count({ where: { organizationId: orgX.id } })).toBe(0);

		// 不删任何成员 User：两位成员的账号都在；X 的成员关系随组织移除
		expect(await db.user.count({ where: { id: { in: [creator.id, admin.id] } } })).toBe(2);
		expect(await db.membership.count({ where: { organizationId: orgX.id } })).toBe(0);

		// 审计：既有 3 条留痕在删组织前统一清理，仅保留一条删除留痕（AUDIT-01：组织删除必须记录）
		const logs = await db.auditLog.findMany({ where: { organizationId: orgX.id } });
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			action: "organization.delete.execute",
			actorUserId: creator.id,
			actorType: "USER",
			result: "SUCCESS",
			targetType: "organization",
			targetId: orgX.id,
		});
		expect(logs[0]?.detail).toMatchObject({
			role: "OWNER",
			organizationName: "delete 被操作组织",
		});

		// 无关组织 Y 零变化
		expect(await readOrgRows([orgY.id])).toEqual(otherBefore);
	});

	it("冷静期内所有权已转移：发起人不再是 Owner → 到期不执行，组织与账本零变化并留 DENIED 审计", async () => {
		const { creator, admin, orgX, orgY } =
			await setupOrganizationFixture("delete-lapsed");
		const request = await createRequest({
			userId: creator.id,
			type: "DELETION",
			scope: "ORGANIZATION",
			organizationId: orgX.id,
		});
		const before = await readOrgRows([orgX.id, orgY.id]);
		await transferOwnership(orgX.id, creator.id, admin.id);

		const result = await runOrganizationRequest(request, orgX.id);
		expect(result.outcome).toBe("cancelled");

		const row = await db.dataRequest.findUniqueOrThrow({ where: { id: request.id } });
		expect(row.status).toBe("CANCELLED");
		expect(await db.organization.findUnique({ where: { id: orgX.id } })).not.toBeNull();
		expect(await db.membership.count({ where: { organizationId: orgX.id } })).toBe(2);
		expectOrganizationUntouched(
			before,
			await readOrgRows([orgX.id, orgY.id]),
			request.id,
			"所有权转移后",
		);
		const logs = await db.auditLog.findMany({
			where: { organizationId: orgX.id, action: "organization.delete.cancel" },
		});
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			actorUserId: creator.id,
			result: "DENIED",
			targetId: request.id,
			detail: { reason: "REQUESTER_NOT_AUTHORIZED" },
		});
	});

	it("发起人账号已被删除（requesterUserId=null）导致到期无资格作废时，仍记录系统/空操作者取消审计", async () => {
		const { creator, admin, orgX } = await setupOrganizationFixture("null-requester-cancel");
		const request = await createRequest({
			userId: creator.id,
			type: "DELETION",
			scope: "ORGANIZATION",
			organizationId: orgX.id,
		});
		// 模拟发起人转为 ADMIN 并被后续个人注销物理删除（requesterUserId 经 ON DELETE SET NULL 置空）
		await transferOwnership(orgX.id, creator.id, admin.id);
		await db.membership.deleteMany({ where: { userId: creator.id } });
		await db.user.delete({ where: { id: creator.id } });

		const result = await runOrganizationRequest(
			{ ...request, requesterUserId: null },
			orgX.id,
		);
		expect(result.outcome).toBe("cancelled");

		const logs = await db.auditLog.findMany({
			where: { organizationId: orgX.id, action: "organization.delete.cancel" },
		});
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			actorUserId: null,
			result: "DENIED",
			targetId: request.id,
			detail: { reason: "REQUESTER_NOT_AUTHORIZED" },
		});
	});
});

describe("零残留引用断言的覆盖面（schema 推导 ↔ 数据库目录）", () => {
	it("Prisma DMMF 推导出的 User 级联外键集合与 pg_constraint 中 ON DELETE CASCADE 指向 users 的单列外键逐项一致", async () => {
		const catalog = await db.$queryRaw<Array<{ table: string; column: string }>>`
			SELECT rel.relname AS "table", att.attname AS "column"
			FROM pg_constraint con
			JOIN pg_class rel ON rel.oid = con.conrelid
			JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
			WHERE con.contype = 'f'
				AND con.confrelid = to_regclass('users')
				AND con.confdeltype = 'c'
				AND cardinality(con.conkey) = 1`;
		const fromCatalog = catalog
			.map((foreignKey) => `${foreignKey.table}.${foreignKey.column}`)
			.sort();
		// 模型 / 字段名 → 物理表 / 列名（@@map / @map）
		const models = Prisma.dmmf.datamodel.models;
		const fromSchema = userReferencesFromSchema()
			.map((reference) => {
				const model = models.find((candidate) => candidate.name === reference.model);
				const field = model?.fields.find(
					(candidate) => candidate.name === reference.field,
				);
				return `${model?.dbName ?? model?.name}.${field?.dbName ?? field?.name}`;
			})
			.sort();

		// W30（MIG-E/F）后 6 张表对 users 为 ON DELETE CASCADE
		expect(fromCatalog).toHaveLength(6);
		expect(fromSchema).toEqual(fromCatalog);

		// W30（MIG-E/F）：8 张作者/发起人列为 ON DELETE SET NULL（confdeltype = 'n'），删用户不吞行
		const setNullCatalog = await db.$queryRaw<Array<{ table: string; column: string }>>`
			SELECT rel.relname AS "table", att.attname AS "column"
			FROM pg_constraint con
			JOIN pg_class rel ON rel.oid = con.conrelid
			JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
			WHERE con.contype = 'f'
				AND con.confrelid = to_regclass('users')
				AND con.confdeltype = 'n'
				AND cardinality(con.conkey) = 1`;
		expect(
			setNullCatalog.map((fk) => `${fk.table}.${fk.column}`).sort(),
		).toEqual([
			"accounts.created_by_id",
			"corrections.actor_user_id",
			"data_requests.requester_user_id",
			"initial_holdings.created_by_id",
			"plan_change_logs.actor_user_id",
			"plans.created_by_id",
			"transactions.created_by_id",
			"usage_records.created_by_id",
		]);
	});
});
