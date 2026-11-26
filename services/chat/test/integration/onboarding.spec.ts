import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { AuditService } from "../../src/audit/audit.service";
import { resolveDefaultOrganizationId } from "../../src/authorization/default-organization";
import {
	raceBehindAdvisoryLock,
	runBehindAdvisoryLock,
} from "../helpers/postgres-lock-barrier";
import {
	bearer,
	cleanupUser,
	createTestApp,
	createTestUser,
	orgBearer,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";

// 关闭全局接口限流（先例：test/api/onboarding.spec.ts）
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
 * 集成测试（真实数据库）：首次设置完整业务流 + ToB R1 W22 组织独立建账与并发锁
 */
describe("Onboarding 集成：登录 → 设置 → 锁定 → 重复设置被拒", () => {
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
		user = await createTestUser(app, "onb-int");
	});

	afterAll(async () => {
		if (user) await cleanupUser(ctx.prisma, user.userId);
		await app.close();
	});

	it("登录后未设置：status.completed=false，settings 表无行", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/onboarding/status")
			.set(orgBearer(user))
			.expect(200);

		expect(res.body.data.completed).toBe(false);
		const rows = await ctx.prisma.userSettings.findMany({
			where: { userId: user.userId },
		});
		expect(rows).toHaveLength(0);
		// W30（MIG-F）：建账真相在 OrganizationSettings——未建账即无该行
		expect(
			await ctx.prisma.organizationSettings.count({
				where: { organizationId: user.defaultOrganizationId },
			}),
		).toBe(0);
	});

	it("完成设置：条款 + complete 事务落库（ledgerStartedAt = 完成时刻）", async () => {
		await request(app.getHttpServer())
			.post("/api/onboarding/consents")
			.set(bearer(user.accessToken))
			.send({ age18Confirmed: true, termsConfirmed: true })
			.expect(201);

		const done = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(orgBearer(user))
			.send(wizard)
			.expect(201);

		expect(done.body.data.settings.baseCurrency).toBe("CNY");

		// 事务证据：OrganizationSettings 唯一行（W30 MIG-F：组织偏好唯一真相），
		// ledgerStartedAt = 完成时刻 + 同事务审计；个人行只存 locale / region
		const orgSettings = await ctx.prisma.organizationSettings.findUnique({
			where: { organizationId: user.defaultOrganizationId },
		});
		expect(orgSettings?.baseCurrency).toBe("CNY");
		expect(orgSettings?.ledgerStartedAt).toBeInstanceOf(Date);
		expect(done.body.data.ledgerStartedAt).toBe(
			orgSettings?.ledgerStartedAt?.toISOString(),
		);
		const personal = await ctx.prisma.userSettings.findUnique({
			where: { userId: user.userId },
		});
		expect(personal?.locale).toBe("zh-CN");
		expect(personal?.region).toBe("CN");
		const defaultOrgId = (await resolveDefaultOrganizationId(ctx.prisma, user.userId))!;
		const completeAudit = await ctx.prisma.auditLog.findFirst({
			where: {
				organizationId: defaultOrgId,
				actorUserId: user.userId,
				action: "onboarding.complete",
				result: "SUCCESS",
			},
		});
		expect(completeAudit).not.toBeNull();
	});

	it("锁定：本位币设置完成后重复提交被拒且数据不被覆盖", async () => {
		// 用不同本位币再次 complete → 409
		const res = await request(app.getHttpServer())
			.post("/api/onboarding/complete")
			.set(orgBearer(user))
			.send({ ...wizard, baseCurrency: "USD" })
			.expect(409);
		expect(res.body.code).toBe("ONBOARDING_ALREADY_COMPLETED");

		// 落库证据：仍是首次提交的 CNY（不存在任何更新写路径）
		const settings = await ctx.prisma.organizationSettings.findUnique({
			where: { organizationId: user.defaultOrganizationId },
		});
		expect(settings?.baseCurrency).toBe("CNY");

		// status 已完成（前端据此跳过向导）
		const status = await request(app.getHttpServer())
			.get("/api/onboarding/status")
			.set(orgBearer(user))
			.expect(200);
		expect(status.body.data.completed).toBe(true);
		expect(status.body.data.settings?.baseCurrency).toBe("CNY");
	});

	describe("ToB R1 W22 集成：多组织隔离 + 并发锁竞争 + 审计回滚（支持 -t 独立运行）", () => {
		const scopedUserIds: string[] = [];
		const createdRateIds: string[] = [];

		afterEach(async () => {
			vi.restoreAllMocks();
			if (createdRateIds.length > 0) {
				await ctx.prisma.exchangeRate
					.deleteMany({ where: { id: { in: createdRateIds.splice(0) } } })
					.catch(() => {});
			}
			while (scopedUserIds.length > 0) {
				const uid = scopedUserIds.pop()!;
				await cleanupUser(ctx.prisma, uid);
			}
		});

		async function seedFreshRate(base: string, quote: string, rate: string) {
			await ctx.prisma.exchangeRate.deleteMany({ where: { base, quote } });
			const now = new Date();
			const row = await ctx.prisma.exchangeRate.create({
				data: {
					base,
					quote,
					rate,
					source: "er-api",
					canonicalWriteId: randomUUID(),
					observedAt: now,
					latestConfirmedAt: now,
				},
			});
			createdRateIds.push(row.id);
		}

		it("多组织独立建账与补录：Org A(CNY + USD) 与 Org B(HKD + USD) 各自建账、初始持仓与审计完全隔离", async () => {
			await seedFreshRate("CNY", "USD", "7.2100");
			await seedFreshRate("HKD", "USD", "7.8000");

			const owner = await createTestUser(app, "onb-int-multi");
			scopedUserIds.push(owner.userId);
			const orgAId = (await resolveDefaultOrganizationId(ctx.prisma, owner.userId))!;
			const orgBRes = await request(app.getHttpServer())
				.post("/api/organizations")
				.set(bearer(owner.accessToken))
				.send({ name: "集成测试组织 B" })
				.expect(201);
			const orgBId = orgBRes.body.data.id as string;

			await request(app.getHttpServer())
				.post("/api/onboarding/consents")
				.set(bearer(owner.accessToken))
				.send({ age18Confirmed: true, termsConfirmed: true })
				.expect(201);

			// Org A 建账并持 USD 1000
			await request(app.getHttpServer())
				.post("/api/onboarding/complete")
				.set(bearer(owner.accessToken))
				.set("X-Organization-Id", orgAId)
				.send({
					...wizard,
					baseCurrency: "CNY",
					initialHoldings: [{ currencyCode: "USD", amount: "1000.00" }],
				})
				.expect(201);

			// Org B 先建账（HKD），再补录同币种 USD 300
			await request(app.getHttpServer())
				.post("/api/onboarding/complete")
				.set(bearer(owner.accessToken))
				.set("X-Organization-Id", orgBId)
				.send({ ...wizard, baseCurrency: "HKD" })
				.expect(201);

			await request(app.getHttpServer())
				.post("/api/onboarding/initial-holdings")
				.set(bearer(owner.accessToken))
				.set("X-Organization-Id", orgBId)
				.send({ holdings: [{ currencyCode: "USD", amount: "300.00" }] })
				.expect(201);

			// W30（MIG-F）：个人行只承载 locale / region，不再有 baseCurrency；
			// 组织本位币真相在 OrganizationSettings（Org A=CNY、Org B=HKD，见下）
			const userSettings = await ctx.prisma.userSettings.findUniqueOrThrow({
				where: { userId: owner.userId },
			});
			expect(userSettings.locale).toBe("zh-CN");
			expect(userSettings.region).toBe("CN");

			const [orgASettings, orgBSettings, accA, accB, auditA, auditB] =
				await Promise.all([
					ctx.prisma.organizationSettings.findUniqueOrThrow({
						where: { organizationId: orgAId },
					}),
					ctx.prisma.organizationSettings.findUniqueOrThrow({
						where: { organizationId: orgBId },
					}),
					ctx.prisma.account.findUniqueOrThrow({
						where: {
							organizationId_currencyCode: {
								organizationId: orgAId,
								currencyCode: "USD",
							},
						},
					}),
					ctx.prisma.account.findUniqueOrThrow({
						where: {
							organizationId_currencyCode: {
								organizationId: orgBId,
								currencyCode: "USD",
							},
						},
					}),
					ctx.prisma.auditLog.findMany({
						where: { organizationId: orgAId },
						select: { action: true, result: true },
					}),
					ctx.prisma.auditLog.findMany({
						where: { organizationId: orgBId },
						select: { action: true, result: true },
					}),
				]);
			expect(orgASettings.baseCurrency).toBe("CNY");
			expect(orgBSettings.baseCurrency).toBe("HKD");
			expect(accA.balance.toFixed(4)).toBe("1000.0000");
			expect(accB.balance.toFixed(4)).toBe("300.0000");
			expect(auditA.some((a) => a.action === "onboarding.complete" && a.result === "SUCCESS")).toBe(true);
			expect(auditB.some((a) => a.action === "onboarding.complete" && a.result === "SUCCESS")).toBe(true);
			expect(auditB.some((a) => a.action === "onboarding.initial_holdings" && a.result === "SUCCESS")).toBe(true);
		});

		it("并发建账与并发补录（raceBehindAdvisoryLock）：恰一胜一 409，零重复行", async () => {
			await seedFreshRate("CNY", "EUR", "7.8500");
			await seedFreshRate("USD", "EUR", "1.0800");
			const owner = await createTestUser(app, "onb-int-race-owner");
			scopedUserIds.push(owner.userId);
			const orgId = (await resolveDefaultOrganizationId(ctx.prisma, owner.userId))!;
			const admin = await createTestUser(app, "onb-int-race-admin");
			scopedUserIds.push(admin.userId);
			await ctx.prisma.membership.create({
				data: {
					organizationId: orgId,
					userId: admin.userId,
					role: "ADMIN",
					status: "ACTIVE",
				},
			});
			for (const u of [owner, admin]) {
				await request(app.getHttpServer())
					.post("/api/onboarding/consents")
					.set(bearer(u.accessToken))
					.send({ age18Confirmed: true, termsConfirmed: true })
					.expect(201);
			}

			// 1. 两个有权成员并发 complete：恰 1 个 201、1 个 409 ONBOARDING_ALREADY_COMPLETED
			const completeResponses = await raceBehindAdvisoryLock(
				ctx.prisma,
				`membership:${orgId}`,
				[
					() =>
						request(app.getHttpServer())
							.post("/api/onboarding/complete")
							.set(bearer(owner.accessToken))
							.set("X-Organization-Id", orgId)
							.send({ ...wizard, baseCurrency: "CNY" }),
					() =>
						request(app.getHttpServer())
							.post("/api/onboarding/complete")
							.set(bearer(admin.accessToken))
							.set("X-Organization-Id", orgId)
							.send({ ...wizard, baseCurrency: "USD" }),
				],
			);
			const completeStatuses = completeResponses.map((r) => r.status).sort();
			expect(completeStatuses).toEqual([201, 409]);
			expect(
				await ctx.prisma.organizationSettings.count({
					where: { organizationId: orgId },
				}),
			).toBe(1);
			expect(
				await ctx.prisma.auditLog.count({
					where: { organizationId: orgId, action: "onboarding.complete" },
				}),
			).toBe(1);

			// 2. 两个有权成员并发补录同币种 EUR：恰 1 个 201、1 个 409 INITIAL_HOLDING_EXISTS
			const backfillResponses = await raceBehindAdvisoryLock(
				ctx.prisma,
				`membership:${orgId}`,
				[
					() =>
						request(app.getHttpServer())
							.post("/api/onboarding/initial-holdings")
							.set(bearer(owner.accessToken))
							.set("X-Organization-Id", orgId)
							.send({ holdings: [{ currencyCode: "EUR", amount: "400.00" }] }),
					() =>
						request(app.getHttpServer())
							.post("/api/onboarding/initial-holdings")
							.set(bearer(admin.accessToken))
							.set("X-Organization-Id", orgId)
							.send({ holdings: [{ currencyCode: "EUR", amount: "600.00" }] }),
				],
			);
			const backfillStatuses = backfillResponses.map((r) => r.status).sort();
			expect(backfillStatuses).toEqual([201, 409]);
			expect(
				await ctx.prisma.initialHolding.count({
					where: { organizationId: orgId, currencyCode: "EUR" },
				}),
			).toBe(1);
			expect(
				await ctx.prisma.auditLog.count({
					where: { organizationId: orgId, action: "onboarding.initial_holdings" },
				}),
			).toBe(1);
		});

		it("补录锁等期间降权（runBehindAdvisoryLock）与审计故障注入均零写入", async () => {
			await seedFreshRate("CNY", "EUR", "7.8000");
			const owner = await createTestUser(app, "onb-int-demote-owner");
			scopedUserIds.push(owner.userId);
			const orgId = (await resolveDefaultOrganizationId(ctx.prisma, owner.userId))!;
			const admin = await createTestUser(app, "onb-int-demote-admin");
			scopedUserIds.push(admin.userId);
			await ctx.prisma.membership.create({
				data: {
					organizationId: orgId,
					userId: admin.userId,
					role: "ADMIN",
					status: "ACTIVE",
				},
			});
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

			// 锁等期间降权：ADMIN → OPERATOR
			const demotedRes = await runBehindAdvisoryLock(
				ctx.prisma,
				`membership:${orgId}`,
				() =>
					request(app.getHttpServer())
						.post("/api/onboarding/initial-holdings")
						.set(bearer(admin.accessToken))
						.set("X-Organization-Id", orgId)
						.send({ holdings: [{ currencyCode: "EUR", amount: "100.00" }] }),
				async () => {
					await ctx.prisma.membership.update({
						where: {
							organizationId_userId: {
								organizationId: orgId,
								userId: admin.userId,
							},
						},
						data: { role: "OPERATOR" },
					});
				},
			);
			expect(demotedRes.status).toBe(403);
			expect(demotedRes.body.code).toBe("PERMISSION_DENIED");
			expect(
				await ctx.prisma.initialHolding.count({
					where: { organizationId: orgId },
				}),
			).toBe(0);

			// AuditService.recordInTx 故障注入：Owner 补录整单回滚
			vi.spyOn(app.get(AuditService), "recordInTx").mockRejectedValueOnce(
				new Error("injected backfill audit failure"),
			);
			await request(app.getHttpServer())
				.post("/api/onboarding/initial-holdings")
				.set(bearer(owner.accessToken))
				.set("X-Organization-Id", orgId)
				.send({ holdings: [{ currencyCode: "EUR", amount: "100.00" }] })
				.expect(500);
			expect(
				await ctx.prisma.initialHolding.count({
					where: { organizationId: orgId },
				}),
			).toBe(0);
			expect(
				await ctx.prisma.account.count({
					where: { organizationId: orgId },
				}),
			).toBe(0);
			expect(
				await ctx.prisma.costLot.count({
					where: { organizationId: orgId },
				}),
			).toBe(0);
			expect(
				await ctx.prisma.auditLog.count({
					where: { organizationId: orgId, action: "onboarding.initial_holdings" },
				}),
			).toBe(0);
		});

		it("反序建账集成：先建非默认 Org B 不阻塞默认 Org A 独立建账且本位币隔离", async () => {
			const reverseUser = await createTestUser(app, "onb-int-reverse");
			scopedUserIds.push(reverseUser.userId);
			const orgAId = (await resolveDefaultOrganizationId(
				ctx.prisma,
				reverseUser.userId,
			))!;
			const orgBRes = await request(app.getHttpServer())
				.post("/api/organizations")
				.set(bearer(reverseUser.accessToken))
				.send({ name: "集成先建组织 B" })
				.expect(201);
			const orgBId = orgBRes.body.data.id as string;

			await request(app.getHttpServer())
				.post("/api/onboarding/consents")
				.set(bearer(reverseUser.accessToken))
				.send({ age18Confirmed: true, termsConfirmed: true })
				.expect(201);

			await request(app.getHttpServer())
				.post("/api/onboarding/complete")
				.set(bearer(reverseUser.accessToken))
				.set("X-Organization-Id", orgBId)
				.send({ ...wizard, baseCurrency: "USD" })
				.expect(201);

			const statusA = await request(app.getHttpServer())
				.get("/api/onboarding/status")
				.set(bearer(reverseUser.accessToken))
				.set("X-Organization-Id", orgAId)
				.expect(200);
			expect(statusA.body.data.completed).toBe(false);

			await request(app.getHttpServer())
				.post("/api/onboarding/complete")
				.set(bearer(reverseUser.accessToken))
				.set("X-Organization-Id", orgAId)
				.send({ ...wizard, baseCurrency: "CNY" })
				.expect(201);

			const [setA, setB] = await Promise.all([
				ctx.prisma.organizationSettings.findUniqueOrThrow({
					where: { organizationId: orgAId },
				}),
				ctx.prisma.organizationSettings.findUniqueOrThrow({
					where: { organizationId: orgBId },
				}),
			]);
			expect(setA.baseCurrency).toBe("CNY");
			expect(setB.baseCurrency).toBe("USD");
			expect(
				await ctx.prisma.auditLog.count({
					where: { organizationId: orgAId, action: "onboarding.complete", result: "SUCCESS" },
				}),
			).toBe(1);
			expect(
				await ctx.prisma.auditLog.count({
					where: { organizationId: orgBId, action: "onboarding.complete", result: "SUCCESS" },
				}),
			).toBe(1);
		});
	});
});
