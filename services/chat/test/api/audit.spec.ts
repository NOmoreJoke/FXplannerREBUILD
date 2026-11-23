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
 * 接口测试 ↔ src/audit/audit.controller.ts（AUDIT-03；技术方案 §7.2/§13.2）
 *
 * 覆盖：401 / 400 缺头 / 404 非成员（不泄露存在性）/ Owner-Admin 可读 /
 * Operator-Viewer 403（并落 DENIED 审计）/ 分页与动作筛选 / 无写删端点。
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

describe("AuditController（e2e）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const userIds: string[] = [];
	const orgIds: string[] = [];

	let owner: TestUser;
	let viewer: TestUser;
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
		const email = `audit-${label}-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2, 6)}@example.com`;
		await request(app.getHttpServer())
			.post("/api/auth/register")
			.send({ email, password: TEST_PASSWORD, name: `audit-${label}` })
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

	beforeAll(async () => {
		owner = await registerUser("owner");
		viewer = await registerUser("viewer");
		operator = await registerUser("operator");
		outsider = await registerUser("outsider");

		const created = await request(app.getHttpServer())
			.post("/api/organizations")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.send({ name: "审计测试组织" })
			.expect(201);
		orgIds.push(created.body.data.id);
		for (const [user, role] of [
			[viewer, "VIEWER"],
			[operator, "OPERATOR"],
		] as const) {
			await ctx.prisma.membership.create({
				data: { organizationId: orgIds[0]!, userId: user.userId, role, status: "ACTIVE" },
			});
		}
	});

	const auditUrl = "/api/organizations/current/audit-logs";

	it("无 token → 401；缺组织头 → 400 ORGANIZATION_REQUIRED", async () => {
		await request(app.getHttpServer()).get(auditUrl).expect(401);
		const res = await request(app.getHttpServer())
			.get(auditUrl)
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.expect(400);
		expect(res.body.code).toBe("ORGANIZATION_REQUIRED");
	});

	it("Owner 可读：组织创建审计在列；分页与动作筛选", async () => {
		const res = await request(app.getHttpServer())
			.get(auditUrl)
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgIds[0]!)
			.expect(200);
		expect(res.body.data.total).toBeGreaterThanOrEqual(1);
		const actions = res.body.data.items.map(
			(item: { action: string }) => item.action,
		);
		expect(actions).toContain("organization.create");
		// 审计视图不暴露任何 token/hash 类键（评审 N-07：原空转布尔表达式改为真断言）
		expect(JSON.stringify(res.body.data)).not.toMatch(/token_?hash/i);

		const page1 = await request(app.getHttpServer())
			.get(`${auditUrl}?page=1&pageSize=1&action=organization.create`)
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgIds[0]!)
			.expect(200);
		expect(page1.body.data.items).toHaveLength(1);
		expect(page1.body.data.items[0].action).toBe("organization.create");
	});

	it("Admin 可读（DB 直建成员）", async () => {
		const admin = await registerUser("admin");
		await ctx.prisma.membership.create({
			data: {
				organizationId: orgIds[0]!,
				userId: admin.userId,
				role: "ADMIN",
				status: "ACTIVE",
			},
		});
		await request(app.getHttpServer())
			.get(auditUrl)
			.set("Authorization", `Bearer ${admin.accessToken}`)
			.set("X-Organization-Id", orgIds[0]!)
			.expect(200);
	});

	it("Operator/Viewer → 403 PERMISSION_DENIED 且落 DENIED 审计", async () => {
		for (const user of [viewer, operator]) {
			const res = await request(app.getHttpServer())
				.get(auditUrl)
				.set("Authorization", `Bearer ${user.accessToken}`)
				.set("X-Organization-Id", orgIds[0]!)
				.expect(403);
			expect(res.body.code).toBe("PERMISSION_DENIED");
		}
		const denied = await ctx.prisma.auditLog.findFirst({
			where: {
				organizationId: orgIds[0]!,
				action: "permission.denied.audit.read",
				result: "DENIED",
			},
		});
		expect(denied).not.toBeNull();
		expect(denied?.actorUserId).toBe(viewer.userId);
		// Owner 侧确认 DENIED 行可读（审计只读闭环）
		const ownerSee = await request(app.getHttpServer())
			.get(`${auditUrl}?result=DENIED`)
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgIds[0]!)
			.expect(200);
		expect(ownerSee.body.data.total).toBeGreaterThanOrEqual(1);
	});

	it("非成员 → 404（不泄露存在性）", async () => {
		const res = await request(app.getHttpServer())
			.get(auditUrl)
			.set("Authorization", `Bearer ${outsider.accessToken}`)
			.set("X-Organization-Id", orgIds[0]!)
			.expect(404);
		expect(res.body.code).toBe("ORGANIZATION_NOT_FOUND");
	});

	it("审计无写/删端点（AUDIT-03.3：PATCH/DELETE 均 404）", async () => {
		for (const method of ["patch", "delete", "post"] as const) {
			await request(app.getHttpServer())
				[method](auditUrl)
				.set("Authorization", `Bearer ${owner.accessToken}`)
				.set("X-Organization-Id", orgIds[0]!)
				.expect(404);
		}
	});
});
