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
	seedBusinessData,
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
 * 集成测试 ↔ src/data-request/data-request.service.ts（account-data 方案 §10.3；
 * ToB R1 技术方案 §9 双域拆分）
 *
 * 一条业务流一个文件：组织清空生命周期 / 个人注销生命周期 / 组织删除生命周期 / 清理异常回滚。
 * 到期推进用直接写库 dueAt 过去时刻构造，经守卫读时惰性推进触发（不等待真实时间）。
 */
describe("AccountData 生命周期（integration）", () => {
	let env: DataRequestTestEnv;
	let app: INestApplication;
	const userIds: string[] = [];

	async function onboardedUser(label: string): Promise<TestUser> {
		const created = await request(app.getHttpServer())
			.post("/api/auth/register")
			.send({
				email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
				password: ["Life", "Cycle", "123"].join(""),
				name: label,
			})
			.expect(201);
		const email = created.body.data.user.email as string;
		const login = await request(app.getHttpServer())
			.post("/api/auth/login")
			.send({ email, password: ["Life", "Cycle", "123"].join("") })
			.expect(200);
		const result: TestUser = {
			email,
			password: ["Life", "Cycle", "123"].join(""),
			accessToken: login.body.data.accessToken,
			userId: created.body.data.user.id,
		};
		userIds.push(result.userId);
		await completeOnboarding(app, result.accessToken);
		return result;
	}

	/**
	 * 提交指定类型 / 数据域的请求（verify → create 全链路），返回请求视图。
	 * organizationId 用于多组织用户显式指定目标组织（单组织用户可缺省，回落到唯一 ACTIVE 组织）。
	 */
	async function submitRequest(
		user: TestUser,
		type: "EXPORT" | "CLEAR" | "DELETION",
		scope: "PERSONAL" | "ORGANIZATION",
		organizationId?: string,
	): Promise<Record<string, unknown>> {
		const { challengeId } = await sendAndVerify(
			app,
			env.otpChannel,
			user.accessToken,
			user.email,
			type,
		);
		const payload: Record<string, unknown> = { type, scope, challengeId };
		if (type === "CLEAR") {
			const impact = await request(app.getHttpServer())
				.get("/api/data-requests/impact")
				.set("Authorization", `Bearer ${user.accessToken}`)
				.set(organizationId ? { "X-Organization-Id": organizationId } : {})
				.expect(200);
			payload.confirmedTotals = impact.body.data.totals;
		}
		const res = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.set(organizationId ? { "X-Organization-Id": organizationId } : {})
			.send(payload);
		if (res.status !== 200) {
			throw new Error(`create ${scope} ${type} got ${res.status}: ${JSON.stringify(res.body)}`);
		}
		return res.body.data;
	}

	/** 注册用户的默认组织（注册兜底：组织与首位 OWNER 成员关系同事务创建） */
	async function defaultOrgIdOf(userId: string): Promise<string> {
		const organizationId = await resolveDefaultOrganizationId(env.prisma, userId);
		if (!organizationId) throw new Error("注册兜底未建默认组织");
		return organizationId;
	}

	/** 转移组织所有权：先降后升（memberships_single_active_owner_uidx 顺序保护） */
	async function transferOwnership(
		organizationId: string,
		fromUserId: string,
		toUserId: string,
	): Promise<void> {
		await env.prisma.membership.updateMany({
			where: { organizationId, userId: fromUserId, role: "OWNER", status: "ACTIVE" },
			data: { role: "ADMIN" },
		});
		await env.prisma.membership.updateMany({
			where: { organizationId, userId: toUserId, role: "ADMIN", status: "ACTIVE" },
			data: { role: "OWNER" },
		});
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

	it("清空：提交（同域导出链接失效联动 + 写锁）→ 到期推进清空当前组织账本 → 记账起点重置", async () => {
		const user = await onboardedUser("life-clear");
		const seeded = await seedBusinessData(env.prisma, user.userId);
		const orgId = await defaultOrgIdOf(user.userId);

		// 先建一个可下载的**组织**导出，验证提交组织 CLEAR 时同域导出链接失效联动
		const exportView = await submitRequest(user, "EXPORT", "ORGANIZATION");
		expect(exportView.download).not.toBeNull();

		// 提交 CLEAR（默认组织的组织数据请求；单组织用户可缺省 X-Organization-Id）
		const clearView = await submitRequest(user, "CLEAR", "ORGANIZATION");
		expect(clearView.status).toBe("PENDING");
		expect(clearView.scope).toBe("ORGANIZATION");

		// 组织导出链接已失效（downloadExpiresAt 被置为提交时刻）+ 文件删除
		const expiredExport = await env.prisma.dataRequest.findUniqueOrThrow({
			where: { id: (exportView as { id: string }).id },
		});
		expect(expiredExport.downloadExpiresAt!.getTime()).toBeLessThanOrEqual(
			Date.now(),
		);

		// 写锁生效：新增买入被拒（403 DATA_REQUEST_LOCKED）
		await request(app.getHttpServer())
			.post("/api/transactions")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({
				currencyCode: "USD",
				quantity: "10",
				principalAmount: "72",
				exchangeRate: "7.2",
				feeAmount: "0",
				transactedAt: new Date().toISOString(),
			})
			.expect(403);

		// 读时惰性推进：dueAt 置过去后，任意请求（白名单端点也过守卫）触发清理
		const before = new Date(Date.now() - 1000);
		await env.prisma.dataRequest.update({
			where: { id: (clearView as { id: string }).id },
			data: { dueAt: before },
		});
		await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(200);

		// 方案 §5.1 涉及表：当前组织账本（创建者的存量 NULL 行逻辑上属该组织）行数为 0
		expect(await env.prisma.account.count({ where: { userId: user.userId } })).toBe(0);
		expect(await env.prisma.transaction.count({ where: { userId: user.userId } })).toBe(0);
		expect(await env.prisma.costLot.count({ where: { userId: user.userId } })).toBe(0);
		expect(await env.prisma.initialHolding.count({ where: { userId: user.userId } })).toBe(0);
		expect(await env.prisma.plan.count({ where: { userId: user.userId } })).toBe(0);
		expect(await env.prisma.planAllocation.count({ where: { planId: seeded.planId } })).toBe(0);
		expect(await env.prisma.planChangeLog.count({ where: { planId: seeded.planId } })).toBe(0);
		expect(await env.prisma.usageLotAllocation.count({ where: { usageId: seeded.usageRecordId } })).toBe(0);
		expect(await env.prisma.usageRecord.count({ where: { userId: user.userId } })).toBe(0);
		expect(await env.prisma.correction.count({ where: { userId: user.userId } })).toBe(0);
		expect(await env.prisma.reminder.count({ where: { userId: user.userId } })).toBe(0);
		// plan_installments 随 plan 级联删除
		expect(await env.prisma.planInstallment.count({ where: { planId: seeded.planId } })).toBe(0);

		// 保留：账号、组织与成员关系、本位币不变；记账起点重置为空（清空后的账本无起点）
		const settings = await env.prisma.userSettings.findUniqueOrThrow({
			where: { userId: user.userId },
		});
		expect(settings.baseCurrency).toBe("CNY"); // 清空不改变本位币
		expect(settings.ledgerStartedAt).toBeNull();
		const organizationSettings = await env.prisma.organizationSettings.findUniqueOrThrow({
			where: { organizationId: orgId },
		});
		expect(organizationSettings.baseCurrency).toBe("CNY");
		expect(organizationSettings.ledgerStartedAt).toBeNull();
		expect(
			await env.prisma.termsConsent.count({ where: { userId: user.userId } }),
		).toBeGreaterThan(0);
		expect(await env.prisma.membership.count({ where: { organizationId: orgId } })).toBe(1);

		// 请求终态 COMPLETED，并留同事务审计
		const doneRequest = await env.prisma.dataRequest.findUniqueOrThrow({
			where: { id: (clearView as { id: string }).id },
		});
		expect(doneRequest.status).toBe("COMPLETED");
		expect(doneRequest.processedAt).not.toBeNull();
		expect(doneRequest.scope).toBe("ORGANIZATION");
		expect(doneRequest.organizationId).toBe(orgId);
		expect(
			await env.prisma.auditLog.count({
				where: { organizationId: orgId, action: "data.clear.execute", result: "SUCCESS" },
			}),
		).toBe(1);

		// 锁解除：可正常记账
		await request(app.getHttpServer())
			.post("/api/transactions")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({
				currencyCode: "USD",
				quantity: "10",
				principalAmount: "72",
				exchangeRate: "7.2",
				feeAmount: "0",
				transactedAt: new Date().toISOString(),
			})
			.expect(201);
	});

	it("注销：最后 Owner 409 → 转移所有权后进入撤回期（可验证撤回）→ 到期物理删除账号，共享组织账本 1 行不丢", async () => {
		const user = await onboardedUser("life-del");
		const successor = await onboardedUser("life-del-successor");
		const orgId = await defaultOrgIdOf(user.userId);
		// 本人在组织里的两类数据：共享账本行（带 organizationId）与个人域存量行（organization_id IS NULL）
		const shared = await seedBusinessData(env.prisma, user.userId, { organizationId: orgId });
		const legacy = await seedBusinessData(env.prisma, user.userId);
		await env.prisma.membership.create({
			data: { organizationId: orgId, userId: successor.userId, role: "ADMIN" },
		});
		const accountBefore = await env.prisma.account.findUniqueOrThrow({
			where: { id: shared.accountId },
		});
		const auditBefore = await env.prisma.auditLog.count({
			where: { organizationId: orgId },
		});

		// 1. 本人是该组织唯一所有者：不替用户选择处置方式，直接注销被拒且不建请求
		const blockedCredential = await sendAndVerify(
			app,
			env.otpChannel,
			user.accessToken,
			user.email,
			"DELETION",
		);
		const blocked = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ type: "DELETION", scope: "PERSONAL", challengeId: blockedCredential.challengeId })
			.expect(409);
		expect(blocked.body.code).toBe("LAST_OWNER_REQUIRED");
		expect(blocked.body.data.blockingOrganizations).toEqual([
			{ organizationId: orgId, organizationName: expect.any(String), role: "OWNER" },
		]);
		expect(await env.prisma.dataRequest.count({ where: { userId: user.userId } })).toBe(0);

		// 2. 转移所有权（本人降为 ADMIN）
		await transferOwnership(orgId, user.userId, successor.userId);

		// 3. 提交 DELETION：锁定（GET 业务端点也拦截 ACCOUNT_PENDING_DELETION）
		const deletion = await submitRequest(user, "DELETION", "PERSONAL");
		const deletionId = (deletion as { id: string }).id;
		await request(app.getHttpServer())
			.get("/api/accounts")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(403);

		// 撤回期内验证撤回 → 账号恢复
		const { challengeId } = await sendAndVerify(
			app,
			env.otpChannel,
			user.accessToken,
			user.email,
			"DELETION",
		);
		await request(app.getHttpServer())
			.post(`/api/data-requests/${deletionId}/cancel`)
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({ challengeId })
			.expect(200);

		// 账号恢复：业务端点放行、数据原样（共享计划 + 个人域存量计划）
		await request(app.getHttpServer())
			.get("/api/accounts")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(200);
		expect(await env.prisma.plan.count({ where: { userId: user.userId } })).toBe(2);

		// 4. 再次提交 → 到期推进 → 物理删除
		const again = await submitRequest(user, "DELETION", "PERSONAL");
		await makeRequestDue(
			env.prisma,
			(again as { id: string }).id,
			new Date(Date.now() - 1000),
		);
		// 推进由本次请求触发：清理后 user 已删，token 失效 → 401（守卫 advance 已先行完成）
		await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(401);

		// 账号与个人域数据删除（个人请求随账号消失）
		expect(await env.prisma.user.findUnique({ where: { id: user.userId } })).toBeNull();
		expect(await env.prisma.membership.count({ where: { userId: user.userId } })).toBe(0);
		expect(await env.prisma.userSettings.count({ where: { userId: user.userId } })).toBe(0);
		expect(await env.prisma.termsConsent.count({ where: { userId: user.userId } })).toBe(0);
		expect(await env.prisma.dataRequest.count({ where: { userId: user.userId } })).toBe(0);
		// 已无任何行指向被删用户（共享行已过户，个人域存量行已清空）
		expect(await env.prisma.plan.count({ where: { userId: user.userId } })).toBe(0);
		expect(await env.prisma.transaction.count({ where: { userId: user.userId } })).toBe(0);
		expect(await env.prisma.account.count({ where: { userId: user.userId } })).toBe(0);
		expect(
			await env.prisma.account.findUnique({ where: { id: legacy.accountId } }),
		).toBeNull();
		expect(await env.prisma.plan.findUnique({ where: { id: legacy.planId } })).toBeNull();

		// 共享组织账本：行仍在、余额零变化、过户给接任者；创建者审计快照与 updated_at 不变
		const account = await env.prisma.account.findUniqueOrThrow({
			where: { id: shared.accountId },
		});
		expect(account.organizationId).toBe(orgId);
		expect(account.userId).toBe(successor.userId);
		expect(account.balance.toString()).toBe(accountBefore.balance.toString());
		expect(account.createdById).toBe(user.userId);
		expect(account.updatedAt).toEqual(accountBefore.updatedAt);
		const [transaction, plan, usage, lot, reminder, correction, allocation, usageLot] =
			await Promise.all([
				env.prisma.transaction.findUniqueOrThrow({ where: { id: shared.transactionId } }),
				env.prisma.plan.findUniqueOrThrow({ where: { id: shared.planId } }),
				env.prisma.usageRecord.findUniqueOrThrow({ where: { id: shared.usageRecordId } }),
				env.prisma.costLot.findUniqueOrThrow({ where: { id: shared.costLotId } }),
				env.prisma.reminder.findUniqueOrThrow({ where: { id: shared.reminderId } }),
				env.prisma.correction.findUniqueOrThrow({ where: { id: shared.correctionId } }),
				env.prisma.planAllocation.findUniqueOrThrow({ where: { id: shared.planAllocationId } }),
				env.prisma.usageLotAllocation.findUniqueOrThrow({
					where: { id: shared.usageLotAllocationId },
				}),
			]);
		for (const row of [transaction, plan, usage, lot, reminder, correction]) {
			expect(row.userId, row.id).toBe(successor.userId);
			expect(row.organizationId, row.id).toBe(orgId);
		}
		expect(transaction.createdById).toBe(user.userId);
		expect(correction.actorUserId).toBe(user.userId);
		expect(allocation).not.toBeNull();
		expect(usageLot).not.toBeNull();

		// 组织与接任者保留；组织审计一条不删（个人注销不删组织审计）
		expect(
			await env.prisma.organization.findUnique({ where: { id: orgId } }),
		).not.toBeNull();
		expect(
			await env.prisma.membership.findUnique({
				where: { organizationId_userId: { organizationId: orgId, userId: successor.userId } },
			}),
		).toMatchObject({ role: "OWNER", status: "ACTIVE" });
		expect(await env.prisma.auditLog.count({ where: { organizationId: orgId } })).toBeGreaterThanOrEqual(auditBefore);

		// 旧 token 失效（jwt.strategy 查无此人 → 401）
		await request(app.getHttpServer())
			.get("/api/auth/me")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(401);

		// 5. 同一邮箱可作为全新账号注册（email unique 随行删除释放），看不到任何旧记录
		const reReg = await request(app.getHttpServer())
			.post("/api/auth/register")
			.send({
				email: user.email,
				password: ["New", "Life", "456"].join(""),
			})
			.expect(201);
		const newUserId = reReg.body.data.user.id as string;
		expect(newUserId).not.toBe(user.userId);
		expect(
			await env.prisma.plan.count({ where: { userId: newUserId } }),
		).toBe(0);
		// 清理注册产物（userIds 里旧 id 已不存在，cleanupUser 容错）
		userIds.push(newUserId);
	});

	it("组织删除：Admin 不可发起 → Owner 发起进入撤回期 → 到期删除组织及其账本，成员账号与其他组织不受影响", async () => {
		const owner = await onboardedUser("life-org-del-owner");
		const member = await onboardedUser("life-org-del-member");
		const orgId = await defaultOrgIdOf(owner.userId);
		await env.prisma.membership.create({
			data: { organizationId: orgId, userId: member.userId, role: "ADMIN" },
		});
		const seeded = await seedBusinessData(env.prisma, owner.userId, { organizationId: orgId });
		// Owner 的另一个组织（非默认组织）：删除默认组织不得波及它
		const otherOrg = await env.prisma.organization.create({
			data: {
				name: "另一个组织",
				memberships: {
					create: { userId: owner.userId, role: "OWNER", status: "ACTIVE" },
				},
			},
			select: { id: true },
		});
		await env.prisma.organizationSettings.create({
			data: { organizationId: otherOrg.id, baseCurrency: "CNY" },
		});
		const otherSeeded = await seedBusinessData(env.prisma, owner.userId, {
			organizationId: otherOrg.id,
		});

		// 组织删除仅 Owner 可发起（多组织用户须显式带 X-Organization-Id）
		const memberCredential = await sendAndVerify(
			app,
			env.otpChannel,
			member.accessToken,
			member.email,
			"DELETION",
		);
		const denied = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${member.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({ type: "DELETION", scope: "ORGANIZATION", challengeId: memberCredential.challengeId })
			.expect(403);
		expect(denied.body.code).toBe("PERMISSION_DENIED");

		const deletion = await submitRequest(owner, "DELETION", "ORGANIZATION", orgId);
		const deletionId = (deletion as { id: string }).id;
		expect(deletion).toMatchObject({ scope: "ORGANIZATION", status: "PENDING" });

		// 冷静期：停写不停看
		const locked = await request(app.getHttpServer())
			.post("/api/transactions")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgId)
			.send({
				currencyCode: "EUR",
				quantity: "10",
				principalAmount: "78",
				exchangeRate: "7.8",
				feeAmount: "0",
				transactedAt: new Date().toISOString(),
			})
			.expect(403);
		expect(locked.body.code).toBe("DATA_REQUEST_LOCKED");
		await request(app.getHttpServer())
			.get("/api/accounts")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.set("X-Organization-Id", orgId)
			.expect(200);

		// 到期推进（由本人任意请求触发；成员个人账号不删，token 仍有效）
		await makeRequestDue(env.prisma, deletionId, new Date(Date.now() - 1000));
		const advanced = await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.expect(200);
		expect(advanced.body.data).toBeNull(); // 该组织的数据请求随组织一并删除

		// 组织及其账本、成员关系、设置、数据请求全部删除
		expect(await env.prisma.organization.findUnique({ where: { id: orgId } })).toBeNull();
		expect(await env.prisma.account.findUnique({ where: { id: seeded.accountId } })).toBeNull();
		expect(await env.prisma.plan.findUnique({ where: { id: seeded.planId } })).toBeNull();
		expect(await env.prisma.planAllocation.count({ where: { planId: seeded.planId } })).toBe(0);
		expect(await env.prisma.usageLotAllocation.count({ where: { usageId: seeded.usageRecordId } })).toBe(0);
		// 组织账本八张带 organization_id 的表全部清空（顺序：账户 / 交易 / 持仓 / 批次 / 计划 / 使用 / 更正 / 提醒）
		const organizationRowCounts = await Promise.all([
			env.prisma.account.count({ where: { organizationId: orgId } }),
			env.prisma.transaction.count({ where: { organizationId: orgId } }),
			env.prisma.initialHolding.count({ where: { organizationId: orgId } }),
			env.prisma.costLot.count({ where: { organizationId: orgId } }),
			env.prisma.plan.count({ where: { organizationId: orgId } }),
			env.prisma.usageRecord.count({ where: { organizationId: orgId } }),
			env.prisma.correction.count({ where: { organizationId: orgId } }),
			env.prisma.reminder.count({ where: { organizationId: orgId } }),
		]);
		expect(organizationRowCounts).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
		expect(await env.prisma.membership.count({ where: { organizationId: orgId } })).toBe(0);
		expect(await env.prisma.organizationSettings.count({ where: { organizationId: orgId } })).toBe(0);
		expect(await env.prisma.dataRequest.count({ where: { organizationId: orgId } })).toBe(0);

		// 成员个人账号保留；成员在其他组织的身份不受影响
		expect(await env.prisma.user.count({ where: { id: { in: [owner.userId, member.userId] } } })).toBe(2);
		expect(await defaultOrgIdOf(member.userId)).not.toBe(orgId);

		// 另一个组织零变化，Owner 锁解除
		const otherAccount = await env.prisma.account.findUniqueOrThrow({
			where: { id: otherSeeded.accountId },
		});
		expect(otherAccount.balance.toString()).toBe("900");
		expect(await env.prisma.plan.count({ where: { organizationId: otherOrg.id } })).toBe(1);
		const current = await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.set("Authorization", `Bearer ${owner.accessToken}`)
			.expect(200);
		expect(current.body.data).toBeNull();

		// 审计：既有留痕在删组织前统一清理，仅保留一条删除留痕
		const logs = await env.prisma.auditLog.findMany({ where: { organizationId: orgId } });
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			action: "organization.delete.execute",
			actorUserId: owner.userId,
			result: "SUCCESS",
		});
		// 用例自清：组织删除后留痕无成员可回收
		await env.prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
	});

	it("异常：清理事务失败 → 整体回滚 + FAILED 锁保持 → 重试推进 COMPLETED", async () => {
		const user = await onboardedUser("life-fail");
		await seedBusinessData(env.prisma, user.userId);

		const clearView = await submitRequest(user, "CLEAR", "ORGANIZATION");
		const clearId = (clearView as { id: string }).id;
		await env.prisma.dataRequest.update({
			where: { id: clearId },
			data: { dueAt: new Date(Date.now() - 1000) },
		});

		// 注入失败：cost_lots 删除抛错（模拟中断）。事务内用的是 tx 客户端，
		// spyOn(prisma.costLot) 拦不到 → 用 $use 中间件（事务内同样生效），
		// PrismaClient 无移除 API → 用可变开关控制。
		let injectFail = false;
		env.prisma.$use(async (params, next) => {
			if (
				injectFail &&
				params.model === "CostLot" &&
				params.action === "deleteMany"
			) {
				throw new Error("injected cleanup failure");
			}
			return next(params);
		});

		// 开启注入后触发推进（事务回滚 → FAILED）
		injectFail = true;
		await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(200);
		await vi.waitFor(async () => {
			const row = await env.prisma.dataRequest.findUniqueOrThrow({
				where: { id: clearId },
			});
			if (row.status !== "FAILED") throw new Error("not FAILED yet");
		});

		// 整体回滚：数据原样（不保存任何一部分）
		expect(await env.prisma.plan.count({ where: { userId: user.userId } })).toBe(1);
		expect(await env.prisma.transaction.count({ where: { userId: user.userId } })).toBe(1);

		// FAILED 锁保持：POST 被拦（残留数据不当作正常账本）
		const locked = await request(app.getHttpServer())
			.post("/api/transactions")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send({
				currencyCode: "USD",
				quantity: "10",
				principalAmount: "72",
				exchangeRate: "7.2",
				feeAmount: "0",
				transactedAt: new Date().toISOString(),
			})
			.expect(403);
		expect(locked.body.code).toBe("DATA_REQUEST_LOCKED");

		// 关闭注入 → 下次读时重试推进 → COMPLETED
		injectFail = false;
		await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(200);
		await vi.waitFor(async () => {
			const row = await env.prisma.dataRequest.findUniqueOrThrow({
				where: { id: clearId },
			});
			if (row.status !== "COMPLETED") throw new Error("not COMPLETED yet");
		});
		expect(await env.prisma.plan.count({ where: { userId: user.userId } })).toBe(0);
	});
});
