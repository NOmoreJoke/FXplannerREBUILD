import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import request from "supertest";
import { AuditService } from "../../src/audit/audit.service";
import { resolveDefaultOrganizationId } from "../../src/authorization/default-organization";
import { runBehindAdvisoryLock } from "../helpers/postgres-lock-barrier";
import {
	bearer,
	cleanupUser,
	createTestApp,
	createTestUser,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";

// 关闭全局接口限流（先例：transaction.spec/plan.spec——APP_GUARD token 无法 override，只能 mock 类）
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
 * 接口测试 ↔ src/settings/settings.controller.ts
 * GET / PATCH /api/settings：完整视图、白名单更新、本位币只读（无更新通道）
 *
 * 注（§8.2 行 11 的豁免说明）：「PATCH 改偏好后 home/state 同步反映」——
 * home/state 只返回分流布尔与摘要、不承载偏好字段（后端数据中立约定），
 * 偏好同步以 GET /settings 断言为准，home/state 部分豁免。
 */
describe("SettingsController（e2e）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let user: TestUser;

	const wizard = {
		region: "CN",
		locale: "zh-CN",
		baseCurrency: "CNY",
		prepPreference: "balanced",
		reminderEnabled: true,
	};

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;
		user = await createTestUser(app, "settings");
	});

	afterAll(async () => {
		if (user) await cleanupUser(ctx.prisma, user.userId);
		await app.close();
	});

	it("GET /settings 无 token 应该 401", () => {
		return request(app.getHttpServer()).get("/api/settings").expect(401);
	});

	it("PATCH /settings 无 token 应该 401", () => {
		return request(app.getHttpServer())
			.patch("/api/settings")
			.send({ locale: "en" })
			.expect(401);
	});

	it("未建账 GET → 409 ONBOARDING_NOT_COMPLETED", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/settings")
			.set(bearer(user.accessToken))
			.expect(409);

		expect(res.body.code).toBe("ONBOARDING_NOT_COMPLETED");
	});

	it("未建账 PATCH → 409 ONBOARDING_NOT_COMPLETED", async () => {
		const res = await request(app.getHttpServer())
			.patch("/api/settings")
			.set(bearer(user.accessToken))
			.send({ locale: "en" })
			.expect(409);

		expect(res.body.code).toBe("ONBOARDING_NOT_COMPLETED");
	});

	it("建账后 GET → 200 完整视图（email/本位币/偏好/记账起点）", async () => {
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(user.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);
		await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(bearer(user.accessToken))
			.send(wizard)
			.expect(201);

		const res = await request(app.getHttpServer())
			.get("/api/settings")
			.set(bearer(user.accessToken))
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.message).toBe("设置查询成功");
		expect(res.body.data).toEqual({
			email: user.email,
			region: "CN",
			locale: "zh-CN",
			baseCurrency: "CNY",
			prepPreference: "balanced",
			reminderEnabled: true,
			ledgerStartedAt: expect.any(String),
		});
	});

	it("PATCH 改 locale+prepPreference+reminderEnabled → 200；TermsConsent 数不变、baseCurrency 不变", async () => {
		const consentsBefore = await ctx.prisma.termsConsent.count({
			where: { userId: user.userId },
		});

		const res = await request(app.getHttpServer())
			.patch("/api/settings")
			.set(bearer(user.accessToken))
			.send({
				locale: "en",
				prepPreference: "cautious",
				reminderEnabled: false,
			})
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.message).toBe("设置已更新");
		expect(res.body.data).toMatchObject({
			locale: "en",
			prepPreference: "cautious",
			reminderEnabled: false,
			baseCurrency: "CNY", // baseCurrency 不变
			region: "CN", // 未提交字段不被覆盖
		});

		// 同版本条款不重签
		const consentsAfter = await ctx.prisma.termsConsent.count({
			where: { userId: user.userId },
		});
		expect(consentsAfter).toBe(consentsBefore);

		// GET /settings 同步反映（§8.2 行 11：home/state 不承载偏好字段，以 GET /settings 为准）
		const get = await request(app.getHttpServer())
			.get("/api/settings")
			.set(bearer(user.accessToken))
			.expect(200);
		expect(get.body.data.locale).toBe("en");
		expect(get.body.data.prepPreference).toBe("cautious");
		expect(get.body.data.reminderEnabled).toBe(false);
	});

	it("PATCH 空 body → 400 SETTINGS_UPDATE_EMPTY", async () => {
		const res = await request(app.getHttpServer())
			.patch("/api/settings")
			.set(bearer(user.accessToken))
			.send({})
			.expect(400);

		expect(res.body.code).toBe("SETTINGS_UPDATE_EMPTY");
	});

	it("PATCH 只含 baseCurrency → 400（白名单剥离后为空，本位币无更新通道）", async () => {
		const res = await request(app.getHttpServer())
			.patch("/api/settings")
			.set(bearer(user.accessToken))
			.send({ baseCurrency: "USD" })
			.expect(400);

		expect(res.body.code).toBe("SETTINGS_UPDATE_EMPTY");

		const settings = await ctx.prisma.userSettings.findUnique({
			where: { userId: user.userId },
		});
		expect(settings?.baseCurrency).toBe("CNY");
	});

	it("PATCH 含 baseCurrency+region → 200 但 baseCurrency 不变（剥离语义）", async () => {
		const res = await request(app.getHttpServer())
			.patch("/api/settings")
			.set(bearer(user.accessToken))
			.send({ baseCurrency: "USD", region: "HK" })
			.expect(200);

		expect(res.body.data.region).toBe("HK");
		expect(res.body.data.baseCurrency).toBe("CNY");
	});

	it("PATCH 枚举非法 → 400", async () => {
		const res = await request(app.getHttpServer())
			.patch("/api/settings")
			.set(bearer(user.accessToken))
			.send({ prepPreference: "aggressive" })
			.expect(400);
		// 枚举非法来自全局 ValidationPipe：标准 400 结构（statusCode），非模块错误体
		expect(res.body.statusCode).toBe(400);
	});

	it("值集回归（FE-03 根治）：prep 全部合法值 cautious/proactive 各自 PATCH 200 且 GET 回显一致（词集单一来源后端 DTO）", async () => {
		for (const prepPreference of ["cautious", "proactive"] as const) {
			const res = await request(app.getHttpServer())
				.patch("/api/settings")
				.set(bearer(user.accessToken))
				.send({ prepPreference })
				.expect(200);
			expect(res.body.data.prepPreference).toBe(prepPreference);

			const get = await request(app.getHttpServer())
				.get("/api/settings")
				.set(bearer(user.accessToken))
				.expect(200);
			expect(get.body.data.prepPreference).toBe(prepPreference);
		}
	});

	describe("ToB R1 W22：个人/组织设置分离 + 锁内降权 + 审计原子性（支持 -t 独立运行）", () => {
		const scopedUserIds: string[] = [];

		afterEach(async () => {
			vi.restoreAllMocks();
			// 后进先出清理：先清受邀成员再清 Owner，确保默认与共享组织全部回收（零孤儿）
			while (scopedUserIds.length > 0) {
				const uid = scopedUserIds.pop()!;
				await cleanupUser(ctx.prisma, uid);
			}
		});

		async function setupOnboardedOrgWithMember(
			role: "ADMIN" | "OPERATOR" | "VIEWER",
			label: string,
		) {
			const owner = await createTestUser(app, `${label}-owner`);
			scopedUserIds.push(owner.userId);
			const orgId = (await resolveDefaultOrganizationId(ctx.prisma, owner.userId))!;
			await request(app.getHttpServer())
				.post("/api/onboarding/consents")
				.set(bearer(owner.accessToken))
				.send({ age18Confirmed: true, termsConfirmed: true })
				.expect(201);
			await request(app.getHttpServer())
				.post("/api/onboarding/complete")
				.set(bearer(owner.accessToken))
				.set("X-Organization-Id", orgId)
				.send(wizard)
				.expect(201);

			const member = await createTestUser(app, `${label}-member`);
			scopedUserIds.push(member.userId);
			await ctx.prisma.membership.create({
				data: {
					organizationId: orgId,
					userId: member.userId,
					role,
					status: "ACTIVE",
				},
			});
			return { owner, member, orgId };
		}

		it.each(["VIEWER", "OPERATOR"] as const)(
			"%s 改组织偏好（prepPreference / reminderEnabled）→ 403 PERMISSION_DENIED + DENIED 审计（含 requestId）",
			async (role) => {
				const { member, orgId } = await setupOnboardedOrgWithMember(
					role,
					`settings-${role.toLowerCase()}`,
				);
				const reqId = `req-settings-denied-${role}-${Date.now()}`;

				const res = await request(app.getHttpServer())
					.patch("/api/settings")
					.set(bearer(member.accessToken))
					.set("X-Organization-Id", orgId)
					.set("X-Request-Id", reqId)
					.send({ prepPreference: "proactive", reminderEnabled: false })
					.expect(403);

				expect(res.body.code).toBe("PERMISSION_DENIED");
				const orgSettings = await ctx.prisma.organizationSettings.findUniqueOrThrow({
					where: { organizationId: orgId },
				});
				expect(orgSettings.prepPreference).toBe("balanced");
				expect(orgSettings.reminderEnabled).toBe(true);

				const deniedAudit = await ctx.prisma.auditLog.findFirst({
					where: {
						organizationId: orgId,
						actorUserId: member.userId,
						action: "permission.denied.settings.update",
						result: "DENIED",
					},
				});
				expect(deniedAudit).not.toBeNull();
				expect(deniedAudit?.requestId).toBe(reqId);
			},
		);

		it("受邀 VIEWER（无本人 UserSettings 行）PATCH /settings 仅改 locale/region → 200，组织偏好与审计不受影响", async () => {
			const { member, orgId } = await setupOnboardedOrgWithMember(
				"VIEWER",
				"settings-viewer-personal",
			);
			expect(
				await ctx.prisma.userSettings.findUnique({ where: { userId: member.userId } }),
			).toBeNull();

			const res = await request(app.getHttpServer())
				.patch("/api/settings")
				.set(bearer(member.accessToken))
				.set("X-Organization-Id", orgId)
				.send({ region: "HK", locale: "en" })
				.expect(200);

			expect(res.body.data).toMatchObject({
				email: member.email,
				region: "HK",
				locale: "en",
				baseCurrency: "CNY",
				prepPreference: "balanced",
				reminderEnabled: true,
			});

			const personal = await ctx.prisma.userSettings.findUniqueOrThrow({
				where: { userId: member.userId },
			});
			expect(personal.region).toBe("HK");
			expect(personal.locale).toBe("en");
			expect(
				await ctx.prisma.auditLog.count({
					where: {
						organizationId: orgId,
						actorUserId: member.userId,
						action: "settings.update",
					},
				}),
			).toBe(0);
		});

		it("GET / PATCH /settings/personal：未建账用户可独立读写个人偏好，不创建 OrganizationSettings 且保持 /settings 409", async () => {
			const fresh = await createTestUser(app, "settings-personal-only");
			scopedUserIds.push(fresh.userId);
			const orgId = (await resolveDefaultOrganizationId(ctx.prisma, fresh.userId))!;

			const initial = await request(app.getHttpServer())
				.get("/api/settings/personal")
				.set(bearer(fresh.accessToken))
				.expect(200);
			expect(initial.body.data).toEqual({
				email: fresh.email,
				region: "CN",
				locale: "zh-CN",
			});

			const updated = await request(app.getHttpServer())
				.patch("/api/settings/personal")
				.set(bearer(fresh.accessToken))
				.send({ region: "HK", locale: "en" })
				.expect(200);
			expect(updated.body.data).toEqual({
				email: fresh.email,
				region: "HK",
				locale: "en",
			});

			// 不允许偷建 OrganizationSettings，未建账组织的 /settings 仍返回 409
			expect(
				await ctx.prisma.organizationSettings.findUnique({
					where: { organizationId: orgId },
				}),
			).toBeNull();
			await request(app.getHttpServer())
				.get("/api/settings")
				.set(bearer(fresh.accessToken))
				.set("X-Organization-Id", orgId)
				.expect(409);

			// 传 org 字段 / baseCurrency 会被 ValidationPipe 剥离 → 400 SETTINGS_UPDATE_EMPTY
			const bad = await request(app.getHttpServer())
				.patch("/api/settings/personal")
				.set(bearer(fresh.accessToken))
				.send({ baseCurrency: "USD", prepPreference: "proactive" })
				.expect(400);
			expect(bad.body.code).toBe("SETTINGS_UPDATE_EMPTY");
		});

		it("锁等期间降权（ADMIN → VIEWER）：放行过 Guard 后阻塞在组织锁，醒来重读角色 → 403 + DENIED 审计 + 零写入", async () => {
			const { member, orgId } = await setupOnboardedOrgWithMember(
				"ADMIN",
				"settings-demote-lock",
			);
			const reqId = `req-demote-lock-${Date.now()}`;

			const res = await runBehindAdvisoryLock(
				ctx.prisma,
				`membership:${orgId}`,
				() =>
					request(app.getHttpServer())
						.patch("/api/settings")
						.set(bearer(member.accessToken))
						.set("X-Organization-Id", orgId)
						.set("X-Request-Id", reqId)
						.send({ prepPreference: "proactive" }),
				async () => {
					await ctx.prisma.membership.update({
						where: {
							organizationId_userId: {
								organizationId: orgId,
								userId: member.userId,
							},
						},
						data: { role: "VIEWER" },
					});
				},
			);

			expect(res.status).toBe(403);
			expect(res.body.code).toBe("PERMISSION_DENIED");
			const orgSettings = await ctx.prisma.organizationSettings.findUniqueOrThrow({
				where: { organizationId: orgId },
			});
			expect(orgSettings.prepPreference).toBe("balanced");
			const deniedAudit = await ctx.prisma.auditLog.findFirst({
				where: {
					organizationId: orgId,
					actorUserId: member.userId,
					action: "permission.denied.settings.update",
					result: "DENIED",
					requestId: reqId,
				},
			});
			expect(deniedAudit).not.toBeNull();
		});

		it("AuditService.recordInTx 故障注入：组织设置修改整单回滚", async () => {
			const { owner, orgId } = await setupOnboardedOrgWithMember(
				"VIEWER",
				"settings-audit-fault",
			);
			const spy = vi
				.spyOn(app.get(AuditService), "recordInTx")
				.mockRejectedValueOnce(new Error("injected audit failure"));

			await request(app.getHttpServer())
				.patch("/api/settings")
				.set(bearer(owner.accessToken))
				.set("X-Organization-Id", orgId)
				.send({ prepPreference: "proactive", reminderEnabled: false })
				.expect(500);

			expect(spy).toHaveBeenCalledTimes(1);
			const orgSettings = await ctx.prisma.organizationSettings.findUniqueOrThrow({
				where: { organizationId: orgId },
			});
			expect(orgSettings.prepPreference).toBe("balanced");
			expect(orgSettings.reminderEnabled).toBe(true);
			expect(
				await ctx.prisma.auditLog.count({
					where: { organizationId: orgId, action: "settings.update" },
				}),
			).toBe(0);
		});

		it("未建账受邀 VIEWER 在 Org 1 更新 region/locale 后，其本人默认组织仍保持未建账（Important #2 回归）", async () => {
			const { member, orgId } = await setupOnboardedOrgWithMember(
				"VIEWER",
				"settings-viewer-no-leak",
			);
			const memberDefaultOrgId = (await resolveDefaultOrganizationId(
				ctx.prisma,
				member.userId,
			))!;

			await request(app.getHttpServer())
				.patch("/api/settings")
				.set(bearer(member.accessToken))
				.set("X-Organization-Id", orgId)
				.send({ region: "HK", locale: "en" })
				.expect(200);

			// 成员自己的默认组织绝不能被误判为 OWNER_LEGACY 已建账
			const status = await request(app.getHttpServer())
				.get("/api/onboarding/status")
				.set(bearer(member.accessToken))
				.set("X-Organization-Id", memberDefaultOrgId)
				.expect(200);
			expect(status.body.data.completed).toBe(false);

			const defaultGet = await request(app.getHttpServer())
				.get("/api/settings")
				.set(bearer(member.accessToken))
				.set("X-Organization-Id", memberDefaultOrgId)
				.expect(409);
			expect(defaultGet.body.code).toBe("ONBOARDING_NOT_COMPLETED");
		});

		it.each(["VIEWER", "OPERATOR"] as const)(
			"N-17 %s 发送混合设置 { region, prepPreference } → 403 PERMISSION_DENIED + DENIED 审计 + 双方零写入",
			async (role) => {
				const { member, orgId } = await setupOnboardedOrgWithMember(
					role,
					`settings-mixed-${role.toLowerCase()}`,
				);
				const reqId = `req-settings-mixed-${role}-${Date.now()}`;

				const res = await request(app.getHttpServer())
					.patch("/api/settings")
					.set(bearer(member.accessToken))
					.set("X-Organization-Id", orgId)
					.set("X-Request-Id", reqId)
					.send({ region: "HK", locale: "en", prepPreference: "proactive" })
					.expect(403);

				expect(res.body.code).toBe("PERMISSION_DENIED");
				expect(
					await ctx.prisma.userSettings.findUnique({
						where: { userId: member.userId },
					}),
				).toBeNull();
				const orgSettings = await ctx.prisma.organizationSettings.findUniqueOrThrow({
					where: { organizationId: orgId },
				});
				expect(orgSettings.prepPreference).toBe("balanced");
				const deniedAudit = await ctx.prisma.auditLog.findFirst({
					where: {
						organizationId: orgId,
						actorUserId: member.userId,
						action: "permission.denied.settings.update",
						result: "DENIED",
						requestId: reqId,
					},
				});
				expect(deniedAudit).not.toBeNull();
			},
		);

		it("PATCH /settings/personal 占位行不绕过 transaction/plan 未建账 409 防线（Important #3 回归）", async () => {
			const fresh = await createTestUser(app, "settings-personal-guard");
			scopedUserIds.push(fresh.userId);

			await request(app.getHttpServer())
				.patch("/api/settings/personal")
				.set(bearer(fresh.accessToken))
				.send({ region: "HK", locale: "en" })
				.expect(200);

			const txRes = await request(app.getHttpServer())
				.post("/api/transactions")
				.set(bearer(fresh.accessToken))
				.send({
					currencyCode: "USD",
					principalAmount: "700",
					exchangeRate: "7.0",
					quantity: "100",
					transactedAt: new Date(Date.now() - 86_400_000).toISOString(),
				})
				.expect(409);
			expect(txRes.body.code).toBe("ONBOARDING_NOT_COMPLETED");

			const planRes = await request(app.getHttpServer())
				.post("/api/plans")
				.set(bearer(fresh.accessToken))
				.send({
					name: "未建账计划拦截",
					targetCurrency: "USD",
					targetAmount: "1000",
					expectUseDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
					prepLeadDays: 3,
					pacePreference: "balanced",
				})
				.expect(409);
			expect(planRes.body.code).toBe("ONBOARDING_NOT_COMPLETED");
		});
	});
});
