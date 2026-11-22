import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	cleanupUser,
	type TestUser,
} from "../helpers/test-app";
import {
	completeOnboarding,
	createDataRequestTestApp,
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
		const result: TestUser = {
			email,
			password: ["Data", "Pass", "123"].join(""),
			accessToken: login.body.data.accessToken,
			userId: created.body.data.user.id,
		};
		userIds.push(result.userId);
		await completeOnboarding(app, result.accessToken);
		return result;
	}

	it("未登录访问全部端点 → 401", async () => {
		await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.expect(401);
		await request(app.getHttpServer())
			.get("/api/data-requests/impact")
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
			.post("/api/data-requests/nope/cancel")
			.send({})
			.expect(401);
		await request(app.getHttpServer())
			.get("/api/data-requests/nope/download")
			.expect(401);
	});

	it("未完成首次设置 → 409 ONBOARDING_NOT_COMPLETED", async () => {
		const created = await request(app.getHttpServer())
			.post("/api/auth/register")
			.send({
				email: `raw-user-${Date.now()}@example.com`,
				password: ["Data", "Pass", "123"].join(""),
			})
			.expect(201);
		const rawToken = created.body.data.accessToken;
		userIds.push(created.body.data.user.id);

		const impact = await request(app.getHttpServer())
			.get("/api/data-requests/impact")
			.set("Authorization", `Bearer ${rawToken}`)
			.expect(409);
		expect(impact.body.code).toBe("ONBOARDING_NOT_COMPLETED");

		const create = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${rawToken}`)
			.send({ type: "EXPORT", challengeId: "whatever" })
			.expect(409);
		expect(create.body.code).toBe("ONBOARDING_NOT_COMPLETED");
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
			where: { userId: user.userId, type: "EXPORT" },
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
		const res = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({
				type: "CLEAR",
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
			where: { userId: user.userId, type: "EXPORT" },
			data: { downloadExpiresAt: new Date(Date.now() - 1000) },
		});
		const impact = await request(app.getHttpServer())
			.get("/api/data-requests/impact")
			.set("Authorization", `Bearer ${user.accessToken}`)
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
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({
				type: "CLEAR",
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

	it("CLEAR PENDING 期间：POST/PATCH 业务端点 403 DATA_REQUEST_LOCKED，GET 放行", async () => {
		const locked = await request(app.getHttpServer())
			.patch("/api/settings")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ region: "CN" })
			.expect(403);
		expect(locked.body.code).toBe("DATA_REQUEST_LOCKED");

		// GET 放行（停写不停看）
		await request(app.getHttpServer())
			.get("/api/settings")
			.set("Authorization", `Bearer ${user.accessToken}`)
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

	it("撤回：CLEAR 直接撤成功；DELETION 无验证码被拒、带 DELETION 验证成功", async () => {
		const { sendAndVerify: sv } = await import("../helpers/data-request-helper");
		const current = await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(200);
		expect(current.body.data.type).toBe("CLEAR");

		const cancelled = await request(app.getHttpServer())
			.post(`/api/data-requests/${current.body.data.id}/cancel`)
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({})
			.expect(200);
		expect(cancelled.body.data.status).toBe("CANCELLED");

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

		const locked = await request(app.getHttpServer())
			.get("/api/settings")
			.set("Authorization", `Bearer ${user.accessToken}`)
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
		const impact = await request(app.getHttpServer())
			.get("/api/data-requests/impact")
			.set("Authorization", `Bearer ${user.accessToken}`)
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
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({
				type: "CLEAR",
				challengeId,
				confirmedTotals: {
					...totals,
					accounts: totals.accounts + 1, // 确认后又多了一个账户
				},
			})
			.expect(409);
		expect(res.body.code).toBe("IMPACT_CHANGED");
	});

	it("F1-2 性能收敛：单次受保护请求仅验签 1 次、查 user 1 次、查 data_requests 1 次；已删除用户 token 零查 data_requests", async () => {
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

			// 1. 合法用户访问受保护业务端点（无进行中数据请求）
			await request(app.getHttpServer())
				.get("/api/settings")
				.set("Authorization", `Bearer ${user.accessToken}`)
				.expect(200);
			expect(verifySpy).toHaveBeenCalledTimes(1);
			expect(userFindSpy).toHaveBeenCalledTimes(1);
			expect(drFindManySpy).toHaveBeenCalledTimes(1);
			expect(drFindFirstSpy).not.toHaveBeenCalled();

			// 2. 合法签名但用户不存在的旧 token → 401，且在守卫阶段短路零查 data_requests
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

		// 3. CLEAR PENDING 期间单次查询不变量：GET 放行、POST 403 DATA_REQUEST_LOCKED，且均只查 1 次 dataRequest.findMany / 0 次 findFirst
		const lockUser = await onboardedUser("f1-2-clear-pending");
		const clearRow = await env.prisma.dataRequest.create({
			data: {
				userId: lockUser.userId,
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
				.expect(200);
			expect(drManyClearSpy).toHaveBeenCalledTimes(1);
			expect(drFirstClearSpy).not.toHaveBeenCalled();

			drManyClearSpy.mockClear();
			drFirstClearSpy.mockClear();
			const postRes = await request(app.getHttpServer())
				.post("/api/transactions")
				.set("Authorization", `Bearer ${lockUser.accessToken}`)
				.send({})
				.expect(403);
			expect(postRes.body.code).toBe("DATA_REQUEST_LOCKED");
			expect(drManyClearSpy).toHaveBeenCalledTimes(1);
			expect(drFirstClearSpy).not.toHaveBeenCalled();
		} finally {
			drManyClearSpy.mockRestore();
			drFirstClearSpy.mockRestore();
			await env.prisma.dataRequest
				.delete({ where: { id: clearRow.id } })
				.catch(() => {});
		}

		// 4. data_requests 查询异常边界：非白名单端点 fail-closed（500），@SkipDataRequestLock 白名单放行（200）
		const dbErrSpy = vi
			.spyOn(env.prisma.dataRequest, "findMany")
			.mockRejectedValue(new Error("simulated db connection error"));
		try {
			await request(app.getHttpServer())
				.get("/api/settings")
				.set("Authorization", `Bearer ${user.accessToken}`)
				.expect(500);
			await request(app.getHttpServer())
				.get("/api/auth/me")
				.set("Authorization", `Bearer ${user.accessToken}`)
				.expect(200);
		} finally {
			dbErrSpy.mockRestore();
		}
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
