import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 关闭全局接口限流（与 plan.spec / audit.spec / ai-chat.spec 同一方案：APP_GUARD token 只能 mock 类）
vi.mock("@nestjs/throttler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nestjs/throttler")>();
	class NoopThrottlerGuard {
		async canActivate() {
			return true;
		}
	}
	return { ...actual, ThrottlerGuard: NoopThrottlerGuard };
});

import { AiAgentService } from "../../src/ai/ai-agent.service";
import {
	AI_RUNTIME_CONFIG,
	resolveAiRuntimeConfig,
} from "../../src/ai/llm/ai-runtime-config";
import { OTP_CHANNELS, OTP_OPTIONS } from "../../src/auth/otp/otp-channel";
import type { Permission } from "../../src/authorization/authorization.types";
import type { PrismaService } from "../../src/prisma/prisma.service";
import {
	RATE_PROVIDER_TIMEOUT_TOKEN,
	RateProvider,
} from "../../src/rate/rate.provider";
import {
	createCapturingEmailOtpChannel,
	type CapturingEmailOtpChannel,
} from "../helpers/capturing-email-otp-channel";
import { seedUsageRecord } from "../helpers/correction-fixture";
import { ensureOnboarded } from "../helpers/onboarding-helper";
import {
	cleanupOrgLedgers,
	createOrgLedger,
	orgHeaders,
	purchaseBody,
	seedOrgInitialHolding,
	type OrgLedger,
} from "../helpers/organization-ledger-test-helper";
import {
	PLAN_EXPECT_USE_DATE,
	PLAN_START_DATE,
} from "../helpers/plan-test-helper";
import { createRateSourceFetchStub } from "../helpers/rate-source-fixtures";
import {
	bearer,
	cleanupUser,
	createTestApp,
	createTestUser,
	mintAccessToken,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";
import { closeTestApps } from "../helpers/test-http";

/**
 * ToB R1 全量跨租户 API 参数化矩阵测试（Goal #3C W31-Part1；技术方案 §14.2）。
 *
 * 覆盖全部 16 个组织/业务控制器领域（account / plan / transaction / usage / correction /
 * report / reminder / settings / onboarding / home / organization / members / invitations /
 * audit / data-requests / ai）及个人/公共端点的跨租户隔离、权限边界与不变量：
 * 1. 无 Bearer token → 401
 * 2. 缺失/非法 X-Organization-Id → 400 ORGANIZATION_REQUIRED（含 W30 MIG-D 收口后单组织缺头 400 契约；个人/公共端点免头正常）
 * 3. 非成员组织 ID → 404 ORGANIZATION_NOT_FOUND
 * 4. DISABLED 成员 → 404 ORGANIZATION_NOT_FOUND（零业务数据泄露）
 * 5. VIEWER / OPERATOR / ADMIN / FINANCE 角色边界 → 403 PERMISSION_DENIED + DB 零变更 + AuditLog(DENIED)
 * 6. 跨组织记录 ID 探测（Org A 头 + Org B 记录 ID）→ 统一 404
 * 7. 成员降权即时生效（复用旧 JWT）→ 403 PERMISSION_DENIED（移除后 → 404）
 * 8. 最后 Owner 保护（自降/自移除/退出/个人注销）→ 409 LAST_OWNER_REQUIRED
 */

interface OrgFixture {
	orgId: string;
	owner: TestUser;
	admin: TestUser;
	finance: TestUser;
	operator: TestUser;
	viewer: TestUser;
	disabled: TestUser;
	dualMember: TestUser;
	ownerMembershipId: string;
	viewerMembershipId: string;
	planId: string;
	planUpdatedAt: string;
	transactionId: string;
	initialHoldingId: string;
	usageId: string;
	reminderId: string;
	invitationId: string;
	invitationToken: string;
	exportRequestId: string;
	clearRequestId: string;
	conversationId: string;
}

interface MatrixEndpoint {
	domain: string;
	label: string;
	method: "get" | "post" | "patch" | "delete";
	path: (fx: MatrixFixtures) => string;
	guardType: "business" | "strict";
	body?: (fx: MatrixFixtures) => Record<string, unknown>;
	/** 权限点（仅用于分类标注；null 表示无额外权限点要求） */
	permission: Permission | null;
	viewerDenied: boolean;
	operatorDenied: boolean;
	deniedAction?: string;
	/** DataRequestService.create/cancel 为异步 recordDeniedAuditBestEffort */
	asyncDeniedAudit?: boolean;
	/** 跨组织记录 ID 探测时的路径（带 X-Organization-Id: orgA.orgId） */
	crossOrgPath?: (fx: MatrixFixtures) => string;
	/** 跨组织记录 ID 探测时的请求体 */
	crossOrgBody?: (fx: MatrixFixtures) => Record<string, unknown>;
	/** 跨组织记录 ID 探测时的发起者（缺省 dualMember；owner.transfer 需 OWNER） */
	crossOrgActor?: (fx: MatrixFixtures) => TestUser;
	/** 仅在「携带有效消费凭证」下才触发权限校验的端点 */
	needsDataRequestChallenge?: "EXPORT" | "CLEAR" | "DELETION";
	/** SSE 流式端点（supertest buffer 需正常读完流） */
	isSse?: boolean;
}

interface MatrixFixtures {
	orgA: OrgFixture;
	orgB: OrgFixture;
	singleOrg: OrgFixture;
	outsider: TestUser;
}

const ZERO_TOTALS = {
	accounts: 0,
	transactions: 0,
	initialHoldings: 0,
	plans: 0,
	usageRecords: 0,
	corrections: 0,
} as const;

describe("Organization Cross-Tenant API Matrix (W31-Part1)", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let prisma: PrismaService;
	let otpChannel: CapturingEmailOtpChannel;
	let fx: MatrixFixtures;

	const trackedUsers: TestUser[] = [];
	const trackedOrgIds = new Set<string>();
	const trackedOrgLedgers: OrgLedger[] = [];

	const trackUser = (user: TestUser): TestUser => {
		trackedUsers.push(user);
		return user;
	};

	/** 直造已消费 OTP 凭证（绕开频控与发信，用于测试业务鉴权与 403/409 路径） */
	async function seedConsumedChallenge(
		email: string,
		purpose: "EXPORT" | "CLEAR" | "DELETION",
	): Promise<string> {
		const now = new Date();
		const row = await prisma.otpChallenge.create({
			data: {
				channel: "email",
				target: email.toLowerCase(),
				purpose,
				codeHash: `matrix-consumed-${randomUUID()}`,
				expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
				consumedAt: now,
			},
			select: { id: true },
		});
		return row.id;
	}

	/** 抓取组织维度的全表快照，用于 403 越权断言「数据库零变更」（含子表与 updatedAt/标量校验） */
	async function readOrgMutationSnapshot(orgId: string) {
		const [plans, transactions, usageRecords, reminders, aiConversations, memberships] =
			await Promise.all([
				prisma.plan.findMany({
					where: { organizationId: orgId },
					orderBy: { id: "asc" },
					select: {
						id: true,
						status: true,
						targetAmount: true,
						updatedAt: true,
					},
				}),
				prisma.transaction.findMany({
					where: { organizationId: orgId },
					orderBy: { id: "asc" },
					select: { id: true, version: true, updatedAt: true },
				}),
				prisma.usageRecord.findMany({
					where: { organizationId: orgId },
					orderBy: { id: "asc" },
					select: { id: true, version: true, amount: true, updatedAt: true },
				}),
				prisma.reminder.findMany({
					where: { organizationId: orgId },
					orderBy: { id: "asc" },
					select: { id: true, type: true, scheduledFor: true, updatedAt: true },
				}),
				prisma.aiConversation.findMany({
					where: { organizationId: orgId },
					orderBy: { id: "asc" },
					select: { id: true, title: true, lastMessageAt: true, updatedAt: true },
				}),
				prisma.membership.findMany({
					where: { organizationId: orgId },
					orderBy: { id: "asc" },
					select: { id: true, userId: true, role: true, status: true, updatedAt: true },
				}),
			]);

		const planIds = plans.map((p) => p.id);
		const usageIds = usageRecords.map((u) => u.id);
		const reminderIds = reminders.map((r) => r.id);
		const conversationIds = aiConversations.map((c) => c.id);
		const memberUserIds = [...new Set(memberships.map((m) => m.userId))].sort();

		const [
			org,
			orgSettings,
			accounts,
			initialHoldings,
			costLots,
			planAllocations,
			planInstallments,
			planChangeLogs,
			usageLotAllocations,
			corrections,
			reminderReads,
			invitations,
			dataRequests,
			aiMessages,
			userSettings,
			nonDeniedAuditLogs,
		] = await Promise.all([
			prisma.organization.findUnique({
				where: { id: orgId },
				select: { id: true, name: true, updatedAt: true },
			}),
			prisma.organizationSettings.findUnique({
				where: { organizationId: orgId },
				select: {
					baseCurrency: true,
					prepPreference: true,
					reminderEnabled: true,
					updatedAt: true,
				},
			}),
			prisma.account.findMany({
				where: { organizationId: orgId },
				orderBy: { currencyCode: "asc" },
				select: { id: true, currencyCode: true, balance: true, updatedAt: true },
			}),
			prisma.initialHolding.findMany({
				where: { organizationId: orgId },
				orderBy: { id: "asc" },
				select: { id: true, amount: true, updatedAt: true },
			}),
			prisma.costLot.findMany({
				where: { organizationId: orgId },
				orderBy: { id: "asc" },
				select: { id: true, remainingQty: true, updatedAt: true },
			}),
			planIds.length > 0
				? prisma.planAllocation.findMany({
						where: { planId: { in: planIds } },
						orderBy: { planId: "asc" },
						select: { planId: true, amount: true, usedAmount: true, updatedAt: true },
					})
				: Promise.resolve([]),
			planIds.length > 0
				? prisma.planInstallment.findMany({
						where: { planId: { in: planIds } },
						orderBy: [{ planId: "asc" }, { seq: "asc" }],
						select: { id: true, planId: true, seq: true, amount: true, scheduledAt: true },
					})
				: Promise.resolve([]),
			planIds.length > 0
				? prisma.planChangeLog.count({
						where: { planId: { in: planIds } },
					})
				: Promise.resolve(0),
			usageIds.length > 0
				? prisma.usageLotAllocation.findMany({
						where: { usageId: { in: usageIds } },
						orderBy: [{ usageId: "asc" }, { lotId: "asc" }],
						select: { id: true, usageId: true, lotId: true, quantity: true, cost: true, updatedAt: true },
					})
				: Promise.resolve([]),
			prisma.correction.findMany({
				where: { organizationId: orgId },
				orderBy: { id: "asc" },
				select: { id: true, status: true, updatedAt: true },
			}),
			reminderIds.length > 0
				? prisma.reminderRead.findMany({
						where: { reminderId: { in: reminderIds } },
						orderBy: [{ reminderId: "asc" }, { userId: "asc" }],
						select: { id: true, reminderId: true, userId: true, readAt: true },
					})
				: Promise.resolve([]),
			prisma.organizationInvitation.findMany({
				where: { organizationId: orgId },
				orderBy: { id: "asc" },
				select: {
					id: true,
					email: true,
					role: true,
					acceptedAt: true,
					declinedAt: true,
					revokedAt: true,
				},
			}),
			prisma.dataRequest.findMany({
				where: { organizationId: orgId },
				orderBy: { id: "asc" },
				select: { id: true, status: true, updatedAt: true },
			}),
			conversationIds.length > 0
				? prisma.aiMessage.findMany({
						where: { conversationId: { in: conversationIds } },
						orderBy: { id: "asc" },
						select: { id: true, conversationId: true, role: true, content: true },
					})
				: Promise.resolve([]),
			memberUserIds.length > 0
				? prisma.userSettings.findMany({
						where: { userId: { in: memberUserIds } },
						orderBy: { userId: "asc" },
						select: {
							userId: true,
							region: true,
							locale: true,
							updatedAt: true,
						},
					})
				: Promise.resolve([]),
			prisma.auditLog.findMany({
				where: { organizationId: orgId, result: { not: "DENIED" } },
				orderBy: { id: "asc" },
				select: { id: true, action: true, result: true },
			}),
		]);
		return {
			org,
			orgSettings,
			accounts: accounts.map((a) => ({
				id: a.id,
				currencyCode: a.currencyCode,
				balance: a.balance.toFixed(4),
				updatedAt: a.updatedAt,
			})),
			initialHoldings: initialHoldings.map((h) => ({
				id: h.id,
				amount: h.amount.toFixed(4),
				updatedAt: h.updatedAt,
			})),
			transactions,
			costLots: costLots.map((c) => ({
				id: c.id,
				remainingQty: c.remainingQty.toFixed(4),
				updatedAt: c.updatedAt,
			})),
			plans: plans.map((p) => ({
				id: p.id,
				status: p.status,
				targetAmount: p.targetAmount.toFixed(4),
				updatedAt: p.updatedAt,
			})),
			planAllocations: planAllocations.map((pa) => ({
				planId: pa.planId,
				amount: pa.amount.toFixed(4),
				usedAmount: pa.usedAmount.toFixed(4),
				updatedAt: pa.updatedAt,
			})),
			planInstallments: planInstallments.map((pi) => ({
				id: pi.id,
				planId: pi.planId,
				seq: pi.seq,
				amount: pi.amount.toFixed(4),
				scheduledAt: pi.scheduledAt,
			})),
			planChangeLogs,
			usageRecords: usageRecords.map((u) => ({
				id: u.id,
				version: u.version,
				amount: u.amount.toFixed(4),
				updatedAt: u.updatedAt,
			})),
			usageLotAllocations: usageLotAllocations.map((ula) => ({
				id: ula.id,
				usageId: ula.usageId,
				lotId: ula.lotId,
				quantity: ula.quantity.toFixed(4),
				cost: ula.cost.toFixed(4),
				updatedAt: ula.updatedAt,
			})),
			corrections,
			reminders,
			reminderReads,
			memberships,
			invitations,
			dataRequests,
			aiConversations,
			aiMessages,
			userSettings,
			nonDeniedAuditLogs,
		};
	}

	/** 构建一个已建账且含完整业务与组织记录的夹具组织 */
	async function seedFullOrgFixture(
		label: string,
		currencyCode: "USD" | "JPY",
		dualMember: TestUser,
	): Promise<OrgFixture> {
		const ledger = await createOrgLedger(app, prisma, label, [
			"ADMIN",
			"FINANCE",
			"OPERATOR",
			"VIEWER",
		]);
		trackedOrgLedgers.push(ledger);
		trackedOrgIds.add(ledger.orgId);

		const [admin, finance, operator, viewer] = ledger.members as [
			TestUser,
			TestUser,
			TestUser,
			TestUser,
		];
		const disabled = trackUser(await createTestUser(app, `${label}-disabled`));
		await prisma.membership.create({
			data: {
				organizationId: ledger.orgId,
				userId: disabled.userId,
				role: "FINANCE",
				status: "DISABLED",
			},
		});
		await prisma.membership.create({
			data: {
				organizationId: ledger.orgId,
				userId: dualMember.userId,
				role: "ADMIN",
				status: "ACTIVE",
			},
		});

		const ownerMembership = await prisma.membership.findUniqueOrThrow({
			where: {
				organizationId_userId: {
					organizationId: ledger.orgId,
					userId: ledger.owner.userId,
				},
			},
		});
		const viewerMembership = await prisma.membership.findUniqueOrThrow({
			where: {
				organizationId_userId: {
					organizationId: ledger.orgId,
					userId: viewer.userId,
				},
			},
		});

		const confirmedAt = new Date("2026-09-01T02:00:00.000Z");
		const initialAmount = currencyCode === "JPY" ? "20000" : "2000";
		const initialRate = currencyCode === "JPY" ? "0.0500" : "7.0000";
		const initialCost = currencyCode === "JPY" ? "1000.00" : "14000.00";

		const holding = await seedOrgInitialHolding(prisma, {
			organizationId: ledger.orgId,
			userId: ledger.owner.userId,
			currencyCode,
			amount: initialAmount,
			rate: initialRate,
			cost: initialCost,
			confirmedAt,
		});

		const txRes = await request(app.getHttpServer())
			.post("/api/transactions")
			.set(orgHeaders(ledger.owner, ledger.orgId))
			.send(
				purchaseBody(
					currencyCode,
					currencyCode === "JPY" ? "10000" : "1000",
					currencyCode === "JPY" ? "0.05" : "7.2",
					new Date("2026-09-02T02:00:00.000Z"),
				),
			)
			.expect(201);
		const transactionId = txRes.body.data.id as string;

		const planRes = await request(app.getHttpServer())
			.post("/api/plans")
			.set(orgHeaders(ledger.owner, ledger.orgId))
			.send({
				name: `${label}-plan`,
				targetCurrency: currencyCode,
				targetAmount: currencyCode === "JPY" ? "10000" : "1000",
				expectUseDate: PLAN_EXPECT_USE_DATE,
				prepLeadDays: 3,
				pacePreference: "balanced",
				startDate: PLAN_START_DATE,
				allocatedAmount: currencyCode === "JPY" ? "5000" : "500",
			})
			.expect(201);
		const planId = planRes.body.data.id as string;
		const planDetail = await request(app.getHttpServer())
			.get(`/api/plans/${planId}`)
			.set(orgHeaders(ledger.owner, ledger.orgId))
			.expect(200);
		const planUpdatedAt = planDetail.body.data.updatedAt as string;

		const lot = await prisma.costLot.findFirstOrThrow({
			where: { organizationId: ledger.orgId, sourceType: "INITIAL" },
		});
		const usageId = await prisma.$transaction(async (tx) => {
			return seedUsageRecord(tx, {
				userId: ledger.owner.userId,
				organizationId: ledger.orgId,
				planId,
				currencyCode,
				amount: currencyCode === "JPY" ? "100" : "10",
				usedAt: new Date("2026-09-03T02:00:00.000Z"),
				allocations: [
					{ lotId: lot.id, quantity: currencyCode === "JPY" ? "100" : "10" },
				],
			});
		});

		const reminder = await prisma.reminder.create({
			data: {
				organizationId: ledger.orgId,
				type: "PREP",
				planId,
				dedupKey: `MATRIX:${label}:${planId}`,
				scheduledFor: new Date("2026-09-04T00:00:00.000Z"),
			},
		});

		const inviteeEmail = `${label}-invitee-${randomUUID().slice(0, 6)}@example.com`;
		const invRes = await request(app.getHttpServer())
			.post("/api/organizations/current/invitations")
			.set(orgHeaders(ledger.owner, ledger.orgId))
			.send({ email: inviteeEmail, role: "VIEWER" })
			.expect(201);

		const exportRow = await prisma.dataRequest.create({
			data: {
				requesterUserId: dualMember.userId,
				scope: "ORGANIZATION",
				organizationId: ledger.orgId,
				type: "EXPORT",
				status: "COMPLETED",
				requestedAt: new Date(),
				dueAt: new Date(),
				processedAt: new Date(),
				downloadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
				verifiedChallengeId: await seedConsumedChallenge(
					dualMember.email,
					"EXPORT",
				),
			},
		});

		// 已取消历史 CLEAR 行：用于跨组织 ID 探测（不激活 orgA / orgB 的锁）
		const clearRow = await prisma.dataRequest.create({
			data: {
				requesterUserId: dualMember.userId,
				scope: "ORGANIZATION",
				organizationId: ledger.orgId,
				type: "CLEAR",
				status: "CANCELLED",
				requestedAt: new Date(),
				dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
				verifiedChallengeId: await seedConsumedChallenge(
					dualMember.email,
					"CLEAR",
				),
			},
		});

		const conv = await prisma.aiConversation.create({
			data: {
				userId: dualMember.userId,
				organizationId: ledger.orgId,
				title: `${label}-conv`,
				lastMessageAt: new Date(),
				messages: {
					create: [{ role: "user", content: "hello" }],
				},
			},
		});

		return {
			orgId: ledger.orgId,
			owner: ledger.owner,
			admin,
			finance,
			operator,
			viewer,
			disabled,
			dualMember,
			ownerMembershipId: ownerMembership.id,
			viewerMembershipId: viewerMembership.id,
			planId,
			planUpdatedAt,
			transactionId,
			initialHoldingId: holding.holdingId,
			usageId,
			reminderId: reminder.id,
			invitationId: invRes.body.data.id as string,
			invitationToken: invRes.body.data.token as string,
			exportRequestId: exportRow.id,
			clearRequestId: clearRow.id,
			conversationId: conv.id,
		};
	}

	/** 16 个领域全部组织/业务端点清单（零遗漏） */
	const MATRIX_ENDPOINTS: readonly MatrixEndpoint[] = [
		// 1. account (4)
		{
			domain: "account",
			label: "GET /api/accounts",
			method: "get",
			path: () => "/api/accounts",
			guardType: "business",
			permission: "account.read",
			viewerDenied: false,
			operatorDenied: false,
		},
		{
			domain: "account",
			label: "GET /api/accounts/:currencyCode",
			method: "get",
			path: () => "/api/accounts/USD",
			guardType: "business",
			permission: "account.read",
			viewerDenied: false,
			operatorDenied: false,
			crossOrgPath: () => "/api/accounts/JPY",
		},
		{
			domain: "account",
			label: "GET /api/accounts/:currencyCode/allocations",
			method: "get",
			path: () => "/api/accounts/USD/allocations",
			guardType: "business",
			permission: "account.read",
			viewerDenied: false,
			operatorDenied: false,
			crossOrgPath: () => "/api/accounts/JPY/allocations",
		},
		{
			domain: "account",
			label: "GET /api/accounts/:currencyCode/transactions",
			method: "get",
			path: () => "/api/accounts/USD/transactions",
			guardType: "business",
			permission: "account.read",
			viewerDenied: false,
			operatorDenied: false,
			crossOrgPath: () => "/api/accounts/JPY/transactions",
		},

		// 2. plan (8)
		{
			domain: "plan",
			label: "POST /api/plans/schedule-preview",
			method: "post",
			path: () => "/api/plans/schedule-preview",
			guardType: "business",
			body: () => ({
				targetCurrency: "USD",
				targetAmount: "1000",
				expectUseDate: PLAN_EXPECT_USE_DATE,
				prepLeadDays: 3,
				pacePreference: "balanced",
				startDate: PLAN_START_DATE,
			}),
			permission: "plan.create",
			viewerDenied: true,
			operatorDenied: false,
			deniedAction: "permission.denied.plan.create",
		},
		{
			domain: "plan",
			label: "POST /api/plans",
			method: "post",
			path: () => "/api/plans",
			guardType: "business",
			body: () => ({
				name: "matrix-denied-plan",
				targetCurrency: "USD",
				targetAmount: "1000",
				expectUseDate: PLAN_EXPECT_USE_DATE,
				prepLeadDays: 3,
				pacePreference: "balanced",
				startDate: PLAN_START_DATE,
			}),
			permission: "plan.create",
			viewerDenied: true,
			operatorDenied: false,
			deniedAction: "permission.denied.plan.create",
		},
		{
			domain: "plan",
			label: "GET /api/plans",
			method: "get",
			path: () => "/api/plans",
			guardType: "business",
			permission: "plan.read",
			viewerDenied: false,
			operatorDenied: false,
		},
		{
			domain: "plan",
			label: "GET /api/plans/:id",
			method: "get",
			path: (f) => `/api/plans/${f.orgA.planId}`,
			guardType: "business",
			permission: "plan.read",
			viewerDenied: false,
			operatorDenied: false,
			crossOrgPath: (f) => `/api/plans/${f.orgB.planId}`,
		},
		{
			domain: "plan",
			label: "POST /api/plans/:id/adjust-preview",
			method: "post",
			path: (f) => `/api/plans/${f.orgA.planId}/adjust-preview`,
			guardType: "business",
			body: () => ({ newTargetAmount: "1200" }),
			permission: "plan.adjust",
			viewerDenied: true,
			operatorDenied: false,
			deniedAction: "permission.denied.plan.adjust",
			crossOrgPath: (f) => `/api/plans/${f.orgB.planId}/adjust-preview`,
		},
		{
			domain: "plan",
			label: "PATCH /api/plans/:id",
			method: "patch",
			path: (f) => `/api/plans/${f.orgA.planId}`,
			guardType: "business",
			body: (f) => ({
				newTargetAmount: "1200",
				expectedUpdatedAt: f.orgA.planUpdatedAt,
			}),
			permission: "plan.adjust",
			viewerDenied: true,
			operatorDenied: false,
			deniedAction: "permission.denied.plan.adjust",
			crossOrgPath: (f) => `/api/plans/${f.orgB.planId}`,
			crossOrgBody: (f) => ({
				newTargetAmount: "1200",
				expectedUpdatedAt: f.orgB.planUpdatedAt,
			}),
		},
		{
			domain: "plan",
			label: "POST /api/plans/:id/complete",
			method: "post",
			path: (f) => `/api/plans/${f.orgA.planId}/complete`,
			guardType: "business",
			permission: "plan.adjust",
			viewerDenied: true,
			operatorDenied: false,
			deniedAction: "permission.denied.plan.adjust",
			crossOrgPath: (f) => `/api/plans/${f.orgB.planId}/complete`,
		},
		{
			domain: "plan",
			label: "POST /api/plans/:id/cancel",
			method: "post",
			path: (f) => `/api/plans/${f.orgA.planId}/cancel`,
			guardType: "business",
			permission: "plan.adjust",
			viewerDenied: true,
			operatorDenied: false,
			deniedAction: "permission.denied.plan.adjust",
			crossOrgPath: (f) => `/api/plans/${f.orgB.planId}/cancel`,
		},

		// 3. transaction (2)
		{
			domain: "transaction",
			label: "POST /api/transactions",
			method: "post",
			path: () => "/api/transactions",
			guardType: "business",
			body: () =>
				purchaseBody(
					"USD",
					"100",
					"7.2",
					new Date("2026-09-02T02:00:00.000Z"),
				),
			permission: "transaction.create",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.transaction.create",
			crossOrgPath: () => "/api/transactions",
			crossOrgBody: (f) => ({
				...purchaseBody(
					"JPY",
					"100",
					"0.05",
					new Date("2026-09-02T02:00:00.000Z"),
				),
				planId: f.orgB.planId,
			}),
		},
		{
			domain: "transaction",
			label: "GET /api/transactions/:id",
			method: "get",
			path: (f) => `/api/transactions/${f.orgA.transactionId}`,
			guardType: "business",
			permission: "transaction.read",
			viewerDenied: false,
			operatorDenied: false,
			crossOrgPath: (f) => `/api/transactions/${f.orgB.transactionId}`,
		},

		// 4. usage (2)
		{
			domain: "usage",
			label: "POST /api/plans/:id/usages",
			method: "post",
			path: (f) => `/api/plans/${f.orgA.planId}/usages`,
			guardType: "business",
			body: () => ({
				amount: "10",
				usedAt: "2026-09-03T00:00:00.000Z",
			}),
			permission: "usage.create",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.usage.create",
			crossOrgPath: (f) => `/api/plans/${f.orgB.planId}/usages`,
		},
		{
			domain: "usage",
			label: "GET /api/plans/:id/usages",
			method: "get",
			path: (f) => `/api/plans/${f.orgA.planId}/usages`,
			guardType: "business",
			permission: "usage.read",
			viewerDenied: false,
			operatorDenied: false,
			crossOrgPath: (f) => `/api/plans/${f.orgB.planId}/usages`,
		},

		// 5. correction (4)
		{
			domain: "correction",
			label: "POST /api/corrections/preview",
			method: "post",
			path: () => "/api/corrections/preview",
			guardType: "business",
			body: (f) => ({
				targetType: "TRANSACTION",
				targetId: f.orgA.transactionId,
				baseVersion: 1,
				reason: "matrix-preview",
				changes: { feeAmount: "12.00" },
			}),
			permission: "correction.preview",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.correction.preview",
			crossOrgPath: () => "/api/corrections/preview",
			crossOrgBody: (f) => ({
				targetType: "TRANSACTION",
				targetId: f.orgB.transactionId,
				baseVersion: 1,
				reason: "cross-org-probe",
				changes: { feeAmount: "12.00" },
			}),
		},
		{
			domain: "correction",
			label: "POST /api/corrections",
			method: "post",
			path: () => "/api/corrections",
			guardType: "business",
			body: (f) => ({
				targetType: "TRANSACTION",
				targetId: f.orgA.transactionId,
				baseVersion: 1,
				reason: "matrix-apply",
				changes: { feeAmount: "12.00" },
			}),
			permission: "correction.apply",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.correction.apply",
			crossOrgPath: () => "/api/corrections",
			crossOrgBody: (f) => ({
				targetType: "TRANSACTION",
				targetId: f.orgB.transactionId,
				baseVersion: 1,
				reason: "cross-org-probe",
				changes: { feeAmount: "12.00" },
			}),
		},
		{
			domain: "correction",
			label: "GET /api/corrections/target",
			method: "get",
			path: (f) =>
				`/api/corrections/target?targetType=TRANSACTION&targetId=${f.orgA.transactionId}`,
			guardType: "business",
			permission: "correction.read",
			viewerDenied: false,
			operatorDenied: false,
			crossOrgPath: (f) =>
				`/api/corrections/target?targetType=TRANSACTION&targetId=${f.orgB.transactionId}`,
		},
		{
			domain: "correction",
			label: "GET /api/corrections",
			method: "get",
			path: (f) =>
				`/api/corrections?targetType=TRANSACTION&targetId=${f.orgA.transactionId}`,
			guardType: "business",
			permission: "correction.read",
			viewerDenied: false,
			operatorDenied: false,
			crossOrgPath: (f) =>
				`/api/corrections?targetType=TRANSACTION&targetId=${f.orgB.transactionId}`,
		},

		// 6. report (2)
		{
			domain: "report",
			label: "GET /api/reports/plans",
			method: "get",
			path: () => "/api/reports/plans",
			guardType: "business",
			permission: "report.read",
			viewerDenied: false,
			operatorDenied: false,
		},
		{
			domain: "report",
			label: "GET /api/reports/plans/:id",
			method: "get",
			path: (f) => `/api/reports/plans/${f.orgA.planId}`,
			guardType: "business",
			permission: "report.read",
			viewerDenied: false,
			operatorDenied: false,
			crossOrgPath: (f) => `/api/reports/plans/${f.orgB.planId}`,
		},

		// 7. reminder (3)
		{
			domain: "reminder",
			label: "GET /api/reminders",
			method: "get",
			path: () => "/api/reminders",
			guardType: "business",
			permission: "plan.read",
			viewerDenied: false,
			operatorDenied: false,
		},
		{
			domain: "reminder",
			label: "POST /api/reminders/:id/read",
			method: "post",
			path: (f) => `/api/reminders/${f.orgA.reminderId}/read`,
			guardType: "business",
			permission: "plan.read",
			viewerDenied: false,
			operatorDenied: false,
			crossOrgPath: (f) => `/api/reminders/${f.orgB.reminderId}/read`,
		},
		{
			domain: "reminder",
			label: "POST /api/reminders/read-all",
			method: "post",
			path: () => "/api/reminders/read-all",
			guardType: "business",
			permission: "plan.read",
			viewerDenied: false,
			operatorDenied: false,
		},

		// 8. settings (2 org)
		{
			domain: "settings",
			label: "GET /api/settings",
			method: "get",
			path: () => "/api/settings",
			guardType: "business",
			permission: "settings.read",
			viewerDenied: false,
			operatorDenied: false,
		},
		{
			domain: "settings",
			label: "PATCH /api/settings",
			method: "patch",
			path: () => "/api/settings",
			guardType: "business",
			body: () => ({ prepPreference: "cautious" }),
			permission: "settings.update",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.settings.update",
		},

		// 9. onboarding (3 org)
		{
			domain: "onboarding",
			label: "GET /api/onboarding/status",
			method: "get",
			path: () => "/api/onboarding/status",
			guardType: "business",
			permission: "settings.read",
			viewerDenied: false,
			operatorDenied: false,
		},
		{
			domain: "onboarding",
			label: "POST /api/onboarding/complete",
			method: "post",
			path: () => "/api/onboarding/complete",
			guardType: "business",
			body: () => ({
				region: "CN",
				locale: "zh-CN",
				baseCurrency: "CNY",
			}),
			permission: "settings.update",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.settings.update",
		},
		{
			domain: "onboarding",
			label: "POST /api/onboarding/initial-holdings",
			method: "post",
			path: () => "/api/onboarding/initial-holdings",
			guardType: "business",
			body: () => ({
				holdings: [{ currencyCode: "EUR", amount: "100.00" }],
			}),
			permission: "settings.update",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.settings.update",
		},

		// 10. home (2)
		{
			domain: "home",
			label: "GET /api/home/state",
			method: "get",
			path: () => "/api/home/state",
			guardType: "business",
			permission: "account.read",
			viewerDenied: false,
			operatorDenied: false,
		},
		{
			domain: "home",
			label: "GET /api/home/portfolio",
			method: "get",
			path: () => "/api/home/portfolio",
			guardType: "business",
			permission: "account.read",
			viewerDenied: false,
			operatorDenied: false,
		},

		// 11. organization (3 org)
		{
			domain: "organization",
			label: "GET /api/organizations/current",
			method: "get",
			path: () => "/api/organizations/current",
			guardType: "strict",
			permission: "organization.read",
			viewerDenied: false,
			operatorDenied: false,
		},
		{
			domain: "organization",
			label: "PATCH /api/organizations/current",
			method: "patch",
			path: () => "/api/organizations/current",
			guardType: "strict",
			body: () => ({ name: "不应该改成功" }),
			permission: "organization.update",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.organization.update",
		},
		{
			domain: "organization",
			label: "DELETE /api/organizations/current",
			method: "delete",
			path: () => "/api/organizations/current",
			guardType: "strict",
			body: () => ({ challengeId: "dummy-challenge-id" }),
			permission: "organization.delete",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.organization.delete",
		},

		// 12. members (5)
		{
			domain: "members",
			label: "GET /api/organizations/current/members",
			method: "get",
			path: () => "/api/organizations/current/members",
			guardType: "strict",
			permission: "member.read",
			viewerDenied: false,
			operatorDenied: false,
		},
		{
			domain: "members",
			label: "PATCH /api/organizations/current/members/:id",
			method: "patch",
			path: (f) =>
				`/api/organizations/current/members/${f.orgA.viewerMembershipId}`,
			guardType: "strict",
			body: () => ({ role: "FINANCE" }),
			permission: "member.update",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.member.update",
			crossOrgPath: (f) =>
				`/api/organizations/current/members/${f.orgB.ownerMembershipId}`,
		},
		{
			domain: "members",
			label: "DELETE /api/organizations/current/members/:id",
			method: "delete",
			path: (f) =>
				`/api/organizations/current/members/${f.orgA.viewerMembershipId}`,
			guardType: "strict",
			permission: "member.remove",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.member.remove",
			crossOrgPath: (f) =>
				`/api/organizations/current/members/${f.orgB.ownerMembershipId}`,
		},
		{
			domain: "members",
			label: "POST /api/organizations/current/members/leave",
			method: "post",
			path: () => "/api/organizations/current/members/leave",
			guardType: "strict",
			permission: "member.read",
			viewerDenied: false,
			operatorDenied: false,
		},
		{
			domain: "members",
			label: "POST /api/organizations/current/transfer-ownership",
			method: "post",
			path: () => "/api/organizations/current/transfer-ownership",
			guardType: "strict",
			body: (f) => ({ targetMembershipId: f.orgA.viewerMembershipId }),
			permission: "owner.transfer",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.owner.transfer",
			crossOrgPath: () => "/api/organizations/current/transfer-ownership",
			crossOrgBody: (f) => ({ targetMembershipId: f.orgB.ownerMembershipId }),
			crossOrgActor: (f) => f.orgA.owner,
		},

		// 13. invitations (3 org)
		{
			domain: "invitations",
			label: "POST /api/organizations/current/invitations",
			method: "post",
			path: () => "/api/organizations/current/invitations",
			guardType: "strict",
			body: () => ({ email: "denied-invite@example.com", role: "VIEWER" }),
			permission: "member.invite",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.member.invite",
		},
		{
			domain: "invitations",
			label: "GET /api/organizations/current/invitations",
			method: "get",
			path: () => "/api/organizations/current/invitations",
			guardType: "strict",
			permission: "member.read",
			viewerDenied: false,
			operatorDenied: false,
		},
		{
			domain: "invitations",
			label: "DELETE /api/organizations/current/invitations/:id",
			method: "delete",
			path: (f) =>
				`/api/organizations/current/invitations/${f.orgA.invitationId}`,
			guardType: "strict",
			permission: "member.invite",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.member.invite",
			crossOrgPath: (f) =>
				`/api/organizations/current/invitations/${f.orgB.invitationId}`,
		},

		// 14. audit (1)
		{
			domain: "audit",
			label: "GET /api/organizations/current/audit-logs",
			method: "get",
			path: () => "/api/organizations/current/audit-logs",
			guardType: "strict",
			permission: "audit.read",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.audit.read",
		},

		// 15. data-requests (6 org)
		{
			domain: "data-requests",
			label: "GET /api/organizations/current/data-requests/current",
			method: "get",
			path: () => "/api/organizations/current/data-requests/current",
			guardType: "strict",
			permission: "organization.read",
			viewerDenied: false,
			operatorDenied: false,
		},
		{
			domain: "data-requests",
			label: "GET /api/organizations/current/data-requests/impact",
			method: "get",
			path: () => "/api/organizations/current/data-requests/impact",
			guardType: "strict",
			permission: "data.clear",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.data.clear",
		},
		{
			domain: "data-requests",
			label: "POST /api/organizations/current/data-requests/verify",
			method: "post",
			path: () => "/api/organizations/current/data-requests/verify",
			guardType: "strict",
			body: () => ({
				challengeId: "dummy-challenge",
				code: "123456",
				purpose: "EXPORT",
			}),
			permission: null,
			viewerDenied: false,
			operatorDenied: false,
		},
		{
			domain: "data-requests",
			label: "POST /api/organizations/current/data-requests (EXPORT)",
			method: "post",
			path: () => "/api/organizations/current/data-requests",
			guardType: "strict",
			permission: "data.export",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.data.export",
			asyncDeniedAudit: true,
			needsDataRequestChallenge: "EXPORT",
		},
		{
			domain: "data-requests",
			label: "POST /api/organizations/current/data-requests/:id/cancel",
			method: "post",
			path: (f) =>
				`/api/organizations/current/data-requests/${f.orgA.clearRequestId}/cancel`,
			guardType: "strict",
			body: () => ({}),
			permission: null,
			// 403 cancel 需目标为 PENDING 且由本人发起，见专项用例
			viewerDenied: false,
			operatorDenied: false,
			crossOrgPath: (f) =>
				`/api/organizations/current/data-requests/${f.orgB.clearRequestId}/cancel`,
		},
		{
			domain: "data-requests",
			label: "GET /api/organizations/current/data-requests/:id/download",
			method: "get",
			path: (f) =>
				`/api/organizations/current/data-requests/${f.orgA.exportRequestId}/download`,
			guardType: "strict",
			permission: "data.export",
			viewerDenied: true,
			operatorDenied: true,
			deniedAction: "permission.denied.data.export",
			crossOrgPath: (f) =>
				`/api/organizations/current/data-requests/${f.orgB.exportRequestId}/download`,
		},

		// 16. ai (5 org)
		{
			domain: "ai",
			label: "GET /api/ai/conversations",
			method: "get",
			path: () => "/api/ai/conversations",
			guardType: "business",
			permission: "agent.use",
			viewerDenied: false,
			operatorDenied: false,
		},
		{
			domain: "ai",
			label: "POST /api/ai/conversations",
			method: "post",
			path: () => "/api/ai/conversations",
			guardType: "business",
			body: () => ({ content: "现在美元汇率如何？" }),
			permission: "agent.use",
			viewerDenied: false,
			operatorDenied: false,
			isSse: true,
		},
		{
			domain: "ai",
			label: "POST /api/ai/conversations/:id/messages",
			method: "post",
			path: (f) => `/api/ai/conversations/${f.orgA.conversationId}/messages`,
			guardType: "business",
			body: () => ({ content: "继续分析" }),
			permission: "agent.use",
			viewerDenied: false,
			operatorDenied: false,
			crossOrgPath: (f) =>
				`/api/ai/conversations/${f.orgB.conversationId}/messages`,
			isSse: true,
		},
		{
			domain: "ai",
			label: "GET /api/ai/conversations/:id/messages",
			method: "get",
			path: (f) => `/api/ai/conversations/${f.orgA.conversationId}/messages`,
			guardType: "business",
			permission: "agent.use",
			viewerDenied: false,
			operatorDenied: false,
			crossOrgPath: (f) =>
				`/api/ai/conversations/${f.orgB.conversationId}/messages`,
		},
		{
			domain: "ai",
			label: "DELETE /api/ai/conversations/:id",
			method: "delete",
			path: (f) => `/api/ai/conversations/${f.orgA.conversationId}`,
			guardType: "business",
			permission: "agent.use",
			viewerDenied: false,
			operatorDenied: false,
			crossOrgPath: (f) => `/api/ai/conversations/${f.orgB.conversationId}`,
		},
	];

	function sendRequest(
		method: "get" | "post" | "patch" | "delete",
		path: string,
		headers: Record<string, string>,
		body?: Record<string, unknown>,
	) {
		const req = request(app.getHttpServer())[method](path).set(headers);
		if (body !== undefined) {
			return req.send(body);
		}
		return req;
	}

	beforeAll(async () => {
		otpChannel = createCapturingEmailOtpChannel();
		const rateFetchStub = createRateSourceFetchStub();
		ctx = await createTestApp((builder) =>
			builder
				.overrideProvider(OTP_CHANNELS)
				.useValue([otpChannel])
				.overrideProvider(OTP_OPTIONS)
				.useValue({
					targetMaxRequests: 100,
					ipMaxRequests: 100,
					sendMaxPerHour: 1000,
					sendMaxPerDay: 1000,
				})
				.overrideProvider(AI_RUNTIME_CONFIG)
				.useValue(
					resolveAiRuntimeConfig({
						...process.env,
						AI_PROVIDER_AIGYSD_API_KEY: "matrix-fixture-key-not-real",
						AI_CHAT_ENABLED: "true",
					}),
				)
				.overrideProvider(AiAgentService)
				.useValue({
					async *streamReply() {
						yield {
							type: "done",
							content: "ok",
							usage: { inputTokens: 1, outputTokens: 1 },
							model: "gpt-4.1-mini",
						};
					},
				})
				.overrideProvider(RateProvider)
				.useFactory({
					factory: (timeoutMs: number) =>
						new RateProvider(
							timeoutMs,
							rateFetchStub as unknown as typeof fetch,
						),
					inject: [RATE_PROVIDER_TIMEOUT_TOKEN],
				}),
		);
		app = ctx.app;
		prisma = ctx.prisma;

		const dualMember = trackUser(
			await createTestUser(app, "matrix-dual-member"),
		);
		const outsider = trackUser(await createTestUser(app, "matrix-outsider"));
		await ensureOnboarded(prisma, outsider.userId);

		const orgA = await seedFullOrgFixture("matrix-a", "USD", dualMember);
		const orgB = await seedFullOrgFixture("matrix-b", "JPY", dualMember);
		const singleOrg = await seedFullOrgFixture("matrix-single", "USD", dualMember);
		fx = { orgA, orgB, singleOrg, outsider };
	});

	afterAll(async () => {
		try {
			const allOrgIds = new Set<string>([
				...trackedOrgIds,
				...trackedOrgLedgers.map((l) => l.orgId),
			]);
			const allUserIds = new Set<string>([
				...trackedUsers.map((u) => u.userId),
				...trackedOrgLedgers.flatMap((l) => l.users.map((u) => u.userId)),
			]);
			const allEmails = [
				...trackedUsers.map((u) => u.email.toLowerCase()),
				...trackedOrgLedgers.flatMap((l) =>
					l.users.map((u) => u.email.toLowerCase()),
				),
			];

			// 清理组织关联的 DataRequest（含本地导出压缩包）、AiConversation、Reminder、Invitation、AuditLog、Membership
			if (allOrgIds.size > 0 || allUserIds.size > 0) {
				const drWhere = {
					OR: [
						...(allOrgIds.size > 0
							? [{ organizationId: { in: [...allOrgIds] } }]
							: []),
						...(allUserIds.size > 0
							? [{ requesterUserId: { in: [...allUserIds] } }]
							: []),
					],
				};
				const exportRows = await prisma.dataRequest.findMany({
					where: { ...drWhere, fileUrl: { not: null } },
					select: { fileUrl: true },
				});
				const exportDir =
					process.env.DATA_EXPORT_DIR ?? join(process.cwd(), "data-exports");
				for (const row of exportRows) {
					if (row.fileUrl) {
						await rm(join(exportDir, row.fileUrl), { force: true }).catch(
							() => undefined,
						);
					}
				}
				await prisma.dataRequest.deleteMany({
					where: drWhere,
				});
				await prisma.aiConversation.deleteMany({
					where: {
						OR: [
							...(allOrgIds.size > 0
								? [{ organizationId: { in: [...allOrgIds] } }]
								: []),
							...(allUserIds.size > 0
								? [{ userId: { in: [...allUserIds] } }]
								: []),
						],
					},
				});
				await prisma.reminderRead.deleteMany({
					where: {
						OR: [
							...(allUserIds.size > 0
								? [{ userId: { in: [...allUserIds] } }]
								: []),
							...(allOrgIds.size > 0
								? [{ reminder: { organizationId: { in: [...allOrgIds] } } }]
								: []),
						],
					},
				});
				if (allOrgIds.size > 0) {
					await prisma.reminder.deleteMany({
						where: { organizationId: { in: [...allOrgIds] } },
					});
				}
				if (allOrgIds.size > 0) {
					await prisma.organizationInvitation.deleteMany({
						where: { organizationId: { in: [...allOrgIds] } },
					});
					await prisma.organizationSettings.deleteMany({
						where: { organizationId: { in: [...allOrgIds] } },
					});
				}
			}
			if (allEmails.length > 0) {
				await prisma.otpChallenge.deleteMany({
					where: { target: { in: allEmails } },
				});
			}

			// 清理账本与基础组织成员/用户（确保 0 孤儿组织）
			if (trackedOrgLedgers.length > 0) {
				await cleanupOrgLedgers(prisma, ...trackedOrgLedgers);
			}
			for (const orgId of trackedOrgIds) {
				await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
				await prisma.membership.deleteMany({ where: { organizationId: orgId } });
				await prisma.organization.deleteMany({ where: { id: orgId } });
			}
			for (const user of [...trackedUsers].reverse()) {
				await cleanupUser(prisma, user.userId);
			}
		} finally {
			await closeTestApps(app);
		}
	});

	// ─────────────────── 1. 无 Bearer token → 401 ───────────────────

	describe("1. 无 Bearer token → 401", () => {
		it.each(MATRIX_ENDPOINTS)(
			"$domain | $label → 401",
			async (ep) => {
				const res = await sendRequest(
					ep.method,
					ep.path(fx),
					{ "X-Organization-Id": fx.orgA.orgId },
					ep.body?.(fx),
				);
				expect(res.status).toBe(401);
			},
		);
	});

	// ─────────────────── 2. 缺头 / 非法头 → 400 ORGANIZATION_REQUIRED；个人/公共端点免头 ───────────────────

	describe("2a. 非法格式 X-Organization-Id → 400 ORGANIZATION_REQUIRED", () => {
		it.each(MATRIX_ENDPOINTS)(
			"$domain | $label（非法头）→ 400 ORGANIZATION_REQUIRED",
			async (ep) => {
				const res = await sendRequest(
					ep.method,
					ep.path(fx),
					{
						...bearer(fx.orgA.owner.accessToken),
						"X-Organization-Id": "not-a-valid-cuid",
					},
					ep.body?.(fx),
				);
				expect(res.status).toBe(400);
				expect(res.body.code).toBe("ORGANIZATION_REQUIRED");
			},
		);
	});

	describe("2b. 多组织成员缺失 X-Organization-Id → 400 ORGANIZATION_REQUIRED", () => {
		it.each(MATRIX_ENDPOINTS)(
			"$domain | $label（多组织缺头）→ 400 ORGANIZATION_REQUIRED",
			async (ep) => {
				const res = await sendRequest(
					ep.method,
					ep.path(fx),
					bearer(fx.orgA.dualMember.accessToken),
					ep.body?.(fx),
				);
				expect(res.status).toBe(400);
				expect(res.body.code).toBe("ORGANIZATION_REQUIRED");
			},
		);
	});

	describe("2c. 单组织成员缺失 X-Organization-Id → 400 ORGANIZATION_REQUIRED（W30 MIG-D 后全量要求）", () => {
		it.each(MATRIX_ENDPOINTS)(
			"$domain | $label（单组织缺头）→ 400 ORGANIZATION_REQUIRED",
			async (ep) => {
				// 使用独立单组织用户 singleOrg.owner（仅有 1 个 ACTIVE 组织），防止 W29 兼容窗口下
				// 业务端点回落修改 orgA 夹具数据
				const singleFx: MatrixFixtures = {
					...fx,
					orgA: fx.singleOrg,
				};
				const res = await sendRequest(
					ep.method,
					ep.path(singleFx),
					bearer(fx.singleOrg.owner.accessToken),
					ep.body?.(singleFx),
				);
				expect(res.status).toBe(400);
				expect(res.body.code).toBe("ORGANIZATION_REQUIRED");
			},
		);
	});

	describe("2d. 个人与公共端点无 X-Organization-Id 保持合法语义", () => {
		it("个人与公共端点不依赖 X-Organization-Id 即可正常响应", async () => {
			const orgList = await request(app.getHttpServer())
				.get("/api/organizations")
				.set(bearer(fx.outsider.accessToken))
				.expect(200);
			expect(Array.isArray(orgList.body.data)).toBe(true);

			const createdOrg = await request(app.getHttpServer())
				.post("/api/organizations")
				.set(bearer(fx.outsider.accessToken))
				.send({ name: "个人端免头临时组织" })
				.expect(201);
			trackedOrgIds.add(createdOrg.body.data.id as string);

			await request(app.getHttpServer())
				.get("/api/settings/personal")
				.set(bearer(fx.orgA.owner.accessToken))
				.expect(200);

			await request(app.getHttpServer())
				.patch("/api/settings/personal")
				.set(bearer(fx.orgA.owner.accessToken))
				.send({ locale: "zh-CN" })
				.expect(200);

			await request(app.getHttpServer())
				.post("/api/onboarding/consents")
				.set(bearer(fx.orgA.owner.accessToken))
				.send({ age18Confirmed: true, termsConfirmed: true })
				.expect(201);

			await request(app.getHttpServer())
				.get("/api/data-requests/current")
				.set(bearer(fx.orgA.owner.accessToken))
				.expect(200);

			await request(app.getHttpServer())
				.get("/api/ai/models")
				.set(bearer(fx.orgA.owner.accessToken))
				.expect(200);

			await request(app.getHttpServer())
				.get("/api/auth/me")
				.set(bearer(fx.orgA.owner.accessToken))
				.expect(200);

			await request(app.getHttpServer())
				.get("/api/currencies")
				.expect(200);

			await request(app.getHttpServer())
				.get("/api/rates/supported")
				.expect(200);

			await request(app.getHttpServer())
				.get("/api/health")
				.expect(200);

			// 邀请个人端点：持合法受邀 token 不带组织头可摘要 / 接受 / 拒绝
			const invRes = await request(app.getHttpServer())
				.get(`/api/organization-invitations/${fx.orgA.invitationToken}`)
				.set(bearer(fx.outsider.accessToken));
			// 受邀邮箱与 outsider 不一致 → 403 INVITATION_EMAIL_MISMATCH（非 400 ORGANIZATION_REQUIRED）
			expect(invRes.status).toBe(403);
			expect(invRes.body.code).toBe("INVITATION_EMAIL_MISMATCH");

			const invSubOrg = await createOrgLedger(app, prisma, "matrix-2d-inv");
			trackedOrgLedgers.push(invSubOrg);
			trackedOrgIds.add(invSubOrg.orgId);

			const acceptInvitee = trackUser(
				await createTestUser(app, "matrix-2d-accept"),
			);
			const declineInvitee = trackUser(
				await createTestUser(app, "matrix-2d-decline"),
			);

			const acceptInv = await request(app.getHttpServer())
				.post("/api/organizations/current/invitations")
				.set(orgHeaders(invSubOrg.owner, invSubOrg.orgId))
				.send({ email: acceptInvitee.email, role: "VIEWER" })
				.expect(201);
			const declineInv = await request(app.getHttpServer())
				.post("/api/organizations/current/invitations")
				.set(orgHeaders(invSubOrg.owner, invSubOrg.orgId))
				.send({ email: declineInvitee.email, role: "VIEWER" })
				.expect(201);

			await request(app.getHttpServer())
				.post(
					`/api/organization-invitations/${acceptInv.body.data.token as string}/accept`,
				)
				.set(bearer(acceptInvitee.accessToken))
				.expect(200);

			await request(app.getHttpServer())
				.post(
					`/api/organization-invitations/${declineInv.body.data.token as string}/decline`,
				)
				.set(bearer(declineInvitee.accessToken))
				.expect(200);

			// 个人域数据请求端点：verify / create(EXPORT) / download / cancel 均不带组织头正常响应
			const personalUser = trackUser(
				await createTestUser(app, "matrix-2d-dr"),
			);
			const sendExport = await request(app.getHttpServer())
				.post("/api/auth/otp/send-code")
				.send({
					channel: "email",
					target: personalUser.email,
					purpose: "EXPORT",
				})
				.expect(200);
			const exportCode = otpChannel.lastCode();
			expect(exportCode).toBeDefined();

			const verifiedExport = await request(app.getHttpServer())
				.post("/api/data-requests/verify")
				.set(bearer(personalUser.accessToken))
				.send({
					challengeId: sendExport.body.data.challengeId,
					code: exportCode,
					purpose: "EXPORT",
				})
				.expect(200);

			const createdExport = await request(app.getHttpServer())
				.post("/api/data-requests")
				.set(bearer(personalUser.accessToken))
				.send({
					scope: "PERSONAL",
					type: "EXPORT",
					challengeId: verifiedExport.body.data.challengeId,
				})
				.expect(200);
			const exportId = createdExport.body.data.id as string;

			const downloadRes = await request(app.getHttpServer())
				.get(`/api/data-requests/${exportId}/download`)
				.set(bearer(personalUser.accessToken))
				.expect(200);
			expect(downloadRes.headers["content-type"]).toContain("application/zip");

			const pendingPersonalDeletion = await prisma.dataRequest.create({
				data: {
					requesterUserId: personalUser.userId,
					scope: "PERSONAL",
					organizationId: null,
					type: "DELETION",
					status: "PENDING",
					requestedAt: new Date(),
					dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
					verifiedChallengeId: await seedConsumedChallenge(
						personalUser.email,
						"DELETION",
					),
				},
			});
			const cancelChallengeId = await seedConsumedChallenge(
				personalUser.email,
				"DELETION",
			);
			const cancelRes = await request(app.getHttpServer())
				.post(`/api/data-requests/${pendingPersonalDeletion.id}/cancel`)
				.set(bearer(personalUser.accessToken))
				.send({ challengeId: cancelChallengeId })
				.expect(200);
			expect(cancelRes.body.data.status).toBe("CANCELLED");
		});
	});

	// ─────────────────── 3. 非成员组织 ID → 404 ORGANIZATION_NOT_FOUND ───────────────────

	describe("3. 非成员组织 ID（合法 Org B cuid）→ 404 ORGANIZATION_NOT_FOUND", () => {
		it.each(MATRIX_ENDPOINTS)(
			"$domain | $label → 404 ORGANIZATION_NOT_FOUND",
			async (ep) => {
				const res = await sendRequest(
					ep.method,
					ep.path(fx),
					orgHeaders(fx.orgA.owner, fx.orgB.orgId),
					ep.body?.(fx),
				);
				expect(res.status).toBe(404);
				expect(res.body.code).toBe("ORGANIZATION_NOT_FOUND");
			},
		);
	});

	// ─────────────────── 4. DISABLED 成员 → 404 ORGANIZATION_NOT_FOUND ───────────────────

	describe("4. DISABLED 成员 → 404 ORGANIZATION_NOT_FOUND（零数据泄露）", () => {
		it.each(MATRIX_ENDPOINTS)(
			"$domain | $label → 404 ORGANIZATION_NOT_FOUND",
			async (ep) => {
				const res = await sendRequest(
					ep.method,
					ep.path(fx),
					orgHeaders(fx.orgA.disabled, fx.orgA.orgId),
					ep.body?.(fx),
				);
				expect(res.status).toBe(404);
				expect(res.body.code).toBe("ORGANIZATION_NOT_FOUND");
			},
		);
	});

	// ─────────────────── 5. 角色权限边界 → 403 PERMISSION_DENIED + DB 零变更 + AuditLog(DENIED) ───────────────────

	describe("5a. VIEWER 越权写/审计/导出端点 → 403 + DB 零变更 + DENIED 审计", () => {
		const viewerDeniedEndpoints = MATRIX_ENDPOINTS.filter(
			(ep) => ep.viewerDenied,
		);

		it.each(viewerDeniedEndpoints)(
			"$domain | $label (VIEWER) → 403 PERMISSION_DENIED + 0 DB mutation + AuditLog(DENIED)",
			async (ep) => {
				const requestId = `matrix-v-${randomUUID()}`;
				const body = ep.needsDataRequestChallenge
					? {
							type: ep.needsDataRequestChallenge,
							scope: "ORGANIZATION",
							challengeId: await seedConsumedChallenge(
								fx.orgA.viewer.email,
								ep.needsDataRequestChallenge,
							),
						}
					: ep.body?.(fx);

				const before = await readOrgMutationSnapshot(fx.orgA.orgId);
				const res = await sendRequest(
					ep.method,
					ep.path(fx),
					orgHeaders(fx.orgA.viewer, fx.orgA.orgId, requestId),
					body,
				);
				expect(res.status).toBe(403);
				expect(res.body.code).toBe("PERMISSION_DENIED");

				const after = await readOrgMutationSnapshot(fx.orgA.orgId);
				expect(after).toEqual(before);

				const checkAudit = async () =>
					prisma.auditLog.findFirst({
						where: {
							organizationId: fx.orgA.orgId,
							actorUserId: fx.orgA.viewer.userId,
							action: ep.deniedAction!,
							result: "DENIED",
							...(ep.asyncDeniedAudit ? {} : { requestId }),
						},
					});

				if (ep.asyncDeniedAudit) {
					await vi.waitFor(async () => {
						expect(await checkAudit()).not.toBeNull();
					});
				} else {
					expect(await checkAudit()).not.toBeNull();
				}
			},
		);
	});

	describe("5b. OPERATOR 越权记账/使用/更正/审计/导出/组织管理端点 → 403 + DB 零变更 + DENIED 审计", () => {
		const operatorDeniedEndpoints = MATRIX_ENDPOINTS.filter(
			(ep) => ep.operatorDenied,
		);

		it.each(operatorDeniedEndpoints)(
			"$domain | $label (OPERATOR) → 403 PERMISSION_DENIED + 0 DB mutation + AuditLog(DENIED)",
			async (ep) => {
				const requestId = `matrix-o-${randomUUID()}`;
				const body = ep.needsDataRequestChallenge
					? {
							type: ep.needsDataRequestChallenge,
							scope: "ORGANIZATION",
							challengeId: await seedConsumedChallenge(
								fx.orgA.operator.email,
								ep.needsDataRequestChallenge,
							),
						}
					: ep.body?.(fx);

				const before = await readOrgMutationSnapshot(fx.orgA.orgId);
				const res = await sendRequest(
					ep.method,
					ep.path(fx),
					orgHeaders(fx.orgA.operator, fx.orgA.orgId, requestId),
					body,
				);
				expect(res.status).toBe(403);
				expect(res.body.code).toBe("PERMISSION_DENIED");

				const after = await readOrgMutationSnapshot(fx.orgA.orgId);
				expect(after).toEqual(before);

				const checkAudit = async () =>
					prisma.auditLog.findFirst({
						where: {
							organizationId: fx.orgA.orgId,
							actorUserId: fx.orgA.operator.userId,
							action: ep.deniedAction!,
							result: "DENIED",
							...(ep.asyncDeniedAudit ? {} : { requestId }),
						},
					});

				if (ep.asyncDeniedAudit) {
					await vi.waitFor(async () => {
						expect(await checkAudit()).not.toBeNull();
					});
				} else {
					expect(await checkAudit()).not.toBeNull();
				}
			},
		);
	});

	describe("5c. 专项角色边界：CLEAR/DELETION 提交、撤回、混合设置及 ADMIN/FINANCE 越权 → 403 + DB 零变更 + DENIED 审计", () => {
		it("VIEWER/OPERATOR/FINANCE 提交无权组织 CLEAR/DELETION、ADMIN 提交组织 DELETION 均 403 + 0 DB mutation + DENIED 审计", async () => {
			const cases = [
				{
					actor: fx.orgA.viewer,
					type: "CLEAR" as const,
					expectedAction: "permission.denied.data.clear",
					extra: { confirmedTotals: ZERO_TOTALS },
				},
				{
					actor: fx.orgA.viewer,
					type: "DELETION" as const,
					expectedAction: "permission.denied.organization.delete",
					extra: {},
				},
				{
					actor: fx.orgA.operator,
					type: "CLEAR" as const,
					expectedAction: "permission.denied.data.clear",
					extra: { confirmedTotals: ZERO_TOTALS },
				},
				{
					actor: fx.orgA.finance,
					type: "CLEAR" as const,
					expectedAction: "permission.denied.data.clear",
					extra: { confirmedTotals: ZERO_TOTALS },
				},
				{
					actor: fx.orgA.finance,
					type: "DELETION" as const,
					expectedAction: "permission.denied.organization.delete",
					extra: {},
				},
				{
					actor: fx.orgA.admin,
					type: "DELETION" as const,
					expectedAction: "permission.denied.organization.delete",
					extra: {},
				},
			];

			for (const c of cases) {
				const before = await readOrgMutationSnapshot(fx.orgA.orgId);
				const challengeId = await seedConsumedChallenge(c.actor.email, c.type);
				const res = await request(app.getHttpServer())
					.post("/api/organizations/current/data-requests")
					.set(orgHeaders(c.actor, fx.orgA.orgId))
					.send({
						type: c.type,
						scope: "ORGANIZATION",
						challengeId,
						...c.extra,
					});
				expect(res.status).toBe(403);
				expect(res.body.code).toBe("PERMISSION_DENIED");
				expect(await readOrgMutationSnapshot(fx.orgA.orgId)).toEqual(before);

				await vi.waitFor(async () => {
					const denied = await prisma.auditLog.findFirst({
						where: {
							organizationId: fx.orgA.orgId,
							actorUserId: c.actor.userId,
							action: c.expectedAction,
							result: "DENIED",
						},
					});
					expect(denied).not.toBeNull();
				});
			}
		});

		it("VIEWER/OPERATOR/FINANCE 携带混合 { region, prepPreference } 调 PATCH /api/settings → 403 且个人 region 与组织设置均零变更", async () => {
			for (const actor of [fx.orgA.viewer, fx.orgA.operator, fx.orgA.finance]) {
				const requestId = `matrix-mixed-settings-${randomUUID()}`;
				const before = await readOrgMutationSnapshot(fx.orgA.orgId);
				const res = await request(app.getHttpServer())
					.patch("/api/settings")
					.set(orgHeaders(actor, fx.orgA.orgId, requestId))
					.send({ region: "HK", prepPreference: "cautious" });
				expect(res.status).toBe(403);
				expect(res.body.code).toBe("PERMISSION_DENIED");
				expect(await readOrgMutationSnapshot(fx.orgA.orgId)).toEqual(before);

				const denied = await prisma.auditLog.findFirst({
					where: {
						organizationId: fx.orgA.orgId,
						actorUserId: actor.userId,
						action: "permission.denied.settings.update",
						result: "DENIED",
						requestId,
					},
				});
				expect(denied).not.toBeNull();
			}
		});

		it("VIEWER / OPERATOR 撤回本人发起的组织 CLEAR 请求（降权后）→ 403 + 状态不变 + DENIED 审计", async () => {
			const subLedger = await createOrgLedger(app, prisma, "matrix-cancel-403", [
				"VIEWER",
				"OPERATOR",
			]);
			trackedOrgLedgers.push(subLedger);
			trackedOrgIds.add(subLedger.orgId);

			for (const member of subLedger.members) {
				const pendingClear = await prisma.dataRequest.create({
					data: {
						requesterUserId: member.userId,
						scope: "ORGANIZATION",
						organizationId: subLedger.orgId,
						type: "CLEAR",
						status: "PENDING",
						requestedAt: new Date(),
						dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
						verifiedChallengeId: await seedConsumedChallenge(
							member.email,
							"CLEAR",
						),
					},
				});

				const before = await readOrgMutationSnapshot(subLedger.orgId);
				const res = await request(app.getHttpServer())
					.post(
						`/api/organizations/current/data-requests/${pendingClear.id}/cancel`,
					)
					.set(orgHeaders(member, subLedger.orgId))
					.send({});
				expect(res.status).toBe(403);
				expect(res.body.code).toBe("PERMISSION_DENIED");
				expect(await readOrgMutationSnapshot(subLedger.orgId)).toEqual(before);

				await vi.waitFor(async () => {
					const denied = await prisma.auditLog.findFirst({
						where: {
							organizationId: subLedger.orgId,
							actorUserId: member.userId,
							action: "permission.denied.data.clear",
							result: "DENIED",
						},
					});
					expect(denied).not.toBeNull();
				});
			}
		});

		it("ADMIN 不可 DELETE /api/organizations/current 或 transfer-ownership，FINANCE 不可改成员/设置/组织", async () => {
			const adminCases = [
				{
					method: "delete" as const,
					path: "/api/organizations/current",
					body: { challengeId: "dummy" },
					action: "permission.denied.organization.delete",
				},
				{
					method: "post" as const,
					path: "/api/organizations/current/transfer-ownership",
					body: { targetMembershipId: fx.orgA.viewerMembershipId },
					action: "permission.denied.owner.transfer",
				},
			];
			for (const c of adminCases) {
				const requestId = `matrix-admin-${randomUUID()}`;
				const before = await readOrgMutationSnapshot(fx.orgA.orgId);
				const res = await sendRequest(
					c.method,
					c.path,
					orgHeaders(fx.orgA.admin, fx.orgA.orgId, requestId),
					c.body,
				);
				expect(res.status).toBe(403);
				expect(res.body.code).toBe("PERMISSION_DENIED");
				expect(await readOrgMutationSnapshot(fx.orgA.orgId)).toEqual(before);
				const audit = await prisma.auditLog.findFirst({
					where: {
						organizationId: fx.orgA.orgId,
						actorUserId: fx.orgA.admin.userId,
						action: c.action,
						result: "DENIED",
						requestId,
					},
				});
				expect(audit).not.toBeNull();
			}

			const financeCases = [
				{
					method: "patch" as const,
					path: "/api/organizations/current",
					body: { name: "finance-denied" },
					action: "permission.denied.organization.update",
				},
				{
					method: "patch" as const,
					path: "/api/settings",
					body: { reminderEnabled: false },
					action: "permission.denied.settings.update",
				},
				{
					method: "post" as const,
					path: "/api/organizations/current/invitations",
					body: { email: "f-deny@example.com", role: "VIEWER" },
					action: "permission.denied.member.invite",
				},
			];
			for (const c of financeCases) {
				const requestId = `matrix-fin-${randomUUID()}`;
				const before = await readOrgMutationSnapshot(fx.orgA.orgId);
				const res = await sendRequest(
					c.method,
					c.path,
					orgHeaders(fx.orgA.finance, fx.orgA.orgId, requestId),
					c.body,
				);
				expect(res.status).toBe(403);
				expect(res.body.code).toBe("PERMISSION_DENIED");
				expect(await readOrgMutationSnapshot(fx.orgA.orgId)).toEqual(before);
				const audit = await prisma.auditLog.findFirst({
					where: {
						organizationId: fx.orgA.orgId,
						actorUserId: fx.orgA.finance.userId,
						action: c.action,
						result: "DENIED",
						requestId,
					},
				});
				expect(audit).not.toBeNull();
			}
		});
	});

	// ─────────────────── 6. 跨组织记录 ID 探测 → 统一 404（零存在性泄露） ───────────────────

	describe("6. 跨组织记录 ID 探测（X-Organization-Id: orgA + Org B 记录 ID）→ 统一 404", () => {
		const crossOrgEndpoints = MATRIX_ENDPOINTS.filter(
			(ep) => ep.crossOrgPath !== undefined,
		);

		it.each(crossOrgEndpoints)(
			"$domain | $label（带 Org A 头探测 Org B ID）→ 404",
			async (ep) => {
				// 默认 dualMember（同时属于 Org A 与 Org B，且其本身即 Org B 记录创建者）——
				// 仍返回 404 证明服务端严格按 actor.organizationId 隔离，不退化到 userId
				const actor = ep.crossOrgActor ? ep.crossOrgActor(fx) : fx.orgA.dualMember;
				const res = await sendRequest(
					ep.method,
					ep.crossOrgPath!(fx),
					orgHeaders(actor, fx.orgA.orgId),
					ep.crossOrgBody ? ep.crossOrgBody(fx) : ep.body?.(fx),
				);
				expect(res.status).toBe(404);
			},
		);

		it("corrections 跨组织探测 USAGE 与 INITIAL_HOLDING 记录 ID 同样统一 404", async () => {
			const usageProbes = [
				{
					method: "get" as const,
					path: `/api/corrections/target?targetType=USAGE&targetId=${fx.orgB.usageId}`,
				},
				{
					method: "get" as const,
					path: `/api/corrections?targetType=USAGE&targetId=${fx.orgB.usageId}`,
				},
				{
					method: "post" as const,
					path: "/api/corrections/preview",
					body: {
						targetType: "USAGE",
						targetId: fx.orgB.usageId,
						baseVersion: 1,
						reason: "cross-org-usage",
						changes: { amount: "50" },
					},
				},
				{
					method: "post" as const,
					path: "/api/corrections",
					body: {
						targetType: "USAGE",
						targetId: fx.orgB.usageId,
						baseVersion: 1,
						expectedUsageImpact: "none",
						reason: "cross-org-usage",
						changes: { amount: "50" },
					},
				},
				{
					method: "get" as const,
					path: `/api/corrections/target?targetType=INITIAL_HOLDING&targetId=${fx.orgB.initialHoldingId}`,
				},
				{
					method: "post" as const,
					path: "/api/corrections/preview",
					body: {
						targetType: "INITIAL_HOLDING",
						targetId: fx.orgB.initialHoldingId,
						reason: "cross-org-holding",
						changes: { amount: "5000" },
					},
				},
			];
			for (const p of usageProbes) {
				const res = await sendRequest(
					p.method,
					p.path,
					orgHeaders(fx.orgA.dualMember, fx.orgA.orgId),
					p.body,
				);
				expect(res.status, p.path).toBe(404);
			}
		});
	});

	// ─────────────────── 7. 降权与移除即时生效（复用旧 JWT） ───────────────────

	describe("7. 降权与移除即时生效（旧 JWT 立即按最新角色/状态拦截）", () => {
		it("FINANCE 降为 VIEWER 后立即复用旧 JWT 调交易/更正接口 → 403 PERMISSION_DENIED；移除后 → 404", async () => {
			const subLedger = await createOrgLedger(app, prisma, "matrix-demote");
			trackedOrgLedgers.push(subLedger);
			trackedOrgIds.add(subLedger.orgId);

			const targetUser = trackUser(
				await createTestUser(app, "matrix-demote-target"),
			);
			const membership = await prisma.membership.create({
				data: {
					organizationId: subLedger.orgId,
					userId: targetUser.userId,
					role: "FINANCE",
					status: "ACTIVE",
				},
			});
			const oldJwt = mintAccessToken(
				app,
				targetUser.userId,
				targetUser.email,
			);
			const staleHeaders = {
				...bearer(oldJwt),
				"X-Organization-Id": subLedger.orgId,
			};

			// 1. 降权前 FINANCE 正常放行
			const createdTx = await request(app.getHttpServer())
				.post("/api/transactions")
				.set(staleHeaders)
				.send(
					purchaseBody(
						"USD",
						"100",
						"7.2",
						new Date("2026-09-02T02:00:00.000Z"),
					),
				)
				.expect(201);
			const txId = createdTx.body.data.id as string;

			await request(app.getHttpServer())
				.post("/api/corrections/preview")
				.set(staleHeaders)
				.send({
					targetType: "TRANSACTION",
					targetId: txId,
					baseVersion: 1,
					reason: "demote-before",
					changes: { feeAmount: "5.00" },
				})
				.expect(200);

			// 2. Owner 将其降为 VIEWER
			await request(app.getHttpServer())
				.patch(`/api/organizations/current/members/${membership.id}`)
				.set(orgHeaders(subLedger.owner, subLedger.orgId))
				.send({ role: "VIEWER" })
				.expect(200);

			// 3. 立即复用旧 JWT 调交易/更正/计划/审计 → 403 PERMISSION_DENIED + DB 零变更 + DENIED 审计
			const beforeDemotedCalls = await readOrgMutationSnapshot(subLedger.orgId);
			const demotedAttempts = [
				{
					action: "permission.denied.transaction.create",
					run: (reqId: string) =>
						request(app.getHttpServer())
							.post("/api/transactions")
							.set({ ...staleHeaders, "X-Request-Id": reqId })
							.send(
								purchaseBody(
									"USD",
									"50",
									"7.2",
									new Date("2026-09-03T02:00:00.000Z"),
								),
							),
				},
				{
					action: "permission.denied.correction.preview",
					run: (reqId: string) =>
						request(app.getHttpServer())
							.post("/api/corrections/preview")
							.set({ ...staleHeaders, "X-Request-Id": reqId })
							.send({
								targetType: "TRANSACTION",
								targetId: txId,
								baseVersion: 1,
								reason: "demote-after",
								changes: { feeAmount: "6.00" },
							}),
				},
				{
					action: "permission.denied.correction.apply",
					run: (reqId: string) =>
						request(app.getHttpServer())
							.post("/api/corrections")
							.set({ ...staleHeaders, "X-Request-Id": reqId })
							.send({
								targetType: "TRANSACTION",
								targetId: txId,
								baseVersion: 1,
								reason: "demote-after",
								changes: { feeAmount: "6.00" },
							}),
				},
				{
					action: "permission.denied.audit.read",
					run: (reqId: string) =>
						request(app.getHttpServer())
							.get("/api/organizations/current/audit-logs")
							.set({ ...staleHeaders, "X-Request-Id": reqId }),
				},
			];
			for (const attempt of demotedAttempts) {
				const reqId = `matrix-demote-${randomUUID()}`;
				const res = await attempt.run(reqId);
				expect(res.status).toBe(403);
				expect(res.body.code).toBe("PERMISSION_DENIED");
				expect(await readOrgMutationSnapshot(subLedger.orgId)).toEqual(
					beforeDemotedCalls,
				);
				const denied = await prisma.auditLog.findFirst({
					where: {
						organizationId: subLedger.orgId,
						actorUserId: targetUser.userId,
						action: attempt.action,
						result: "DENIED",
						requestId: reqId,
					},
				});
				expect(denied).not.toBeNull();
			}

			// 4. 移除该成员 → 立即复用旧 JWT 调只读端点 → 404 ORGANIZATION_NOT_FOUND
			await request(app.getHttpServer())
				.delete(`/api/organizations/current/members/${membership.id}`)
				.set(orgHeaders(subLedger.owner, subLedger.orgId))
				.expect(200);

			const afterRemove = await request(app.getHttpServer())
				.get("/api/accounts")
				.set(staleHeaders)
				.expect(404);
			expect(afterRemove.body.code).toBe("ORGANIZATION_NOT_FOUND");
		});
	});

	// ─────────────────── 8. 最后 Owner 保护 → 409 LAST_OWNER_REQUIRED ───────────────────

	describe("8. 最后 Owner 保护 → 409 LAST_OWNER_REQUIRED", () => {
		it("唯一 OWNER 自降权、自移除、主动退出或个人注销 → 均 409 LAST_OWNER_REQUIRED", async () => {
			// 使用独立单成员组织测试（与共享 orgA 解耦，支持任意顺序与 -t 单跑）
			const soleOwner = trackUser(await createTestUser(app, "matrix-sole-owner"));
			await ensureOnboarded(prisma, soleOwner.userId);
			const created = await request(app.getHttpServer())
				.post("/api/organizations")
				.set(bearer(soleOwner.accessToken))
				.send({ name: "唯一Owner保护测试组织" })
				.expect(201);
			const soleOrgId = created.body.data.id as string;
			trackedOrgIds.add(soleOrgId);

			const soleMembership = await prisma.membership.findUniqueOrThrow({
				where: {
					organizationId_userId: {
						organizationId: soleOrgId,
						userId: soleOwner.userId,
					},
				},
			});

			// 8.1 自降权
			const demoteRes = await request(app.getHttpServer())
				.patch(`/api/organizations/current/members/${soleMembership.id}`)
				.set(orgHeaders(soleOwner, soleOrgId))
				.send({ role: "ADMIN" })
				.expect(409);
			expect(demoteRes.body.code).toBe("LAST_OWNER_REQUIRED");

			// 8.2 自移除
			const removeRes = await request(app.getHttpServer())
				.delete(`/api/organizations/current/members/${soleMembership.id}`)
				.set(orgHeaders(soleOwner, soleOrgId))
				.expect(409);
			expect(removeRes.body.code).toBe("LAST_OWNER_REQUIRED");

			// 8.3 主动退出
			const leaveRes = await request(app.getHttpServer())
				.post("/api/organizations/current/members/leave")
				.set(orgHeaders(soleOwner, soleOrgId))
				.send({})
				.expect(409);
			expect(leaveRes.body.code).toBe("LAST_OWNER_REQUIRED");

			// 8.4 个人注销（POST /api/data-requests { scope: "PERSONAL", type: "DELETION" }）
			const challengeId = await seedConsumedChallenge(
				soleOwner.email,
				"DELETION",
			);
			const deleteRes = await request(app.getHttpServer())
				.post("/api/data-requests")
				.set(bearer(soleOwner.accessToken))
				.send({ scope: "PERSONAL", type: "DELETION", challengeId })
				.expect(409);
			expect(deleteRes.body.code).toBe("LAST_OWNER_REQUIRED");
			expect(
				deleteRes.body.data.blockingOrganizations.map(
					(o: { organizationId: string }) => o.organizationId,
				),
			).toContain(soleOrgId);
		});
	});

	// ─────────────────── 9. 列表读隔离（双组织成员切换上下文零交叉） ───────────────────

	describe("9. 列表级读隔离（dualMember 切换 Org A / Org B 头不混入他组织数据）", () => {
		it("全部列表与聚合端点按 X-Organization-Id 严格隔离，互不含对方记录 ID 或币种", async () => {
			// 为 Org A / Org B 各建一条满足 COMPLETE_READY（used==target 且剩余分配==0）的计划，
			// 使 GET /reminders 读时懒生成非空条目且严格隔离
			const readyPlanA = await prisma.plan.create({
				data: {
					organizationId: fx.orgA.orgId,
					createdById: fx.orgA.owner.userId,
					name: "matrix-a-ready-plan",
					targetCurrency: "USD",
					targetAmount: "200.0000",
					expectUseDate: new Date("2030-09-05T00:00:00.000Z"),
					latestPrepDate: new Date("2030-09-02T00:00:00.000Z"),
					status: "ACTIVE",
				},
			});
			await prisma.planAllocation.create({
				data: { planId: readyPlanA.id, amount: "200.0000", usedAmount: "200.0000" },
			});
			const readyPlanB = await prisma.plan.create({
				data: {
					organizationId: fx.orgB.orgId,
					createdById: fx.orgB.owner.userId,
					name: "matrix-b-ready-plan",
					targetCurrency: "JPY",
					targetAmount: "2000.0000",
					expectUseDate: new Date("2030-09-05T00:00:00.000Z"),
					latestPrepDate: new Date("2030-09-02T00:00:00.000Z"),
					status: "ACTIVE",
				},
			});
			await prisma.planAllocation.create({
				data: { planId: readyPlanB.id, amount: "2000.0000", usedAmount: "2000.0000" },
			});

			const getAs = (orgId: string, path: string) =>
				request(app.getHttpServer())
					.get(path)
					.set(orgHeaders(fx.orgA.dualMember, orgId))
					.expect(200);

			// 1. accounts
			const [accA, accB] = await Promise.all([
				getAs(fx.orgA.orgId, "/api/accounts"),
				getAs(fx.orgB.orgId, "/api/accounts"),
			]);
			expect(
				accA.body.data.accounts.map((i: { currencyCode: string }) => i.currencyCode),
			).toEqual(["USD"]);
			expect(
				accB.body.data.accounts.map((i: { currencyCode: string }) => i.currencyCode),
			).toEqual(["JPY"]);

			// 2. plans
			const [plansA, plansB] = await Promise.all([
				getAs(fx.orgA.orgId, "/api/plans"),
				getAs(fx.orgB.orgId, "/api/plans"),
			]);
			const planIdsA = plansA.body.data.items.map((i: { id: string }) => i.id);
			const planIdsB = plansB.body.data.items.map((i: { id: string }) => i.id);
			expect(planIdsA).toContain(fx.orgA.planId);
			expect(planIdsA).not.toContain(fx.orgB.planId);
			expect(planIdsB).toContain(fx.orgB.planId);
			expect(planIdsB).not.toContain(fx.orgA.planId);

			// 3. reports/plans
			const [repA, repB] = await Promise.all([
				getAs(fx.orgA.orgId, "/api/reports/plans"),
				getAs(fx.orgB.orgId, "/api/reports/plans"),
			]);
			expect(JSON.stringify(repA.body.data)).toContain(fx.orgA.planId);
			expect(JSON.stringify(repA.body.data)).not.toContain(fx.orgB.planId);
			expect(JSON.stringify(repB.body.data)).toContain(fx.orgB.planId);
			expect(JSON.stringify(repB.body.data)).not.toContain(fx.orgA.planId);

			// 4. reminders
			const [remA, remB] = await Promise.all([
				getAs(fx.orgA.orgId, "/api/reminders"),
				getAs(fx.orgB.orgId, "/api/reminders"),
			]);
			expect(remA.body.data.items.length).toBeGreaterThanOrEqual(1);
			expect(remB.body.data.items.length).toBeGreaterThanOrEqual(1);
			expect(JSON.stringify(remA.body.data)).toContain(readyPlanA.id);
			expect(JSON.stringify(remA.body.data)).not.toContain(readyPlanB.id);
			expect(JSON.stringify(remA.body.data)).not.toContain(fx.orgB.planId);
			expect(JSON.stringify(remB.body.data)).toContain(readyPlanB.id);
			expect(JSON.stringify(remB.body.data)).not.toContain(readyPlanA.id);
			expect(JSON.stringify(remB.body.data)).not.toContain(fx.orgA.planId);

			// 5. members
			const [memA, memB] = await Promise.all([
				getAs(fx.orgA.orgId, "/api/organizations/current/members"),
				getAs(fx.orgB.orgId, "/api/organizations/current/members"),
			]);
			const memIdsA = memA.body.data.map((m: { id: string }) => m.id);
			const memIdsB = memB.body.data.map((m: { id: string }) => m.id);
			expect(memIdsA).toContain(fx.orgA.ownerMembershipId);
			expect(memIdsA).not.toContain(fx.orgB.ownerMembershipId);
			expect(memIdsB).toContain(fx.orgB.ownerMembershipId);
			expect(memIdsB).not.toContain(fx.orgA.ownerMembershipId);

			// 6. invitations
			const [invA, invB] = await Promise.all([
				getAs(fx.orgA.orgId, "/api/organizations/current/invitations"),
				getAs(fx.orgB.orgId, "/api/organizations/current/invitations"),
			]);
			const invIdsA = invA.body.data.map((i: { id: string }) => i.id);
			const invIdsB = invB.body.data.map((i: { id: string }) => i.id);
			expect(invIdsA).toContain(fx.orgA.invitationId);
			expect(invIdsA).not.toContain(fx.orgB.invitationId);
			expect(invIdsB).toContain(fx.orgB.invitationId);
			expect(invIdsB).not.toContain(fx.orgA.invitationId);

			// 7. audit-logs
			const [audA, audB] = await Promise.all([
				getAs(fx.orgA.orgId, "/api/organizations/current/audit-logs"),
				getAs(fx.orgB.orgId, "/api/organizations/current/audit-logs"),
			]);
			expect(audA.body.data.items.length).toBeGreaterThanOrEqual(1);
			expect(audB.body.data.items.length).toBeGreaterThanOrEqual(1);
			for (const item of audA.body.data.items as Array<{
				organizationId: string;
			}>) {
				expect(item.organizationId).toBe(fx.orgA.orgId);
			}
			for (const item of audB.body.data.items as Array<{
				organizationId: string;
			}>) {
				expect(item.organizationId).toBe(fx.orgB.orgId);
			}

			// 8. ai/conversations
			const [aiA, aiB] = await Promise.all([
				getAs(fx.orgA.orgId, "/api/ai/conversations"),
				getAs(fx.orgB.orgId, "/api/ai/conversations"),
			]);
			const convIdsA = aiA.body.data.items.map((c: { id: string }) => c.id);
			const convIdsB = aiB.body.data.items.map((c: { id: string }) => c.id);
			expect(convIdsA).toContain(fx.orgA.conversationId);
			expect(convIdsA).not.toContain(fx.orgB.conversationId);
			expect(convIdsB).toContain(fx.orgB.conversationId);
			expect(convIdsB).not.toContain(fx.orgA.conversationId);

			// 9. home/state
			const [homeA, homeB] = await Promise.all([
				getAs(fx.orgA.orgId, "/api/home/state"),
				getAs(fx.orgB.orgId, "/api/home/state"),
			]);
			expect(JSON.stringify(homeA.body.data)).toContain(fx.orgA.planId);
			expect(JSON.stringify(homeA.body.data)).not.toContain(fx.orgB.planId);
			expect(JSON.stringify(homeA.body.data)).not.toContain("JPY");
			expect(JSON.stringify(homeB.body.data)).toContain(fx.orgB.planId);
			expect(JSON.stringify(homeB.body.data)).not.toContain(fx.orgA.planId);
			expect(JSON.stringify(homeB.body.data)).not.toContain("USD");

			// 10. home/portfolio
			const [portA, portB] = await Promise.all([
				getAs(fx.orgA.orgId, "/api/home/portfolio"),
				getAs(fx.orgB.orgId, "/api/home/portfolio"),
			]);
			expect(
				portA.body.data.byCurrency.map((i: { currencyCode: string }) => i.currencyCode),
			).toEqual(["USD"]);
			expect(
				portB.body.data.byCurrency.map((i: { currencyCode: string }) => i.currencyCode),
			).toEqual(["JPY"]);
		});
	});

	// ─────────────────── 10. 组织锁跨组织隔离（锁当前组织、他组织正常） ───────────────────

	describe("10. 组织锁跨组织隔离（当前组织 CLEAR/DELETION 锁 → 403 ORGANIZATION_DATA_LOCKED，他组织正常写入）", () => {
		it("锁定 Org 写端点返回 403 ORGANIZATION_DATA_LOCKED，同成员在另一健康组织写端点全部成功", async () => {
			const sharedActor = trackUser(
				await createTestUser(app, "matrix-lock-actor"),
			);
			const lockedFx = await seedFullOrgFixture(
				"matrix-lock-a",
				"USD",
				sharedActor,
			);
			const healthyFx = await seedFullOrgFixture(
				"matrix-lock-b",
				"USD",
				sharedActor,
			);

			// 分别对 CLEAR 锁与 DELETION 锁验证：锁定组织被拦 403 ORGANIZATION_DATA_LOCKED，健康组织正常
			for (const lockType of ["CLEAR", "DELETION"] as const) {
				const lockRow = await prisma.dataRequest.create({
					data: {
						requesterUserId: lockedFx.owner.userId,
						scope: "ORGANIZATION",
						organizationId: lockedFx.orgId,
						type: lockType,
						status: "PENDING",
						requestedAt: new Date(),
						dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
						verifiedChallengeId: await seedConsumedChallenge(
							lockedFx.owner.email,
							lockType,
						),
					},
				});

				const lockedWriteProbes = [
					{
						method: "post" as const,
						path: "/api/plans",
						body: {
							name: "locked-plan",
							targetCurrency: "USD",
							targetAmount: "1000",
							expectUseDate: PLAN_EXPECT_USE_DATE,
							prepLeadDays: 3,
							pacePreference: "balanced",
							startDate: PLAN_START_DATE,
						},
					},
					{
						method: "patch" as const,
						path: `/api/plans/${lockedFx.planId}`,
						body: {
							newTargetAmount: "1200",
							expectedUpdatedAt: lockedFx.planUpdatedAt,
						},
					},
					{
						method: "post" as const,
						path: "/api/transactions",
						body: purchaseBody(
							"USD",
							"50",
							"7.2",
							new Date("2026-09-02T02:00:00.000Z"),
						),
					},
					{
						method: "post" as const,
						path: `/api/plans/${lockedFx.planId}/usages`,
						body: { amount: "10", usedAt: "2026-09-03T00:00:00.000Z" },
					},
					{
						method: "post" as const,
						path: "/api/corrections",
						body: {
							targetType: "TRANSACTION",
							targetId: lockedFx.transactionId,
							baseVersion: 1,
							reason: "locked-probe",
							changes: { feeAmount: "5.00" },
						},
					},
					{
						method: "patch" as const,
						path: "/api/settings",
						body: { prepPreference: "cautious" },
					},
					{
						method: "patch" as const,
						path: "/api/organizations/current",
						body: { name: "locked-rename" },
					},
					{
						method: "post" as const,
						path: "/api/organizations/current/invitations",
						body: { email: `locked-${lockType}@example.com`, role: "VIEWER" },
					},
					{
						method: "patch" as const,
						path: `/api/organizations/current/members/${lockedFx.viewerMembershipId}`,
						body: { role: "FINANCE" },
					},
					{
						method: "post" as const,
						path: "/api/ai/conversations",
						body: { content: "锁期间新建会话" },
					},
				];

				for (const probe of lockedWriteProbes) {
					const res = await sendRequest(
						probe.method,
						probe.path,
						orgHeaders(sharedActor, lockedFx.orgId),
						probe.body,
					);
					expect(res.status, `${lockType} ${probe.path}`).toBe(403);
					expect(res.body.code, `${lockType} ${probe.path}`).toBe(
						"ORGANIZATION_DATA_LOCKED",
					);
				}

				// 同一用户在健康组织正常写入（互不干扰）
				await request(app.getHttpServer())
					.post("/api/transactions")
					.set(orgHeaders(sharedActor, healthyFx.orgId))
					.send(
						purchaseBody(
							"USD",
							"20",
							"7.2",
							new Date("2026-09-02T02:00:00.000Z"),
						),
					)
					.expect(201);

				await request(app.getHttpServer())
					.patch("/api/organizations/current")
					.set(orgHeaders(sharedActor, healthyFx.orgId))
					.send({ name: `healthy-updated-${lockType}` })
					.expect(200);

				await request(app.getHttpServer())
					.patch("/api/settings")
					.set(orgHeaders(sharedActor, healthyFx.orgId))
					.send({ prepPreference: "cautious" })
					.expect(200);

				await request(app.getHttpServer())
					.post("/api/ai/conversations")
					.set(orgHeaders(sharedActor, healthyFx.orgId))
					.send({ content: `healthy-${lockType}` })
					.expect(200);

				// 清理本轮 PENDING 锁以进入下一锁类型验证
				await prisma.dataRequest.delete({ where: { id: lockRow.id } });
			}
		});
	});
});
