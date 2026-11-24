import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	cleanupUser,
	type TestUser,
} from "../helpers/test-app";
import {
	completeOnboarding,
	createDataRequestTestApp,
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
 * 集成测试 ↔ src/data-request/data-request.service.ts（account-data 方案 §10.3）
 *
 * 一条业务流一个文件：清空生命周期 / 注销生命周期 / 清理异常回滚。
 * 到期推进用直接写库 dueAt 过去时刻构造，经守卫读时惰性推进触发（不等待真实时间）。
 */
describe("AccountData 生命周期（integration）", () => {
	let env: DataRequestTestEnv;
	let app: INestApplication;
	const userIds: string[] = [];
	/**
	 * 注销用例里被业务流程物理删除的用户所遗留的默认组织。
	 * Membership 随用户级联而组织不级联——用户独占的默认组织会留下无成员的空壳。
	 * （产品侧「最后 Owner 保护 / 注销前组织处置」属 Goal #3B W26；此处仅回收
	 * 用例自己造出来的那一条，否则每次全量跑在共享本地库留下一条孤儿组织。）
	 */
	const orphanedOrgIds: string[] = [];

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

	/** 提交指定类型请求（verify → create 全链路），返回请求视图 */
	async function submitRequest(
		user: TestUser,
		type: "EXPORT" | "CLEAR" | "DELETION",
	): Promise<Record<string, unknown>> {
		const { challengeId } = await sendAndVerify(
			app,
			env.otpChannel,
			user.accessToken,
			user.email,
			type,
		);
		const payload: Record<string, unknown> = { type, challengeId };
		if (type === "CLEAR") {
			const impact = await request(app.getHttpServer())
				.get("/api/data-requests/impact")
				.set("Authorization", `Bearer ${user.accessToken}`)
				.expect(200);
			payload.confirmedTotals = impact.body.data.totals;
		}
		const res = await request(app.getHttpServer())
			.post("/api/data-requests")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.send(payload)
			.expect(200);
		return res.body.data;
	}

	beforeAll(async () => {
		env = await createDataRequestTestApp();
		app = env.app;
	});

	afterAll(async () => {
		for (const userId of userIds) {
			await cleanupUser(env.prisma, userId);
		}
		// 审计日志对组织无外键，须先于组织显式清理
		for (const organizationId of orphanedOrgIds) {
			await env.prisma.auditLog.deleteMany({ where: { organizationId } });
			await env.prisma.organization.deleteMany({ where: { id: organizationId } });
		}
		await app.close();
	});

	it("清空：提交（导出链接失效联动 + 写锁）→ 到期推进六步删除 → 新记账起点", async () => {
		const user = await onboardedUser("life-clear");
		const seeded = await seedBusinessData(env.prisma, user.userId);

		// 先建一个可下载导出，验证提交 CLEAR 时链接失效联动
		const exportView = await submitRequest(user, "EXPORT");
		expect(exportView.download).not.toBeNull();

		// 提交 CLEAR
		const clearView = await submitRequest(user, "CLEAR");
		expect(clearView.status).toBe("PENDING");

		// 导出链接已失效（downloadExpiresAt 被置为提交时刻）+ 文件删除
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

		// §5.1 六步涉及表该用户行数为 0（含裸外键两表）
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

		// 保留：user_settings（仅记账起点更新）、terms_consents、data_requests、请求 COMPLETED
		const settings = await env.prisma.userSettings.findUniqueOrThrow({
			where: { userId: user.userId },
		});
		expect(settings.baseCurrency).toBe("CNY"); // 清空不改变本位币
		expect(settings.ledgerStartedAt!.getTime()).toBeGreaterThanOrEqual(
			before.getTime(),
		);
		expect(
			await env.prisma.termsConsent.count({ where: { userId: user.userId } }),
		).toBeGreaterThan(0);
		const doneRequest = await env.prisma.dataRequest.findUniqueOrThrow({
			where: { id: (clearView as { id: string }).id },
		});
		expect(doneRequest.status).toBe("COMPLETED");
		expect(doneRequest.processedAt).not.toBeNull();

		// 锁解除：以新记账起点正常记账
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

	it("注销：撤回期内验证撤回恢复账号 → 到期推进物理删除 → 同邮箱可注册新账号", async () => {
		const user = await onboardedUser("life-del");
		await seedBusinessData(env.prisma, user.userId);

		// 提交 DELETION
		const deletion = await submitRequest(user, "DELETION");
		const deletionId = (deletion as { id: string }).id;

		// 锁定：GET 业务端点也拦截（ACCOUNT_PENDING_DELETION）
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

		// 账号恢复：业务端点放行、数据原样
		await request(app.getHttpServer())
			.get("/api/accounts")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(200);
		expect(await env.prisma.plan.count({ where: { userId: user.userId } })).toBe(1);

		// 再次提交 → 到期推进 → 物理删除（先记下其组织：用户删除后无法再反查）
		const ownedOrgs = await env.prisma.membership.findMany({
			where: { userId: user.userId },
			select: { organizationId: true },
		});
		orphanedOrgIds.push(...ownedOrgs.map(({ organizationId }) => organizationId));
		const again = await submitRequest(user, "DELETION");
		await env.prisma.dataRequest.update({
			where: { id: (again as { id: string }).id },
			data: { dueAt: new Date(Date.now() - 1000) },
		});
		// 推进由本次请求触发：清理后 user 已删，token 失效 → 401（守卫 advance 已先行完成）
		await request(app.getHttpServer())
			.get("/api/data-requests/current")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(401);

		// users 行删除；业务表级联清空；请求记录随级联消失
		expect(await env.prisma.user.findUnique({ where: { id: user.userId } })).toBeNull();
		expect(await env.prisma.plan.count({ where: { userId: user.userId } })).toBe(0);
		expect(await env.prisma.transaction.count({ where: { userId: user.userId } })).toBe(0);
		expect(await env.prisma.account.count({ where: { userId: user.userId } })).toBe(0);
		expect(await env.prisma.dataRequest.count({ where: { userId: user.userId } })).toBe(0);

		// 旧 token 失效（jwt.strategy 查无此人 → 401）
		await request(app.getHttpServer())
			.get("/api/auth/me")
			.set("Authorization", `Bearer ${user.accessToken}`)
			.expect(401);

		// 同一邮箱可作为全新账号注册（email unique 随行删除释放），看不到任何旧记录
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

	it("异常：清理事务失败 → 整体回滚 + FAILED 锁保持 → 重试推进 COMPLETED", async () => {
		const user = await onboardedUser("life-fail");
		await seedBusinessData(env.prisma, user.userId);

		const clearView = await submitRequest(user, "CLEAR");
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
