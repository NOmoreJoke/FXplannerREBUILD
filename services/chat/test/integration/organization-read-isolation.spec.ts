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
