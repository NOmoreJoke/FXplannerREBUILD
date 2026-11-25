import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	cleanupUser,
	createTestApp,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";
import { TEST_PASSWORD } from "../fixtures/test-credentials";
import { ensureOnboarded } from "../helpers/onboarding-helper";
import { backfillDefaultOrganizations } from "../../src/organization/organization-backfill";
import { reconcileMigration } from "../../src/organization/organization-reconcile";
import { resolveDefaultOrganizationId } from "../../src/authorization/default-organization";

/**
 * 组织只读隔离集成测试（GOAL-3A W18；技术方案 §14.2 通用矩阵 + 需求 15.2.11）
 *
 * 构造：Org A（Owner U1 + Viewer U2）与 Org B（Owner U3，且 U1 属双组织 A+B）。
 * 验证：
 * 1. 同组织 Viewer U2 与 Owner U1 在 Org A 读取到完全一致的账户/计划/交易/使用/更正/报告；
 * 2. U1 带 Org B 头请求 Org A 的任意记录 ID（Account/Plan/Transaction/Correction/
 *    Report/AiConversation）全部 404；
 * 3. U1 属 A+B 双组织但不传 X-Organization-Id 请求业务 GET → 400（禁猜测默认组织）；
 * 4. Viewer U2 被禁用后用旧 JWT 请求全部 GET 端点 → 404。
 */

vi.mock("@nestjs/throttler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nestjs/throttler")>();
	class NoopThrottlerGuard {
		async canActivate() {
			return true;
		}
	}
	return { ...actual, ThrottlerGuard: NoopThrottlerGuard };
});

const RUN = `orgiso-${Date.now()}`;

describe("组织只读隔离（integration）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const userIds: string[] = [];
	const orgIds: string[] = [];

	let u1: TestUser; // Org A Owner（双组织 A+B）
	let u2: TestUser; // Org A Viewer
	let u3: TestUser; // Org B Owner
	let orgA: string;
	let orgB: string;

	// Org A 业务数据 id（U1 建、组织行）
	let planA: { id: string };
	let txnA: { id: string };
	let usageA: { id: string };
	let convA: { id: string };

	beforeAll(async () => {
		// AI 运行时配置在模块 compile 期从 env 快照（ai-chat.spec 先例）：注入夹具
		// 密钥使 AI 会话端点可用（否则 listMessages 在归属校验前 503 短路）；
		// 凭据 env-first（TEST_AI_PROVIDER_KEY），缺省回落测试夹具占位值（非真实凭据）
		const aiEnv = {
			AI_PROVIDER_AIGYSD_API_KEY:
				process.env.TEST_AI_PROVIDER_KEY ?? "test-fixture-placeholder-key",
			AI_DEFAULT_CHAT_MODEL: "gpt-4.1-mini",
		};
		const saved: Record<string, string | undefined> = {};
		for (const [key, value] of Object.entries(aiEnv)) {
			saved[key] = process.env[key];
			process.env[key] = value;
		}
		try {
			ctx = await createTestApp();
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		app = ctx.app;
	});

	afterAll(async () => {
		// 派生行先清（裸外键），再组织级联、用户级联
		for (const orgId of orgIds) {
			const plans = await ctx.prisma.plan.findMany({
				where: { organizationId: orgId },
				select: { id: true },
			});
			const usages = await ctx.prisma.usageRecord.findMany({
				where: { organizationId: orgId },
				select: { id: true },
			});
			const lots = await ctx.prisma.costLot.findMany({
				where: { organizationId: orgId },
				select: { id: true },
			});
			// 裸外键派生行按 ID 集合先清（UsageLotAllocation 无 relation）
			await ctx.prisma.usageLotAllocation.deleteMany({
				where: {
					OR: [
						...(usages.length > 0
							? [{ usageId: { in: usages.map((u) => u.id) } }]
							: []),
						...(lots.length > 0
							? [{ lotId: { in: lots.map((l) => l.id) } }]
							: []),
					],
				},
			});
			await ctx.prisma.usageRecord.deleteMany({
				where: { organizationId: orgId },
			});
			await ctx.prisma.planAllocation.deleteMany({
				where: { planId: { in: plans.map((p) => p.id) } },
			});
			await ctx.prisma.planInstallment.deleteMany({
				where: { planId: { in: plans.map((p) => p.id) } },
			});
			await ctx.prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
			await ctx.prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
		}
		for (const userId of userIds) {
			await cleanupUser(ctx.prisma, userId);
		}
		await app.close();
	});

	async function registerUser(label: string): Promise<TestUser> {
		const email = `${RUN}-${label}-${Math.random().toString(36).slice(2, 8)}@example.com`;
		await request(app.getHttpServer())
			.post("/api/auth/register")
			.send({ email, password: TEST_PASSWORD, name: label })
			.expect(201);
		const login = await request(app.getHttpServer())
			.post("/api/auth/login")
			.send({ email, password: TEST_PASSWORD })
			.expect(200);
		const user: TestUser = {
			email,
			password: TEST_PASSWORD,
			accessToken: login.body.data.accessToken,
			userId: login.body.data.user.id,
		};
		userIds.push(user.userId);
		return user;
	}

	/** 头：鉴权 + 组织上下文（org 缺省 = 不带组织头） */
	function hdr(user: TestUser, org?: string): Record<string, string> {
		const base: Record<string, string> = {
			Authorization: `Bearer ${user.accessToken}`,
		};
		if (org) base["X-Organization-Id"] = org;
		return base;
	}

	beforeAll(async () => {
		u1 = await registerUser("u1-owner-a");
		u2 = await registerUser("u2-viewer-a");
		u3 = await registerUser("u3-owner-b");

		// Org A：U1 默认组织（注册兜底）；U2 加入为 Viewer
		const u1Default = await ctx.prisma.membership.findFirst({
			where: { userId: u1.userId, role: "OWNER", status: "ACTIVE" },
		});
		if (!u1Default) throw new Error("注册兜底未建默认组织");
		orgA = u1Default.organizationId;
		orgIds.push(orgA);
		await ctx.prisma.membership.create({
			data: {
				organizationId: orgA,
				userId: u2.userId,
				role: "VIEWER",
				status: "ACTIVE",
			},
		});

		// Org B：U3 默认组织；U1 也加入 B（双组织场景）
		const u3Default = await ctx.prisma.membership.findFirst({
			where: { userId: u3.userId, role: "OWNER", status: "ACTIVE" },
		});
		if (!u3Default) throw new Error("注册兜底未建默认组织");
		orgB = u3Default.organizationId;
		orgIds.push(orgB);
		await ctx.prisma.membership.create({
			data: {
				organizationId: orgB,
				userId: u1.userId,
				role: "FINANCE",
				status: "ACTIVE",
			},
		});

		// Org A 业务数据（DB 直造，organizationId 显式 = orgA；模拟 MIG-B 后组织行）
		await ctx.prisma.account.create({
			data: {
				userId: u1.userId,
				organizationId: orgA,
				createdById: u1.userId,
				currencyCode: "USD",
				balance: "120.0000",
			},
		});
		planA = await ctx.prisma.plan.create({
			data: {
				userId: u1.userId,
				organizationId: orgA,
				createdById: u1.userId,
				targetCurrency: "USD",
				targetAmount: "100.0000",
				expectUseDate: new Date("2026-12-01T00:00:00.000Z"),
				prepLeadDays: 3,
				latestPrepDate: new Date("2026-11-25T00:00:00.000Z"),
				status: "ACTIVE",
			},
		});
		await ctx.prisma.planAllocation.create({
			data: { planId: planA.id, amount: "100.0000", usedAmount: "0.0000" },
		});
		txnA = await ctx.prisma.transaction.create({
			data: {
				userId: u1.userId,
				organizationId: orgA,
				createdById: u1.userId,
				currencyCode: "USD",
				quantity: "20.0000",
				principalAmount: "144.0000",
				feeAmount: null,
				exchangeRate: "7.2000000000",
				rateSource: "identity",
				rateObservedAt: new Date("2026-11-01T00:00:00.000Z"),
				transactedAt: new Date("2026-11-02T00:00:00.000Z"),
				planId: planA.id,
			},
		});
		await ctx.prisma.costLot.create({
			data: {
				userId: u1.userId,
				organizationId: orgA,
				currencyCode: "USD",
				sourceType: "PURCHASE",
				sourceId: txnA.id,
				quantity: "20.0000",
				remainingQty: "20.0000",
				unitCost: "7.2000000000",
				totalCost: "144.0000",
				acquiredAt: new Date("2026-11-02T00:00:00.000Z"),
			},
		});
		usageA = await ctx.prisma.usageRecord.create({
			data: {
				userId: u1.userId,
				organizationId: orgA,
				createdById: u1.userId,
				planId: planA.id,
				currencyCode: "USD",
				amount: "5.0000",
				usedAt: new Date("2026-11-10T00:00:00.000Z"),
			},
		});
		await ctx.prisma.correction.create({
			data: {
				userId: u1.userId,
				organizationId: orgA,
				actorUserId: u1.userId,
				targetType: "TRANSACTION",
				targetId: txnA.id,
				reason: "隔离测试更正",
				beforeSnapshot: {},
				afterSnapshot: {},
				status: "APPLIED",
			},
		});
		convA = await ctx.prisma.aiConversation.create({
			data: {
				userId: u1.userId,
				organizationId: orgA,
				title: "隔离测试会话",
			},
		});
		await ctx.prisma.aiMessage.create({
			data: {
				conversationId: convA.id,
				role: "user",
				content: "隔离测试消息",
			},
		});
	});

	it("1. 同组织 Viewer 与 Owner 读取到完全一致的组织视图（账户/计划/交易/使用/更正/报告）", async () => {
		// 账户列表（组织行跨用户共享）
		const ownerAccounts = await request(app.getHttpServer())
			.get("/api/accounts")
			.set(hdr(u1, orgA))
			.expect(200);
		const viewerAccounts = await request(app.getHttpServer())
			.get("/api/accounts")
			.set(hdr(u2, orgA))
			.expect(200);
		expect(viewerAccounts.body.data.accounts).toEqual(
			ownerAccounts.body.data.accounts,
		);
		expect(ownerAccounts.body.data.accounts).toHaveLength(1);
		expect(ownerAccounts.body.data.accounts[0].currencyCode).toBe("USD");

		// 计划列表 + 详情
		const ownerPlans = await request(app.getHttpServer())
			.get("/api/plans")
			.set(hdr(u1, orgA))
			.expect(200);
		const viewerPlans = await request(app.getHttpServer())
			.get("/api/plans")
			.set(hdr(u2, orgA))
			.expect(200);
		expect(viewerPlans.body.data.items.map((i: { id: string }) => i.id)).toEqual(
			ownerPlans.body.data.items.map((i: { id: string }) => i.id),
		);
		const viewerDetail = await request(app.getHttpServer())
			.get(`/api/plans/${planA.id}`)
			.set(hdr(u2, orgA))
			.expect(200);
		expect(viewerDetail.body.data.id).toBe(planA.id);

		// 交易详情（Viewer 经组织行可见 Owner 的交易）
		const viewerTxn = await request(app.getHttpServer())
			.get(`/api/transactions/${txnA.id}`)
			.set(hdr(u2, orgA))
			.expect(200);
		expect(viewerTxn.body.data.id).toBe(txnA.id);

		// 计划使用记录
		const viewerUsages = await request(app.getHttpServer())
			.get(`/api/plans/${planA.id}/usages`)
			.set(hdr(u2, orgA))
			.expect(200);
		expect(viewerUsages.body.data.items).toHaveLength(1);
		expect(viewerUsages.body.data.items[0].id).toBe(usageA.id);

		// 更正列表（targetType+targetId）
		const viewerCorr = await request(app.getHttpServer())
			.get(`/api/corrections?targetType=TRANSACTION&targetId=${txnA.id}`)
			.set(hdr(u2, orgA))
			.expect(200);
		expect(viewerCorr.body.data.total).toBe(1);

		// 报告列表与单计划报告
		const ownerReport = await request(app.getHttpServer())
			.get("/api/reports/plans")
			.set(hdr(u1, orgA))
			.expect(200);
		const viewerReport = await request(app.getHttpServer())
			.get("/api/reports/plans")
			.set(hdr(u2, orgA))
			.expect(200);
		expect(viewerReport.body.data.items).toEqual(ownerReport.body.data.items);
		await request(app.getHttpServer())
			.get(`/api/reports/plans/${planA.id}`)
			.set(hdr(u2, orgA))
			.expect(200);

		// 首页状态/持仓（组织视图一致）
		const ownerHome = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(hdr(u1, orgA))
			.expect(200);
		const viewerHome = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(hdr(u2, orgA))
			.expect(200);
		expect(viewerHome.body.data.accounts).toEqual(ownerHome.body.data.accounts);
		expect(viewerHome.body.data.plans.map((p: { id: string }) => p.id)).toEqual(
			ownerHome.body.data.plans.map((p: { id: string }) => p.id),
		);
	});

	it("2. 双组织成员带 Org B 头请求 Org A 记录 → 全部 404（不泄露存在性）", async () => {
		const asB = hdr(u1, orgB);
		await request(app.getHttpServer())
			.get("/api/accounts/USD")
			.set(asB)
			.expect(404);
		await request(app.getHttpServer())
			.get(`/api/plans/${planA.id}`)
			.set(asB)
			.expect(404);
		await request(app.getHttpServer())
			.get(`/api/transactions/${txnA.id}`)
			.set(asB)
			.expect(404);
		await request(app.getHttpServer())
			.get(`/api/plans/${planA.id}/usages`)
			.set(asB)
			.expect(404);
		await request(app.getHttpServer())
			.get(`/api/corrections?targetType=TRANSACTION&targetId=${txnA.id}`)
			.set(asB)
			.expect(404);
		await request(app.getHttpServer())
			.get(`/api/reports/plans/${planA.id}`)
			.set(asB)
			.expect(404);
		// AI 会话：个人所有 + 组织绑定——Org B 上下文看不到 Org A 会话（404）
		await request(app.getHttpServer())
			.get(`/api/ai/conversations/${convA.id}/messages`)
			.set(asB)
			.expect(404);
		// Org B 视图本身为空（Org A 数据不可见）
		const bAccounts = await request(app.getHttpServer())
			.get("/api/accounts")
			.set(asB)
			.expect(200);
		expect(bAccounts.body.data.accounts).toHaveLength(0);
	});

	it("3. 双组织成员不传组织头请求业务 GET → 400 ORGANIZATION_REQUIRED（禁猜测默认组织）", async () => {
		const endpoints = [
			"/api/accounts",
			"/api/plans",
			`/api/plans/${planA.id}`,
			"/api/home/state",
			"/api/home/portfolio",
			"/api/reports/plans",
			"/api/reminders",
		];
		for (const url of endpoints) {
			const res = await request(app.getHttpServer())
				.get(url)
				.set(hdr(u1))
				.expect(400);
			expect(res.body.code).toBe("ORGANIZATION_REQUIRED");
		}
	});

	it("4. Viewer 被禁用后旧 JWT 请求全部 GET 端点 → 404 ORGANIZATION_NOT_FOUND（降权秒级）", async () => {
		// 对照：禁用前 Viewer 正常读
		await request(app.getHttpServer())
			.get("/api/accounts")
			.set(hdr(u2, orgA))
			.expect(200);
		await ctx.prisma.membership.update({
			where: {
				organizationId_userId: { organizationId: orgA, userId: u2.userId },
			},
			data: { status: "DISABLED" },
		});
		const endpoints = [
			"/api/accounts",
			"/api/plans",
			`/api/plans/${planA.id}`,
			`/api/transactions/${txnA.id}`,
			`/api/plans/${planA.id}/usages`,
			"/api/home/state",
			"/api/home/portfolio",
			"/api/reports/plans",
			`/api/reports/plans/${planA.id}`,
			"/api/ai/conversations",
		];
		for (const url of endpoints) {
			const res = await request(app.getHttpServer())
				.get(url)
				.set(hdr(u2, orgA))
				.expect(404);
			expect(res.body.code).toBe("ORGANIZATION_NOT_FOUND");
		}
	});

	it("5. 单组织用户无头请求回落默认组织（兼容窗口正路径）", async () => {
		// u2 已禁用后重新激活（保持单组织）；U3 单组织 Owner
		const res = await request(app.getHttpServer())
			.get("/api/accounts")
			.set(hdr(u3))
			.expect(200);
		expect(res.body.data.accounts).toHaveLength(0); // Org B 无数据但不 400
		const plans = await request(app.getHttpServer())
			.get("/api/plans")
			.set(hdr(u3))
			.expect(200);
		expect(plans.body.data.items).toHaveLength(0);
	});
});

/** UTC+8 日初（提醒规则的业务日口径） */
function utc8Midday(offsetDays: number): Date {
	const now = Date.now() + 8 * 60 * 60 * 1000;
	const day = Math.floor(now / 86_400_000) + offsetDays;
	return new Date(day * 86_400_000 - 8 * 60 * 60 * 1000);
}

/** 注册并登录测试用户（R2 回归两个 describe 共用；userIds 供 afterAll 的 cleanupUser 收尾） */
async function registerR2User(
	app: INestApplication,
	label: string,
	userIds: string[],
): Promise<TestUser> {
	const email = `r2-${label}-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 8)}@example.com`;
	await request(app.getHttpServer())
		.post("/api/auth/register")
		.send({ email, password: TEST_PASSWORD, name: label })
		.expect(201);
	const login = await request(app.getHttpServer())
		.post("/api/auth/login")
		.send({ email, password: TEST_PASSWORD })
		.expect(200);
	const user: TestUser = {
		email,
		password: TEST_PASSWORD,
		accessToken: login.body.data.accessToken,
		userId: login.body.data.user.id,
	};
	userIds.push(user.userId);
	return user;
}

/** 当前用户的默认组织（注册兜底建的 OWNER 成员关系），并入用例托管列表供 afterAll 清理 */
async function trackDefaultOrg(
	prisma: TestContext["prisma"],
	userId: string,
	orgIds: string[],
): Promise<string> {
	const membership = await prisma.membership.findFirst({
		where: { userId, role: "OWNER", status: "ACTIVE" },
	});
	if (!membership) throw new Error("注册兜底未建默认组织");
	orgIds.push(membership.organizationId);
	return membership.organizationId;
}

/**
 * 外部评审修复回归（Goal #3A R1）：兼容窗口回落的作用域与组织偏好真相来源。
 *
 * 场景：U1 的默认组织 A 内含「旧写路径产生的 organizationId IS NULL 行」与个人设置；
 * U1 另新建组织 B、并作为成员加入 U3 的组织 C（C 有自己的组织行账户与所有者设置）。
 * - I-08：存量 NULL 行与个人设置回落**只在默认组织 A 生效**，不渗入 B / C；
 * - I-10：受邀成员（无个人设置）在已建账组织可读设置/提醒/建账状态；
 * - I-11：提醒生成按当前组织作用域；已读态按成员独立，行主读过不替他人清除未读。
 */
describe("评审修复回归：兼容回落作用域与组织偏好（I-08 / I-10 / I-11）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const userIds: string[] = [];
	const orgIds: string[] = [];

	let u1: TestUser;
	let u2: TestUser;
	let u3: TestUser;
	let orgA: string;
	let orgB: string;
	let orgC: string;
	/** U1 在 A 的 ACTIVE 计划（组织行）与一条「行主 40 天前已读」的旧提醒 */
	let planA1: string;
	let planA2: string;
	let ownerReadReminderId: string;

	const headers = (user: TestUser, org: string) => ({
		Authorization: `Bearer ${user.accessToken}`,
		"X-Organization-Id": org,
	});

	async function registerUser(label: string): Promise<TestUser> {
		const email = `rev2-${label}-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2, 8)}@example.com`;
		await request(app.getHttpServer())
			.post("/api/auth/register")
			.send({ email, password: TEST_PASSWORD, name: label })
			.expect(201);
		const login = await request(app.getHttpServer())
			.post("/api/auth/login")
			.send({ email, password: TEST_PASSWORD })
			.expect(200);
		const user: TestUser = {
			email,
			password: TEST_PASSWORD,
			accessToken: login.body.data.accessToken,
			userId: login.body.data.user.id,
		};
		userIds.push(user.userId);
		return user;
	}

	/** 建一条 ACTIVE 计划（组织行）：目标 1000、分配 500（缺口 > 0），单个排期节点 */
	async function seedPlan(
		organizationId: string,
		installmentDay: Date,
		expectUseDay: Date,
	): Promise<string> {
		const plan = await ctx.prisma.plan.create({
			data: {
				userId: u1.userId,
				organizationId,
				createdById: u1.userId,
				targetCurrency: "USD",
				targetAmount: "1000.0000",
				expectUseDate: expectUseDay,
				prepLeadDays: 3,
				latestPrepDate: new Date(expectUseDay.getTime() - 3 * 86_400_000),
				status: "ACTIVE",
				installments: {
					create: { seq: 1, scheduledAt: installmentDay, amount: "500.0000" },
				},
			},
			select: { id: true },
		});
		await ctx.prisma.planAllocation.create({
			data: { planId: plan.id, amount: "500.0000", usedAmount: "0.0000" },
		});
		return plan.id;
	}

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		u1 = await registerUser("owner-a");
		u2 = await registerUser("viewer-a");
		u3 = await registerUser("owner-c");

		// Org A = U1 注册兜底的默认组织
		const u1Default = await ctx.prisma.membership.findFirst({
			where: { userId: u1.userId, role: "OWNER", status: "ACTIVE" },
		});
		if (!u1Default) throw new Error("注册兜底未建默认组织");
		orgA = u1Default.organizationId;
		orgIds.push(orgA);
		await ctx.prisma.membership.create({
			data: { organizationId: orgA, userId: u2.userId, role: "VIEWER", status: "ACTIVE" },
		});
		await ensureOnboarded(ctx.prisma, u1.userId, "CNY");
		// 旧写路径产生的存量行（organizationId IS NULL）：仅在默认组织 A 可见
		await ctx.prisma.account.create({
			data: { userId: u1.userId, currencyCode: "USD", balance: "100.0000" },
		});
		await ctx.prisma.costLot.create({
			data: {
				userId: u1.userId,
				currencyCode: "USD",
				sourceType: "INITIAL",
				sourceId: `legacy-${Date.now()}`,
				quantity: "12.0000",
				remainingQty: "12.0000",
				unitCost: "7.0000000000",
				totalCost: "84.0000",
				acquiredAt: utc8Midday(-50),
			},
		});

		// Org B = U1 新建的空组织（未建账）
		const createdB = await request(app.getHttpServer())
			.post("/api/organizations")
			.set("Authorization", `Bearer ${u1.accessToken}`)
			.send({ name: "U1 新建的组织 B" })
			.expect(201);
		orgB = createdB.body.data.id;
		orgIds.push(orgB);

		// Org C = U3 的默认组织；U1 作为 FINANCE 加入；C 有自己的 USD 账户（组织行）
		const u3Default = await ctx.prisma.membership.findFirst({
			where: { userId: u3.userId, role: "OWNER", status: "ACTIVE" },
		});
		if (!u3Default) throw new Error("注册兜底未建默认组织");
		orgC = u3Default.organizationId;
		orgIds.push(orgC);
		await ctx.prisma.membership.create({
			data: { organizationId: orgC, userId: u1.userId, role: "FINANCE", status: "ACTIVE" },
		});
		await ensureOnboarded(ctx.prisma, u3.userId, "CNY");
		await ctx.prisma.account.create({
			data: {
				userId: u3.userId,
				organizationId: orgC,
				currencyCode: "USD",
				balance: "500.0000",
			},
		});
	}, 30_000);

	afterAll(async () => {
		await ctx.prisma.auditLog.deleteMany({
			where: { organizationId: { in: orgIds } },
		});
		await ctx.prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
		for (const userId of userIds) {
			await cleanupUser(ctx.prisma, userId);
		}
		await app.close();
	});

	it("I-08：默认组织内可见自己的存量 NULL 行与个人设置（回落正路径不变）", async () => {
		const accounts = await request(app.getHttpServer())
			.get("/api/accounts")
			.set(headers(u1, orgA))
			.expect(200);
		const usd = accounts.body.data.accounts.find(
			(item: { currencyCode: string }) => item.currencyCode === "USD",
		);
		expect(usd.balance).toBe("100.0000");
		expect(accounts.body.data.baseCurrency).toBe("CNY");

		const state = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(headers(u1, orgA))
			.expect(200);
		expect(state.body.data.onboardingCompleted).toBe(true);
		expect(state.body.data.hasAccounts).toBe(true);
	});

	it("I-08：用户新建的组织 B 不渗入其存量 NULL 行与个人设置", async () => {
		const accounts = await request(app.getHttpServer())
			.get("/api/accounts")
			.set(headers(u1, orgB))
			.expect(200);
		expect(accounts.body.data.accounts).toEqual([]);

		const state = await request(app.getHttpServer())
			.get("/api/home/state")
			.set(headers(u1, orgB))
			.expect(200);
		expect(state.body.data).toMatchObject({
			onboardingCompleted: false,
			hasAccounts: false,
		});

		const portfolio = await request(app.getHttpServer())
			.get("/api/home/portfolio")
			.set(headers(u1, orgB))
			.expect(200);
		expect(portfolio.body.data.byCurrency).toEqual([]);
		expect(portfolio.body.data.totalRemainingCost).toBe("0.0000");
		expect(portfolio.body.data.baseCurrency).toBeNull();

		const current = await request(app.getHttpServer())
			.get("/api/organizations/current")
			.set(headers(u1, orgB))
			.expect(200);
		expect(current.body.data).toMatchObject({
			onboardingCompleted: false,
			baseCurrency: null,
		});

		// 新建组织未建账：设置 409、建账状态 false（不回落创建者的个人设置）
		const settings = await request(app.getHttpServer())
			.get("/api/settings")
			.set(headers(u1, orgB))
			.expect(409);
		expect(settings.body.code).toBe("ONBOARDING_NOT_COMPLETED");
		const status = await request(app.getHttpServer())
			.get("/api/onboarding/status")
			.set(headers(u1, orgB))
			.expect(200);
		expect(status.body.data.completed).toBe(false);
		expect(status.body.data.settings).toBeNull();
	});

	it("I-08：组织列表对 A（默认，已建账）与 B（新建，未建账）分别报告建账态", async () => {
		const list = await request(app.getHttpServer())
			.get("/api/organizations")
			.set("Authorization", `Bearer ${u1.accessToken}`)
			.expect(200);
		const byId = new Map<string, { onboardingCompleted: boolean; baseCurrency: string | null }>(
			list.body.data.map((item: { id: string }) => [item.id, item]),
		);
		expect(byId.get(orgA)).toMatchObject({ onboardingCompleted: true, baseCurrency: "CNY" });
		expect(byId.get(orgB)).toMatchObject({ onboardingCompleted: false, baseCurrency: null });
		// 受邀加入的 C 以其所有者的设置为准（U3 已建账）
		expect(byId.get(orgC)).toMatchObject({ onboardingCompleted: true, baseCurrency: "CNY" });
	});

	it("I-08：受邀加入的组织 C 不混入个人 NULL 行——不产生重复币种、不混算余额与持仓", async () => {
		const accounts = await request(app.getHttpServer())
			.get("/api/accounts")
			.set(headers(u1, orgC))
			.expect(200);
		const usdRows = accounts.body.data.accounts.filter(
			(item: { currencyCode: string }) => item.currencyCode === "USD",
		);
		expect(usdRows).toHaveLength(1);
		expect(usdRows[0].balance).toBe("500.0000"); // 仅 C 的账户，不是 500 + 100

		const detail = await request(app.getHttpServer())
			.get("/api/accounts/USD")
			.set(headers(u1, orgC))
			.expect(200);
		expect(detail.body.data.balance).toBe("500.0000");
		expect(detail.body.data.remainingTotalCost).toBeNull(); // C 无批次；不得带出 U1 的 NULL 批次

		const portfolio = await request(app.getHttpServer())
			.get("/api/home/portfolio")
			.set(headers(u1, orgC))
			.expect(200);
		expect(portfolio.body.data.totalRemainingCost).toBe("0.0000");
	});

	it("I-10：受邀成员（无个人设置）在已建账组织可读设置、建账状态与提醒", async () => {
		const settings = await request(app.getHttpServer())
			.get("/api/settings")
			.set(headers(u2, orgA))
			.expect(200);
		expect(settings.body.data).toMatchObject({
			email: u2.email,
			baseCurrency: "CNY", // 组织（所有者）的本位币，而非成员本人——成员没有
			locale: "zh-CN",
			region: "CN",
		});

		const status = await request(app.getHttpServer())
			.get("/api/onboarding/status")
			.set(headers(u2, orgA))
			.expect(200);
		expect(status.body.data.completed).toBe(true);
		expect(status.body.data.settings.baseCurrency).toBe("CNY");

		const reminders = await request(app.getHttpServer())
			.get("/api/reminders")
			.set(headers(u2, orgA))
			.expect(200);
		expect(Array.isArray(reminders.body.data.items)).toBe(true);
	});

	it("I-11：已读态按成员独立——行主读过的一条 30 天前的提醒，对同组织其他成员仍是未读", async () => {
		// 计划 A1：排期节点在 40 天前，缺口 500 → 该日有 PREP_DUE 事项
		const installmentDay = utc8Midday(-40);
		planA1 = await seedPlan(orgA, installmentDay, utc8Midday(20));
		const reminder = await ctx.prisma.reminder.create({
			data: {
				userId: u1.userId,
				organizationId: orgA,
				planId: planA1,
				type: "PREP_DUE",
				dedupKey: `review-read-${Date.now()}`,
				scheduledFor: installmentDay,
				readAt: new Date(), // 行主 U1 已读
			},
		});
		ownerReadReminderId = reminder.id;

		// 行主本人：已读且不在近 30 天窗口 → 不再出现
		const ownerList = await request(app.getHttpServer())
			.get("/api/reminders")
			.set(headers(u1, orgA))
			.expect(200);
		expect(
			ownerList.body.data.items.map((item: { id: string }) => item.id),
		).not.toContain(ownerReadReminderId);

		// 成员 U2：从未读过 → 必须仍然看到，且 readAt 为空（计入未读）
		const viewerList = await request(app.getHttpServer())
			.get("/api/reminders")
			.set(headers(u2, orgA))
			.expect(200);
		const forViewer = viewerList.body.data.items.find(
			(item: { id: string }) => item.id === ownerReadReminderId,
		);
		expect(forViewer).toBeDefined();
		expect(forViewer.readAt).toBeNull();
		expect(viewerList.body.data.unreadCount).toBeGreaterThanOrEqual(1);

		// 行主的已读态未被成员的读取改动
		const row = await ctx.prisma.reminder.findUnique({ where: { id: ownerReadReminderId } });
		expect(row?.readAt).not.toBeNull();
	});

	it("I-11：提醒生成按当前组织作用域——读组织 C 不会为组织 A 的计划生成提醒", async () => {
		// 计划 A2：预计使用日 = 今天 → 读 A 的提醒时应生成 USE_DUE
		planA2 = await seedPlan(orgA, utc8Midday(-10), utc8Midday(0));

		// U1 在组织 C 读取：C 内没有 U1 的计划 → 不得为 A 的计划生成任何提醒
		await request(app.getHttpServer())
			.get("/api/reminders")
			.set(headers(u1, orgC))
			.expect(200);
		expect(
			await ctx.prisma.reminder.count({ where: { planId: { in: [planA1, planA2] } } }),
		).toBe(1); // 仅上一用例手工插入的那条

		// U1 在组织 A 读取：为 A 的计划生成提醒，且行归属随父计划（不是 NULL 行）
		await request(app.getHttpServer())
			.get("/api/reminders")
			.set(headers(u1, orgA))
			.expect(200);
		const generated = await ctx.prisma.reminder.findMany({
			where: { planId: planA2 },
		});
		expect(generated.length).toBeGreaterThanOrEqual(1);
		for (const row of generated) {
			expect(row.organizationId).toBe(orgA);
			expect(row.userId).toBe(u1.userId);
		}
	});
});

/**
 * 外部评审 R2 回归（R2-I02）：三个只读 @Post 预览端点的读作用域。
 *
 * 修复前三个预览只把 user.id 传给服务，BusinessOrgScopeGuard 形同虚设：
 * - 携带其他组织头仍按本人 userId 直查 → 带出本人别的组织的余额 caps / 账本重放（IDOR）；
 * - 受邀成员按自己的 userId 查 → 目标 404 或按自己的空账本计算。
 * 修复后预览与业务 GET 同口径：目标归属、账户/计划/账本行按 compatReadWhere(scope)，
 * 本位币取组织偏好（resolveOrganizationPreferences）。
 *
 * 构造：Org A（Owner U1，默认组织、个人本位币 CNY；组织行 USD 账户 1000 + 计划分配 200
 * + 两笔买入；另有一条仅本人在默认组织可见的存量 NULL 行 EUR 300）；U2 为 A 的 FINANCE；
 * Org B = U1 新建的空组织；Org C = U3 的默认组织（本位币 USD），U1 以 FINANCE 加入。
 */
describe("R2 回归：只读预览端点按组织作用域读取（R2-I02）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const userIds: string[] = [];
	const orgIds: string[] = [];

	let ownerA: TestUser;
	let financeA: TestUser;
	let ownerC: TestUser;
	let orgA: string;
	let orgB: string;
	let orgC: string;
	let planA: { id: string };
	let txnA: { id: string };

	const headers = (user: TestUser, org: string) => ({
		Authorization: `Bearer ${user.accessToken}`,
		"X-Organization-Id": org,
	});
	/** 排期预览请求体（远期用途日，断言不依赖时钟） */
	const scheduleBody = (targetCurrency: string) => ({
		targetCurrency,
		targetAmount: "100",
		expectUseDate: new Date(Date.now() + 60 * 86_400_000).toISOString(),
		prepLeadDays: 3,
		pacePreference: "balanced",
	});
	const post = (url: string, user: TestUser, org: string, body: unknown) =>
		request(app.getHttpServer()).post(url).set(headers(user, org)).send(body);
	const registerUser = (label: string) => registerR2User(app, label, userIds);

	/** 组织行买入（模拟 MIG-B 回填后的归属；手续费未知 → 预览可做手续费补录） */
	async function seedPurchase(
		quantity: string,
		principalAmount: string,
	): Promise<{ id: string }> {
		return ctx.prisma.transaction.create({
			data: {
				userId: ownerA.userId,
				organizationId: orgA,
				createdById: ownerA.userId,
				currencyCode: "USD",
				quantity,
				principalAmount,
				feeAmount: null,
				exchangeRate: "7.2000000000",
				rateSource: "identity",
				rateObservedAt: new Date(Date.now() - 10 * 86_400_000),
				transactedAt: new Date(Date.now() - 9 * 86_400_000),
			},
			select: { id: true },
		});
	}

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		ownerA = await registerUser("owner-a");
		financeA = await registerUser("finance-a");
		ownerC = await registerUser("owner-c");

		// Org A：U1 的默认组织，个人本位币 CNY
		orgA = await trackDefaultOrg(ctx.prisma, ownerA.userId, orgIds);
		await ctx.prisma.membership.create({
			data: { organizationId: orgA, userId: financeA.userId, role: "FINANCE", status: "ACTIVE" },
		});
		await ensureOnboarded(ctx.prisma, ownerA.userId, "CNY");
		await ctx.prisma.account.create({
			data: {
				userId: ownerA.userId,
				organizationId: orgA,
				createdById: ownerA.userId,
				currencyCode: "USD",
				balance: "1000.0000",
			},
		});
		planA = await ctx.prisma.plan.create({
			data: {
				userId: ownerA.userId,
				organizationId: orgA,
				createdById: ownerA.userId,
				targetCurrency: "USD",
				targetAmount: "500.0000",
				expectUseDate: new Date(Date.now() + 60 * 86_400_000),
				prepLeadDays: 3,
				latestPrepDate: new Date(Date.now() + 57 * 86_400_000),
				status: "ACTIVE",
			},
			select: { id: true },
		});
		await ctx.prisma.planAllocation.create({
			data: { planId: planA.id, amount: "200.0000", usedAmount: "0.0000" },
		});
		// 账本事件合计 = 账户余额 1000（600 + 400）：重放余额与分配 200 自洽，不触发 V2' 拦截
		txnA = await seedPurchase("600.0000", "4320.0000");
		await seedPurchase("400.0000", "2880.0000");
		// 存量 NULL 行（旧写路径）：逻辑上属默认组织 A，且仅本人可见
		await ctx.prisma.account.create({
			data: { userId: ownerA.userId, currencyCode: "EUR", balance: "300.0000" },
		});

		// Org B：U1 新建的空组织（未建账）
		const createdB = await request(app.getHttpServer())
			.post("/api/organizations")
			.set("Authorization", `Bearer ${ownerA.accessToken}`)
			.send({ name: "U1 新建的组织 B" })
			.expect(201);
		orgB = createdB.body.data.id;
		orgIds.push(orgB);

		// Org C：U3 的默认组织，本位币 USD；U1 以 FINANCE 加入（个人本位币仍是 CNY）
		orgC = await trackDefaultOrg(ctx.prisma, ownerC.userId, orgIds);
		await ctx.prisma.membership.create({
			data: { organizationId: orgC, userId: ownerA.userId, role: "FINANCE", status: "ACTIVE" },
		});
		await ensureOnboarded(ctx.prisma, ownerC.userId, "USD");
	}, 30_000);

	afterAll(async () => {
		await ctx.prisma.auditLog.deleteMany({
			where: { organizationId: { in: orgIds } },
		});
		await ctx.prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
		for (const userId of userIds) {
			await cleanupUser(ctx.prisma, userId);
		}
		await app.close();
	});

	it("R2-I02：带 Org B 头做排期预览，不带出 Org A 的余额 caps 与存量 NULL 行", async () => {
		const inB = await post("/api/plans/schedule-preview", ownerA, orgB, scheduleBody("USD")).expect(
			200,
		);
		// Org B 无账户无计划：caps 归零，而不是本人 Org A 的 800 / 100
		expect(inB.body.data.caps).toEqual({
			allocatableBalance: "0.0000",
			maxAllocatable: "0.0000",
		});
		// 存量 NULL 行（EUR 300）逻辑上属默认组织 A：在 B 的上下文同样不可见
		const inBNull = await post(
			"/api/plans/schedule-preview",
			ownerA,
			orgB,
			scheduleBody("EUR"),
		).expect(200);
		expect(inBNull.body.data.caps.allocatableBalance).toBe("0.0000");
	});

	it("R2-I02：带 Org B 头对 Org A 的计划做修改预览 → 404 PLAN_NOT_FOUND", async () => {
		const res = await post(`/api/plans/${planA.id}/adjust-preview`, ownerA, orgB, {
			newAllocAmount: "250",
		}).expect(404);
		expect(res.body.code).toBe("PLAN_NOT_FOUND");
	});

	it("R2-I02：带 Org B 头对 Org A 的交易做更正预览 → 404，不返回账本重放结果", async () => {
		const res = await post("/api/corrections/preview", ownerA, orgB, {
			targetType: "TRANSACTION",
			targetId: txnA.id,
			baseVersion: 1,
			reason: "手续费当时漏填",
			changes: { feeAmount: "10.00" },
		}).expect(404);
		expect(res.body.code).toBe("CORRECTION_TARGET_NOT_FOUND");
		expect(res.body.data).toBeUndefined();
	});

	it("对照：所有者在默认组织 A 内的三个预览不变（组织行 + 本人存量 NULL 行均可见）", async () => {
		const schedule = await post(
			"/api/plans/schedule-preview",
			ownerA,
			orgA,
			scheduleBody("USD"),
		).expect(200);
		expect(schedule.body.data.caps).toEqual({
			allocatableBalance: "800.0000", // 1000 − 计划分配 200
			maxAllocatable: "100.0000", // min(800, 还需准备 100)
		});
		// 本人存量 NULL 行在默认组织上下文可见
		const legacy = await post(
			"/api/plans/schedule-preview",
			ownerA,
			orgA,
			scheduleBody("EUR"),
		).expect(200);
		expect(legacy.body.data.caps.allocatableBalance).toBe("300.0000");

		const adjust = await post(`/api/plans/${planA.id}/adjust-preview`, ownerA, orgA, {
			newAllocAmount: "250",
		}).expect(200);
		expect(adjust.body.data.caps.unallocatedBalance).toBe("800.0000");

		const correction = await post("/api/corrections/preview", ownerA, orgA, {
			targetType: "TRANSACTION",
			targetId: txnA.id,
			baseVersion: 1,
			reason: "手续费当时漏填",
			changes: { feeAmount: "10.00" },
		}).expect(200);
		expect(correction.body.data.blockers).toEqual([]);
		expect(correction.body.data.impacts.balances).toEqual([
			{ currencyCode: "USD", before: "1000.0000", after: "1000.0000" },
		]);
	});

	it("R2-I02：受邀 FINANCE 成员的更正预览按组织账本重放（含同组织其他买入），blockers 为空", async () => {
		const correction = await post("/api/corrections/preview", financeA, orgA, {
			targetType: "TRANSACTION",
			targetId: txnA.id,
			baseVersion: 1,
			reason: "手续费当时漏填",
			changes: { feeAmount: "10.00" },
		}).expect(200);
		// 重放范围 = 组织账本（600 + 400 两笔买入），不是成员自己的空账本
		expect(correction.body.data.impacts.balances).toEqual([
			{ currencyCode: "USD", before: "1000.0000", after: "1000.0000" },
		]);
		expect(correction.body.data.blockers).toEqual([]);
		expect(correction.body.data.after.totalCost).toBe("4330.0000");
	});

	it("R2-I02：受邀 FINANCE 成员的排期预览按组织账本计算——不是自己的空账本，也不含行主的存量 NULL 行", async () => {
		const schedule = await post(
			"/api/plans/schedule-preview",
			financeA,
			orgA,
			scheduleBody("USD"),
		).expect(200);
		// 与所有者的结果一致（组织行跨成员共享）
		expect(schedule.body.data.caps).toEqual({
			allocatableBalance: "800.0000",
			maxAllocatable: "100.0000",
		});
		// 行主的 NULL 行仅本人可见：成员在 A 看不到 EUR 300
		const legacy = await post(
			"/api/plans/schedule-preview",
			financeA,
			orgA,
			scheduleBody("EUR"),
		).expect(200);
		expect(legacy.body.data.caps.allocatableBalance).toBe("0.0000");
	});

	it("R2-I02：受邀 FINANCE 成员可对组织的计划做修改预览，caps 取组织账户余额", async () => {
		const adjust = await post(`/api/plans/${planA.id}/adjust-preview`, financeA, orgA, {
			newAllocAmount: "250",
		}).expect(200);
		expect(adjust.body.data.valid).toBe(true);
		expect(adjust.body.data.before.allocAmount).toBe("200.0000");
		expect(adjust.body.data.caps.unallocatedBalance).toBe("800.0000");
	});

	it("R2-I02：预览的本位币取组织偏好——成员在组织 C 预览 C 的本位币 USD → 400，而非沿用个人本位币 CNY", async () => {
		const res = await post(
			"/api/plans/schedule-preview",
			ownerA,
			orgC,
			scheduleBody("USD"),
		).expect(400);
		expect(res.body.code).toBe("INVALID_PLAN_PARAMS");
		expect(res.body.message).toContain("本位币");
	});
});

/**
 * 外部评审 R2 回归（R2-I03）：所有权转移后默认组织不漂移。
 *
 * 修复前默认组织 =「最早的 ACTIVE OWNER 成员关系」：原所有者 A 把默认组织 A 转给 B 后，
 * A 最早的 ACTIVE OWNER 变成他后建的组织 C，于是
 * - A 的个人设置成了组织 C 的偏好（C 瞬间「已建账」并向 C 的成员带出 A 的本位币）；
 * - A 写下的存量 NULL 行从 A 消失、出现在 C；
 * - 组织 A 失去「所有者个人设置」回落，变回未建账（全端点 409）；
 * - MIG-B 重跑把 A 的行灌进 C。
 * 修复后默认组织 =「该用户创建的最早的组织」（见 authorization/default-organization.ts），
 * 且转移前把仍靠回落支撑的组织偏好固化为 OrganizationSettings。
 *
 * 构造：组织 A = A 的注册兜底组织（已建账 CNY，尚无 OrganizationSettings，即 OWNER_LEGACY；
 * 另有一条 A 的存量 NULL 行 EUR 300）；B 为 A 的 ADMIN 成员（接任者）；F 为 A 的 FINANCE
 * 成员，同时被邀入 A 显式新建的空组织 C。
 */
describe("R2 回归：所有权转移后默认组织不漂移（R2-I03）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const db = new PrismaClient();
	const userIds: string[] = [];
	const orgIds: string[] = [];

	let ownerA: TestUser;
	let successorB: TestUser;
	let memberF: TestUser;
	let orgA: string;
	let orgC: string;
	/** A 的存量 NULL 行（旧写路径产生）：逻辑上属其默认组织 A */
	let legacyAccountId: string;

	const TRANSFER = "/api/organizations/current/transfer-ownership";
	const headers = (user: TestUser, org: string) => ({
		Authorization: `Bearer ${user.accessToken}`,
		"X-Organization-Id": org,
	});
	const get = (url: string, user: TestUser, org: string) =>
		request(app.getHttpServer()).get(url).set(headers(user, org));
	/** GET /organizations/current 的 data */
	const current = async (user: TestUser, org: string) => {
		const res = await get("/api/organizations/current", user, org).expect(200);
		return res.body.data as {
			role: string;
			onboardingCompleted: boolean;
			baseCurrency: string | null;
		};
	};
	const usd = expect.objectContaining({ currencyCode: "EUR", balance: "300.0000" });

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		ownerA = await registerR2User(app, "drift-owner", userIds);
		successorB = await registerR2User(app, "drift-successor", userIds);
		memberF = await registerR2User(app, "drift-member", userIds);

		// 组织 A：A 的默认组织，已建账但设置仍是个人设置（无 OrganizationSettings）
		orgA = await trackDefaultOrg(ctx.prisma, ownerA.userId, orgIds);
		await ensureOnboarded(ctx.prisma, ownerA.userId, "CNY", null, {
			legacyOnly: true,
		});
		await ctx.prisma.membership.create({
			data: { organizationId: orgA, userId: successorB.userId, role: "ADMIN", status: "ACTIVE" },
		});
		await ctx.prisma.membership.create({
			data: { organizationId: orgA, userId: memberF.userId, role: "FINANCE", status: "ACTIVE" },
		});
		const legacy = await ctx.prisma.account.create({
			data: { userId: ownerA.userId, currencyCode: "EUR", balance: "300.0000" },
		});
		legacyAccountId = legacy.id;

		// 组织 C：A 显式新建的空组织，F 以 FINANCE 加入
		const createdC = await request(app.getHttpServer())
			.post("/api/organizations")
			.set("Authorization", `Bearer ${ownerA.accessToken}`)
			.send({ name: "A 后建的组织 C" })
			.expect(201);
		orgC = createdC.body.data.id;
		orgIds.push(orgC);
		await ctx.prisma.membership.create({
			data: { organizationId: orgC, userId: memberF.userId, role: "FINANCE", status: "ACTIVE" },
		});
	}, 30_000);

	afterAll(async () => {
		await ctx.prisma.auditLog.deleteMany({
			where: { organizationId: { in: orgIds } },
		});
		await ctx.prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
		for (const userId of userIds) {
			await cleanupUser(ctx.prisma, userId);
		}
		await app.close();
		await db.$disconnect();
	});

	it("R2-I03：默认组织按「创建者」识别——兜底组织与显式新建组织的首个成员关系都与组织同事务创建", async () => {
		for (const orgId of [orgA, orgC]) {
			const membership = await ctx.prisma.membership.findFirstOrThrow({
				where: { userId: ownerA.userId, organizationId: orgId },
				include: { organization: true },
			});
			// 默认组织判定的依据：成员关系与组织 created_at 恒等（Postgres 事务时间）
			expect(membership.createdAt.getTime(), orgId).toBe(
				membership.organization.createdAt.getTime(),
			);
		}
		expect(await resolveDefaultOrganizationId(db, ownerA.userId)).toBe(orgA);
		// 接任者与受邀成员在 A 的成员关系不是创建者关系：他们的默认组织是各自的兜底组织
		const successorDefault = await resolveDefaultOrganizationId(db, successorB.userId);
		expect(successorDefault).not.toBeNull();
		expect(successorDefault).not.toBe(orgA);
	});

	it("R2-I03：转移前基线——组织 A 靠原所有者个人设置回落为已建账；组织 C 未建账", async () => {
		expect(await current(ownerA, orgA)).toMatchObject({
			onboardingCompleted: true,
			baseCurrency: "CNY",
		});
		expect(await current(memberF, orgC)).toMatchObject({
			onboardingCompleted: false,
			baseCurrency: null,
		});
		// A 的存量 NULL 行在默认组织 A 的上下文里对 A 本人可见
		const accounts = await get("/api/accounts", ownerA, orgA).expect(200);
		expect(accounts.body.data.accounts).toEqual([usd]);
	});

	it("R2-I03：转移后——组织 A 固化自己的设置，原所有者的默认组织仍是 A，组织 C 不继承", async () => {
		const successorMembership = await ctx.prisma.membership.findFirstOrThrow({
			where: { organizationId: orgA, userId: successorB.userId },
		});
		const transferred = await request(app.getHttpServer())
			.post(TRANSFER)
			.set(headers(ownerA, orgA))
			.send({ targetMembershipId: successorMembership.id })
			.expect(200);
		expect(transferred.body.data.promotedId).toBe(successorMembership.id);

		// 组织 A：新所有者与成员照常读到已建账与本位币（此前转移后变 409）
		expect(await current(successorB, orgA)).toMatchObject({
			role: "OWNER",
			onboardingCompleted: true,
			baseCurrency: "CNY",
		});
		const settings = await get("/api/settings", memberF, orgA).expect(200);
		expect(settings.body.data.baseCurrency).toBe("CNY");
		// 组织 A 的偏好已是组织自己的行，不再依赖任何人的个人设置；审计留痕
		expect(
			await ctx.prisma.organizationSettings.findUnique({ where: { organizationId: orgA } }),
		).toMatchObject({ baseCurrency: "CNY" });
		const audit = await ctx.prisma.auditLog.findFirst({
			where: { organizationId: orgA, action: "owner.transfer" },
			orderBy: { createdAt: "desc" },
		});
		expect(audit?.detail).toMatchObject({ settingsMaterialized: true });

		// 原所有者（现为 ADMIN）：默认组织仍是 A，自己的存量 NULL 行留在原处
		expect(await resolveDefaultOrganizationId(db, ownerA.userId)).toBe(orgA);
		const stillThere = await get("/api/accounts", ownerA, orgA).expect(200);
		expect(stillThere.body.data.accounts).toEqual([usd]);

		// 组织 C：不继承原所有者的个人设置与存量行（此前瞬间变已建账并带出 EUR 300）
		expect(await current(memberF, orgC)).toMatchObject({
			onboardingCompleted: false,
			baseCurrency: null,
		});
		const inC = await get("/api/accounts", ownerA, orgC).expect(200);
		expect(inC.body.data.accounts).toEqual([]);

		// 组织列表口径一致
		const list = await request(app.getHttpServer())
			.get("/api/organizations")
			.set("Authorization", `Bearer ${ownerA.accessToken}`)
			.expect(200);
		const byId = new Map(
			list.body.data.map((item: { id: string }) => [item.id, item] as const),
		);
		expect(byId.get(orgA)).toMatchObject({
			role: "ADMIN",
			onboardingCompleted: true,
			baseCurrency: "CNY",
		});
		expect(byId.get(orgC)).toMatchObject({
			role: "OWNER",
			onboardingCompleted: false,
			baseCurrency: null,
		});
	});

	it("R2-I03：MIG-B 重跑把原所有者的存量行归回组织 A，而不是他后建的组织 C", async () => {
		const run = await backfillDefaultOrganizations(db, { userIds: [ownerA.userId] });
		expect(run.organizationsCreated).toBe(0);
		expect(
			(await db.account.findUniqueOrThrow({ where: { id: legacyAccountId } }))
				.organizationId,
		).toBe(orgA);
		// 行归位后对组织 A 全体成员可见（组织行跨成员共享）
		const forMember = await get("/api/accounts", memberF, orgA).expect(200);
		expect(forMember.body.data.accounts.map((a: { currencyCode: string }) => a.currencyCode)).toContain("EUR");
		expect(await reconcileMigration(db, { userIds: [ownerA.userId] })).toMatchObject({
			diffs: [],
		});
	});

	it("R2-I03：组织已有自己的设置时，再转移不重复固化（不覆盖组织设置）", async () => {
		// 模拟组织化写路径已独立修改过组织设置：转移不得用任何人的个人设置覆盖
		await db.organizationSettings.update({
			where: { organizationId: orgA },
			data: { baseCurrency: "USD" },
		});
		const ownerMembership = await ctx.prisma.membership.findFirstOrThrow({
			where: { organizationId: orgA, userId: ownerA.userId },
		});
		const back = await request(app.getHttpServer())
			.post(TRANSFER)
			.set(headers(successorB, orgA))
			.send({ targetMembershipId: ownerMembership.id })
			.expect(200);
		expect(back.body.data.promotedId).toBe(ownerMembership.id);
		const audit = await ctx.prisma.auditLog.findFirst({
			where: { organizationId: orgA, action: "owner.transfer" },
			orderBy: { createdAt: "desc" },
		});
		expect(audit?.detail).toMatchObject({ settingsMaterialized: false });
		expect(await current(ownerA, orgA)).toMatchObject({
			role: "OWNER",
			baseCurrency: "USD",
		});
	});
});
