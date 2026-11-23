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
 * 接口测试 ↔ src/organization/{member,invitation}.controller.ts（MEM-01/02）
 *
 * 覆盖：邀请创建/幂等复用/摘要脱敏/邮箱不匹配/过期/撤回/接受后重放拒绝/
 * 并发接受单 Membership/Admin 越权管 Owner/被禁用成员恢复/所有权转移顺序/
 * 最后 Owner 409/角色边界矩阵。
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

describe("MemberController / InvitationController（e2e）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const userIds: string[] = [];
	const orgIds: string[] = [];

	let owner: TestUser;
	let admin: TestUser;
	let financeInvitee: TestUser;
	let outsider: TestUser;
	let orgId: string;

	/** 注册（W18 起注册即建默认组织——作为「已有其他组织」的用户） */
	async function registerUser(label: string): Promise<TestUser> {
		const email = `mem-${label}-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2, 6)}@example.com`;
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

	function hdr(user: TestUser, org: string): Record<string, string> {
		return {
			Authorization: `Bearer ${user.accessToken}`,
			"X-Organization-Id": org,
		};
	}

	async function seedMember(
		organizationId: string,
		userId: string,
		role: string,
		status = "ACTIVE",
	): Promise<string> {
		const membership = await ctx.prisma.membership.create({
			data: { organizationId, userId, role, status },
		});
		return membership.id;
	}

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		owner = await registerUser("owner");
		admin = await registerUser("admin");
		financeInvitee = await registerUser("invitee");
		outsider = await registerUser("outsider");

		const created = await request(app.getHttpServer())
			.post("/api/organizations")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.send({ name: "成员管理测试组织" })
			.expect(201);
		orgId = created.body.data.id;
		orgIds.push(orgId);
		await seedMember(orgId, admin.userId, "ADMIN");
	});

	afterAll(async () => {
		await ctx.prisma.auditLog.deleteMany({
			where: { organizationId: { in: orgIds } },
		});
		await ctx.prisma.membership.deleteMany({
			where: { organizationId: { in: orgIds } },
		});
		await ctx.prisma.organizationInvitation.deleteMany({
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

	let invitationToken = "";
	let invitationId = "";

	it("Owner 创建邀请：token 一次性发放 + 同事务审计 + 列表脱敏", async () => {
		const created = await request(app.getHttpServer())
			.post("/api/organizations/current/invitations")
			.set(hdr(owner, orgId))
			.send({ email: financeInvitee.email.toUpperCase(), role: "FINANCE" })
			.expect(201);
		expect(created.body.data.reused).toBe(false);
		expect(created.body.data.role).toBe("FINANCE");
		expect(created.body.data.email).toBe(financeInvitee.email); // 规范化小写
		invitationToken = created.body.data.token;
		expect(invitationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		invitationId = created.body.data.id;

		// 库内只存 hash：token 原文不出现在任何行
		const row = await ctx.prisma.organizationInvitation.findUnique({
			where: { id: invitationId },
		});
		expect(row?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
		expect(row?.tokenHash).not.toBe(invitationToken);

		const list = await request(app.getHttpServer())
			.get("/api/organizations/current/invitations")
			.set(hdr(owner, orgId))
			.expect(200);
		const serialized = JSON.stringify(list.body);
		expect(serialized).not.toContain(invitationToken);
		expect(serialized).not.toContain("tokenHash");
		expect(list.body.data[0].status).toBe("OPEN");
		// 注册路径不落 name（auth.register 只存 email/passwordHash）→ 显示名 null
		expect(list.body.data[0].invitedByName).toBeNull();

		const audit = await ctx.prisma.auditLog.findFirst({
			where: { organizationId: orgId, action: "invitation.create" },
		});
		expect(audit?.result).toBe("SUCCESS");
		// 审计 detail 不含 token 原文
		expect(JSON.stringify(audit?.detail)).not.toContain(invitationToken);
	});

	it("重复邀请同邮箱：幂等复用（reused=true，不重发 token）", async () => {
		const again = await request(app.getHttpServer())
			.post("/api/organizations/current/invitations")
			.set(hdr(owner, orgId))
			.send({ email: financeInvitee.email, role: "OPERATOR" })
			.expect(201);
		expect(again.body.data.reused).toBe(true);
		expect(again.body.data.id).toBe(invitationId);
		expect(again.body.data.token).toBe("");
		// 复用不新建行
		const count = await ctx.prisma.organizationInvitation.count({
			where: { organizationId: orgId },
		});
		expect(count).toBe(1);
	});

	it("禁邀 OWNER：DTO 层即拒（400，ASSIGNABLE_ROLES 白名单）；Operator 无邀请资格 403", async () => {
		// OWNER 不在可分配角色白名单——ValidationPipe 先拒（service 层 canManage 为第二道闸）
		await request(app.getHttpServer())
			.post("/api/organizations/current/invitations")
			.set(hdr(owner, orgId))
			.send({ email: outsider.email, role: "OWNER" })
			.expect(400);
		await request(app.getHttpServer())
			.post("/api/organizations/current/invitations")
			.set(hdr(admin, orgId))
			.send({ email: outsider.email, role: "OWNER" })
			.expect(400);
		const operator = await registerUser("operator");
		await seedMember(orgId, operator.userId, "OPERATOR");
		const res = await request(app.getHttpServer())
			.post("/api/organizations/current/invitations")
			.set(hdr(operator, orgId))
			.send({ email: outsider.email, role: "VIEWER" })
			.expect(403);
		expect(res.body.code).toBe("PERMISSION_DENIED");
		// 零邀请行产生（白名单外角色与无资格者均未落库）
		const invitations = await ctx.prisma.organizationInvitation.count({
			where: { organizationId: orgId, email: outsider.email },
		});
		expect(invitations).toBe(0);
	});

	it("受邀摘要：脱敏（组织名/角色/邀请人/状态）；无效 token 404", async () => {
		const summary = await request(app.getHttpServer())
			.get(`/api/organization-invitations/${invitationToken}`)
			.set("Authorization", `Bearer ${financeInvitee.accessToken}`)
			.expect(200);
		expect(summary.body.data.organizationName).toBe("成员管理测试组织");
		expect(summary.body.data.role).toBe("FINANCE");
		expect(summary.body.data.status).toBe("OPEN");
		// 无业务明细字段
		expect(summary.body.data.balance).toBeUndefined();
		expect(summary.body.data.accounts).toBeUndefined();

		await request(app.getHttpServer())
			.get("/api/organization-invitations/not-a-real-token")
			.set("Authorization", `Bearer ${financeInvitee.accessToken}`)
			.expect(404);
	});

	it("邮箱不匹配的登录用户拒绝（403，不产生成员关系）", async () => {
		const res = await request(app.getHttpServer())
			.post(`/api/organization-invitations/${invitationToken}/accept`)
			.set("Authorization", `Bearer ${outsider.accessToken}`)
			.expect(403);
		expect(res.body.code).toBe("INVITATION_EMAIL_MISMATCH");
		const membership = await ctx.prisma.membership.findFirst({
			where: { organizationId: orgId, userId: outsider.userId },
		});
		expect(membership).toBeNull();
	});

	it("接受邀请：成为 ACTIVE FINANCE；重放/再接受 409", async () => {
		const accepted = await request(app.getHttpServer())
			.post(`/api/organization-invitations/${invitationToken}/accept`)
			.set("Authorization", `Bearer ${financeInvitee.accessToken}`)
			.expect(200);
		expect(accepted.body.data.role).toBe("FINANCE");

		const membership = await ctx.prisma.membership.findUnique({
			where: {
				organizationId_userId: {
					organizationId: orgId,
					userId: financeInvitee.userId,
				},
			},
		});
		expect(membership?.status).toBe("ACTIVE");

		await request(app.getHttpServer())
			.post(`/api/organization-invitations/${invitationToken}/accept`)
			.set("Authorization", `Bearer ${financeInvitee.accessToken}`)
			.expect(409);

		const audit = await ctx.prisma.auditLog.findFirst({
			where: { organizationId: orgId, action: "invitation.accept" },
		});
		expect(audit?.actorUserId).toBe(financeInvitee.userId);
	});

	it("被移除成员重新获邀可恢复且历史记录操作者不丢（MEM-02.4）", async () => {
		// 移除（Owner 操作 financeInvitee）
		const members = await request(app.getHttpServer())
			.get("/api/organizations/current/members")
			.set(hdr(owner, orgId))
			.expect(200);
		const target = members.body.data.find(
			(m: { userId: string }) => m.userId === financeInvitee.userId,
		);
		await request(app.getHttpServer())
			.delete(`/api/organizations/current/members/${target.id}`)
			.set(hdr(owner, orgId))
			.expect(200);
		const removed = await ctx.prisma.membership.findUnique({
			where: { id: target.id },
		});
		expect(removed?.status).toBe("DISABLED"); // 保留行 = 历史归属

		// 再邀（同邮箱新建邀请——旧邀请已 ACCEPTED 不复用）
		const reinvite = await request(app.getHttpServer())
			.post("/api/organizations/current/invitations")
			.set(hdr(owner, orgId))
			.send({ email: financeInvitee.email, role: "OPERATOR" })
			.expect(201);
		expect(reinvite.body.data.reused).toBe(false);
		await request(app.getHttpServer())
			.post(`/api/organization-invitations/${reinvite.body.data.token}/accept`)
			.set("Authorization", `Bearer ${financeInvitee.accessToken}`)
			.expect(200);
		const restored = await ctx.prisma.membership.findUnique({
			where: { id: target.id },
		});
		expect(restored?.status).toBe("ACTIVE");
		expect(restored?.role).toBe("OPERATOR"); // 按新角色恢复
	});

	it("Admin 越权管 Owner：改角色/移除均 403（MEM-02.1）", async () => {
		const ownerMembership = await ctx.prisma.membership.findFirst({
			where: { organizationId: orgId, userId: owner.userId },
		});
		await request(app.getHttpServer())
			.patch(`/api/organizations/current/members/${ownerMembership?.id}`)
			.set(hdr(admin, orgId))
			.send({ role: "VIEWER" })
			.expect(403);
		await request(app.getHttpServer())
			.delete(`/api/organizations/current/members/${ownerMembership?.id}`)
			.set(hdr(admin, orgId))
			.expect(403);
	});

	it("所有权转移：先降后升顺序 + 转移后角色立即生效 + 审计含双方", async () => {
		const adminMembership = await ctx.prisma.membership.findFirst({
			where: { organizationId: orgId, userId: admin.userId },
		});
		const transferred = await request(app.getHttpServer())
			.post("/api/organizations/current/transfer-ownership")
			.set(hdr(owner, orgId))
			.send({ targetMembershipId: adminMembership?.id })
			.expect(200);
		expect(transferred.body.data.promotedId).toBe(adminMembership?.id);

		const after = await ctx.prisma.membership.findMany({
			where: { organizationId: orgId },
		});
		const newOwner = after.find((m) => m.userId === admin.userId);
		const demoted = after.find((m) => m.userId === owner.userId);
		expect(newOwner?.role).toBe("OWNER");
		expect(demoted?.role).toBe("ADMIN");
		// 单活跃 Owner 不变量仍成立
		const activeOwners = after.filter(
			(m) => m.role === "OWNER" && m.status === "ACTIVE",
		);
		expect(activeOwners).toHaveLength(1);

		const audit = await ctx.prisma.auditLog.findFirst({
			where: { organizationId: orgId, action: "owner.transfer" },
		});
		expect(audit?.actorUserId).toBe(owner.userId);
		const detail = audit?.detail as Record<string, unknown>;
		expect(detail.toUserId).toBe(admin.userId);

		// 转移后新 Owner 立即可用旧 JWT 管理组织（AUTH-02 实时生效）
		await request(app.getHttpServer())
			.get("/api/organizations/current/members")
			.set(hdr(admin, orgId))
			.expect(200);
		// 原 Owner（现 ADMIN）不可再转移
		await request(app.getHttpServer())
			.post("/api/organizations/current/transfer-ownership")
			.set(hdr(owner, orgId))
			.send({ targetMembershipId: adminMembership?.id })
			.expect(403);
	});

	it("最后 Owner 退出 409 LAST_OWNER_REQUIRED；转移后可退出", async () => {
		// admin 是唯一 Owner
		const res = await request(app.getHttpServer())
			.post("/api/organizations/current/members/leave")
			.set(hdr(admin, orgId))
			.expect(409);
		expect(res.body.code).toBe("LAST_OWNER_REQUIRED");
		// 非 Owner 成员可退出
		await request(app.getHttpServer())
			.post("/api/organizations/current/members/leave")
			.set(hdr(financeInvitee, orgId))
			.expect(200);
		const left = await ctx.prisma.membership.findFirst({
			where: { organizationId: orgId, userId: financeInvitee.userId },
		});
		expect(left?.status).toBe("DISABLED");
	});

	it("撤回邀请：OPEN → REVOKED；已结束邀请撤回 409", async () => {
		const created = await request(app.getHttpServer())
			.post("/api/organizations/current/invitations")
			.set(hdr(admin, orgId))
			.send({ email: outsider.email, role: "VIEWER" })
			.expect(201);
		const revoked = await request(app.getHttpServer())
			.delete(`/api/organizations/current/invitations/${created.body.data.id}`)
			.set(hdr(admin, orgId))
			.expect(200);
		expect(revoked.body.data.status).toBe("REVOKED");
		// 撤回后接受 409
		await request(app.getHttpServer())
			.post(`/api/organization-invitations/${created.body.data.token}/accept`)
			.set("Authorization", `Bearer ${outsider.accessToken}`)
			.expect(409);
		// 再撤回已结束邀请 → 409
		await request(app.getHttpServer())
			.delete(`/api/organizations/current/invitations/${created.body.data.id}`)
			.set(hdr(admin, orgId))
			.expect(409);
	});

	it("过期邀请不可接受（409 EXPIRED 语义）", async () => {
		const created = await request(app.getHttpServer())
			.post("/api/organizations/current/invitations")
			.set(hdr(admin, orgId))
			.send({ email: outsider.email, role: "VIEWER" })
			.expect(201);
		await ctx.prisma.organizationInvitation.update({
			where: { id: created.body.data.id },
			data: { expiresAt: new Date(Date.now() - 1000) },
		});
		await request(app.getHttpServer())
			.post(`/api/organization-invitations/${created.body.data.token}/accept`)
			.set("Authorization", `Bearer ${outsider.accessToken}`)
			.expect(409);
	});

	it("并发接受：仅一方成功，恰好一个有效 Membership（§14.2）", async () => {
		const created = await request(app.getHttpServer())
			.post("/api/organizations/current/invitations")
			.set(hdr(admin, orgId))
			.send({ email: outsider.email, role: "VIEWER" })
			.expect(201);
		const token = created.body.data.token;
		const results = await Promise.allSettled([
			request(app.getHttpServer())
				.post(`/api/organization-invitations/${token}/accept`)
				.set("Authorization", `Bearer ${outsider.accessToken}`)
				.expect(200),
			request(app.getHttpServer())
				.post(`/api/organization-invitations/${token}/accept`)
				.set("Authorization", `Bearer ${outsider.accessToken}`)
				.expect(200),
		]);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		expect(fulfilled).toHaveLength(1);
		const membershipCount = await ctx.prisma.membership.count({
			where: { organizationId: orgId, userId: outsider.userId },
		});
		expect(membershipCount).toBe(1);
	});
});
