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
import { runBehindAdvisoryLock } from "../helpers/postgres-lock-barrier";

/**
 * 接口测试 ↔ src/organization/organization.controller.ts（技术方案 §7.2）
 *
 * 覆盖 §14.2 通用矩阵：无 token 401、缺/非法 X-Organization-Id 400、
 * 非成员/他组织/不存在 404（不泄露存在性）、降权秒级生效（AUTH-02）、
 * Operator/Viewer 403、新建组织独立未建账（ORG-01.5）。
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

describe("OrganizationController（e2e）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const userIds: string[] = [];
	const orgIds: string[] = [];

	let owner: TestUser;
	let member: TestUser;
	let operator: TestUser;
	let outsider: TestUser;

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
	});

	afterAll(async () => {
		await ctx.prisma.auditLog.deleteMany({
			where: { organizationId: { in: orgIds } },
		});
		await ctx.prisma.organization.deleteMany({
			where: { id: { in: orgIds } },
		});
		for (const userId of userIds) {
			await cleanupUser(ctx.prisma, userId);
		}
		await app.close();
	});

	async function registerUser(label: string): Promise<TestUser> {
		const email = `org-${label}-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2, 6)}@example.com`;
		await request(app.getHttpServer())
			.post("/api/auth/register")
			.send({ email, password: TEST_PASSWORD, name: `org-${label}` })
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

	/** 直接 DB 建成员行（邀请 API 属 W19；角色矩阵测试需要） */
	async function seedMembership(
		organizationId: string,
		userId: string,
		role: string,
	): Promise<void> {
		await ctx.prisma.membership.create({
			data: { organizationId, userId, role, status: "ACTIVE" },
		});
	}

	beforeAll(async () => {
		owner = await registerUser("owner");
		member = await registerUser("member");
		operator = await registerUser("operator");
		outsider = await registerUser("outsider");
	});

	it("无 token 访问组织端点 → 401", async () => {
		await request(app.getHttpServer())
			.get("/api/organizations")
			.expect(401);
		await request(app.getHttpServer())
			.get("/api/organizations/current")
			.expect(401);
	});

	it("POST /organizations：创建者 OWNER + 空设置待建账 + 同事务审计", async () => {
		const created = await request(app.getHttpServer())
			.post("/api/organizations")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.send({ name: "  张三的外贸工作台  " })
			.expect(201);
		expect(created.body.success).toBe(true);
		expect(created.body.data.role).toBe("OWNER");
		const orgId = created.body.data.id;
		orgIds.push(orgId);
		expect(created.body.data.name).toBe("张三的外贸工作台");

		// 无 OrganizationSettings：新组织独立待建账（ORG-01.5 不复制任何数据）
		const settings = await ctx.prisma.organizationSettings.findUnique({
			where: { organizationId: orgId },
		});
		expect(settings).toBeNull();
		const membership = await ctx.prisma.membership.findUnique({
			where: {
				organizationId_userId: { organizationId: orgId, userId: owner.userId },
			},
		});
		expect(membership?.role).toBe("OWNER");
		expect(membership?.status).toBe("ACTIVE");

		// 同事务审计（AUDIT-01 组织创建必记）
		const audit = await ctx.prisma.auditLog.findFirst({
			where: { organizationId: orgId, action: "organization.create" },
		});
		expect(audit?.result).toBe("SUCCESS");
		expect(audit?.actorUserId).toBe(owner.userId);
	});

	it("GET /organizations：列出本人组织与角色", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/organizations")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.expect(200);
		const mine = res.body.data as Array<{ id: string; role: string }>;
		expect(
			mine.some((item) => orgIds.includes(item.id) && item.role === "OWNER"),
		).toBe(true);
		// W18 注册兜底：新注册用户立即拥有唯一默认组织（OWNER/待建账）
		const outsiderRes = await request(app.getHttpServer())
			.get("/api/organizations")
			.set("Authorization", `Bearer ${outsider.accessToken}`)
			.expect(200);
		expect(outsiderRes.body.data).toHaveLength(1);
		expect(outsiderRes.body.data[0].role).toBe("OWNER");
		expect(outsiderRes.body.data[0].onboardingCompleted).toBe(false);
	});

	it("GET /organizations/current：缺头 400 / 非法头 400 / 不存在 404", async () => {
		const auth = { Authorization: `Bearer ${owner.accessToken}` };
		const missing = await request(app.getHttpServer())
			.get("/api/organizations/current")
			.set(auth)
			.expect(400);
		expect(missing.body.code).toBe("ORGANIZATION_REQUIRED");

		const malformed = await request(app.getHttpServer())
			.get("/api/organizations/current")
			.set(auth)
			.set("X-Organization-Id", "not-a-cuid")
			.expect(400);
		expect(malformed.body.code).toBe("ORGANIZATION_REQUIRED");

		const notFound = await request(app.getHttpServer())
			.get("/api/organizations/current")
			.set(auth)
			.set("X-Organization-Id", "c000000000000000000000000")
			.expect(404);
		expect(notFound.body.code).toBe("ORGANIZATION_NOT_FOUND");
	});

	it("GET /organizations/current：返回角色、capabilities 与待建账状态", async () => {
		const orgId = orgIds[0]!;
		const res = await request(app.getHttpServer())
			.get("/api/organizations/current")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(200);
		expect(res.body.data.role).toBe("OWNER");
		expect(res.body.data.capabilities["organization.read"]).toBe(true);
		expect(res.body.data.capabilities["owner.transfer"]).toBe(true);
		expect(res.body.data.capabilities["audit.read"]).toBe(true);
		expect(res.body.data.onboardingCompleted).toBe(false);
		expect(res.body.data.baseCurrency).toBeNull();
		expect(res.body.data.dataRequestLock.active).toBe(false);
	});

	it("PATCH /organizations/current：改名成功并同事务审计", async () => {
		const orgId = orgIds[0]!;
		const res = await request(app.getHttpServer())
			.patch("/api/organizations/current")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({ name: "改名后的工作台" })
			.expect(200);
		expect(res.body.data.name).toBe("改名后的工作台");
		const audit = await ctx.prisma.auditLog.findFirst({
			where: { organizationId: orgId, action: "organization.update" },
		});
		expect(audit?.result).toBe("SUCCESS");
	});

	it("新建第二个组织：独立未建账、不复制第一个组织数据", async () => {
		const created = await request(app.getHttpServer())
			.post("/api/organizations")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.send({ name: "第二个组织" })
			.expect(201);
		orgIds.push(created.body.data.id);

		// 第一个组织先造一笔业务数据
		await ctx.prisma.account.create({
			data: {
				userId: owner.userId,
				organizationId: orgIds[0]!,
				currencyCode: "TST",
				balance: "100.0000",
			},
		});

		const second = await request(app.getHttpServer())
			.get("/api/organizations/current")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", created.body.data.id)
			.expect(200);
		expect(second.body.data.onboardingCompleted).toBe(false);
		expect(second.body.data.baseCurrency).toBeNull();

		const secondAccounts = await ctx.prisma.account.count({
			where: { organizationId: created.body.data.id },
		});
		expect(secondAccounts).toBe(0);
	});

	it("非成员/他组织访问 current → 404（不泄露存在性）", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/organizations/current")
			.set("Authorization", `Bearer ${outsider.accessToken}`)
			.set("X-Organization-Id", orgIds[0]!)
			.expect(404);
		expect(res.body.code).toBe("ORGANIZATION_NOT_FOUND");
	});

	it("降权秒级生效：DB 降为 VIEWER 后同一旧 JWT 立即按 VIEWER 拒绝（AUTH-02）", async () => {
		const orgId = orgIds[0]!;
		await seedMembership(orgId, member.userId, "ADMIN");
		// ADMIN 可改名
		await request(app.getHttpServer())
			.patch("/api/organizations/current")
			.set("Authorization", `Bearer ${member.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({ name: "管理员改名" })
			.expect(200);

		// 直接 DB 降权（不等待 JWT 过期）
		await ctx.prisma.membership.update({
			where: {
				organizationId_userId: { organizationId: orgId, userId: member.userId },
			},
			data: { role: "VIEWER" },
		});
		await request(app.getHttpServer())
			.patch("/api/organizations/current")
			.set("Authorization", `Bearer ${member.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({ name: "降权后应失败" })
			.expect(403);
		// GET current（organization.read）对 VIEWER 仍放行
		await request(app.getHttpServer())
			.get("/api/organizations/current")
			.set("Authorization", `Bearer ${member.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(200);
	});

	it("R3-N1：改名取锁后重读操作者——Guard 放行后被降权的 Admin 改名 → 403，不留成功审计", async () => {
		const orgId = orgIds[0]!;
		const memberWhere = {
			organizationId_userId: { organizationId: orgId, userId: member.userId },
		};
		await ctx.prisma.membership.update({
			where: memberWhere,
			data: { role: "ADMIN" },
		});
		const auditWhere = { organizationId: orgId, action: "organization.update" };
		const auditCountBefore = await ctx.prisma.auditLog.count({
			where: auditWhere,
		});

		const res = await runBehindAdvisoryLock(
			ctx.prisma,
			`membership:${orgId}`,
			() =>
				request(app.getHttpServer())
					.patch("/api/organizations/current")
					.set("Authorization", `Bearer ${member.accessToken}`)
					.set("X-Organization-Id", orgId)
					.send({ name: "锁内降权后的改名" }),
			async () => {
				// 改名请求已阻塞在组织锁上：此刻并发的降权已提交
				await ctx.prisma.membership.update({
					where: memberWhere,
					data: { role: "VIEWER" },
				});
			},
		);

		// 资格只用锁内重读到的最新角色：请求以 ADMIN 身份通过 Guard，但此刻已是 VIEWER
		expect(res.status).toBe(403);
		expect(res.body.code).toBe("PERMISSION_DENIED");
		const organization = await ctx.prisma.organization.findUnique({
			where: { id: orgId },
			select: { name: true },
		});
		expect(organization?.name).not.toBe("锁内降权后的改名");
		const auditCountAfter = await ctx.prisma.auditLog.count({
			where: auditWhere,
		});
		expect(auditCountAfter).toBe(auditCountBefore);
	});

	it("Operator/Viewer 调 PATCH /current → 403 PERMISSION_DENIED", async () => {
		const orgId = orgIds[0]!;
		await seedMembership(orgId, operator.userId, "OPERATOR");
		const res = await request(app.getHttpServer())
			.patch("/api/organizations/current")
			.set("Authorization", `Bearer ${operator.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({ name: "operator 应失败" })
			.expect(403);
		expect(res.body.code).toBe("PERMISSION_DENIED");
	});
});
