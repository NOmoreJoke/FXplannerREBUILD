import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

let testUserId: string;
let independentOtpUserId: string;
let independentPasswordUserId: string;
const otpTarget = `infra-otp-${Date.now()}@example.com`;
const observedAt = new Date(Date.UTC(2024, 0, 1, 12, 0, 0));

beforeAll(async () => {
	const user = await prisma.user.create({
		data: {
			email: `infra-test-${Date.now()}@example.com`,
			passwordHash: "test-hash",
			name: "基础设施测试用户",
		},
	});
	testUserId = user.id;
});

afterAll(async () => {
	await prisma.otpIdentity.deleteMany({ where: { userId: testUserId } });
	await prisma.otpChallenge.deleteMany({ where: { target: otpTarget } });
	await prisma.workflowCheckpoint.deleteMany({
		where: { conversationId: "infra-conversation" },
	});
	await prisma.exchangeRate.deleteMany({
		where: { source: "prisma-test" },
	});
	if (independentPasswordUserId) {
		await prisma.user
			.delete({ where: { id: independentPasswordUserId } })
			.catch(() => {});
	}
	if (independentOtpUserId) {
		await prisma.user
			.delete({ where: { id: independentOtpUserId } })
			.catch(() => {});
	}
	await prisma.user.delete({ where: { id: testUserId } });
	await prisma.$disconnect();
});

describe("数据库基础设施测试", () => {
	describe("用户操作", () => {
		test("查询用户", async () => {
			const user = await prisma.user.findUnique({
				where: { id: testUserId },
			});

			expect(user).toBeDefined();
			expect(user!.email).toContain("@example.com");
			expect(user!.createdAt).toBeInstanceOf(Date);
		});

		test("更新用户", async () => {
			const updated = await prisma.user.update({
				where: { id: testUserId },
				data: { name: "更新后的名字" },
			});

			expect(updated.name).toBe("更新后的名字");
		});
	});

	describe("汇率操作", () => {
		test("以 Decimal 精度保存并按观察时间排序", async () => {
			await prisma.exchangeRate.createMany({
				data: [
					{
						base: "TEST",
						quote: "USD",
						rate: "1.2345678901",
						source: "prisma-test",
						observedAt,
					},
					{
						base: "TEST",
						quote: "USD",
						rate: "1.2345678902",
						source: "prisma-test",
						observedAt: new Date(observedAt.getTime() + 86_400_000),
					},
				],
			});

			const rates = await prisma.exchangeRate.findMany({
				where: { base: "TEST", quote: "USD" },
				orderBy: { observedAt: "asc" },
			});

			expect(rates).toHaveLength(2);
			expect(rates[0].rate.toString()).toBe("1.2345678901");
			expect(rates[1].rate.toString()).toBe("1.2345678902");
			expect(rates[0].observedAt.getTime()).toBeLessThan(
				rates[1].observedAt.getTime(),
			);
		});

		test("同一报价时间不可重复写入", async () => {
			await expect(
				prisma.exchangeRate.create({
					data: {
						base: "TEST",
						quote: "USD",
						rate: "9.99",
						source: "prisma-test",
						observedAt,
					},
				}),
			).rejects.toThrow();
		});

		test("ExchangeRate 支持可空 sellRate 列（读写往返；未写入时为 NULL）", async () => {
			// 与既有两行（observedAt / +1 天）错开，避免唯一约束冲突
			const withSellObservedAt = new Date(
				observedAt.getTime() + 2 * 86_400_000,
			);
			const created = await prisma.exchangeRate.create({
				data: {
					base: "TEST",
					quote: "USD",
					rate: "6.7105500000",
					sellRate: "6.7253100000",
					source: "prisma-test",
					observedAt: withSellObservedAt,
				},
			});

			const readBack = await prisma.exchangeRate.findUnique({
				where: { id: created.id },
			});
			expect(readBack?.rate.toFixed(10)).toBe("6.7105500000");
			expect(readBack?.sellRate?.toFixed(10)).toBe("6.7253100000");

			// 未填充 sellRate 的行保持 NULL（非 0、非缺省值）
			const withoutSell = await prisma.exchangeRate.findFirst({
				where: { base: "TEST", quote: "USD", sellRate: null },
			});
			expect(withoutSell).not.toBeNull();
			expect(withoutSell?.sellRate).toBeNull();
		});
	});

	describe("OTP 与工作流模型", () => {
		test("保存 OTP challenge 和独立 identity", async () => {
			const challenge = await prisma.otpChallenge.create({
				data: {
					channel: "email",
					target: otpTarget,
					codeHash: "hashed-code",
					expiresAt: new Date(Date.now() + 300_000),
				},
			});
			const identity = await prisma.otpIdentity.create({
				data: {
					userId: testUserId,
					channel: "email",
					target: otpTarget,
				},
			});

			expect(challenge.attempts).toBe(0);
			expect(identity.userId).toBe(testUserId);
		});

		test("OTP 账号与同目标的密码账号保持独立", async () => {
			const otpUser = await prisma.user.create({ data: {} });
			const passwordUser = await prisma.user.create({
				data: { email: otpTarget, passwordHash: "password-hash" },
			});
			independentOtpUserId = otpUser.id;
			independentPasswordUserId = passwordUser.id;

			expect(otpUser.id).not.toBe(passwordUser.id);
			expect(otpUser.email).toBeNull();
			expect(passwordUser.email).toBe(otpTarget);
		});

		test("保存 JSON workflow checkpoint", async () => {
			const checkpoint = await prisma.workflowCheckpoint.create({
				data: {
					conversationId: "infra-conversation",
					threadId: "infra-thread",
					checkpoint: { node: "rate", version: 1 },
					metadata: { source: "prisma-test" },
				},
			});

			expect(checkpoint.checkpoint).toEqual({ node: "rate", version: 1 });
			expect(checkpoint.metadata).toEqual({ source: "prisma-test" });
		});
	});

	describe("事务", () => {
		test("事务内更新用户，全部成功才提交", async () => {
			const result = await prisma.$transaction(async (tx) =>
				tx.user.update({
					where: { id: testUserId },
					data: { name: "事务内更新" },
				}),
			);

			expect(result.name).toBe("事务内更新");
		});
	});

	describe("M0 schema 冻结基线", () => {
		// 使用专用前缀的测试数据，避免与其他用例冲突；失败时在 afterAll 统一清理
		const m0CurrencyA = "M0A";
		const m0CurrencyB = "M0B";
		const m0CurrencyC = "M0C";
		const m0PlanId = "m0-plan-unique-check";
		const m0TargetId = "m0-corr-failed-check";

		afterAll(async () => {
			await prisma.correction.deleteMany({
				where: { userId: testUserId, targetId: m0TargetId },
			});
			await prisma.planAllocation.deleteMany({ where: { planId: m0PlanId } });
			await prisma.account.deleteMany({
				where: {
					userId: testUserId,
					currencyCode: { in: [m0CurrencyA, m0CurrencyB, m0CurrencyC] },
				},
			});
		});

		test("Account userId+currencyCode 唯一冲突", async () => {
			await prisma.account.create({
				data: {
					userId: testUserId,
					currencyCode: m0CurrencyA,
					balance: "100.0000",
				},
			});

			await expect(
				prisma.account.create({
					data: {
						userId: testUserId,
						currencyCode: m0CurrencyA,
						balance: "1.0000",
					},
				}),
			).rejects.toThrow();

			// 同用户不同币种不受影响
			await expect(
				prisma.account.create({
					data: {
						userId: testUserId,
						currencyCode: m0CurrencyB,
					},
				}),
			).resolves.toBeDefined();
		});

		test("PlanAllocation planId 唯一冲突（一计划一条分配汇总）", async () => {
			await prisma.planAllocation.create({
				data: { planId: m0PlanId, amount: "500.0000", usedAmount: "0.0000" },
			});

			await expect(
				prisma.planAllocation.create({
					data: { planId: m0PlanId, amount: "1.0000", usedAmount: "0.0000" },
				}),
			).rejects.toThrow();
		});

		test("金额列 Decimal(20,4) 存 4 位小数不丢精度", async () => {
			const created = await prisma.account.create({
				data: {
					userId: testUserId,
					currencyCode: m0CurrencyC,
					balance: "12345.6789",
				},
			});

			const readBack = await prisma.account.findUnique({
				where: { id: created.id },
			});
			expect(readBack?.balance.toString()).toBe("12345.6789");

			await prisma.account.delete({ where: { id: created.id } });
		});

		test("Correction 可写 status=FAILED 并保留 failReason", async () => {
			const created = await prisma.correction.create({
				data: {
					userId: testUserId,
					targetType: "TRANSACTION",
					targetId: m0TargetId,
					reason: "余额不足，回滚",
					beforeSnapshot: { balance: "100.0000" },
					afterSnapshot: { balance: "80.0000" },
					status: "FAILED",
					failReason: "使用后余额不足以覆盖现有分配",
				},
			});

			expect(created.status).toBe("FAILED");
			expect(created.failReason).toBe("使用后余额不足以覆盖现有分配");

			const readBack = await prisma.correction.findUnique({
				where: { id: created.id },
			});
			expect(readBack?.status).toBe("FAILED");
			expect(readBack?.failReason).toBe("使用后余额不足以覆盖现有分配");
		});
	});

	describe("ToB R1 MIG-A 增量", () => {
		const migOrgIds: string[] = [];
		const migUserIds: string[] = [];
		const migCurrency = "M1A";
		const migPlanId = "miga-plan-null-org";

		afterAll(async () => {
			await prisma.membership.deleteMany({
				where: { organizationId: { in: migOrgIds } },
			});
			await prisma.organizationInvitation.deleteMany({
				where: { organizationId: { in: migOrgIds } },
			});
			await prisma.organizationSettings.deleteMany({
				where: { organizationId: { in: migOrgIds } },
			});
			await prisma.organization.deleteMany({
				where: { id: { in: migOrgIds } },
			});
			await prisma.user.deleteMany({ where: { id: { in: migUserIds } } });
			// 个人流程锁定测试的清理（内层 afterAll 先于外层 testUserId 清理执行）
			await prisma.transaction.deleteMany({
				where: { userId: testUserId, currencyCode: migCurrency },
			});
			await prisma.planAllocation.deleteMany({ where: { planId: migPlanId } });
			await prisma.plan.deleteMany({
				where: { userId: testUserId, id: migPlanId },
			});
			await prisma.account.deleteMany({
				where: { userId: testUserId, currencyCode: migCurrency },
			});
		});

		test("部分唯一索引 memberships_single_active_owner_uidx 阻断同组织双活跃 OWNER", async () => {
			const org = await prisma.organization.create({
				data: { name: "MIG-A 单 Owner 唯一性测试组织" },
			});
			migOrgIds.push(org.id);
			const owner1 = await prisma.user.create({
				data: {
					email: `miga-owner1-${Date.now()}@example.com`,
					passwordHash: "test-hash",
				},
			});
			const owner2 = await prisma.user.create({
				data: {
					email: `miga-owner2-${Date.now()}@example.com`,
					passwordHash: "test-hash",
				},
			});
			migUserIds.push(owner1.id, owner2.id);

			await prisma.membership.create({
				data: {
					organizationId: org.id,
					userId: owner1.id,
					role: "OWNER",
					status: "ACTIVE",
				},
			});
			// 第二个 OWNER+ACTIVE 违反部分唯一索引（Prisma 以底层唯一冲突抛错）
			await expect(
				prisma.membership.create({
					data: {
						organizationId: org.id,
						userId: owner2.id,
						role: "OWNER",
						status: "ACTIVE",
					},
				}),
			).rejects.toThrow();

			// 先降原 Owner（转移所有权顺序保护）→ 新 Owner 可 ACTIVE
			await prisma.membership.update({
				where: {
					organizationId_userId: { organizationId: org.id, userId: owner1.id },
				},
				data: { role: "ADMIN" },
			});
			await expect(
				prisma.membership.create({
					data: {
						organizationId: org.id,
						userId: owner2.id,
						role: "OWNER",
						status: "ACTIVE",
					},
				}),
			).resolves.toBeDefined();

			// DISABLED 的 OWNER 不占唯一索引（禁用 Owner 不阻断新 Owner）
			await prisma.membership.update({
				where: {
					organizationId_userId: { organizationId: org.id, userId: owner2.id },
				},
				data: { status: "DISABLED" },
			});
			const owner3 = await prisma.user.create({
				data: {
					email: `miga-owner3-${Date.now()}@example.com`,
					passwordHash: "test-hash",
				},
			});
			migUserIds.push(owner3.id);
			await expect(
				prisma.membership.create({
					data: {
						organizationId: org.id,
						userId: owner3.id,
						role: "OWNER",
						status: "ACTIVE",
					},
				}),
			).resolves.toBeDefined();
		});

		test("OrganizationInvitation.tokenHash 唯一", async () => {
			const org = await prisma.organization.create({
				data: { name: "MIG-A 邀请唯一性测试组织" },
			});
			migOrgIds.push(org.id);
			const inviter = await prisma.user.create({
				data: {
					email: `miga-inviter-${Date.now()}@example.com`,
					passwordHash: "test-hash",
				},
			});
			migUserIds.push(inviter.id);

			await prisma.organizationInvitation.create({
				data: {
					organizationId: org.id,
					email: "miga-invitee@example.com",
					role: "FINANCE",
					tokenHash: "miga-token-hash-unique-probe",
					invitedById: inviter.id,
					expiresAt: new Date(Date.now() + 7 * 86_400_000),
				},
			});
			await expect(
				prisma.organizationInvitation.create({
					data: {
						organizationId: org.id,
						email: "miga-invitee-2@example.com",
						role: "OPERATOR",
						tokenHash: "miga-token-hash-unique-probe",
						invitedById: inviter.id,
						expiresAt: new Date(Date.now() + 7 * 86_400_000),
					},
				}),
			).rejects.toThrow();
		});

		test("新增可空租户列不影响既有个人建账/写入流程（NULL 往返）", async () => {
			// 不带 organizationId/createdById 写入 → 成功且读回 NULL（个人 MVP 路径零破坏）
			const account = await prisma.account.create({
				data: {
					userId: testUserId,
					currencyCode: migCurrency,
					balance: "77.0000",
				},
			});
			const accountRead = await prisma.account.findUnique({
				where: { id: account.id },
			});
			expect(accountRead?.organizationId).toBeNull();
			expect(accountRead?.createdById).toBeNull();

			const transaction = await prisma.transaction.create({
				data: {
					userId: testUserId,
					currencyCode: migCurrency,
					quantity: "10.0000",
					principalAmount: "650.0000",
					exchangeRate: "6.5000000000",
					rateSource: "identity",
					rateObservedAt: new Date(Date.UTC(2024, 0, 1, 12, 0, 0)),
					transactedAt: new Date(Date.UTC(2024, 0, 2, 12, 0, 0)),
				},
			});
			expect(transaction.organizationId).toBeNull();
			expect(transaction.createdById).toBeNull();

			const plan = await prisma.plan.create({
				data: {
					id: migPlanId,
					userId: testUserId,
					targetCurrency: migCurrency,
					targetAmount: "100.0000",
					expectUseDate: new Date(Date.UTC(2024, 1, 1)),
					latestPrepDate: new Date(Date.UTC(2024, 0, 25)),
				},
			});
			expect(plan.organizationId).toBeNull();
			expect(plan.createdById).toBeNull();

			// DataRequest.scope 默认 PERSONAL；organizationId 可空
			const dataRequest = await prisma.dataRequest.create({
				data: {
					userId: testUserId,
					type: "EXPORT",
					requestedAt: new Date(),
					dueAt: new Date(Date.now() + 86_400_000),
				},
			});
			expect(dataRequest.scope).toBe("PERSONAL");
			expect(dataRequest.organizationId).toBeNull();
			await prisma.dataRequest.delete({ where: { id: dataRequest.id } });
		});
	});
});
