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
});
