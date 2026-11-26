import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveDefaultOrganizationId } from "../../src/authorization/default-organization";
import {
	cleanupUser,
	type TestUser,
} from "../helpers/test-app";
import {
	completeOnboarding,
	createDataRequestTestApp,
	makeRequestDue,
	sendAndVerify,
	type DataRequestTestEnv,
} from "../helpers/data-request-helper";

// 关闭全局接口限流（先例 plan-usage.spec）
vi.mock("@nestjs/throttler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nestjs/throttler")>();
	class NoopThrottlerGuard {
		async canActivate() {
			return true;
		}
	}
	return { ...actual, ThrottlerGuard: NoopThrottlerGuard };
});

/**
 * 组织域数据权利生命周期（integration）↔ src/data-request/organization-lock.guard.ts
 * + organization-data-request.controller.ts + organization.controller.ts
 * （ToB R1 技术方案 §9；Goal #3B W27）
 *
 * 真实应用 + 真实 Postgres 闭环覆盖：
 * 1. 组织 CLEAR 锁：PENDING 停写不停看 / PROCESSING 全锁；**只锁当前组织**，
 *    Org B 完全不受影响；同组织成员可见进度页；非 data.clear 角色不可发起 / 撤回；
 *    到期清空本组织账本并写审计；
 * 2. DELETE /api/organizations/current：Owner 唯一可发起 → PENDING 全锁 →
 *    同事务审计 → 到期删除该组织，成员 User 与 Org B 零损伤；
 * 3. 导出下载降权复验：发起导出后被降权 / 移除 / 切错组织一律 403 / 404；
 * 4. 个人账号删除锁隔离：成员 X 发起 PERSONAL DELETION → X 全端点 403
 *    ACCOUNT_PENDING_DELETION（到点删号后 401），同组织其他成员 Y 全程不受影响；
 * 5. Prisma query spy：两套锁守卫各自至多 1 条 data_requests SELECT。
 *
 * 到期推进用直接写库 dueAt 过去时刻构造（不等待真实时间、无 sleep）。
 */
describe("OrganizationData 生命周期（integration）", () => {
	let env: DataRequestTestEnv;
	let app: INestApplication;
	const userIds: string[] = [];

	async function onboardedUser(label: string): Promise<TestUser> {
		const created = await request(app.getHttpServer())
			.post("/api/auth/register")
			.send({
				email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
				password: ["Org", "Data", "123"].join(""),
				name: label,
			})
			.expect(201);
		const email = created.body.data.user.email as string;
		const login = await request(app.getHttpServer())
			.post("/api/auth/login")
			.send({ email, password: ["Org", "Data", "123"].join("") })
			.expect(200);
		const userId: string = created.body.data.user.id;
		const defaultOrganizationId = await resolveDefaultOrganizationId(env.prisma, userId);
		if (!defaultOrganizationId) throw new Error("注册兜底未建默认组织");
		const result: TestUser = {
			email,
			password: ["Org", "Data", "123"].join(""),
			accessToken: login.body.data.accessToken,
			userId,
			defaultOrganizationId,
		};
		userIds.push(result.userId);
		await completeOnboarding(app, result);
		return result;
	}

	async function defaultOrgIdOf(userId: string): Promise<string> {
		const organizationId = await resolveDefaultOrganizationId(env.prisma, userId);
		if (!organizationId) throw new Error("注册兜底未建默认组织");
		return organizationId;
	}

	/** 加入组织并赋予角色（返回成员关系 id） */
	async function addMember(
		organizationId: string,
		userId: string,
		role: "OWNER" | "ADMIN" | "FINANCE" | "OPERATOR" | "VIEWER",
	): Promise<void> {
		await env.prisma.membership.create({
			data: { organizationId, userId, role, status: "ACTIVE" },
		});
	}

	/** 提交组织域请求（verify → create），返回已完成的响应 */
	async function submitOrganizationRequest(
		member: TestUser,
		organizationId: string,
		type: "EXPORT" | "CLEAR" | "DELETION",
		extra: Record<string, unknown> = {},
	) {
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
			.set("X-Organization-Id", organizationId)
			.send({ type, scope: "ORGANIZATION", challengeId, ...extra });
	}

	/** 提交组织域请求并断言状态码 */
	async function submitOrganizationRequestExpect(
		member: TestUser,
		organizationId: string,
		type: "EXPORT" | "CLEAR" | "DELETION",
		status: number,
		extra: Record<string, unknown> = {},
	) {
		const res = await submitOrganizationRequest(member, organizationId, type, extra);
		expect(res.status, `${member.email} × ${type}`).toBe(status);
		return res;
	}

	/** 组织域影响页（清空确认页数据） */
	async function getImpact(member: TestUser, organizationId: string) {
		return request(app.getHttpServer())
			.get("/api/organizations/current/data-requests/impact")
			.set("Authorization", `Bearer ${member.accessToken}`)
			.set("X-Organization-Id", organizationId);
	}

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

	it("组织 CLEAR 锁：PENDING 停写不停看 / PROCESSING 全锁；只锁当前组织，Org B 零影响；到期清空本组织账本并写审计", async () => {
		const owner = await onboardedUser("org-clear-owner");
		const admin = await onboardedUser("org-clear-admin");
		const finance = await onboardedUser("org-clear-finance");
		const operator = await onboardedUser("org-clear-operator");
		const viewer = await onboardedUser("org-clear-viewer");
		const outsider = await onboardedUser("org-clear-outsider");

		const orgA = await defaultOrgIdOf(owner.userId);
		const orgB = await defaultOrgIdOf(outsider.userId);
		await addMember(orgA, admin.userId, "ADMIN");
		await addMember(orgA, finance.userId, "FINANCE");
		await addMember(orgA, operator.userId, "OPERATOR");
		await addMember(orgA, viewer.userId, "VIEWER");
		// 同一用户同时属于 Org A 与 Org B（验证零跨组织误锁）
		await addMember(orgB, owner.userId, "ADMIN");

		// Org A 与 Org B 各写一笔业务数据（金额用于断言清空范围）
		for (const organizationId of [orgA, orgB]) {
			await env.prisma.account.create({
				data: {
					organizationId,
					createdById: owner.userId,
					currencyCode: "USD",
					balance: "900.0000",
				},
			});
		}

		// 角色判权：Finance / Operator / Viewer 不可发起 CLEAR（需 data.clear）
		for (const member of [finance, operator, viewer]) {
			const denied = await submitOrganizationRequestExpect(member, orgA, "CLEAR", 403, {
				confirmedTotals: {
					accounts: 1,
					transactions: 0,
					initialHoldings: 0,
					plans: 0,
					usageRecords: 0,
					corrections: 0,
				},
			});
			expect(denied.body.code).toBe("PERMISSION_DENIED");
		}
		// 被拒请求零副作用
		expect(await env.prisma.dataRequest.count({ where: { organizationId: orgA } })).toBe(0);

		// Admin 发起 CLEAR → PENDING（7 日撤回期）
		const impact = await getImpact(admin, orgA);
		expect(impact.status).toBe(200);
		const clear = await submitOrganizationRequestExpect(admin, orgA, "CLEAR", 200, {
			confirmedTotals: impact.body.data.totals,
		});
		expect(clear.body.data).toMatchObject({
			type: "CLEAR",
			scope: "ORGANIZATION",
			organizationId: orgA,
			status: "PENDING",
			canCancel: true,
		});

		// PENDING 冷静期：停写不停看
		const locked = await request(app.getHttpServer())
			.post("/api/transactions")
			.set("Authorization", `Bearer ${admin.accessToken}`)
			.set("X-Organization-Id", orgA)
			.send({
				currencyCode: "EUR",
				quantity: "10",
				principalAmount: "78",
				exchangeRate: "7.8",
				feeAmount: "0",
				transactedAt: new Date().toISOString(),
			})
			.expect(403);
		expect(locked.body.code).toBe("ORGANIZATION_DATA_LOCKED");
		await request(app.getHttpServer())
			.get("/api/accounts")
			.set("Authorization", `Bearer ${admin.accessToken}`)
			.set("X-Organization-Id", orgA)
			.expect(200);

		// [I-3] 控制平面端点不被组织锁拦：冷静期内 Owner 再发起组织删除 →
		// 统一 409 DATA_REQUEST_CONFLICT，data 附原 CLEAR 请求（普通业务端点仍 403）
		const deletionCredential = await sendAndVerify(
			app,
			env.otpChannel,
			owner.accessToken,
			owner.email,
			"DELETION",
		);
		const conflict = await request(app.getHttpServer())
			.delete("/api/organizations/current")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgA)
			.send({ challengeId: deletionCredential.challengeId })
			.expect(409);
		expect(conflict.body.code).toBe("DATA_REQUEST_CONFLICT");
		expect(conflict.body.data).toMatchObject({
			id: clear.body.data.id,
			type: "CLEAR",
			scope: "ORGANIZATION",
			status: "PENDING",
		});

		// [N-4] PROCESSING（清理进行中）：全端点拦截——连 GET 也 403
		await env.prisma.dataRequest.update({
			where: { id: clear.body.data.id as string },
			data: { status: "PROCESSING" },
		});
		const processingRead = await request(app.getHttpServer())
			.get("/api/accounts")
			.set("Authorization", `Bearer ${admin.accessToken}`)
			.set("X-Organization-Id", orgA)
			.expect(403);
		expect(processingRead.body.code).toBe("ORGANIZATION_DATA_LOCKED");
		const processingWrite = await request(app.getHttpServer())
			.post("/api/transactions")
			.set("Authorization", `Bearer ${admin.accessToken}`)
			.set("X-Organization-Id", orgA)
			.send({
				currencyCode: "EUR",
				quantity: "10",
				principalAmount: "78",
				exchangeRate: "7.8",
				feeAmount: "0",
				transactedAt: new Date().toISOString(),
			})
			.expect(403);
		expect(processingWrite.body.code).toBe("ORGANIZATION_DATA_LOCKED");
		// 复原为 PENDING（后续撤回与到期推进用例继续）
		await env.prisma.dataRequest.update({
			where: { id: clear.body.data.id as string },
			data: { status: "PENDING" },
		});

		// 零跨组织误锁：同一用户切到 Org B 读写完全正常
		await request(app.getHttpServer())
			.get("/api/accounts")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgB)
			.expect(200);
		const orgBWrite = await request(app.getHttpServer())
			.post("/api/transactions")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgB)
			.send({
				currencyCode: "EUR",
				quantity: "10",
				principalAmount: "78",
				exchangeRate: "7.8",
				feeAmount: "0",
				transactedAt: new Date().toISOString(),
			})
			.expect(201);
		// Org B 清空前的行数基线（建账账户 + 买入产生的账户）
		const orgBAccountsBefore = await env.prisma.account.count({
			where: { organizationId: orgB },
		});
		const orgBTransactionsBefore = await env.prisma.transaction.count({
			where: { organizationId: orgB },
		});

		// 同组织成员可见进度页（白名单）
		const progress = await request(app.getHttpServer())
			.get("/api/organizations/current/data-requests/current")
			.set("Authorization", `Bearer ${viewer.accessToken}`)
			.set("X-Organization-Id", orgA)
			.expect(200);
		expect(progress.body.data).toMatchObject({ type: "CLEAR", status: "PENDING" });

		// 撤回权限按请求类型核验：发起人失去 data.clear 后撤回被拒（403 PERMISSION_DENIED）
		await env.prisma.membership.update({
			where: {
				organizationId_userId: { organizationId: orgA, userId: admin.userId },
			},
			data: { role: "FINANCE" },
		});
		const deniedCancel = await request(app.getHttpServer())
			.post(
				`/api/organizations/current/data-requests/${clear.body.data.id as string}/cancel`,
			)
			.set("Authorization", `Bearer ${admin.accessToken}`)
			.set("X-Organization-Id", orgA)
			.send({})
			.expect(403);
		expect(deniedCancel.body.code).toBe("PERMISSION_DENIED");
		// 恢复角色（后续断言与审计需要 Admin 身份）
		await env.prisma.membership.update({
			where: {
				organizationId_userId: { organizationId: orgA, userId: admin.userId },
			},
			data: { role: "ADMIN" },
		});

		// 到期推进 → 清空本组织账本（Org B 与成员身份零变化）
		await makeRequestDue(
			env.prisma,
			clear.body.data.id as string,
			new Date(Date.now() - 1000),
		);
		await request(app.getHttpServer())
			.get("/api/organizations/current")
			.set("Authorization", `Bearer ${admin.accessToken}`)
			.set("X-Organization-Id", orgA)
			.expect(200);

		expect(await env.prisma.account.count({ where: { organizationId: orgA } })).toBe(0);
		expect(await env.prisma.transaction.count({ where: { organizationId: orgA } })).toBe(0);
		// Org B 完全不受影响（行数与发起清空前一致）
		expect(await env.prisma.account.count({ where: { organizationId: orgB } })).toBe(
			orgBAccountsBefore,
		);
		expect(
			await env.prisma.transaction.count({ where: { organizationId: orgB } }),
		).toBe(orgBTransactionsBefore);
		expect(
			await env.prisma.transaction.count({ where: { id: orgBWrite.body.data.id } }),
		).toBe(1);
		// 成员关系与账号保留
		expect(await env.prisma.membership.count({ where: { organizationId: orgA } })).toBe(5);
		expect(
			await env.prisma.user.count({ where: { id: { in: [owner.userId, admin.userId] } } }),
		).toBe(2);
		// 请求终态 + 同事务审计留痕
		const row = await env.prisma.dataRequest.findUniqueOrThrow({
			where: { id: clear.body.data.id as string },
		});
		expect(row.status).toBe("COMPLETED");
		expect(
			await env.prisma.auditLog.count({
				where: {
					organizationId: orgA,
					action: "data.clear.execute",
					result: "SUCCESS",
				},
			}),
		).toBe(1);
	});

	it("DELETE /api/organizations/current：仅 Owner 可发起 → PENDING 全锁 → 到期删除组织，成员 User 与 Org B 零损伤", async () => {
		const owner = await onboardedUser("org-del-owner");
		const admin = await onboardedUser("org-del-admin");
		const orgId = await defaultOrgIdOf(owner.userId);
		await addMember(orgId, admin.userId, "ADMIN");
		await env.prisma.account.create({
			data: {
				organizationId: orgId,
				createdById: owner.userId,
				currencyCode: "USD",
				balance: "900.0000",
			},
		});
		// Owner 的另一个组织：删除默认组织不得波及它
		const otherOrg = await env.prisma.organization.create({
			data: {
				name: "保留组织",
				memberships: {
					create: { userId: owner.userId, role: "OWNER", status: "ACTIVE" },
				},
			},
			select: { id: true },
		});
		await env.prisma.account.create({
			data: {
				organizationId: otherOrg.id,
				createdById: owner.userId,
				currencyCode: "USD",
				balance: "100.0000",
			},
		});

		// Admin 不可发起（organization.delete 仅 Owner）
		const adminCredential = await sendAndVerify(
			app,
			env.otpChannel,
			admin.accessToken,
			admin.email,
			"DELETION",
		);
		const denied = await request(app.getHttpServer())
			.delete("/api/organizations/current")
			.set("Authorization", `Bearer ${admin.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({ challengeId: adminCredential.challengeId })
			.expect(403);
		expect(denied.body.code).toBe("PERMISSION_DENIED");

		// 缺少凭证 → 拒绝（仅登录不算发起删除）
		const missing = await request(app.getHttpServer())
			.delete("/api/organizations/current")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({})
			.expect(400);
		expect(missing.body.message).toEqual(
			expect.arrayContaining([expect.stringContaining("challengeId")]),
		);

		// Owner 发起 → PENDING 7 日撤回期
		const ownerCredential = await sendAndVerify(
			app,
			env.otpChannel,
			owner.accessToken,
			owner.email,
			"DELETION",
		);
		const deletion = await request(app.getHttpServer())
			.delete("/api/organizations/current")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({ challengeId: ownerCredential.challengeId })
			.expect(200);
		expect(deletion.body.data).toMatchObject({
			type: "DELETION",
			scope: "ORGANIZATION",
			organizationId: orgId,
			status: "PENDING",
			displayStatus: "WITHDRAWAL_PERIOD",
		});

		// PENDING 期间全端点拦截（含 GET），白名单仍可达
		const locked = await request(app.getHttpServer())
			.get("/api/accounts")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(403);
		expect(locked.body.code).toBe("ORGANIZATION_DATA_LOCKED");
		await request(app.getHttpServer())
			.get("/api/organizations/current/data-requests/current")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(200);

		// 撤回期内可撤回（凭 DELETION 用途凭证）→ 组织保留
		const cancelCredential = await sendAndVerify(
			app,
			env.otpChannel,
			owner.accessToken,
			owner.email,
			"DELETION",
		);
		const cancelled = await request(app.getHttpServer())
			.post(
				`/api/organizations/current/data-requests/${deletion.body.data.id as string}/cancel`,
			)
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({ challengeId: cancelCredential.challengeId })
			.expect(200);
		expect(cancelled.body.data.status).toBe("CANCELLED");
		expect(await env.prisma.organization.findUnique({ where: { id: orgId } })).not.toBeNull();

		// 再次发起 → 到期删除组织（成员 User 不删、其他组织零损伤）
		const secondCredential = await sendAndVerify(
			app,
			env.otpChannel,
			owner.accessToken,
			owner.email,
			"DELETION",
		);
		const again = await request(app.getHttpServer())
			.delete("/api/organizations/current")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({ challengeId: secondCredential.challengeId })
			.expect(200);
		await makeRequestDue(
			env.prisma,
			again.body.data.id as string,
			new Date(Date.now() - 1000),
		);
		// 到期推进：组织已删 → 404（不得残留虚幻权限）
		await request(app.getHttpServer())
			.get("/api/organizations/current")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(404);

		expect(await env.prisma.organization.findUnique({ where: { id: orgId } })).toBeNull();
		expect(await env.prisma.membership.count({ where: { organizationId: orgId } })).toBe(0);
		expect(await env.prisma.dataRequest.count({ where: { organizationId: orgId } })).toBe(0);
		// 成员 User 账号保留（组织删除绝不删成员身份）
		expect(
			await env.prisma.user.count({ where: { id: { in: [owner.userId, admin.userId] } } }),
		).toBe(2);
		// 另一个组织零损伤
		expect(await env.prisma.account.count({ where: { organizationId: otherOrg.id } })).toBe(1);
		// 删除留痕：仅保留一条删除审计
		const logs = await env.prisma.auditLog.findMany({ where: { organizationId: orgId } });
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			action: "organization.delete.execute",
			actorUserId: owner.userId,
			result: "SUCCESS",
		});
		await env.prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
	});

	it("[I-4] 未建账组织也可删除：Owner 发起 DELETE 成功 → 到期组织被完整删除（其他组织零影响）", async () => {
		const owner = await onboardedUser("org-unbuilt-owner");
		const other = await onboardedUser("org-unbuilt-other");
		// 新建组织：创建者 OWNER，但**未建账**（无 OrganizationSettings）
		const created = await request(app.getHttpServer())
			.post("/api/organizations")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.send({ name: "未建账组织" })
			.expect(201);
		const orgId = created.body.data.id as string;
		expect(
			await env.prisma.organizationSettings.count({ where: { organizationId: orgId } }),
		).toBe(0);
		// 其他用户的组织：删除本组织不得波及
		const otherOrgId = await defaultOrgIdOf(other.userId);

		// 未建账组织的 Owner 发起删除 → 成功进入 7 日撤回期（不受 ONBOARDING 限制）
		const credential = await sendAndVerify(
			app,
			env.otpChannel,
			owner.accessToken,
			owner.email,
			"DELETION",
		);
		const deletion = await request(app.getHttpServer())
			.delete("/api/organizations/current")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({ challengeId: credential.challengeId })
			.expect(200);
		expect(deletion.body.data).toMatchObject({
			type: "DELETION",
			scope: "ORGANIZATION",
			organizationId: orgId,
			status: "PENDING",
		});

		// 到期推进 → 组织被完整删除
		await makeRequestDue(
			env.prisma,
			deletion.body.data.id as string,
			new Date(Date.now() - 1000),
		);
		await request(app.getHttpServer())
			.get("/api/organizations/current")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(404);
		expect(await env.prisma.organization.findUnique({ where: { id: orgId } })).toBeNull();
		expect(await env.prisma.membership.count({ where: { organizationId: orgId } })).toBe(0);
		expect(await env.prisma.dataRequest.count({ where: { organizationId: orgId } })).toBe(0);
		// 其他用户的组织与账号零损伤
		expect(
			await env.prisma.organization.findUnique({ where: { id: otherOrgId } }),
		).not.toBeNull();
		expect(await env.prisma.user.count({ where: { id: other.userId } })).toBe(1);
		await env.prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
	});

	it("[I-4] 唯一 Owner 的个人注销死锁闭环（未建账组织）：409 LAST_OWNER_REQUIRED → 删除该组织 → 再次个人注销放行", async () => {
		const sole = await onboardedUser("org-sole-owner");
		const successor = await onboardedUser("org-sole-successor");
		// 解除默认组织的唯一 Owner 阻塞（先降后升，遵守单活跃 Owner 不变量）：
		// 默认组织交给 successor，sole 在其中降为 ADMIN → 阻塞源唯一
		const defaultOrgId = await defaultOrgIdOf(sole.userId);
		await env.prisma.membership.updateMany({
			where: {
				organizationId: defaultOrgId,
				userId: sole.userId,
				role: "OWNER",
				status: "ACTIVE",
			},
			data: { role: "ADMIN" },
		});
		await env.prisma.membership.create({
			data: {
				organizationId: defaultOrgId,
				userId: successor.userId,
				role: "OWNER",
				status: "ACTIVE",
			},
		});
		// 阻塞源用**未建账的新组织**（POST /api/organizations 创建者即唯一 OWNER）——
		// 只有这样才能钉住 I-4 修复：删除未建账组织同样不受 ONBOARDING 限制。
		// （用已建账默认组织作阻塞源时，删除路径走不到「未建账」这一新分支。）
		const created = await request(app.getHttpServer())
			.post("/api/organizations")
			.set("Authorization", `Bearer ${sole.accessToken}`)
			.send({ name: "未建账阻塞组织" })
			.expect(201);
		const orgId = created.body.data.id as string;
		expect(
			await env.prisma.organizationSettings.count({ where: { organizationId: orgId } }),
		).toBe(0);
		// 本人是该组织唯一所有者 → 个人注销被 409 阻塞
		const blockedCredential = await sendAndVerify(
			app,
			env.otpChannel,
			sole.accessToken,
			sole.email,
			"DELETION",
		);
		const blocked = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${sole.accessToken}`)
			.send({ type: "DELETION", scope: "PERSONAL", challengeId: blockedCredential.challengeId })
			.expect(409);
		expect(blocked.body.code).toBe("LAST_OWNER_REQUIRED");
		expect(blocked.body.data.blockingOrganizations).toEqual([
			{ organizationId: orgId, organizationName: expect.any(String), role: "OWNER" },
		]);
		expect(
			await env.prisma.dataRequest.count({ where: { requesterUserId: sole.userId } }),
		).toBe(0);

		// 闭环路径：删除该组织（Owner 专属）→ 组织消失 → 最后 Owner 阻塞解除
		const orgDeletionCredential = await sendAndVerify(
			app,
			env.otpChannel,
			sole.accessToken,
			sole.email,
			"DELETION",
		);
		const orgDeletion = await request(app.getHttpServer())
			.delete("/api/organizations/current")
			.set("Authorization", `Bearer ${sole.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({ challengeId: orgDeletionCredential.challengeId })
			.expect(200);
		await makeRequestDue(
			env.prisma,
			orgDeletion.body.data.id as string,
			new Date(Date.now() - 1000),
		);
		await request(app.getHttpServer())
			.get("/api/organizations/current")
			.set("Authorization", `Bearer ${sole.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(404);
		expect(await env.prisma.organization.findUnique({ where: { id: orgId } })).toBeNull();

		// 再次发起个人注销 → 放行（进入 7 日撤回期）
		const retryCredential = await sendAndVerify(
			app,
			env.otpChannel,
			sole.accessToken,
			sole.email,
			"DELETION",
		);
		const allowed = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${sole.accessToken}`)
			.send({ type: "DELETION", scope: "PERSONAL", challengeId: retryCredential.challengeId })
			.expect(200);
		expect(allowed.body.data).toMatchObject({
			type: "DELETION",
			scope: "PERSONAL",
			organizationId: null,
			status: "PENDING",
			displayStatus: "WITHDRAWAL_PERIOD",
		});
		await env.prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
	});

	it("组织导出下载降权复验：降权 / 移除 / 切错组织一律 403 或 404，绝不可凭旧 id 偷下组织账本", async () => {
		const owner = await onboardedUser("org-dl-owner");
		const finance = await onboardedUser("org-dl-finance");
		const orgId = await defaultOrgIdOf(owner.userId);
		await addMember(orgId, finance.userId, "FINANCE");

		// Finance 发起组织导出（data.export 具备）
		const exportRes = await submitOrganizationRequestExpect(finance, orgId, "EXPORT", 200);
		const exportId = exportRes.body.data.id as string;
		expect(exportRes.body.data.download.url).toContain(
			"/api/organizations/current/data-requests/",
		);

		// 正常下载（发起人 + 当前权限 + 组织绑定均满足）
		await request(app.getHttpServer())
			.get(`/api/organizations/current/data-requests/${exportId}/download`)
			.set("Authorization", `Bearer ${finance.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(200);

		// 降权为 OPERATOR（失去 data.export）→ 严格 403 PERMISSION_DENIED（权限守卫）
		await env.prisma.membership.update({
			where: {
				organizationId_userId: { organizationId: orgId, userId: finance.userId },
			},
			data: { role: "OPERATOR" },
		});
		const downgraded = await request(app.getHttpServer())
			.get(`/api/organizations/current/data-requests/${exportId}/download`)
			.set("Authorization", `Bearer ${finance.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(403);
		expect(downgraded.body.code).toBe("PERMISSION_DENIED");

		// 降权为 VIEWER → 同样严格 403
		await env.prisma.membership.update({
			where: {
				organizationId_userId: { organizationId: orgId, userId: finance.userId },
			},
			data: { role: "VIEWER" },
		});
		const viewer = await request(app.getHttpServer())
			.get(`/api/organizations/current/data-requests/${exportId}/download`)
			.set("Authorization", `Bearer ${finance.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(403);
		expect(viewer.body.code).toBe("PERMISSION_DENIED");

		// 被移出组织（DISABLED）→ 404（组织上下文不可达）
		await env.prisma.membership.update({
			where: {
				organizationId_userId: { organizationId: orgId, userId: finance.userId },
			},
			data: { status: "DISABLED" },
		});
		const removed = await request(app.getHttpServer())
			.get(`/api/organizations/current/data-requests/${exportId}/download`)
			.set("Authorization", `Bearer ${finance.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(404);
		expect(removed.body.code).toBe("ORGANIZATION_NOT_FOUND");

		// 切错 X-Organization-Id → 严格 404 DATA_REQUEST_NOT_FOUND（组织绑定校验）
		//
		// 判别力前提（R2-I1 修复）：发起人 finance 必须在**原导出组织 orgId** 内恢复
		// 完全合法的下载资格（ACTIVE + FINANCE + data.export）——否则上面的
		// 「被移出组织（DISABLED）」会残留状态，使本例的 404 可能来自
		// canDownloadOrganizationExport 的成员资格校验而非**组织绑定校验**本身（假绿）。
		await env.prisma.membership.update({
			where: {
				organizationId_userId: { organizationId: orgId, userId: finance.userId },
			},
			data: { role: "FINANCE", status: "ACTIVE" },
		});
		// 同时让 finance 成为 wrongOrg 的 ACTIVE FINANCE 成员：
		// 请求方在「切过去的组织」里完全合法 → 唯一能拦下请求的就是组织绑定校验。
		const wrongOrg = await env.prisma.organization.create({
			data: {
				name: "另一个组织",
				memberships: {
					create: { userId: owner.userId, role: "OWNER", status: "ACTIVE" },
				},
			},
			select: { id: true },
		});
		await addMember(wrongOrg.id, finance.userId, "FINANCE");
		expect(wrongOrg.id).not.toBe(orgId);
		const wrongOrgDownload = await request(app.getHttpServer())
			.get(`/api/organizations/current/data-requests/${exportId}/download`)
			.set("Authorization", `Bearer ${finance.accessToken}`)
			.set("X-Organization-Id", wrongOrg.id)
			.expect(404);
		expect(wrongOrgDownload.body.code).toBe("DATA_REQUEST_NOT_FOUND");

		// 非本人（其他成员）下载 → 404（requester 校验，不泄露存在性）
		const other = await onboardedUser("org-dl-other");
		await addMember(orgId, other.userId, "FINANCE");
		const notRequester = await request(app.getHttpServer())
			.get(`/api/organizations/current/data-requests/${exportId}/download`)
			.set("Authorization", `Bearer ${other.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(404);
		expect(notRequester.body.code).toBe("DATA_REQUEST_NOT_FOUND");

		// 个人端点不得下载组织域导出（跨域 404）
		const crossDomain = await request(app.getHttpServer())
			.get(`/api/data-requests/${exportId}/download`)
			.set("Authorization", `Bearer ${finance.accessToken}`)
			.expect(404);
		expect(crossDomain.body.code).toBe("DATA_REQUEST_NOT_FOUND");
	});

	it("个人账号删除锁隔离：成员 X 发起 PERSONAL DELETION → X 全端 403（到点删号后 401），同组织成员 Y 零影响", async () => {
		const memberX = await onboardedUser("lock-x");
		const memberY = await onboardedUser("lock-y");
		const orgId = await defaultOrgIdOf(memberX.userId);
		await addMember(orgId, memberY.userId, "ADMIN");
		// 解除 X 的唯一 Owner 阻塞：所有权转给 Y（X 降为 ADMIN）
		await env.prisma.membership.updateMany({
			where: { organizationId: orgId, userId: memberX.userId, role: "OWNER" },
			data: { role: "ADMIN" },
		});
		await env.prisma.membership.updateMany({
			where: { organizationId: orgId, userId: memberY.userId, role: "ADMIN" },
			data: { role: "OWNER" },
		});

		const { challengeId } = await sendAndVerify(
			app,
			env.otpChannel,
			memberX.accessToken,
			memberX.email,
			"DELETION",
		);
		const deletion = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${memberX.accessToken}`)
			.send({ type: "DELETION", scope: "PERSONAL", challengeId })
			.expect(200);
		expect(deletion.body.data).toMatchObject({
			type: "DELETION",
			scope: "PERSONAL",
			status: "PENDING",
		});

		// X 全端点被拦（含 GET）→ 403 ACCOUNT_PENDING_DELETION
		for (const path of ["/api/settings", "/api/accounts", "/api/organizations/current"]) {
			const blocked = await request(app.getHttpServer())
				.get(path)
				.set("Authorization", `Bearer ${memberX.accessToken}`)
				.set("X-Organization-Id", orgId)
				.expect(403);
			expect(blocked.body.code, path).toBe("ACCOUNT_PENDING_DELETION");
		}
		// 个人白名单仍可达（进度页 / 验证码）
		await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.set("Authorization", `Bearer ${memberX.accessToken}`)
			.expect(200);

		// 同组织成员 Y 全程不受影响（零跨成员误锁）
		await request(app.getHttpServer())
			.get("/api/accounts")
			.set("Authorization", `Bearer ${memberY.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(200);
		const yWrite = await request(app.getHttpServer())
			.post("/api/transactions")
			.set("Authorization", `Bearer ${memberY.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({
				currencyCode: "EUR",
				quantity: "10",
				principalAmount: "78",
				exchangeRate: "7.8",
				feeAmount: "0",
				transactedAt: new Date().toISOString(),
			})
			.expect(201);

		// 到期 → 物理删除账号；同请求的 JwtAuthGuard 返回 401
		await makeRequestDue(
			env.prisma,
			deletion.body.data.id as string,
			new Date(Date.now() - 1000),
		);
		await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.set("Authorization", `Bearer ${memberX.accessToken}`)
			.expect(401);
		expect(await env.prisma.user.findUnique({ where: { id: memberX.userId } })).toBeNull();
		// Y 与组织账本零损伤
		expect(await env.prisma.user.findUnique({ where: { id: memberY.userId } })).not.toBeNull();
		expect(
			await env.prisma.transaction.count({ where: { id: yWrite.body.data.id } }),
		).toBe(1);
		expect(await env.prisma.membership.count({ where: { organizationId: orgId } })).toBe(1);
	});

	it("[Nit-2] 到期个人注销：组织端点（非白名单）由 OrganizationLockGuard 直接 401，且 User 已被物理删除", async () => {
		const member = await onboardedUser("lock-401");
		const successor = await onboardedUser("lock-401-successor");
		const orgId = await defaultOrgIdOf(member.userId);
		// 解除最后 Owner 阻塞（所有权转给 successor）
		await env.prisma.membership.updateMany({
			where: {
				organizationId: orgId,
				userId: member.userId,
				role: "OWNER",
				status: "ACTIVE",
			},
			data: { role: "ADMIN" },
		});
		await env.prisma.membership.create({
			data: {
				organizationId: orgId,
				userId: successor.userId,
				role: "OWNER",
				status: "ACTIVE",
			},
		});

		const { challengeId } = await sendAndVerify(
			app,
			env.otpChannel,
			member.accessToken,
			member.email,
			"DELETION",
		);
		const deletion = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${member.accessToken}`)
			.send({ type: "DELETION", scope: "PERSONAL", challengeId })
			.expect(200);
		expect(deletion.body.data.status).toBe("PENDING");

		// 到期 → 携带组织头访问**非白名单**组织业务端点：
		// 合并查询推进到期注销 → 物理删号 → 守卫 invalidateRequestUser 后直接 401
		await makeRequestDue(
			env.prisma,
			deletion.body.data.id as string,
			new Date(Date.now() - 1000),
		);
		await request(app.getHttpServer())
			.get("/api/accounts")
			.set("Authorization", `Bearer ${member.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(401);
		// User 已物理删除（账号注销完成）
		expect(await env.prisma.user.findUnique({ where: { id: member.userId } })).toBeNull();
		expect(
			await env.prisma.dataRequest.count({ where: { requesterUserId: member.userId } }),
		).toBe(0);
	});

	it("回归（W30）：唯一成员的空组织在 PERSONAL DELETION 到期后被一并删除（organization.findUnique 为 null）", async () => {
		const soleMember = await onboardedUser("orphan-empty-org");
		const emptyOrg = await env.prisma.organization.create({
			data: { name: "个人注销待回收空组织" },
		});
		await env.prisma.membership.create({
			data: {
				organizationId: emptyOrg.id,
				userId: soleMember.userId,
				role: "ADMIN",
				status: "ACTIVE",
			},
		});
		await env.prisma.organizationSettings.create({
			data: { organizationId: emptyOrg.id, baseCurrency: "USD" },
		});
		await env.prisma.organizationInvitation.create({
			data: {
				organizationId: emptyOrg.id,
				email: `orphan-invite-${Date.now()}@example.com`,
				tokenHash: `orphan-hash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				role: "VIEWER",
				invitedById: soleMember.userId,
				expiresAt: new Date(Date.now() + 86_400_000),
			},
		});
		await env.prisma.auditLog.create({
			data: {
				organizationId: emptyOrg.id,
				actorUserId: soleMember.userId,
				actorType: "USER",
				action: "organization.settings.update",
				result: "SUCCESS",
			},
		});
		// 让默认个人组织转给另一位 Owner，确保仅有空组织由 soleMember 作为唯一非 Owner 成员持有
		const successor = await onboardedUser("orphan-empty-successor");
		const defaultOrgId = await defaultOrgIdOf(soleMember.userId);
		await env.prisma.membership.updateMany({
			where: { organizationId: defaultOrgId, userId: soleMember.userId },
			data: { role: "ADMIN" },
		});
		await addMember(defaultOrgId, successor.userId, "OWNER");

		const { challengeId } = await sendAndVerify(
			app,
			env.otpChannel,
			soleMember.accessToken,
			soleMember.email,
			"DELETION",
		);
		const deletion = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${soleMember.accessToken}`)
			.send({ type: "DELETION", scope: "PERSONAL", challengeId })
			.expect(200);
		await makeRequestDue(
			env.prisma,
			deletion.body.data.id as string,
			new Date(Date.now() - 1000),
		);

		await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.set("Authorization", `Bearer ${soleMember.accessToken}`)
			.expect(401);

		expect(await env.prisma.user.findUnique({ where: { id: soleMember.userId } })).toBeNull();
		expect(await env.prisma.organization.findUnique({ where: { id: emptyOrg.id } })).toBeNull();
		expect(
			await env.prisma.organizationSettings.count({ where: { organizationId: emptyOrg.id } }),
		).toBe(0);
		expect(
			await env.prisma.organizationInvitation.count({ where: { organizationId: emptyOrg.id } }),
		).toBe(0);
		expect(await env.prisma.auditLog.count({ where: { organizationId: emptyOrg.id } })).toBe(0);
	});

	it("双守卫查询不变量：每个请求至多 1 次 data_requests SELECT（组织端点走合并查询；读时推进仅在到期候选时触发）", async () => {
		const member = await onboardedUser("sql-count");
		const orgId = await defaultOrgIdOf(member.userId);
		const findManySpy = vi.spyOn(env.prisma.dataRequest, "findMany");
		const findFirstSpy = vi.spyOn(env.prisma.dataRequest, "findFirst");
		try {
			// 组织上下文端点：OrganizationLockGuard 一条**合并查询**
			// （个人域注销 ∪ 当前组织清空/删除）判定两把锁 → 仍然只有 1 条
			findManySpy.mockClear();
			findFirstSpy.mockClear();
			await request(app.getHttpServer())
				.get("/api/accounts")
				.set("Authorization", `Bearer ${member.accessToken}`)
				.set("X-Organization-Id", orgId)
				.expect(200);
			expect(findManySpy).toHaveBeenCalledTimes(1);
			expect(findFirstSpy).not.toHaveBeenCalled();

			// 合并查询的两条分支口径互不重叠：个人域只看本人，组织域只看当前组织
			const queries = findManySpy.mock.calls.map((call) => {
				const where = (call[0] as { where?: Record<string, unknown> })?.where ?? {};
				return where;
			});
			expect(queries).toHaveLength(1);
			const branches = (queries[0]?.OR ?? []) as Array<Record<string, unknown>>;
			expect(
				branches.some(
					(branch) =>
						branch.scope === "PERSONAL" &&
						branch.requesterUserId === member.userId &&
						branch.type === "DELETION",
				),
			).toBe(true);
			expect(
				branches.some((branch) => {
					if (
						branch.scope !== "ORGANIZATION" ||
						branch.organizationId !== orgId
					) {
						return false;
					}
					const types = (branch.type as { in?: string[] })?.in ?? [];
					return types.includes("CLEAR") && types.includes("DELETION");
				}),
			).toBe(true);

			// 个人域端点：仅个人锁 1 次（进度视图自身用 findFirst 取视图，不属锁查询口径）
			findManySpy.mockClear();
			findFirstSpy.mockClear();
			await request(app.getHttpServer())
				.get("/api/data-requests/current")
				.set("Authorization", `Bearer ${member.accessToken}`)
				.expect(200);
			expect(findManySpy).toHaveBeenCalledTimes(1);
			expect(findFirstSpy).toHaveBeenCalledTimes(1);

			// [N-3] GET /api/organizations/current：合并查询 1 次且 **findFirst 0 次**
			//（当前组织视图复用守卫挂到 request 的锁摘要，不再额外查一次 data_requests）
			findManySpy.mockClear();
			findFirstSpy.mockClear();
			await request(app.getHttpServer())
				.get("/api/organizations/current")
				.set("Authorization", `Bearer ${member.accessToken}`)
				.set("X-Organization-Id", orgId)
				.expect(200);
			expect(findManySpy).toHaveBeenCalledTimes(1);
			expect(findFirstSpy).not.toHaveBeenCalled();
		} finally {
			findManySpy.mockRestore();
			findFirstSpy.mockRestore();
		}

		// [Nit-5] 读时推进仅在「确有到期候选」时触发清理：
		// 种入 1 条**未到期**（dueAt > now）的组织级 CLEAR PENDING → 不产生任何清理写
		const notDue = await env.prisma.dataRequest.create({
			data: {
				requesterUserId: member.userId,
				scope: "ORGANIZATION",
				organizationId: orgId,
				type: "CLEAR",
				status: "PENDING",
				requestedAt: new Date(),
				dueAt: new Date(Date.now() + 60 * 60 * 1000),
			},
		});
		const accountsBefore = await env.prisma.account.count({
			where: { organizationId: orgId },
		});
		const requestsBefore = await env.prisma.dataRequest.count();
		// CLEAR PENDING 冷静期：停写不停看 → GET 放行
		await request(app.getHttpServer())
			.get("/api/accounts")
			.set("Authorization", `Bearer ${member.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(200);
		// 请求仍为 PENDING（未被推进执行）、总行数不变、账本一行未删
		const stillPending = await env.prisma.dataRequest.findUniqueOrThrow({
			where: { id: notDue.id },
		});
		expect(stillPending.status).toBe("PENDING");
		expect(await env.prisma.dataRequest.count()).toBe(requestsBefore);
		expect(
			await env.prisma.account.count({ where: { organizationId: orgId } }),
		).toBe(accountsBefore);
		// 白名单端点同样不推进未到期请求
		await request(app.getHttpServer())
			.get("/api/organizations/current")
			.set("Authorization", `Bearer ${member.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(200);
		expect(
			(
				await env.prisma.dataRequest.findUniqueOrThrow({
					where: { id: notDue.id },
				})
			).status,
		).toBe("PENDING");
		await env.prisma.dataRequest.delete({ where: { id: notDue.id } });
	});
});
