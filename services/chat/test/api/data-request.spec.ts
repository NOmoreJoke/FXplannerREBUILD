import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveDefaultOrganizationId } from "../../src/authorization/default-organization";
import { PERSONAL_EXPORT_PATHS } from "../../src/data-request/export-builder";
import {
	cleanupUser,
	type TestUser,
} from "../helpers/test-app";
import {
	completeOnboarding,
	createDataRequestTestApp,
	sendAndVerify,
	type DataRequestTestEnv,
} from "../helpers/data-request-helper";

/**
 * 接口测试 ↔ src/data-request/data-request.controller.ts（account-data 方案 §10.2）
 *
 * 覆盖：鉴权 / 未建账 / OTP purpose 透传 / verify 用途隔离 / EXPORT 同步生成与
 * 重放 / 确认窗口 / 互斥 / IMPACT_CHANGED / 锁定守卫 / 撤回 / 下载期限与越权 /
 * OTP 登录回归。
 */

// 关闭全局接口限流（先例 plan-usage.spec——APP_GUARD token 无法 override，只能 mock 类）
vi.mock("@nestjs/throttler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nestjs/throttler")>();
	class NoopThrottlerGuard {
		async canActivate() {
			return true;
		}
	}
	return { ...actual, ThrottlerGuard: NoopThrottlerGuard };
});

describe("DataRequestController（e2e）", () => {
	let env: DataRequestTestEnv;
	let app: INestApplication;
	const userIds: string[] = [];

	let user: TestUser;
	let other: TestUser;

	beforeAll(async () => {
		env = await createDataRequestTestApp();
		app = env.app;
	});

	afterAll(async () => {
		for (const userId of userIds) {
			await cleanupUser(env.prisma, userId);
		}
		await app.close();
	});

	/** 注册并完成首次设置 */
	async function onboardedUser(label: string): Promise<TestUser> {
		const created = await request(app.getHttpServer())
			.post("/api/auth/register")
			.send({
				email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
				password: ["Data", "Pass", "123"].join(""),
				name: label,
			})
			.expect(201);
		const email = created.body.data.user.email as string;
		const login = await request(app.getHttpServer())
			.post("/api/auth/login")
			.send({ email, password: ["Data", "Pass", "123"].join("") })
			.expect(200);
		const userId = created.body.data.user.id as string;
		const defaultOrganizationId = await defaultOrgIdOf(userId);
		const result: TestUser = {
			email,
			password: ["Data", "Pass", "123"].join(""),
			accessToken: login.body.data.accessToken,
			userId,
			defaultOrganizationId,
		};
		userIds.push(result.userId);
		await completeOnboarding(app, result);
		return result;
	}

	/** 注册用户的默认组织（注册兜底：组织与首位 OWNER 成员关系同事务创建） */
	async function defaultOrgIdOf(userId: string): Promise<string> {
		const organizationId = await resolveDefaultOrganizationId(env.prisma, userId);
		if (!organizationId) throw new Error("注册兜底未建默认组织");
		return organizationId;
	}

	/**
	 * 把 from 的默认组织所有权转给 to（先降后升：memberships_single_active_owner_uidx
	 * 顺序保护——同一组织只允许一个 ACTIVE OWNER）。用于让用户不再是任何组织的唯一所有者。
	 */
	async function transferDefaultOrgOwnership(
		fromUserId: string,
		toUserId: string,
	): Promise<string> {
		const organizationId = await defaultOrgIdOf(fromUserId);
		await env.prisma.membership.create({
			data: { organizationId, userId: toUserId, role: "ADMIN", status: "ACTIVE" },
		});
		await env.prisma.membership.updateMany({
			where: { organizationId, userId: fromUserId, role: "OWNER", status: "ACTIVE" },
			data: { role: "ADMIN" },
		});
		await env.prisma.membership.updateMany({
			where: { organizationId, userId: toUserId, role: "ADMIN", status: "ACTIVE" },
			data: { role: "OWNER" },
		});
		return organizationId;
	}

	/** 下载导出包为 Buffer（application/zip 无内置解析器）；组织域下载须带组织头 */
	async function downloadZip(
		url: string,
		token: string,
		organizationId?: string,
	): Promise<Buffer> {
		const res = await request(app.getHttpServer())
			.get(url)
			.set("Authorization", `Bearer ${token}`)
			.set(organizationId ? { "X-Organization-Id": organizationId } : {})
			.buffer(true)
			.parse((response, callback) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => callback(null, Buffer.concat(chunks)));
			});
		if (res.status !== 200) {
			throw new Error(`downloadZip ${url} got ${res.status}: ${res.text}`);
		}
		return res.body as Buffer;
	}

	it("未登录访问全部端点 → 401（个人域 + 组织域两套路由）", async () => {
		await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.expect(401);
		await request(app.getHttpServer())
			.get("/api/organizations/current/data-requests/current")
			.expect(401);
		await request(app.getHttpServer())
			.get("/api/organizations/current/data-requests/impact")
			.expect(401);
		await request(app.getHttpServer())
			.post("/api/data-requests/verify")
			.send({})
			.expect(401);
		await request(app.getHttpServer())
			.post("/api/data-requests")
			.send({})
			.expect(401);
		await request(app.getHttpServer())
			.post("/api/organizations/current/data-requests")
			.send({})
			.expect(401);
		await request(app.getHttpServer())
			.post("/api/data-requests/nope/cancel")
			.send({})
			.expect(401);
		await request(app.getHttpServer())
			.post("/api/organizations/current/data-requests/nope/cancel")
			.send({})
			.expect(401);
		await request(app.getHttpServer())
			.get("/api/data-requests/nope/download")
			.expect(401);
		await request(app.getHttpServer())
			.get("/api/organizations/current/data-requests/nope/download")
			.expect(401);
	});

	it("未完成首次设置：组织域请求 409 ONBOARDING_NOT_COMPLETED；个人导出不受建账限制（DATA-01：本人 + 二次验证）", async () => {
		const created = await request(app.getHttpServer())
			.post("/api/auth/register")
			.send({
				email: `raw-user-${Date.now()}@example.com`,
				password: ["Data", "Pass", "123"].join(""),
			})
			.expect(201);
		const rawToken = created.body.data.accessToken as string;
		const rawEmail = created.body.data.user.email as string;
		userIds.push(created.body.data.user.id);

		// 清空影响 / 组织导出是组织数据请求：组织尚未建账 → 409
		const rawOrgId = await defaultOrgIdOf(created.body.data.user.id as string);
		const impact = await request(app.getHttpServer())
			.get("/api/organizations/current/data-requests/impact")
			.set("Authorization", `Bearer ${rawToken}`)
			.set("X-Organization-Id", rawOrgId)
			.expect(409);
		expect(impact.body.code).toBe("ONBOARDING_NOT_COMPLETED");

		// 个人导出只含个人数据，与组织是否建账无关：未建账用户同样可以导出
		const { challengeId } = await sendAndVerify(
			app,
			env.otpChannel,
			rawToken,
			rawEmail,
			"EXPORT",
		);
		const personal = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${rawToken}`)
			.send({ type: "EXPORT", scope: "PERSONAL", challengeId })
			.expect(200);
		expect(personal.body.data).toMatchObject({
			type: "EXPORT",
			scope: "PERSONAL",
			organizationId: null,
			status: "COMPLETED",
		});

		// 同一用户改申请组织导出：个人导出不能顶替组织导出（幂等返回仅限同域），
		// 组织尚未建账 → 409
		const orgCredential = await sendAndVerify(
			app,
			env.otpChannel,
			rawToken,
			rawEmail,
			"EXPORT",
		);
		const orgExport = await request(app.getHttpServer())
			.post("/api/organizations/current/data-requests")
			.set("Authorization", `Bearer ${rawToken}`)
			.set("X-Organization-Id", rawOrgId)
			.send({ type: "EXPORT", scope: "ORGANIZATION", challengeId: orgCredential.challengeId })
			.expect(409);
		expect(orgExport.body.code).toBe("ONBOARDING_NOT_COMPLETED");
	});

	it("send-code 携带 purpose=CLEAR / 缺省（登录回归不受影响）", async () => {
		user = await onboardedUser("dr-main");
		other = await onboardedUser("dr-other");

		await request(app.getHttpServer())
			.post("/api/auth/otp/send-code")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ channel: "email", target: user.email, purpose: "CLEAR" })
			.expect(200);
		const clearChallenge = await env.prisma.otpChallenge.findFirstOrThrow({
			where: { target: user.email, purpose: "CLEAR" },
			orderBy: { createdAt: "desc" },
		});
		expect(clearChallenge.purpose).toBe("CLEAR");

		await request(app.getHttpServer())
			.post("/api/auth/otp/send-code")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ channel: "email", target: user.email })
			.expect(200);
		const loginChallenge = await env.prisma.otpChallenge.findFirstOrThrow({
			where: { target: user.email, purpose: "LOGIN" },
			orderBy: { createdAt: "desc" },
		});
		expect(loginChallenge.purpose).toBe("LOGIN");

		// 登录链路回归：缺省 purpose 的码可正常 OTP 登录
		const otpChannelLast =
			env.otpChannel.sentCodes[env.otpChannel.sentCodes.length - 1];
		await request(app.getHttpServer())
			.post("/api/auth/otp/login")
			.send({ challengeId: loginChallenge.id, code: otpChannelLast })
			.expect(200);
	});

	it("verify 用 LOGIN 用途的码 → 403 VERIFICATION_PURPOSE_MISMATCH（用途隔离）", async () => {
		const sent = await request(app.getHttpServer())
			.post("/api/auth/otp/send-code")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ channel: "email", target: user.email }) // 缺省 LOGIN
			.expect(200);
		const code = env.otpChannel.lastCode()!;
		const res = await request(app.getHttpServer())
			.post("/api/data-requests/verify")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({
				challengeId: sent.body.data.challengeId,
				code,
				purpose: "EXPORT",
			})
			.expect(403);
		expect(res.body.code).toBe("VERIFICATION_PURPOSE_MISMATCH");

		// 该码未被消费（用途不匹配不消费、不累计尝试），仍可用于登录
		const challenge = await env.prisma.otpChallenge.findUniqueOrThrow({
			where: { id: sent.body.data.challengeId },
		});
		expect(challenge.consumedAt).toBeNull();
	});

	it("verify 通过 → 创建 EXPORT 同步完成（COMPLETED + download 入口）", async () => {
		const { challengeId } = await (await import("../helpers/data-request-helper")).sendAndVerify(
			app,
			env.otpChannel,
			user.accessToken,
			user.email,
			"EXPORT",
		);
		const res = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ type: "EXPORT", challengeId })
			.expect(200);
		const view = res.body.data;
		expect(view.type).toBe("EXPORT");
		expect(view.status).toBe("COMPLETED");
		expect(view.displayStatus).toBe("COMPLETED");
		expect(view.download.url).toContain("/api/data-requests/");
		expect(view.download.url).toContain("/download");
		expect(view.download.expiresAt).toBeDefined();
	});

	it("同一凭证重放 → 幂等窗口内返回原请求；原请求终结后 403 VERIFICATION_USED", async () => {
		const { sendAndVerify: sv } = await import("../helpers/data-request-helper");
		// 前置：过期已有导出，让本次 create 走真实创建路径（凭证被唯一绑定）
		await env.prisma.dataRequest.updateMany({
			where: { requesterUserId: user.userId, type: "EXPORT" },
			data: { downloadExpiresAt: new Date(Date.now() - 1000) },
		});
		const { challengeId } = await sv(
			app,
			env.otpChannel,
			user.accessToken,
			user.email,
			"EXPORT",
		);
		const first = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ type: "EXPORT", challengeId })
			.expect(200);
		expect(first.body.data.status).toBe("COMPLETED");
		const firstId = first.body.data.id as string;

		// 幂等窗口内重复点击同一操作（同凭证）→ 返回原请求而非新建（需求 6.1.5）
		const repeat = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ type: "EXPORT", challengeId })
			.expect(200);
		expect(repeat.body.data.id).toBe(firstId);

		// 原请求终结（模拟下载期限已过）后重放同一凭证 → unique 绑定校验拒绝
		await env.prisma.dataRequest.update({
			where: { id: firstId },
			data: { downloadExpiresAt: new Date(Date.now() - 1000) },
		});
		const replay = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ type: "EXPORT", challengeId })
			.expect(403);
		expect(replay.body.code).toBe("VERIFICATION_USED");
	});

	it("verify 后超过 10 分钟再创建（置 consumedAt 过去）→ 403 VERIFICATION_EXPIRED", async () => {
		const { sendAndVerify: sv, consumeChallenge } = await import(
			"../helpers/data-request-helper"
		);
		const { challengeId } = await sv(
			app,
			env.otpChannel,
			user.accessToken,
			user.email,
			"CLEAR",
		);
		await consumeChallenge(
			env.prisma,
			challengeId,
			new Date(Date.now() - 10 * 60 * 1000 - 1000),
		);
		const expiredOrgId = await defaultOrgIdOf(user.userId);
		const res = await request(app.getHttpServer())
			.post("/api/organizations/current/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.set("X-Organization-Id", expiredOrgId)
			.send({
				type: "CLEAR",
				scope: "ORGANIZATION",
				challengeId,
				confirmedTotals: {
					accounts: 0,
					transactions: 0,
					initialHoldings: 0,
					plans: 0,
					usageRecords: 0,
					corrections: 0,
				},
			})
			.expect(403);
		expect(res.body.code).toBe("VERIFICATION_EXPIRED");
	});

	it("challenge target ≠ 当前用户邮箱 → 403 VERIFICATION_INVALID", async () => {
		const sent = await request(app.getHttpServer())
			.post("/api/auth/otp/send-code")
			.send({ channel: "email", target: other.email, purpose: "EXPORT" })
			.expect(200);
		const code = env.otpChannel.lastCode()!;
		const res = await request(app.getHttpServer())
			.post("/api/data-requests/verify")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({
				challengeId: sent.body.data.challengeId,
				code,
				purpose: "EXPORT",
			})
			.expect(403);
		expect(res.body.code).toBe("VERIFICATION_INVALID");
	});

	it("CLEAR 全流程：impact → verify → 创建 PENDING（dueAt=+7d）", async () => {
		// 前置：过期已有导出，确认页不再提示可下载
		await env.prisma.dataRequest.updateMany({
			where: { requesterUserId: user.userId, type: "EXPORT" },
			data: { downloadExpiresAt: new Date(Date.now() - 1000) },
		});
		const clearOrgId = await defaultOrgIdOf(user.userId);
		const impact = await request(app.getHttpServer())
			.get("/api/organizations/current/data-requests/impact")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.set("X-Organization-Id", clearOrgId)
			.expect(200);
		expect(impact.body.data.totals).toMatchObject({
			accounts: 0,
			transactions: 0,
		});
		expect(impact.body.data.hasDownloadableExport).toBe(false);

		const { sendAndVerify: sv } = await import("../helpers/data-request-helper");
		const { challengeId } = await sv(
			app,
			env.otpChannel,
			user.accessToken,
			user.email,
			"CLEAR",
		);
		const res = await request(app.getHttpServer())
			.post("/api/organizations/current/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.set("X-Organization-Id", clearOrgId)
			.send({
				type: "CLEAR",
				scope: "ORGANIZATION",
				challengeId,
				confirmedTotals: impact.body.data.totals,
			});
		if (res.status !== 200) {
			console.log("SENT totals:", JSON.stringify(impact.body.data.totals));
			throw new Error(`create CLEAR got ${res.status}: ${JSON.stringify(res.body)}`);
		}
		expect(res.body.data.type).toBe("CLEAR");
		expect(res.body.data.status).toBe("PENDING");
		expect(res.body.data.displayStatus).toBe("SUBMITTED");
		expect(res.body.data.canCancel).toBe(true);
	});

	it("已有 PENDING 清空请求时创建 EXPORT / DELETION → 409 DATA_REQUEST_CONFLICT（data 含原请求）", async () => {
		const { sendAndVerify: sv } = await import("../helpers/data-request-helper");
		for (const type of ["EXPORT", "DELETION"] as const) {
			const { challengeId } = await sv(
				app,
				env.otpChannel,
				user.accessToken,
				user.email,
				type,
			);
			const res = await request(app.getHttpServer())
				.post("/api/data-requests")
				.set("Authorization", `Bearer ${user.accessToken}`)
				.send({ type, challengeId })
				.expect(409);
			expect(res.body.code).toBe("DATA_REQUEST_CONFLICT");
			expect(res.body.data.type).toBe("CLEAR");
			expect(res.body.data.status).toBe("PENDING");
		}
	});

	it("CLEAR PENDING 期间：POST/PATCH 业务端点 403 ORGANIZATION_DATA_LOCKED，GET 放行", async () => {
		const clearOrgId = await defaultOrgIdOf(user.userId);
		const locked = await request(app.getHttpServer())
			.patch("/api/settings")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.set("X-Organization-Id", clearOrgId)
			.send({ region: "CN" })
			.expect(403);
		expect(locked.body.code).toBe("ORGANIZATION_DATA_LOCKED");

		// GET 放行（停写不停看）
		await request(app.getHttpServer())
			.get("/api/settings")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.set("X-Organization-Id", clearOrgId)
			.expect(200);

		// data-request 白名单端点可用
		await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(200);
		await request(app.getHttpServer())
			.post("/api/auth/otp/send-code")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ channel: "email", target: user.email, purpose: "DELETION" })
			.expect(200);
	});

	it("撤回：CLEAR 直接撤成功；DELETION 无验证码被拒、带 DELETION 验证成功（双域各走各自端点）", async () => {
		const { sendAndVerify: sv } = await import("../helpers/data-request-helper");
		const clearOrgId = await defaultOrgIdOf(user.userId);
		const current = await request(app.getHttpServer())
			.get("/api/organizations/current/data-requests/current")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.set("X-Organization-Id", clearOrgId)
			.expect(200);
		expect(current.body.data.type).toBe("CLEAR");

		// 组织域请求用个人端点撤回 → 404（跨域一律不泄露存在性）
		const crossDomain = await request(app.getHttpServer())
			.post(`/api/data-requests/${current.body.data.id}/cancel`)
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({})
			.expect(404);
		expect(crossDomain.body.code).toBe("DATA_REQUEST_NOT_FOUND");

		const cancelled = await request(app.getHttpServer())
			.post(`/api/organizations/current/data-requests/${current.body.data.id}/cancel`)
			.set("Authorization", `Bearer ${user.accessToken}`)
			.set("X-Organization-Id", clearOrgId)
			.send({})
			.expect(200);
		expect(cancelled.body.data.status).toBe("CANCELLED");

		// 最后 Owner 保护（DATA-02.4）：注册用户的默认组织里本人是唯一所有者，直接注销会被
		// 409 LAST_OWNER_REQUIRED 拒绝。先把默认组织的所有权转给 other（本人降为 ADMIN）后才可注销
		await transferDefaultOrgOwnership(user.userId, other.userId);

		// 提交 DELETION → 撤回需 purpose=DELETION 验证码
		const { challengeId } = await sv(
			app,
			env.otpChannel,
			user.accessToken,
			user.email,
			"DELETION",
		);
		const deletion = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ type: "DELETION", challengeId })
			.expect(200);
		expect(deletion.body.data.scope).toBe("PERSONAL");
		expect(deletion.body.data.displayStatus).toBe("WITHDRAWAL_PERIOD");
		expect(deletion.body.data.withdrawDeadline).toBeDefined();

		const noCredential = await request(app.getHttpServer())
			.post(`/api/data-requests/${deletion.body.data.id}/cancel`)
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({})
			.expect(403);
		expect(noCredential.body.code).toBe("VERIFICATION_INVALID");

		// 非法凭证（不存在的 challengeId）同样拒绝
		const bogus = await request(app.getHttpServer())
			.post(`/api/data-requests/${deletion.body.data.id}/cancel`)
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ challengeId: "nonexistent-challenge" })
			.expect(403);
		expect(bogus.body.code).toBe("VERIFICATION_INVALID");

		// 带 verify（purpose=DELETION）返回的有效凭证 → 撤回成功，账号恢复
		const { challengeId: cancelChallengeId } = await sv(
			app,
			env.otpChannel,
			user.accessToken,
			user.email,
			"DELETION",
		);
		const cancelRes = await request(app.getHttpServer())
			.post(`/api/data-requests/${deletion.body.data.id}/cancel`)
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ challengeId: cancelChallengeId })
			.expect(200);
		expect(cancelRes.body.data.status).toBe("CANCELLED");
	});

	it("下载：24h 内成功（application/zip）；过期 410；他人 404", async () => {
		// 创建新的可下载导出（前面原导出已被置过期）
		const { sendAndVerify: sv } = await import("../helpers/data-request-helper");
		const { challengeId } = await sv(
			app,
			env.otpChannel,
			user.accessToken,
			user.email,
			"EXPORT",
		);
		const created = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ type: "EXPORT", challengeId })
			.expect(200);
		const requestId = created.body.data.id as string;

		const ok = await request(app.getHttpServer())
			.get(`/api/data-requests/${requestId}/download`)
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(200);
		expect(ok.headers["content-type"]).toContain("application/zip");
		expect(ok.headers["content-disposition"]).toContain("attachment");
		expect(Number(ok.headers["content-length"])).toBeGreaterThan(0);

		// 过期 → 410 DOWNLOAD_EXPIRED
		await env.prisma.dataRequest.update({
			where: { id: requestId },
			data: { downloadExpiresAt: new Date(Date.now() - 1000) },
		});
		const expired = await request(app.getHttpServer())
			.get(`/api/data-requests/${requestId}/download`)
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(410);
		expect(expired.body.code).toBe("DOWNLOAD_EXPIRED");

		// 他人下载 → 404（不泄露存在性）
		const forbidden = await request(app.getHttpServer())
			.get(`/api/data-requests/${requestId}/download`)
			.set("Authorization", `Bearer ${other.accessToken}`)
			.expect(404);
		expect(forbidden.body.code).toBe("DATA_REQUEST_NOT_FOUND");
	});

	it("DELETION PENDING 期间：任意业务端点（含 GET）403 ACCOUNT_PENDING_DELETION；白名单放行", async () => {
		const { sendAndVerify: sv } = await import("../helpers/data-request-helper");
		const { challengeId } = await sv(
			app,
			env.otpChannel,
			user.accessToken,
			user.email,
			"DELETION",
		);
		await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ type: "DELETION", challengeId })
			.expect(200);

		const lockedOrgId = await defaultOrgIdOf(user.userId);
		const locked = await request(app.getHttpServer())
			.get("/api/settings")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.set("X-Organization-Id", lockedOrgId)
			.expect(403);
		expect(locked.body.code).toBe("ACCOUNT_PENDING_DELETION");

		await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(200);
		await request(app.getHttpServer())
			.get("/api/auth/me")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(200);
		await request(app.getHttpServer())
			.post("/api/auth/otp/send-code")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ channel: "email", target: user.email, purpose: "DELETION" })
			.expect(200);

		// 无效 token 时守卫放行 → JwtAuthGuard 401（而非锁 403）
		await request(app.getHttpServer())
			.get("/api/settings")
			.set("Authorization", "Bearer not-a-jwt")
			.expect(401);

		// 撤回注销恢复（带 DELETION 用途有效凭证）
		const { challengeId: cancelId } = await sv(
			app,
			env.otpChannel,
			user.accessToken,
			user.email,
			"DELETION",
		);
		await request(app.getHttpServer())
			.post(`/api/data-requests/${(await currentRequestId()).id}/cancel`)
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ challengeId: cancelId })
			.expect(200);
	});

	it("CLEAR 创建时 confirmedTotals 过期 → 409 IMPACT_CHANGED", async () => {
		// 先清掉当前 DELETION（上一用例已撤），直接种一笔业务数据制造数量变化
		const { sendAndVerify: sv } = await import("../helpers/data-request-helper");
		const impactOrgId = await defaultOrgIdOf(user.userId);
		const impact = await request(app.getHttpServer())
			.get("/api/organizations/current/data-requests/impact")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.set("X-Organization-Id", impactOrgId)
			.expect(200);
		const totals = impact.body.data.totals;

		const { challengeId } = await sv(
			app,
			env.otpChannel,
			user.accessToken,
			user.email,
			"CLEAR",
		);
		const res = await request(app.getHttpServer())
			.post("/api/organizations/current/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.set("X-Organization-Id", impactOrgId)
			.send({
				type: "CLEAR",
				scope: "ORGANIZATION",
				challengeId,
				confirmedTotals: {
					...totals,
					accounts: totals.accounts + 1, // 确认后又多了一个账户
				},
			})
			.expect(409);
		expect(res.body.code).toBe("IMPACT_CHANGED");
	});

	it("W27 双守卫查询不变量：每个请求至多 1 次 data_requests SELECT（组织端点走合并查询）；ghost token 短路零查；异常一律 fail-closed 500（个人锁与组织锁两条路径分别验证）", async () => {
		const jwtService = app.get(JwtService);
		const verifySpy = vi.spyOn(jwtService, "verify");
		const userFindSpy = vi.spyOn(env.prisma.user, "findUnique");
		const drFindManySpy = vi.spyOn(env.prisma.dataRequest, "findMany");
		const drFindFirstSpy = vi.spyOn(env.prisma.dataRequest, "findFirst");

		try {
			verifySpy.mockClear();
			userFindSpy.mockClear();
			drFindManySpy.mockClear();
			drFindFirstSpy.mockClear();

			// 1. 个人域受保护端点：仅个人锁守卫 → data_requests 恰好 1 次
			await request(app.getHttpServer())
				.get("/api/settings/personal")
				.set("Authorization", `Bearer ${user.accessToken}`)
				.expect(200);
			expect(verifySpy).toHaveBeenCalledTimes(1);
			expect(userFindSpy).toHaveBeenCalledTimes(1);
			expect(drFindManySpy).toHaveBeenCalledTimes(1);
			expect(drFindFirstSpy).not.toHaveBeenCalled();

			// 2. 组织上下文端点：OrganizationLockGuard 用**一条合并查询**
			//    （个人域注销 ∪ 当前组织清空/删除）同时判定两把锁 → 仍然只有 1 条
			const probeOrgId = await defaultOrgIdOf(user.userId);
			drFindManySpy.mockClear();
			drFindFirstSpy.mockClear();
			await request(app.getHttpServer())
				.get("/api/settings")
				.set("Authorization", `Bearer ${user.accessToken}`)
				.set("X-Organization-Id", probeOrgId)
				.expect(200);
			expect(drFindManySpy).toHaveBeenCalledTimes(1);
			expect(drFindFirstSpy).not.toHaveBeenCalled();

			// 3. 合法签名但用户不存在的旧 token → 401，且在守卫阶段短路零查 data_requests
			verifySpy.mockClear();
			userFindSpy.mockClear();
			drFindManySpy.mockClear();
			drFindFirstSpy.mockClear();
			const ghostToken = jwtService.sign({
				userId: "nonexistent-user-id",
				email: "ghost@example.com",
			});
			await request(app.getHttpServer())
				.get("/api/settings")
				.set("Authorization", `Bearer ${ghostToken}`)
				.expect(401);
			expect(verifySpy).toHaveBeenCalledTimes(1);
			expect(userFindSpy).toHaveBeenCalledTimes(1);
			expect(drFindManySpy).not.toHaveBeenCalled();
			expect(drFindFirstSpy).not.toHaveBeenCalled();
		} finally {
			verifySpy.mockRestore();
			userFindSpy.mockRestore();
			drFindManySpy.mockRestore();
			drFindFirstSpy.mockRestore();
		}

		// 4. 组织 CLEAR PENDING 期间单次查询不变量：GET 放行、POST 403 ORGANIZATION_DATA_LOCKED，
		//    且两次各自至多 1 次 dataRequest.findMany / 0 次 findFirst
		//（CLEAR 属组织域：夹具须带 scope + organizationId，否则被 data_requests_scope_type_org_check 拒绝）
		const lockUser = await onboardedUser("w27-clear-pending");
		const lockOrgId = await defaultOrgIdOf(lockUser.userId);
		const clearRow = await env.prisma.dataRequest.create({
			data: {
				requesterUserId: lockUser.userId,
				scope: "ORGANIZATION",
				organizationId: lockOrgId,
				type: "CLEAR",
				status: "PENDING",
				requestedAt: new Date(),
				dueAt: new Date(Date.now() + 60 * 60 * 1000),
			},
		});
		const drManyClearSpy = vi.spyOn(env.prisma.dataRequest, "findMany");
		const drFirstClearSpy = vi.spyOn(env.prisma.dataRequest, "findFirst");
		try {
			drManyClearSpy.mockClear();
			drFirstClearSpy.mockClear();
			await request(app.getHttpServer())
				.get("/api/settings")
				.set("Authorization", `Bearer ${lockUser.accessToken}`)
				.set("X-Organization-Id", lockOrgId)
				.expect(200);
			expect(drManyClearSpy).toHaveBeenCalledTimes(1);
			expect(drFirstClearSpy).not.toHaveBeenCalled();

			drManyClearSpy.mockClear();
			drFirstClearSpy.mockClear();
			const postRes = await request(app.getHttpServer())
				.post("/api/transactions")
				.set("Authorization", `Bearer ${lockUser.accessToken}`)
				.set("X-Organization-Id", lockOrgId)
				.send({})
				.expect(403);
			expect(postRes.body.code).toBe("ORGANIZATION_DATA_LOCKED");
			expect(drManyClearSpy).toHaveBeenCalledTimes(1);
			expect(drFirstClearSpy).not.toHaveBeenCalled();
		} finally {
			drManyClearSpy.mockRestore();
			drFirstClearSpy.mockRestore();
			await env.prisma.dataRequest
				.delete({ where: { id: clearRow.id } })
				.catch(() => {});
		}

		// 5. 个人锁查询异常边界：非白名单端点 fail-closed（500），个人白名单放行（200）
		const dbErrSpy = vi
			.spyOn(env.prisma.dataRequest, "findMany")
			.mockRejectedValue(new Error("simulated db connection error"));
		try {
			await request(app.getHttpServer())
				.get("/api/settings/personal")
				.set("Authorization", `Bearer ${user.accessToken}`)
				.expect(500);
			await request(app.getHttpServer())
				.get("/api/auth/me")
				.set("Authorization", `Bearer ${user.accessToken}`)
				.expect(200);
		} finally {
			dbErrSpy.mockRestore();
		}

		// 6. 组织锁（合并查询）异常边界：**两把锁中任一把未被跳过即 fail-closed（500）**
		//    - /api/settings：个人锁与组织锁都未跳过 → 500；
		//    - /api/organizations/current：组织锁已跳过，但个人锁未跳过 → 同样 500
		//      （查不到锁状态不得放行注销中的账号）；白名单仅对**两把锁都跳过**的端点放行
		const failOrgId = await defaultOrgIdOf(user.userId);
		const originalFindMany = env.prisma.dataRequest.findMany.bind(
			env.prisma.dataRequest,
		);
		const orgErrSpy = vi
			.spyOn(env.prisma.dataRequest, "findMany")
			.mockImplementation(((args: unknown) => {
				// 合并查询（where.OR）= OrganizationLockGuard 的双锁查询
				const where = (args as { where?: { OR?: unknown } })?.where;
				if (where && where.OR !== undefined) {
					return Promise.reject(
						new Error("simulated organization lock db error"),
					);
				}
				return originalFindMany(args as never);
			}) as never);
		try {
			await request(app.getHttpServer())
				.get("/api/settings")
				.set("Authorization", `Bearer ${user.accessToken}`)
				.set("X-Organization-Id", failOrgId)
				.expect(500);
			// 个人锁未跳过 → 同样 fail-closed（查不到锁状态不得放行注销中的账号）
			await request(app.getHttpServer())
				.get("/api/organizations/current")
				.set("Authorization", `Bearer ${user.accessToken}`)
				.set("X-Organization-Id", failOrgId)
				.expect(500);
		} finally {
			orgErrSpy.mockRestore();
		}
	});

	// ─────────────────────────────────────────────────────────
	// 双域拆分（ToB R1 技术方案 §9；Goal #3B W26）
	// ─────────────────────────────────────────────────────────

	it("最后 Owner 个人注销：409 LAST_OWNER_REQUIRED 附阻塞组织列表且不建请求；所有权转移后放行", async () => {
		const sole = await onboardedUser("dr-sole-owner");
		const successor = await onboardedUser("dr-successor");
		const orgId = await defaultOrgIdOf(sole.userId);
		const organizationName = (
			await env.prisma.organization.findUniqueOrThrow({ where: { id: orgId } })
		).name;

		const { challengeId } = await sendAndVerify(
			app,
			env.otpChannel,
			sole.accessToken,
			sole.email,
			"DELETION",
		);
		const blocked = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${sole.accessToken}`)
			.send({ type: "DELETION", scope: "PERSONAL", challengeId })
			.expect(409);
		expect(blocked.body).toMatchObject({
			success: false,
			code: "LAST_OWNER_REQUIRED",
			data: {
				blockingOrganizations: [{ organizationId: orgId, organizationName, role: "OWNER" }],
			},
		});
		// 不替用户选择处置方式：未创建任何请求行，账号未上锁
		expect(
			await env.prisma.dataRequest.count({
				where: { requesterUserId: sole.userId },
			}),
		).toBe(0);
		const untouched = await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.set("Authorization", `Bearer ${sole.accessToken}`)
			.expect(200);
		expect(untouched.body.data).toBeNull();

		// 转移所有权（本人降为 ADMIN）后放行：个人注销进入 7 日撤回期
		await transferDefaultOrgOwnership(sole.userId, successor.userId);
		const again = await sendAndVerify(
			app,
			env.otpChannel,
			sole.accessToken,
			sole.email,
			"DELETION",
		);
		const allowed = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${sole.accessToken}`)
			.send({ type: "DELETION", scope: "PERSONAL", challengeId: again.challengeId })
			.expect(200);
		expect(allowed.body.data).toMatchObject({
			type: "DELETION",
			scope: "PERSONAL",
			organizationId: null,
			status: "PENDING",
			displayStatus: "WITHDRAWAL_PERIOD",
		});
		const row = await env.prisma.dataRequest.findUniqueOrThrow({
			where: { id: allowed.body.data.id as string },
		});
		expect(row).toMatchObject({ scope: "PERSONAL", organizationId: null });

		// 带验证撤回恢复账号（到期执行的完整路径见 account-data-lifecycle 集成用例）
		const cancelCredential = await sendAndVerify(
			app,
			env.otpChannel,
			sole.accessToken,
			sole.email,
			"DELETION",
		);
		const cancelled = await request(app.getHttpServer())
			.post(`/api/data-requests/${row.id}/cancel`)
			.set("Authorization", `Bearer ${sole.accessToken}`)
			.send({ challengeId: cancelCredential.challengeId })
			.expect(200);
		expect(cancelled.body.data.status).toBe("CANCELLED");
	});

	it("[N-2] 域一致性校验优先：个人端点 CLEAR（无 confirmedTotals）/ scope=ORGANIZATION、组织端点 scope=PERSONAL 一律 400 SCOPE_TYPE_MISMATCH", async () => {
		const member = await onboardedUser("dr-domain-mismatch");
		const orgId = await defaultOrgIdOf(member.userId);
		const { challengeId: clearCredential } = await sendAndVerify(
			app,
			env.otpChannel,
			member.accessToken,
			member.email,
			"CLEAR",
		);

		// ① 个人端点发 CLEAR 且**不带** confirmedTotals → 域不一致优先（400 SCOPE_TYPE_MISMATCH）
		const clearNoTotals = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${member.accessToken}`)
			.send({ type: "CLEAR", challengeId: clearCredential })
			.expect(400);
		expect(clearNoTotals.body.code).toBe("SCOPE_TYPE_MISMATCH");

		// ② 个人端点显式 scope=ORGANIZATION → 400 SCOPE_TYPE_MISMATCH
		const { challengeId: exportCredential } = await sendAndVerify(
			app,
			env.otpChannel,
			member.accessToken,
			member.email,
			"EXPORT",
		);
		const wrongScope = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${member.accessToken}`)
			.send({ type: "EXPORT", scope: "ORGANIZATION", challengeId: exportCredential })
			.expect(400);
		expect(wrongScope.body.code).toBe("SCOPE_TYPE_MISMATCH");

		// ③ 组织端点显式 scope=PERSONAL → 400 SCOPE_TYPE_MISMATCH
		const { challengeId: orgExportCredential } = await sendAndVerify(
			app,
			env.otpChannel,
			member.accessToken,
			member.email,
			"EXPORT",
		);
		const wrongOrgScope = await request(app.getHttpServer())
			.post("/api/organizations/current/data-requests")
			.set("Authorization", `Bearer ${member.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({ type: "EXPORT", scope: "PERSONAL", challengeId: orgExportCredential })
			.expect(400);
		expect(wrongOrgScope.body.code).toBe("SCOPE_TYPE_MISMATCH");

		// 三次拒绝均零副作用
		expect(
			await env.prisma.dataRequest.count({
				where: { requesterUserId: member.userId },
			}),
		).toBe(0);
	});

	it("PERSONAL + CLEAR 一律 400 SCOPE_TYPE_MISMATCH：个人域不能清空组织账本", async () => {
		const member = await onboardedUser("dr-scope-mismatch");
		const { challengeId } = await sendAndVerify(
			app,
			env.otpChannel,
			member.accessToken,
			member.email,
			"CLEAR",
		);
		const res = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${member.accessToken}`)
			.send({
				type: "CLEAR",
				scope: "PERSONAL",
				challengeId,
				confirmedTotals: {
					accounts: 0,
					transactions: 0,
					initialHoldings: 0,
					plans: 0,
					usageRecords: 0,
					corrections: 0,
				},
			})
			.expect(400);
		expect(res.body.code).toBe("SCOPE_TYPE_MISMATCH");
		// 未知 scope 由 DTO 拒绝
		const bogus = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${member.accessToken}`)
			.send({ type: "EXPORT", scope: "TEAM", challengeId })
			.expect(400);
		expect(bogus.body.message).toEqual(expect.arrayContaining([expect.stringContaining("scope")]));
		expect(
			await env.prisma.dataRequest.count({
				where: { requesterUserId: member.userId },
			}),
		).toBe(0);
	});

	it("组织数据请求按角色判权（data.export / data.clear / organization.delete）、同组织进行中请求互斥、审计同事务", async () => {
		const owner = await onboardedUser("dr-org-owner");
		const admin = await onboardedUser("dr-org-admin");
		const finance = await onboardedUser("dr-org-finance");
		const operator = await onboardedUser("dr-org-operator");
		const orgId = await defaultOrgIdOf(owner.userId);
		for (const [member, role] of [
			[admin, "ADMIN"],
			[finance, "FINANCE"],
			[operator, "OPERATOR"],
		] as const) {
			await env.prisma.membership.create({
				data: { organizationId: orgId, userId: member.userId, role },
			});
		}
		const zeroTotals = {
			accounts: 0,
			transactions: 0,
			initialHoldings: 0,
			plans: 0,
			usageRecords: 0,
			corrections: 0,
		};
		const submit = async (
			member: TestUser,
			type: "EXPORT" | "CLEAR" | "DELETION",
			extra: Record<string, unknown> = {},
		) => {
			const { challengeId } = await sendAndVerify(
				app,
				env.otpChannel,
				member.accessToken,
				member.email,
				type,
			);
			return request(app.getHttpServer())
				.post("/api/organizations/current/data-requests")
				.set("Authorization", `Bearer ${member.accessToken}`)
				.set("X-Organization-Id", orgId)
				.send({ type, scope: "ORGANIZATION", challengeId, ...extra });
		};
		/** 提交并断言状态码，返回响应（submit 需先取验证凭证，故先 await 再断言） */
		const submitExpect = async (
			member: TestUser,
			type: "EXPORT" | "CLEAR" | "DELETION",
			status: number,
			extra: Record<string, unknown> = {},
		) => {
			const res = await submit(member, type, extra);
			expect(res.status, `${member.email} × ${type}`).toBe(status);
			return res;
		};

		// Finance：可导出（Owner / Admin / Finance），不可清空（仅 Owner / Admin）
		const financeExport = await submitExpect(finance, "EXPORT", 200);
		expect(financeExport.body.data).toMatchObject({
			type: "EXPORT",
			scope: "ORGANIZATION",
			organizationId: orgId,
			status: "COMPLETED",
			isRequester: true,
		});
		expect(
			(await submitExpect(finance, "CLEAR", 403, { confirmedTotals: zeroTotals })).body
				.code,
		).toBe("PERMISSION_DENIED");
		// Operator：不可导出
		expect((await submitExpect(operator, "EXPORT", 403)).body.code).toBe("PERMISSION_DENIED");
		// Admin：不可删除组织（仅 Owner）
		expect((await submitExpect(admin, "DELETION", 403)).body.code).toBe("PERMISSION_DENIED");
		// 被拒请求零副作用
		expect(await env.prisma.dataRequest.count({ where: { organizationId: orgId } })).toBe(1);

		// Admin 清空 → PENDING
		const adminClear = await submitExpect(admin, "CLEAR", 200, { confirmedTotals: zeroTotals });
		expect(adminClear.body.data).toMatchObject({
			scope: "ORGANIZATION",
			organizationId: orgId,
			status: "PENDING",
			canCancel: true,
			isRequester: true,
		});
		// N4：当前组织请求视图对发起人返回 isRequester=true，对其他有查看权成员（如 Owner）返回 isRequester=false（不泄露 userId）
		const adminCurrentView = await request(app.getHttpServer())
			.get("/api/organizations/current/data-requests/current")
			.set("Authorization", `Bearer ${admin.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(200);
		expect(adminCurrentView.body.data.isRequester).toBe(true);
		const ownerCurrentView = await request(app.getHttpServer())
			.get("/api/organizations/current/data-requests/current")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(200);
		expect(ownerCurrentView.body.data.isRequester).toBe(false);
		expect(ownerCurrentView.body.data).not.toHaveProperty("requesterUserId");
		// 提交 CLEAR 的同域联动：该组织此前的导出链接立即失效
		const exportRow = await env.prisma.dataRequest.findUniqueOrThrow({
			where: { id: financeExport.body.data.id as string },
		});
		expect(exportRow.downloadExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now());

		// 组织级互斥：同组织已有进行中的组织请求（CLEAR PENDING）→
		// 控制平面端点（组织数据请求）不被锁拦，统一 409 DATA_REQUEST_CONFLICT + 原请求视图
		const conflict = await submitExpect(owner, "DELETION", 409);
		expect(conflict.body.code).toBe("DATA_REQUEST_CONFLICT");
		expect(conflict.body.data).toMatchObject({
			type: "CLEAR",
			scope: "ORGANIZATION",
			status: "PENDING",
			isRequester: false,
		});
		// 影响确认页同样按角色判权
		const impactDenied = await request(app.getHttpServer())
			.get("/api/organizations/current/data-requests/impact")
			.set("Authorization", `Bearer ${finance.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(403);
		expect(impactDenied.body.code).toBe("PERMISSION_DENIED");

		// Admin 直接撤回清空 → CANCELLED
		const cancelled = await request(app.getHttpServer())
			.post(`/api/organizations/current/data-requests/${adminClear.body.data.id as string}/cancel`)
			.set("Authorization", `Bearer ${admin.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({})
			.expect(200);
		expect(cancelled.body.data.status).toBe("CANCELLED");

		// Owner 发起组织删除 → 撤回期；带验证撤回
		const ownerDeletion = await submitExpect(owner, "DELETION", 200);
		expect(ownerDeletion.body.data).toMatchObject({
			type: "DELETION",
			scope: "ORGANIZATION",
			organizationId: orgId,
			status: "PENDING",
			displayStatus: "WITHDRAWAL_PERIOD",
		});
		const cancelCredential = await sendAndVerify(
			app,
			env.otpChannel,
			owner.accessToken,
			owner.email,
			"DELETION",
		);
		const deletionCancelled = await request(app.getHttpServer())
			.post(`/api/organizations/current/data-requests/${ownerDeletion.body.data.id as string}/cancel`)
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({ challengeId: cancelCredential.challengeId })
			.expect(200);
		expect(deletionCancelled.body.data.status).toBe("CANCELLED");

		// 审计：创建 / 撤回与请求同事务留痕；权限拒绝有 DENIED 记录
		const logs = await env.prisma.auditLog.findMany({
			where: { organizationId: orgId },
			orderBy: { createdAt: "asc" },
		});
		expect(
			logs.map((log) => [log.action, log.result, log.actorUserId] as const),
		).toEqual(
			expect.arrayContaining([
				["data.export", "SUCCESS", finance.userId],
				["permission.denied.data.clear", "DENIED", finance.userId],
				["permission.denied.data.export", "DENIED", operator.userId],
				["permission.denied.organization.delete", "DENIED", admin.userId],
				["data.clear.create", "SUCCESS", admin.userId],
				["data.clear.cancel", "SUCCESS", admin.userId],
				["organization.delete.create", "SUCCESS", owner.userId],
				["organization.delete.cancel", "SUCCESS", owner.userId],
			]),
		);
	});

	it("个人导出包零账本条目；组织导出包含完整账本表格；同域幂等且两种包互不顶替", async () => {
		const owner = await onboardedUser("dr-export-scopes");
		const orgId = await defaultOrgIdOf(owner.userId);
		const submit = async (scope: "PERSONAL" | "ORGANIZATION") => {
			const { challengeId } = await sendAndVerify(
				app,
				env.otpChannel,
				owner.accessToken,
				owner.email,
				"EXPORT",
			);
			const path =
				scope === "ORGANIZATION"
					? "/api/organizations/current/data-requests"
					: "/api/data-requests";
			const res = await request(app.getHttpServer())
				.post(path)
				.set("Authorization", `Bearer ${owner.accessToken}`)
				.set("X-Organization-Id", orgId)
				.send({ type: "EXPORT", scope, challengeId });
			expect(res.status, scope).toBe(200);
			return res.body.data;
		};

		const personal = await submit("PERSONAL");
		const organization = await submit("ORGANIZATION");
		expect(personal).toMatchObject({ scope: "PERSONAL", organizationId: null, status: "COMPLETED" });
		expect(organization).toMatchObject({ scope: "ORGANIZATION", organizationId: orgId, status: "COMPLETED" });
		expect(personal.id).not.toBe(organization.id);
		// 同域幂等：再次申请组织导出返回原请求，不重复生成
		const again = await submit("ORGANIZATION");
		expect(again.id).toBe(organization.id);
		expect(
			await env.prisma.dataRequest.count({
				where: { requesterUserId: owner.userId },
			}),
		).toBe(2);

		const JSZip = (await import("jszip")).default;
		const entriesOf = async (url: string, organizationId?: string) =>
			Object.keys(
				(
					await JSZip.loadAsync(
						await downloadZip(url, owner.accessToken, organizationId),
					)
				).files,
			).sort();
		// 下载入口按数据域分流（技术方案 §9.1 物理拆分）
		expect(personal.download.url).toContain("/api/data-requests/");
		expect(personal.download.url).toContain("/download");
		expect(organization.download.url).toContain(
			"/api/organizations/current/data-requests/",
		);
		expect(organization.download.url).toContain("/download");
		const personalEntries = await entriesOf(personal.download.url);
		const organizationEntries = await entriesOf(organization.download.url, orgId);
		expect(personalEntries).toEqual([...PERSONAL_EXPORT_PATHS].sort());
		expect(organizationEntries).toEqual(
			expect.arrayContaining([
				"06-plans.csv",
				"07-plan-allocations.csv",
				"10-organization.csv",
				"12-reports.csv",
			]),
		);
		// 两个包互不交叉：个人包无账本表格，组织包无个人资料
		expect(organizationEntries).not.toContain("01-profile.csv");
		expect(personalEntries).not.toContain("07-plan-allocations.csv");
	});

	/** 读取当前 DELETION 请求 id（上一用例辅助） */
	async function currentRequestId(): Promise<{ id: string }> {
		const res = await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(200);
		expect(res.body.data).not.toBeNull();
		return { id: res.body.data.id };
	}
});
