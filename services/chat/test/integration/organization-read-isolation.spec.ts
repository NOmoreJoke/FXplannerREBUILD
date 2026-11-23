import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	cleanupUser,
	createTestApp,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";
import { TEST_PASSWORD } from "../fixtures/test-credentials";
import { ensureOnboarded } from "../helpers/onboarding-helper";

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
