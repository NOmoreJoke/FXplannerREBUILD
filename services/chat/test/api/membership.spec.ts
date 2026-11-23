import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	bearer,
	cleanupUser,
	createTestApp,
	mintAccessToken,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";
import { TEST_PASSWORD } from "../fixtures/test-credentials";
import { runBehindAdvisoryLock } from "../helpers/postgres-lock-barrier";
import {
	generateInvitationToken,
	hashInvitationToken,
} from "../../src/organization/invitation-rules";

/**
 * 接口测试 ↔ src/organization/{member,invitation}.controller.ts（MEM-01/02）
 *
 * 覆盖：邀请创建/幂等复用/摘要脱敏/邮箱不匹配/过期/撤回/接受后重放拒绝/
 * 并发接受单 Membership/Admin 越权管 Owner/被禁用成员恢复/所有权转移顺序/
 * 最后 Owner 409/角色边界矩阵；以及外部评审修复回归（RBAC 提权、邀请覆写
 * Owner、撤回资格、摘要 PII、非法角色 fail-closed、预览端点守卫、成员/邀请
 * 并发竞态的 advisory 锁 + 条件更新）。
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

/** 注册并登录（W18 起注册即建默认组织）；userIds 供 afterAll 的 cleanupUser 收尾 */
async function registerUser(
	app: INestApplication,
	label: string,
	userIds: string[],
): Promise<TestUser> {
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

/** 组织上下文请求头（鉴权 + X-Organization-Id） */
function hdr(user: TestUser, org: string): Record<string, string> {
	return {
		Authorization: `Bearer ${user.accessToken}`,
		"X-Organization-Id": org,
	};
}

/** 直接 DB 建成员行（邀请 API 另测；角色矩阵用例需要） */
async function seedMember(
	ctx: TestContext,
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

/** 当前组织的活跃 Owner 成员行（单活跃 Owner 不变量下唯一） */
async function findActiveOwner(ctx: TestContext, organizationId: string) {
	const owners = await ctx.prisma.membership.findMany({
		where: { organizationId, role: "OWNER", status: "ACTIVE" },
	});
	expect(owners).toHaveLength(1);
	return owners[0];
}

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

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		owner = await registerUser(app, "owner", userIds);
		admin = await registerUser(app, "admin", userIds);
		financeInvitee = await registerUser(app, "invitee", userIds);
		outsider = await registerUser(app, "outsider", userIds);

		const created = await request(app.getHttpServer())
			.post("/api/organizations")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.send({ name: "成员管理测试组织" })
			.expect(201);
		orgId = created.body.data.id;
		orgIds.push(orgId);
		await seedMember(ctx, orgId, admin.userId, "ADMIN");
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
		const operator = await registerUser(app, "operator", userIds);
		await seedMember(ctx, orgId,operator.userId, "OPERATOR");
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

	it("并发所有权转移：双提交恰一方成功，败方 409 TRANSFER_CONFLICT（唯一索引兜底）", async () => {
		// 场景：当前 Owner（admin，#10 转移后）同时向两个不同目标发起转移。
		// 事务串行化下第二个事务的提升撞 memberships_single_active_owner_uidx
		// → P2002 → 409 TRANSFER_CONFLICT（对抗审 R2 [Nit] 补测）。
		const members = await ctx.prisma.membership.findMany({
			where: { organizationId: orgId, status: "ACTIVE" },
		});
		const currentOwner = members.find((m) => m.role === "OWNER");
		const targets = members.filter(
			(m) => m.role !== "OWNER" && m.userId !== currentOwner?.userId,
		);
		expect(currentOwner).toBeDefined();
		expect(targets.length).toBeGreaterThanOrEqual(2);
		const ownerUser = [admin, owner, financeInvitee, outsider].find(
			(u) => u.userId === currentOwner?.userId,
		);
		expect(ownerUser).toBeDefined();

		// 不用 .expect(200)：直接读取两端响应状态，断言「恰一方 200、败方必为 409」
		// （评审 I-06：原 toBeGreaterThanOrEqual(1) 弱断言在双 200 时也能刷绿）
		const [first, second] = await Promise.all([
			request(app.getHttpServer())
				.post("/api/organizations/current/transfer-ownership")
				.set(hdr(ownerUser!, orgId))
				.send({ targetMembershipId: targets[0]!.id }),
			request(app.getHttpServer())
				.post("/api/organizations/current/transfer-ownership")
				.set(hdr(ownerUser!, orgId))
				.send({ targetMembershipId: targets[1]!.id }),
		]);
		const statuses = [first.status, second.status].sort();
		expect(statuses).toEqual([200, 409]);
		const loser = first.status === 409 ? first : second;
		expect(loser.body.code).toBe("TRANSFER_CONFLICT");
		// 终态不变量：仍恰一个活跃 Owner；owner.transfer 审计只写一条（败方回滚）
		const after = await ctx.prisma.membership.findMany({
			where: { organizationId: orgId, role: "OWNER", status: "ACTIVE" },
		});
		expect(after).toHaveLength(1);
		const transferAudits = await ctx.prisma.auditLog.count({
			where: { organizationId: orgId, action: "owner.transfer" },
		});
		// 此前「所有权转移」用例已写 1 条；本并发用例恰新增 1 条
		expect(transferAudits).toBe(2);
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
		const responses = await Promise.all([
			request(app.getHttpServer())
				.post(`/api/organization-invitations/${token}/accept`)
				.set("Authorization", `Bearer ${outsider.accessToken}`),
			request(app.getHttpServer())
				.post(`/api/organization-invitations/${token}/accept`)
				.set("Authorization", `Bearer ${outsider.accessToken}`),
		]);
		// 恰一方加入成功，败方 409（完整开放态条件消费，评审 I-07）
		expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
		const membershipCount = await ctx.prisma.membership.count({
			where: { organizationId: orgId, userId: outsider.userId },
		});
		expect(membershipCount).toBe(1);
	});
});

/**
 * 外部评审修复回归（Goal #3A R1）：RBAC 提权 / 邀请覆写 Owner / 撤回资格 /
 * 最后 Owner 409 可达 / 摘要 PII / 验证码账号受邀 / 非法角色 fail-closed /
 * 预览端点守卫 / 成员与邀请并发竞态（advisory 锁 + 条件更新）。
 * 独立 describe + 独立组织，避免与上方生命周期用例的状态耦合。
 */
describe("评审修复回归：RBAC、邀请状态机与成员并发", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const userIds: string[] = [];
	const orgIds: string[] = [];

	let ownerA: TestUser;
	let adminA: TestUser;
	let viewerA: TestUser;
	let outsiderX: TestUser;
	/** 纯验证码账号：User.email 为 null，邮箱只在已验证的 OtpIdentity 上 */
	let otpUser: { userId: string; accessToken: string; email: string };
	/** 发给 otpUser 的邀请 token（I-05 跨用例读取） */
	let otpInviteToken = "";
	let orgId: string;

	const MEMBERS = "/api/organizations/current/members";
	const INVITES = "/api/organizations/current/invitations";
	const TRANSFER = "/api/organizations/current/transfer-ownership";
	const ORG_LOCK_KEY = () => `membership:${orgId}`;

	const postInvite = (actor: TestUser, email: string, role: string) =>
		request(app.getHttpServer())
			.post(INVITES)
			.set(hdr(actor, orgId))
			.send({ email, role });
	const membershipOf = (userId: string) =>
		ctx.prisma.membership.findFirst({ where: { organizationId: orgId, userId } });

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		ownerA = await registerUser(app, "rev-owner", userIds);
		adminA = await registerUser(app, "rev-admin", userIds);
		viewerA = await registerUser(app, "rev-viewer", userIds);
		outsiderX = await registerUser(app, "rev-outsider", userIds);

		const created = await request(app.getHttpServer())
			.post("/api/organizations")
			.set(bearer(ownerA.accessToken))
			.send({ name: "评审回归组织" })
			.expect(201);
		orgId = created.body.data.id;
		orgIds.push(orgId);
		await seedMember(ctx, orgId, adminA.userId, "ADMIN");
		await seedMember(ctx, orgId, viewerA.userId, "VIEWER");

		const otpEmail = `rev-otp-${Date.now()}@example.com`;
		const otpAccount = await ctx.prisma.user.create({ data: {} });
		userIds.push(otpAccount.id);
		await ctx.prisma.otpIdentity.create({
			data: { userId: otpAccount.id, channel: "email", target: otpEmail },
		});
		otpUser = {
			userId: otpAccount.id,
			accessToken: mintAccessToken(app, otpAccount.id),
			email: otpEmail,
		};
	});

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

	it("I-01：Admin 不可把成员提拔为 Admin（新角色侧资格）；Owner 可以", async () => {
		const viewerMember = await membershipOf(viewerA.userId);
		expect(viewerMember?.role).toBe("VIEWER");

		const denied = await request(app.getHttpServer())
			.patch(`${MEMBERS}/${viewerMember?.id}`)
			.set(hdr(adminA, orgId))
			.send({ role: "ADMIN" })
			.expect(403);
		expect(denied.body.code).toBe("PERMISSION_DENIED");
		expect((await membershipOf(viewerA.userId))?.role).toBe("VIEWER");

		await request(app.getHttpServer())
			.patch(`${MEMBERS}/${viewerMember?.id}`)
			.set(hdr(ownerA, orgId))
			.send({ role: "ADMIN" })
			.expect(200);
		expect((await membershipOf(viewerA.userId))?.role).toBe("ADMIN");
		// 还原为 VIEWER（后续用例依赖其只读角色）
		await request(app.getHttpServer())
			.patch(`${MEMBERS}/${viewerMember?.id}`)
			.set(hdr(ownerA, orgId))
			.send({ role: "VIEWER" })
			.expect(200);
	});

	it("I-02：邀请已是有效成员的邮箱 → 409 MEMBER_ALREADY_ACTIVE（含唯一 Owner，防借邀请降级）", async () => {
		const cases = [
			[adminA, ownerA.email, "VIEWER"],
			[adminA, viewerA.email, "FINANCE"],
			[ownerA, adminA.email, "VIEWER"],
		] as const;
		for (const [actor, email, role] of cases) {
			const res = await postInvite(actor, email, role).expect(409);
			expect(res.body.code).toBe("MEMBER_ALREADY_ACTIVE");
		}
		// 零邀请行产生
		const count = await ctx.prisma.organizationInvitation.count({
			where: { organizationId: orgId },
		});
		expect(count).toBe(0);
	});

	it("I-02：接受时已是有效成员 → 409 且不覆写既有角色（Owner 仍为 Owner，邀请未消费）", async () => {
		// 绕过 create 的成员校验直插邀请行，模拟「邀请创建后目标才成为成员」的时间窗
		const token = generateInvitationToken();
		const invitation = await ctx.prisma.organizationInvitation.create({
			data: {
				organizationId: orgId,
				email: ownerA.email,
				role: "VIEWER",
				tokenHash: hashInvitationToken(token),
				invitedById: adminA.userId,
				expiresAt: new Date(Date.now() + 86_400_000),
			},
		});
		const res = await request(app.getHttpServer())
			.post(`/api/organization-invitations/${token}/accept`)
			.set(bearer(ownerA.accessToken))
			.expect(409);
		expect(res.body.code).toBe("INVITATION_NOT_ACCEPTABLE");
		expect((await findActiveOwner(ctx, orgId)).userId).toBe(ownerA.userId);
		const row = await ctx.prisma.organizationInvitation.findUnique({
			where: { id: invitation.id },
		});
		expect(row?.acceptedAt).toBeNull();
		await ctx.prisma.organizationInvitation.delete({
			where: { id: invitation.id },
		});
	});

	it("I-03：撤回资格按邀请角色判定——Admin 不可撤回 Owner 发出的 Admin 角色邀请", async () => {
		const created = await postInvite(ownerA, outsiderX.email, "ADMIN").expect(201);
		const denied = await request(app.getHttpServer())
			.delete(`${INVITES}/${created.body.data.id}`)
			.set(hdr(adminA, orgId))
			.expect(403);
		expect(denied.body.code).toBe("PERMISSION_DENIED");
		const stillOpen = await ctx.prisma.organizationInvitation.findUnique({
			where: { id: created.body.data.id },
		});
		expect(stillOpen?.revokedAt).toBeNull();

		const revoked = await request(app.getHttpServer())
			.delete(`${INVITES}/${created.body.data.id}`)
			.set(hdr(ownerA, orgId))
			.expect(200);
		expect(revoked.body.data.status).toBe("REVOKED");
	});

	it("I-04/N-06：Owner 自降/自移除 → 409 LAST_OWNER_REQUIRED；Admin 对 Owner → 403；已移除成员不可调整角色", async () => {
		const ownerMember = await findActiveOwner(ctx, orgId);
		const selfDemote = await request(app.getHttpServer())
			.patch(`${MEMBERS}/${ownerMember.id}`)
			.set(hdr(ownerA, orgId))
			.send({ role: "ADMIN" })
			.expect(409);
		expect(selfDemote.body.code).toBe("LAST_OWNER_REQUIRED");
		const selfRemove = await request(app.getHttpServer())
			.delete(`${MEMBERS}/${ownerMember.id}`)
			.set(hdr(ownerA, orgId))
			.expect(409);
		expect(selfRemove.body.code).toBe("LAST_OWNER_REQUIRED");

		const adminOnOwner = await request(app.getHttpServer())
			.patch(`${MEMBERS}/${ownerMember.id}`)
			.set(hdr(adminA, orgId))
			.send({ role: "VIEWER" })
			.expect(403);
		expect(adminOnOwner.body.code).toBe("PERMISSION_DENIED");
		await request(app.getHttpServer())
			.delete(`${MEMBERS}/${ownerMember.id}`)
			.set(hdr(adminA, orgId))
			.expect(403);
		expect((await findActiveOwner(ctx, orgId)).id).toBe(ownerMember.id);

		// N-06：已移除（DISABLED）成员不可调整角色
		const removedMember = await seedMember(
			ctx,
			orgId,
			outsiderX.userId,
			"VIEWER",
			"DISABLED",
		);
		const notActive = await request(app.getHttpServer())
			.patch(`${MEMBERS}/${removedMember}`)
			.set(hdr(ownerA, orgId))
			.send({ role: "FINANCE" })
			.expect(409);
		expect(notActive.body.code).toBe("MEMBER_NOT_ACTIVE");
		// 重复移除幂等（不报错、仍为 DISABLED）
		const again = await request(app.getHttpServer())
			.delete(`${MEMBERS}/${removedMember}`)
			.set(hdr(ownerA, orgId))
			.expect(200);
		expect(again.body.data.status).toBe("DISABLED");
	});

	it("I-05：受邀摘要仅受邀本人可读——他人持链接 403 且不返回组织/邀请人元数据", async () => {
		const created = await postInvite(ownerA, otpUser.email, "FINANCE").expect(201);
		otpInviteToken = created.body.data.token;
		const res = await request(app.getHttpServer())
			.get(`/api/organization-invitations/${otpInviteToken}`)
			.set(bearer(outsiderX.accessToken))
			.expect(403);
		expect(res.body.code).toBe("INVITATION_EMAIL_MISMATCH");
		expect(res.body.data).toBeUndefined();
		expect(JSON.stringify(res.body)).not.toContain("评审回归组织");
	});

	it("I-09：纯验证码账号（User.email 为空）凭已验证邮箱标识可读摘要并接受邀请", async () => {
		const summary = await request(app.getHttpServer())
			.get(`/api/organization-invitations/${otpInviteToken}`)
			.set(bearer(otpUser.accessToken))
			.expect(200);
		expect(summary.body.data.organizationName).toBe("评审回归组织");
		expect(summary.body.data.role).toBe("FINANCE");

		const accepted = await request(app.getHttpServer())
			.post(`/api/organization-invitations/${otpInviteToken}/accept`)
			.set(bearer(otpUser.accessToken))
			.expect(200);
		expect(accepted.body.data.role).toBe("FINANCE");
		const membership = await membershipOf(otpUser.userId);
		expect(membership?.status).toBe("ACTIVE");
		expect(membership?.role).toBe("FINANCE");
	});

	it("I-13：库内非法角色值 fail-closed（403 PERMISSION_DENIED），不放行业务读", async () => {
		const adminMember = await membershipOf(adminA.userId);
		await ctx.prisma.membership.update({
			where: { id: adminMember?.id ?? "" },
			data: { role: "SUPERUSER" },
		});
		try {
			for (const url of [
				"/api/accounts",
				"/api/plans",
				"/api/home/state",
				"/api/reports/plans",
				"/api/organizations/current",
				"/api/organizations/current/audit-logs",
			]) {
				const res = await request(app.getHttpServer())
					.get(url)
					.set(hdr(adminA, orgId))
					.expect(403);
				expect(res.body.code, url).toBe("PERMISSION_DENIED");
			}
		} finally {
			await ctx.prisma.membership.update({
				where: { id: adminMember?.id ?? "" },
				data: { role: "ADMIN" },
			});
		}
	});

	it("I-12：三个只读预览端点挂守卫——Viewer 403；被移除成员 404", async () => {
		// Viewer 缺 correction.preview / plan.adjust / plan.create → 守卫层 403（先于参数校验）
		const correctionDenied = await request(app.getHttpServer())
			.post("/api/corrections/preview")
			.set(hdr(viewerA, orgId))
			.send({})
			.expect(403);
		expect(correctionDenied.body.code).toBe("PERMISSION_DENIED");
		const adjustDenied = await request(app.getHttpServer())
			.post("/api/plans/c000000000000000000000000/adjust-preview")
			.set(hdr(viewerA, orgId))
			.send({})
			.expect(403);
		expect(adjustDenied.body.code).toBe("PERMISSION_DENIED");
		const scheduleDenied = await request(app.getHttpServer())
			.post("/api/plans/schedule-preview")
			.set(hdr(viewerA, orgId))
			.send({})
			.expect(403);
		expect(scheduleDenied.body.code).toBe("PERMISSION_DENIED");

		// 被移除成员：带旧 JWT 请求预览与业务 GET 一律 404（不泄露存在性）
		const viewerMember = await membershipOf(viewerA.userId);
		await ctx.prisma.membership.update({
			where: { id: viewerMember?.id ?? "" },
			data: { status: "DISABLED" },
		});
		try {
			const correctionGone = await request(app.getHttpServer())
				.post("/api/corrections/preview")
				.set(hdr(viewerA, orgId))
				.send({})
				.expect(404);
			expect(correctionGone.body.code).toBe("ORGANIZATION_NOT_FOUND");
			const adjustGone = await request(app.getHttpServer())
				.post("/api/plans/c000000000000000000000000/adjust-preview")
				.set(hdr(viewerA, orgId))
				.send({})
				.expect(404);
			expect(adjustGone.body.code).toBe("ORGANIZATION_NOT_FOUND");
			const accountsGone = await request(app.getHttpServer())
				.get("/api/accounts")
				.set(hdr(viewerA, orgId))
				.expect(404);
			expect(accountsGone.body.code).toBe("ORGANIZATION_NOT_FOUND");
		} finally {
			await ctx.prisma.membership.update({
				where: { id: viewerMember?.id ?? "" },
				data: { status: "ACTIVE" },
			});
		}
	});

	it("I-07：邀请 TOCTOU——取锁前已被撤回的邀请不可被接受（完整开放态条件消费）", async () => {
		const created = await postInvite(ownerA, outsiderX.email, "VIEWER").expect(201);
		const token = created.body.data.token;
		const res = await runBehindAdvisoryLock(
			ctx.prisma,
			ORG_LOCK_KEY(),
			() =>
				request(app.getHttpServer())
					.post(`/api/organization-invitations/${token}/accept`)
					.set(bearer(outsiderX.accessToken)),
			async () => {
				// accept 已阻塞在组织锁上：此刻撤回邀请（模拟并发 revoke 已提交）
				await ctx.prisma.organizationInvitation.update({
					where: { id: created.body.data.id },
					data: { revokedAt: new Date() },
				});
			},
		);
		expect(res.status).toBe(409);
		expect(res.body.code).toBe("INVITATION_NOT_ACCEPTABLE");
		// DISABLED 成员行未被恢复为 ACTIVE
		expect((await membershipOf(outsiderX.userId))?.status).toBe("DISABLED");
	});

	it("I-07：撤回与接受互斥——邀请已被接受后撤回 0 命中 → 409，revokedAt 保持为空", async () => {
		const created = await postInvite(ownerA, outsiderX.email, "VIEWER").expect(201);
		const res = await runBehindAdvisoryLock(
			ctx.prisma,
			ORG_LOCK_KEY(),
			() =>
				request(app.getHttpServer())
					.delete(`${INVITES}/${created.body.data.id}`)
					.set(hdr(ownerA, orgId)),
			async () => {
				// revoke 已阻塞在组织锁上：此刻邀请被并发接受
				await ctx.prisma.organizationInvitation.update({
					where: { id: created.body.data.id },
					data: { acceptedAt: new Date() },
				});
			},
		);
		expect(res.status).toBe(409);
		expect(res.body.code).toBe("INVITATION_NOT_ACCEPTABLE");
		const row = await ctx.prisma.organizationInvitation.findUnique({
			where: { id: created.body.data.id },
		});
		expect(row?.revokedAt).toBeNull();
	});

	it("I-06：所有权转移取锁后重读目标——目标已退出则拒绝，原 Owner 不被降级", async () => {
		const ownerMember = await findActiveOwner(ctx, orgId);
		const adminMember = await membershipOf(adminA.userId);
		const res = await runBehindAdvisoryLock(
			ctx.prisma,
			ORG_LOCK_KEY(),
			() =>
				request(app.getHttpServer())
					.post(TRANSFER)
					.set(hdr(ownerA, orgId))
					.send({ targetMembershipId: adminMember?.id }),
			async () => {
				// transfer 已阻塞在组织锁上：此刻目标并发退出已提交
				await ctx.prisma.membership.update({
					where: { id: adminMember?.id ?? "" },
					data: { status: "DISABLED" },
				});
			},
		);
		expect(res.status).toBe(400);
		expect(res.body.code).toBe("INVALID_ROLE");
		// 组织仍有活跃 Owner，且原 Owner 未被降级
		const after = await findActiveOwner(ctx, orgId);
		expect(after.id).toBe(ownerMember.id);
		expect(after.role).toBe("OWNER");
		// 恢复 adminA 供后续用例
		await ctx.prisma.membership.update({
			where: { id: adminMember?.id ?? "" },
			data: { status: "ACTIVE" },
		});
	});

	it("I-06：同一目标并发双转移——恰一方成功、败方 409 TRANSFER_CONFLICT、审计只写一条", async () => {
		const adminMember = await membershipOf(adminA.userId);
		const transfer = () =>
			request(app.getHttpServer())
				.post(TRANSFER)
				.set(hdr(ownerA, orgId))
				.send({ targetMembershipId: adminMember?.id });
		const [first, second] = await Promise.all([transfer(), transfer()]);
		expect([first.status, second.status].sort()).toEqual([200, 409]);
		const loser = first.status === 409 ? first : second;
		expect(loser.body.code).toBe("TRANSFER_CONFLICT");

		const newOwner = await findActiveOwner(ctx, orgId);
		expect(newOwner.id).toBe(adminMember?.id);
		const demoted = await membershipOf(ownerA.userId);
		expect(demoted?.role).toBe("ADMIN");
		const transferAudits = await ctx.prisma.auditLog.count({
			where: { organizationId: orgId, action: "owner.transfer" },
		});
		expect(transferAudits).toBe(1);
	});
});
