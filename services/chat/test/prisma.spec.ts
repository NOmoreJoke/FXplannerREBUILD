import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient, type Prisma, type PrismaPromise } from "@prisma/client";
import { resolveDefaultOrganizationId } from "../src/authorization/default-organization";
import { deleteOrganizationsCascadeLedger } from "./helpers/test-app";

const prisma = new PrismaClient();

let testUserId: string;
let testOrgId: string;
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
	const org = await prisma.organization.create({
		data: {
			name: "基础设施测试组织",
			memberships: {
				create: { userId: testUserId, role: "OWNER", status: "ACTIVE" },
			},
		},
	});
	testOrgId = org.id;
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
	if (testOrgId) {
		await deleteOrganizationsCascadeLedger(prisma, [testOrgId]);
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
				where: { organizationId: testOrgId, targetId: m0TargetId },
			});
			await prisma.planAllocation.deleteMany({ where: { planId: m0PlanId } });
			await prisma.account.deleteMany({
				where: {
					organizationId: testOrgId,
					currencyCode: { in: [m0CurrencyA, m0CurrencyB, m0CurrencyC] },
				},
			});
		});

		test("Account organizationId+currencyCode 唯一冲突", async () => {
			await prisma.account.create({
				data: {
					organizationId: testOrgId,
					currencyCode: m0CurrencyA,
					balance: "100.0000",
				},
			});

			await expect(
				prisma.account.create({
					data: {
						organizationId: testOrgId,
						currencyCode: m0CurrencyA,
						balance: "1.0000",
					},
				}),
			).rejects.toThrow();

			// 同组织不同币种不受影响
			await expect(
				prisma.account.create({
					data: {
						organizationId: testOrgId,
						currencyCode: m0CurrencyB,
					},
				}),
			).resolves.toBeDefined();
		});

		test("PlanAllocation planId 唯一冲突（一计划一条分配汇总）", async () => {
			await prisma.planAllocation.deleteMany({ where: { planId: m0PlanId } });
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
					organizationId: testOrgId,
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
					organizationId: testOrgId,
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
			// 租户列测试清理（内层 afterAll 先于外层 testOrgId 清理执行）
			await prisma.transaction.deleteMany({
				where: { organizationId: testOrgId, currencyCode: migCurrency },
			});
			await prisma.planAllocation.deleteMany({ where: { planId: migPlanId } });
			await prisma.plan.deleteMany({
				where: { organizationId: testOrgId, id: migPlanId },
			});
			await prisma.account.deleteMany({
				where: { organizationId: testOrgId, currencyCode: migCurrency },
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

		test("MIG-E/F 收紧后：账本表仅以 organizationId 归属，createdById 可空，DataRequest.requesterUserId 可空", async () => {
			// 带 organizationId 且不带 createdById 写入 → 成功且 createdById 读回 NULL
			const account = await prisma.account.create({
				data: {
					organizationId: testOrgId,
					currencyCode: migCurrency,
					balance: "77.0000",
				},
			});
			const accountRead = await prisma.account.findUnique({
				where: { id: account.id },
			});
			expect(accountRead?.organizationId).toBe(testOrgId);
			expect(accountRead?.createdById).toBeNull();

			const transaction = await prisma.transaction.create({
				data: {
					organizationId: testOrgId,
					currencyCode: migCurrency,
					quantity: "10.0000",
					principalAmount: "650.0000",
					exchangeRate: "6.5000000000",
					rateSource: "identity",
					rateObservedAt: new Date(Date.UTC(2024, 0, 1, 12, 0, 0)),
					transactedAt: new Date(Date.UTC(2024, 0, 2, 12, 0, 0)),
				},
			});
			expect(transaction.organizationId).toBe(testOrgId);
			expect(transaction.createdById).toBeNull();

			const plan = await prisma.plan.create({
				data: {
					id: migPlanId,
					organizationId: testOrgId,
					targetCurrency: migCurrency,
					targetAmount: "100.0000",
					expectUseDate: new Date(Date.UTC(2024, 1, 1)),
					latestPrepDate: new Date(Date.UTC(2024, 0, 25)),
				},
			});
			expect(plan.organizationId).toBe(testOrgId);
			expect(plan.createdById).toBeNull();

			// DataRequest.scope 默认 PERSONAL；organizationId 可空，使用 requesterUserId
			const dataRequest = await prisma.dataRequest.create({
				data: {
					requesterUserId: testUserId,
					type: "EXPORT",
					requestedAt: new Date(),
					dueAt: new Date(Date.now() + 86_400_000),
				},
			});
			expect(dataRequest.scope).toBe("PERSONAL");
			expect(dataRequest.organizationId).toBeNull();
			expect(dataRequest.requesterUserId).toBe(testUserId);
			await prisma.dataRequest.delete({ where: { id: dataRequest.id } });
		});
	});

	describe("ToB R1 评审跟进（N-09 跟进索引 / N-11 ReminderRead 唯一性）", () => {
		const readStateUserIds: string[] = [];
		let sharedReminderId = "";

		afterAll(async () => {
			if (sharedReminderId) {
				await prisma.reminder
					.deleteMany({ where: { id: sharedReminderId } })
					.catch(() => {});
			}
			await prisma.user.deleteMany({ where: { id: { in: readStateUserIds } } });
		});

		test("ReminderRead(reminderId, userId) 唯一：同成员重复已读被拒，不同成员互不干扰", async () => {
			const owner = await prisma.user.create({
				data: {
					email: `rr-owner-${Date.now()}@example.com`,
					passwordHash: "test-hash",
				},
			});
			const member = await prisma.user.create({
				data: {
					email: `rr-member-${Date.now()}@example.com`,
					passwordHash: "test-hash",
				},
			});
			readStateUserIds.push(owner.id, member.id);
			const reminder = await prisma.reminder.create({
				data: {
					organizationId: testOrgId,
					type: "PLAN_DUE",
					dedupKey: `rr-${Date.now()}`,
					scheduledFor: observedAt,
				},
			});
			sharedReminderId = reminder.id;

			const readAt = new Date(Date.UTC(2026, 10, 23, 1, 0, 0));
			await prisma.reminderRead.create({
				data: { reminderId: reminder.id, userId: owner.id, readAt },
			});
			// 同一成员对同一提醒的重复已读行 → 唯一约束拒绝（LEDGER-03 / MIG-B 幂等兜底）
			await expect(
				prisma.reminderRead.create({
					data: { reminderId: reminder.id, userId: owner.id, readAt },
				}),
			).rejects.toMatchObject({ code: "P2002" });
			// 另一成员的已读态是独立行：一人已读不清除他人未读
			await expect(
				prisma.reminderRead.create({
					data: { reminderId: reminder.id, userId: member.id, readAt },
				}),
			).resolves.toBeDefined();
			expect(
				await prisma.reminderRead.count({ where: { reminderId: reminder.id } }),
			).toBe(2);
		});

		test("N-09 跟进索引已随迁移落库（reminder_reads.user_id / ai_conversations 组织打头）", async () => {
			const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
				SELECT indexname FROM pg_indexes
				WHERE schemaname = 'public'
					AND indexname IN ('reminder_reads_user_id_idx', 'ai_conversations_organization_id_last_message_at_idx')
			`;
			expect(rows.map((row) => row.indexname).sort()).toEqual([
				"ai_conversations_organization_id_last_message_at_idx",
				"reminder_reads_user_id_idx",
			]);
		});
	});

	describe("ToB R1 MIG-E/F 组织维度唯一索引、NOT NULL 约束、User SET NULL 与旧列下线验证", () => {
		const migCOrgIds: string[] = [];
		const migCUserIds: string[] = [];

		afterAll(async () => {
			await deleteOrganizationsCascadeLedger(prisma, migCOrgIds);
			await prisma.user.deleteMany({
				where: { id: { in: migCUserIds } },
			});
		});

		test("Account / InitialHolding / Reminder 按组织唯一，NULL organization_id 被 NOT NULL 拒绝", async () => {
			const owner = await prisma.user.create({
				data: {
					email: `migc-owner-${Date.now()}@example.com`,
					passwordHash: "test-hash",
				},
			});
			const orgA = await prisma.organization.create({
				data: { name: "MIG-E Org A" },
			});
			const orgB = await prisma.organization.create({
				data: { name: "MIG-E Org B" },
			});
			migCUserIds.push(owner.id);
			migCOrgIds.push(orgA.id, orgB.id);

			// 1. Account: 跨组织同币种共存，同组织重复 P2002
			await prisma.account.create({
				data: { createdById: owner.id, organizationId: orgA.id, currencyCode: "M1C", balance: "10" },
			});
			await expect(
				prisma.account.create({
					data: { createdById: owner.id, organizationId: orgB.id, currencyCode: "M1C", balance: "20" },
				}),
			).resolves.toBeDefined();
			await expect(
				prisma.account.create({
					data: { createdById: owner.id, organizationId: orgA.id, currencyCode: "M1C", balance: "30" },
				}),
			).rejects.toMatchObject({ code: "P2002" });

			// 2. InitialHolding: 跨组织同币种共存，同组织重复 P2002
			const holdingBase = {
				createdById: owner.id,
				currencyCode: "M1C",
				amount: "100",
				rate: "7.0",
				rawRate: "7.0",
				rateSource: "er-api",
				rateObservedAt: observedAt,
				cost: "700",
				confirmedAt: observedAt,
			};
			await prisma.initialHolding.create({
				data: { ...holdingBase, organizationId: orgA.id },
			});
			await expect(
				prisma.initialHolding.create({
					data: { ...holdingBase, organizationId: orgB.id },
				}),
			).resolves.toBeDefined();
			await expect(
				prisma.initialHolding.create({
					data: { ...holdingBase, organizationId: orgA.id },
				}),
			).rejects.toMatchObject({ code: "P2002" });

			// 3. Reminder: (organizationId, dedupKey, scheduledFor) 唯一
			const dedupKey = `migc-dedup-${Date.now()}`;
			await prisma.reminder.create({
				data: {
					organizationId: orgA.id,
					type: "PLAN_DUE",
					dedupKey,
					scheduledFor: observedAt,
				},
			});
			await expect(
				prisma.reminder.create({
					data: {
						organizationId: orgB.id,
						type: "PLAN_DUE",
						dedupKey,
						scheduledFor: observedAt,
					},
				}),
			).resolves.toBeDefined();
			await expect(
				prisma.reminder.create({
					data: {
						organizationId: orgA.id,
						type: "PLAN_DUE",
						dedupKey,
						scheduledFor: observedAt,
					},
				}),
			).rejects.toMatchObject({ code: "P2002" });

			// 4. MIG-E: 底层 NOT NULL 拒绝 organization_id = NULL 写入
			let nullOrgErr: unknown;
			try {
				await prisma.$executeRaw`
					INSERT INTO accounts (id, organization_id, currency_code, balance, created_at, updated_at)
					VALUES (${`mige-null-${Date.now()}`}, NULL, 'M1N', 0, now(), now())`;
			} catch (err) {
				nullOrgErr = err;
			}
			expect(nullOrgErr).toMatchObject({
				code: "P2010",
				meta: expect.objectContaining({ code: "23502" }),
			});
			// 同列集仅补上 organizationId 即可写入（证明 23502 确因 organization_id NOT NULL）
			await expect(
				prisma.account.create({
					data: { organizationId: orgA.id, currencyCode: "M1N", balance: "0" },
				}),
			).resolves.toBeDefined();
		});

		test("MIG-E/F：删除 User 不级联删除组织账本，并将 createdById / actorUserId / requesterUserId 置为 NULL", async () => {
			const creator = await prisma.user.create({
				data: {
					email: `mige-setnull-${Date.now()}@example.com`,
					passwordHash: "test-hash",
				},
			});
			const org = await prisma.organization.create({
				data: { name: "MIG-E SET NULL 保留组织" },
			});
			migCOrgIds.push(org.id);

			const account = await prisma.account.create({
				data: {
					organizationId: org.id,
					createdById: creator.id,
					currencyCode: "MSN",
					balance: "50.0000",
				},
			});
			const txRow = await prisma.transaction.create({
				data: {
					organizationId: org.id,
					createdById: creator.id,
					currencyCode: "MSN",
					quantity: "50.0000",
					principalAmount: "350.0000",
					exchangeRate: "7.0000000000",
					rateSource: "manual",
					rateObservedAt: observedAt,
					transactedAt: observedAt,
				},
			});
			const plan = await prisma.plan.create({
				data: {
					organizationId: org.id,
					createdById: creator.id,
					targetCurrency: "MSN",
					targetAmount: "100.0000",
					expectUseDate: new Date(Date.UTC(2024, 1, 1)),
					latestPrepDate: new Date(Date.UTC(2024, 0, 25)),
				},
			});
			const usage = await prisma.usageRecord.create({
				data: {
					organizationId: org.id,
					createdById: creator.id,
					planId: plan.id,
					currencyCode: "MSN",
					amount: "10.0000",
					usedAt: observedAt,
				},
			});
			const correction = await prisma.correction.create({
				data: {
					organizationId: org.id,
					actorUserId: creator.id,
					targetType: "TRANSACTION",
					targetId: txRow.id,
					reason: "作者注销前留下的更正",
					beforeSnapshot: { principalAmount: "350.0000" },
					afterSnapshot: { principalAmount: "340.0000" },
				},
			});
			const holding = await prisma.initialHolding.create({
				data: {
					organizationId: org.id,
					createdById: creator.id,
					currencyCode: "MSN",
					amount: "100.0000",
					rate: "7.0000000000",
					rawRate: "7.0000000000",
					rateSource: "identity",
					rateObservedAt: observedAt,
					cost: "700.0000",
					confirmedAt: observedAt,
				},
			});
			const auditRow = await prisma.auditLog.create({
				data: {
					organizationId: org.id,
					actorType: "USER",
					actorUserId: creator.id,
					action: "test.set_null",
					targetType: "ACCOUNT",
					targetId: account.id,
					result: "SUCCESS",
				},
			});
			const orgReq = await prisma.dataRequest.create({
				data: {
					organizationId: org.id,
					requesterUserId: creator.id,
					scope: "ORGANIZATION",
					type: "EXPORT",
					requestedAt: observedAt,
					dueAt: observedAt,
				},
			});

			// 删除创建者：个人关系级联，但组织账本 / 审计 / 组织数据请求保留
			await prisma.user.delete({ where: { id: creator.id } });

			const survivedAccount = await prisma.account.findUnique({ where: { id: account.id } });
			const survivedTx = await prisma.transaction.findUnique({ where: { id: txRow.id } });
			const survivedPlan = await prisma.plan.findUnique({ where: { id: plan.id } });
			const survivedUsage = await prisma.usageRecord.findUnique({ where: { id: usage.id } });
			const survivedCorrection = await prisma.correction.findUnique({
				where: { id: correction.id },
			});
			const survivedHolding = await prisma.initialHolding.findUnique({
				where: { id: holding.id },
			});
			const survivedAudit = await prisma.auditLog.findUnique({ where: { id: auditRow.id } });
			const survivedReq = await prisma.dataRequest.findUnique({ where: { id: orgReq.id } });

			// 账本行全部留存——「用户注销把企业账本删光」在数据库层面不可能发生
			expect(survivedAccount).not.toBeNull();
			expect(survivedTx).not.toBeNull();
			expect(survivedPlan).not.toBeNull();
			expect(survivedUsage).not.toBeNull();
			expect(survivedCorrection).not.toBeNull();
			expect(survivedHolding).not.toBeNull();
			expect(survivedReq).not.toBeNull();
			expect(survivedAudit).not.toBeNull();

			// 作者列（ON DELETE SET NULL）：账本表的 created_by_id / actor_user_id
			expect(survivedAccount?.createdById).toBeNull();
			expect(survivedTx?.createdById).toBeNull();
			expect(survivedPlan?.createdById).toBeNull();
			expect(survivedUsage?.createdById).toBeNull();
			expect(survivedHolding?.createdById).toBeNull();
			expect(survivedCorrection?.actorUserId).toBeNull();
			// 数据请求的 requester_user_id（ON DELETE SET NULL）：请求行保留、发起人置空
			expect(survivedReq?.requesterUserId).toBeNull();
			expect(survivedReq?.scope).toBe("ORGANIZATION");
			expect(survivedReq?.organizationId).toBe(org.id);

			// 租户列与业务事实不变
			expect(survivedAccount?.organizationId).toBe(org.id);
			expect(survivedAccount?.balance.toFixed(4)).toBe("50.0000");
			expect(survivedPlan?.organizationId).toBe(org.id);
			expect(survivedUsage?.organizationId).toBe(org.id);
			expect(survivedCorrection?.organizationId).toBe(org.id);

			// audit_logs.actor_user_id **无外键**（审计保留策略独立于用户/组织生命周期，
			// 见 schema.prisma AuditLog 注释）：用户注销不追溯审计行，操作者快照原样保留
			expect(survivedAudit?.actorUserId).toBe(creator.id);

			await prisma.dataRequest.delete({ where: { id: orgReq.id } });
			await prisma.auditLog.delete({ where: { id: auditRow.id } });
		});

		test("MIG-F：旧 user_id / read_at / user_settings 账本旧列与旧部分唯一索引已彻底下线", async () => {
			const droppedCols = await prisma.$queryRaw<
				Array<{ table_name: string; column_name: string }>
			>`
				SELECT table_name, column_name
				FROM information_schema.columns
				WHERE table_schema = current_schema()
					AND (
						(column_name = 'user_id' AND table_name IN (
							'accounts', 'transactions', 'plans', 'usage_records',
							'initial_holdings', 'corrections', 'cost_lots', 'reminders', 'data_requests'
						))
						OR (table_name = 'reminders' AND column_name = 'read_at')
						OR (table_name = 'user_settings' AND column_name IN (
							'base_currency', 'prep_preference', 'reminder_enabled', 'ledger_started_at'
						))
					)`;
			expect(droppedCols).toEqual([]);
		});
	});

	describe("ToB R1 W26 DataRequest 双域拆分：CHECK 约束与迁移规范化", () => {
		const CHECK_NAME = "data_requests_scope_type_org_check";
		/** CHECK 违约：Prisma 以底层检查约束冲突抛出，消息含约束名 */
		const CHECK_VIOLATION = /data_requests_scope_type_org_check/;
		const W26_T0 = new Date(Date.UTC(2026, 10, 1, 0, 0, 0));
		const W26_DUE = new Date(Date.UTC(2026, 10, 8, 0, 0, 0));
		const w26UserIds: string[] = [];
		const w26OrgIds: string[] = [];

		afterAll(async () => {
			await prisma.dataRequest.deleteMany({ where: { requesterUserId: { in: w26UserIds } } });
			await prisma.auditLog.deleteMany({ where: { organizationId: { in: w26OrgIds } } });
			// 成员关系 / 组织设置随组织级联删除
			await prisma.organization.deleteMany({ where: { id: { in: w26OrgIds } } });
			await prisma.user.deleteMany({ where: { id: { in: w26UserIds } } });
		});

		async function createUser(label: string): Promise<string> {
			const user = await prisma.user.create({
				data: {
					email: `w26-check-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
					passwordHash: "test-hash",
					name: label,
				},
				select: { id: true },
			});
			w26UserIds.push(user.id);
			return user.id;
		}

		/** 默认组织：组织与首位成员同事务创建（memberships.created_at = organizations.created_at） */
		async function createDefaultOrg(ownerId: string, name: string): Promise<string> {
			const organization = await prisma.organization.create({
				data: {
					name,
					memberships: { create: { userId: ownerId, role: "OWNER", status: "ACTIVE" } },
				},
				select: { id: true },
			});
			w26OrgIds.push(organization.id);
			return organization.id;
		}

		function requestRow(
			requesterUserId: string,
			type: "EXPORT" | "CLEAR" | "DELETION",
			extra: Record<string, unknown> = {},
		) {
			return { requesterUserId, type, requestedAt: W26_T0, dueAt: W26_DUE, ...extra };
		}

		test("约束已落库且通过校验（convalidated），定义覆盖 PERSONAL / ORGANIZATION 两个分支", async () => {
			const rows = await prisma.$queryRaw<
				Array<{ convalidated: boolean; definition: string }>
			>`
				SELECT convalidated, pg_get_constraintdef(oid) AS definition
				FROM pg_constraint WHERE conname = ${CHECK_NAME}`;
			expect(rows).toHaveLength(1);
			expect(rows[0]!.convalidated).toBe(true);
			const definition = rows[0]!.definition;
			// PERSONAL 分支：仅 EXPORT / DELETION 且 organization_id IS NULL
			expect(definition).toContain("scope = 'PERSONAL'::text");
			expect(definition).toContain("organization_id IS NULL");
			// ORGANIZATION 分支：EXPORT / CLEAR / DELETION 且 organization_id IS NOT NULL
			expect(definition).toContain("scope = 'ORGANIZATION'::text");
			expect(definition).toContain("organization_id IS NOT NULL");
			expect(definition).toContain("'CLEAR'::text");
		});

		test("正向：5 种合法组合全部可写（PERSONAL EXPORT/DELETION 不挂组织；ORGANIZATION EXPORT/CLEAR/DELETION 必挂组织）", async () => {
			const userId = await createUser("valid");
			const organizationId = await createDefaultOrg(userId, "W26 合法组合组织");
			for (const type of ["EXPORT", "DELETION"] as const) {
				await expect(
					prisma.dataRequest.create({ data: requestRow(userId, type, { scope: "PERSONAL" }) }),
				).resolves.toBeDefined();
			}
			for (const type of ["EXPORT", "CLEAR", "DELETION"] as const) {
				await expect(
					prisma.dataRequest.create({
						data: requestRow(userId, type, { scope: "ORGANIZATION", organizationId }),
					}),
				).resolves.toBeDefined();
			}
			const rows = await prisma.dataRequest.findMany({ where: { requesterUserId: userId } });
			expect(rows.map((row) => [row.scope, row.type, row.organizationId === null])).toEqual([
				["PERSONAL", "EXPORT", true],
				["PERSONAL", "DELETION", true],
				["ORGANIZATION", "EXPORT", false],
				["ORGANIZATION", "CLEAR", false],
				["ORGANIZATION", "DELETION", false],
			]);
		});

		test("反向：PERSONAL+CLEAR、PERSONAL+组织、ORGANIZATION+无组织、未知 type 一律被数据库拒绝", async () => {
			const userId = await createUser("invalid");
			const organizationId = await createDefaultOrg(userId, "W26 违约组织");
			const invalid: Array<[string, Record<string, unknown>]> = [
				["PERSONAL + CLEAR（个人域不能清空组织账本）", { type: "CLEAR", scope: "PERSONAL" }],
				["PERSONAL + CLEAR（未显式给 scope，走库列默认值）", { type: "CLEAR" }],
				["PERSONAL + EXPORT + 组织", { type: "EXPORT", scope: "PERSONAL", organizationId }],
				["PERSONAL + DELETION + 组织", { type: "DELETION", scope: "PERSONAL", organizationId }],
				["ORGANIZATION + EXPORT 无组织", { type: "EXPORT", scope: "ORGANIZATION" }],
				["ORGANIZATION + CLEAR 无组织", { type: "CLEAR", scope: "ORGANIZATION" }],
				["ORGANIZATION + DELETION 无组织", { type: "DELETION", scope: "ORGANIZATION" }],
				["ORGANIZATION + 未知 type", { type: "PURGE", scope: "ORGANIZATION", organizationId }],
			];
			for (const [label, data] of invalid) {
				await expect(
					prisma.dataRequest.create({ data: requestRow(userId, data.type as "EXPORT", data) }),
					label,
				).rejects.toThrow(CHECK_VIOLATION);
			}
			// 违约写入零落库
			expect(await prisma.dataRequest.count({ where: { requesterUserId: userId } })).toBe(0);
		});

		test("反向：更新同样受约束——把已挂组织的请求改成 PERSONAL、或把组织域请求的组织置空均被拒绝", async () => {
			const userId = await createUser("update");
			const organizationId = await createDefaultOrg(userId, "W26 更新违约组织");
			const row = await prisma.dataRequest.create({
				data: requestRow(userId, "CLEAR", { scope: "ORGANIZATION", organizationId }),
				select: { id: true },
			});
			await expect(
				prisma.dataRequest.update({ where: { id: row.id }, data: { scope: "PERSONAL" } }),
			).rejects.toThrow(CHECK_VIOLATION);
			await expect(
				prisma.dataRequest.update({
					where: { id: row.id },
					data: { organizationId: null },
				}),
			).rejects.toThrow(CHECK_VIOLATION);
			await expect(
				prisma.dataRequest.updateMany({
					where: { id: row.id },
					data: { scope: "PERSONAL", organizationId: null, type: "EXPORT" },
				}),
			).resolves.toMatchObject({ count: 1 }); // 整体改成合法组合则放行
		});

		test("迁移规范化 SQL（20261125180000）：历史 CLEAR 无损转为默认组织的 ORGANIZATION 请求，PENDING 锁不解锁，随后 CHECK 可成功添加", async () => {
			// 执行的 7 条语句与迁移文件逐条相等（空白归一后比对）——相等即保证这里跑的正是迁移内容；
			// 迁移文件一旦改动，本用例失败并要求同步复核
			const migrationSql = readFileSync(
				path.resolve(
					__dirname,
					"../prisma/migrations/20261125180000_tob_r1_data_request_scope_check/migration.sql",
				),
				"utf8",
			);
			const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
			const fileStatements = migrationSql
				.split("\n")
				.filter((line) => !line.trimStart().startsWith("--"))
				.join("\n")
				.split(";")
				.map((statement) => normalize(statement))
				.filter(
					(statement) => statement.length > 0 && statement !== "BEGIN" && statement !== "COMMIT",
				);
			expect(fileStatements).toHaveLength(7);

			/** ① 补建默认组织（尚无默认组织但持有历史 CLEAR 的用户） */
			const createMissingOrganizations = (tx: Prisma.TransactionClient) =>
				tx.$executeRaw`
					WITH first_members AS (
						SELECT DISTINCT ON (m.organization_id)
							m.organization_id, m.user_id, m.joined_at, m.created_at, m.id
						FROM memberships m
						ORDER BY m.organization_id, m.created_at ASC, m.id ASC
					),
					defaults AS (
						SELECT DISTINCT ON (f.user_id) f.user_id, f.organization_id
						FROM first_members f
						JOIN organizations o ON o.id = f.organization_id
						WHERE f.created_at = o.created_at
						ORDER BY f.user_id, f.joined_at ASC, f.created_at ASC, f.id ASC
					),
					missing_users AS (
						SELECT DISTINCT dr.user_id
						FROM data_requests dr
						LEFT JOIN defaults d ON d.user_id = dr.user_id
						WHERE dr.type = 'CLEAR'
							AND dr.organization_id IS NULL
							AND d.organization_id IS NULL
					)
					INSERT INTO organizations (id, name, created_at, updated_at)
					SELECT
						'cdrmig' || substr(md5(mu.user_id), 1, 19),
						COALESCE(
							NULLIF(btrim(u.name), ''),
							NULLIF(btrim(split_part(COALESCE(u.email, ''), '@', 1)), ''),
							'我的'
						) || '的工作台',
						timezone('UTC', now()),
						timezone('UTC', now())
					FROM missing_users mu
					JOIN users u ON u.id = mu.user_id
					ORDER BY mu.user_id`;
			/** ② OWNER / ACTIVE 成员关系（created_at 与组织同事务同一值） */
			const createOwnerMemberships = (tx: Prisma.TransactionClient) =>
				tx.$executeRaw`
					INSERT INTO memberships (id, organization_id, user_id, role, status, joined_at, created_at, updated_at)
					SELECT
						'cdrmig' || substr(md5('membership:' || legacy.user_id), 1, 19),
						o.id,
						legacy.user_id,
						'OWNER',
						'ACTIVE',
						o.created_at,
						o.created_at,
						o.created_at
					FROM (
						SELECT DISTINCT dr.user_id
						FROM data_requests dr
						WHERE dr.type = 'CLEAR' AND dr.organization_id IS NULL
					) legacy
					JOIN organizations o
						ON o.id = 'cdrmig' || substr(md5(legacy.user_id), 1, 19)
					ON CONFLICT (organization_id, user_id) DO NOTHING`;
			/** ③ 组织设置：仅复制非空 base_currency 的个人设置 */
			const copyOrganizationSettings = (tx: Prisma.TransactionClient) =>
				tx.$executeRaw`
					INSERT INTO organization_settings (id, organization_id, base_currency, prep_preference, reminder_enabled, ledger_started_at, created_at, updated_at)
					SELECT
						'cdrmig' || substr(md5('settings:' || o.id), 1, 19),
						o.id,
						s.base_currency,
						s.prep_preference,
						s.reminder_enabled,
						s.ledger_started_at,
						timezone('UTC', now()),
						timezone('UTC', now())
					FROM (
						SELECT DISTINCT dr.user_id
						FROM data_requests dr
						WHERE dr.type = 'CLEAR' AND dr.organization_id IS NULL
					) legacy
					JOIN organizations o
						ON o.id = 'cdrmig' || substr(md5(legacy.user_id), 1, 19)
					JOIN user_settings s ON s.user_id = legacy.user_id
					WHERE COALESCE(btrim(s.base_currency), '') <> ''
					ON CONFLICT (organization_id) DO NOTHING`;
			/** ④ 未挂组织的 EXPORT / DELETION 一律为 PERSONAL */
			const rescopePersonal = (tx: Prisma.TransactionClient) =>
				tx.$executeRaw`
					UPDATE data_requests
					SET scope = 'PERSONAL'
					WHERE organization_id IS NULL
						AND type IN ('EXPORT', 'DELETION')
						AND scope <> 'PERSONAL'`;
			/** ⑤ 历史 CLEAR → 默认组织的 ORGANIZATION 请求 */
			const rescopeLegacyClear = (tx: Prisma.TransactionClient) =>
				tx.$executeRaw`
					WITH first_members AS (
						SELECT DISTINCT ON (m.organization_id)
							m.organization_id, m.user_id, m.joined_at, m.created_at, m.id
						FROM memberships m
						ORDER BY m.organization_id, m.created_at ASC, m.id ASC
					),
					defaults AS (
						SELECT DISTINCT ON (f.user_id) f.user_id, f.organization_id
						FROM first_members f
						JOIN organizations o ON o.id = f.organization_id
						WHERE f.created_at = o.created_at
						ORDER BY f.user_id, f.joined_at ASC, f.created_at ASC, f.id ASC
					)
					UPDATE data_requests dr
					SET scope = 'ORGANIZATION', organization_id = d.organization_id
					FROM defaults d
					WHERE dr.organization_id IS NULL
						AND dr.type = 'CLEAR'
						AND d.user_id = dr.user_id`;
			/** ⑥ 已挂组织的行一律为 ORGANIZATION */
			const rescopeBound = (tx: Prisma.TransactionClient) =>
				tx.$executeRaw`
					UPDATE data_requests
					SET scope = 'ORGANIZATION'
					WHERE organization_id IS NOT NULL
						AND scope <> 'ORGANIZATION'`;
			/** ⑦ 加 CHECK（DDL 须用 $executeRawUnsafe：Prisma 的标签模板拒绝 ALTER；语句为静态字面量） */
			const addCheck = (tx: Prisma.TransactionClient) =>
				tx.$executeRawUnsafe(
					'ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_scope_type_org_check" CHECK (("scope" = \'PERSONAL\' AND "type" IN (\'EXPORT\', \'DELETION\') AND "organization_id" IS NULL) OR ("scope" = \'ORGANIZATION\' AND "type" IN (\'EXPORT\', \'CLEAR\', \'DELETION\') AND "organization_id" IS NOT NULL))',
				);

			// 先用「记录型假客户端」取出 7 条语句文本（不触达数据库），与迁移文件逐条比对：
			// 相等即保证下文在事务里执行的正是迁移文件的内容
			type Step = (tx: Prisma.TransactionClient) => PrismaPromise<number>;
			const steps: Step[] = [
				createMissingOrganizations,
				createOwnerMemberships,
				copyOrganizationSettings,
				rescopePersonal,
				rescopeLegacyClear,
				rescopeBound,
				addCheck,
			];
			const recorded: string[] = [];
			const recorder = {
				$executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
					expect(values, "迁移语句不应含绑定参数").toHaveLength(0);
					recorded.push(normalize(strings.join("")));
					return Promise.resolve(0);
				},
				$executeRawUnsafe: (query: string) => {
					recorded.push(normalize(query));
					return Promise.resolve(0);
				},
			} as unknown as Prisma.TransactionClient;
			for (const step of steps) {
				await step(recorder);
			}
			expect(recorded).toEqual(fileStatements);

			// 在独立临时 schema 演练 MIG-E/F 前的历史库形态（含 data_requests.user_id 与 user_settings 4 列），
			// 不污染主库 public 结构，跑完即 DROP SCHEMA CASCADE
			const tempSchema = `w26_replay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			await prisma.$executeRawUnsafe(`CREATE SCHEMA "${tempSchema}"`);
			try {
				await prisma.$transaction(async (tx) => {
					await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${tempSchema}"`);
					for (const ddl of [
						`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT)`,
						`CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('UTC', now()), updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('UTC', now()))`,
						`CREATE TABLE memberships (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, joined_at TIMESTAMPTZ NOT NULL DEFAULT timezone('UTC', now()), created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('UTC', now()), updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('UTC', now()), UNIQUE (organization_id, user_id))`,
						`CREATE TABLE user_settings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, base_currency TEXT, prep_preference TEXT NOT NULL, reminder_enabled BOOLEAN NOT NULL, ledger_started_at TIMESTAMPTZ)`,
						`CREATE TABLE organization_settings (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL UNIQUE, base_currency TEXT NOT NULL, prep_preference TEXT NOT NULL, reminder_enabled BOOLEAN NOT NULL, ledger_started_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
						`CREATE TABLE data_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, organization_id TEXT, scope TEXT NOT NULL DEFAULT 'PERSONAL', type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', requested_at TIMESTAMPTZ NOT NULL, due_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('UTC', now()), updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('UTC', now()))`,
					]) {
						await tx.$executeRawUnsafe(ddl);
					}

					const withDefault = "u-with-default";
					const defaultOrgId = "org-with-default";
					const noDefault = "u-no-default";
					const bare = "u-bare";
					const migratedOrgId = `cdrmig${createHash("md5").update(noDefault).digest("hex").slice(0, 19)}`;
					const bareOrgId = `cdrmig${createHash("md5").update(bare).digest("hex").slice(0, 19)}`;

					await tx.$executeRaw`
						INSERT INTO users (id, email, name) VALUES
							(${withDefault}, 'with@example.com', '已有默认组织'),
							(${noDefault}, 'nodefault@example.com', '迁移补建'),
							(${bare}, 'bare@example.com', NULL)`;
					await tx.$executeRaw`
						INSERT INTO organizations (id, name, created_at, updated_at)
						VALUES (${defaultOrgId}, 'W26 既有默认组织', ${W26_T0}, ${W26_T0})`;
					await tx.$executeRaw`
						INSERT INTO memberships (id, organization_id, user_id, role, status, joined_at, created_at, updated_at)
						VALUES ('m-default', ${defaultOrgId}, ${withDefault}, 'OWNER', 'ACTIVE', ${W26_T0}, ${W26_T0}, ${W26_T0})`;
					await tx.$executeRaw`
						INSERT INTO user_settings (id, user_id, base_currency, prep_preference, reminder_enabled, ledger_started_at)
						VALUES ('us-nodefault', ${noDefault}, 'USD', 'cautious', false, ${W26_T0})`;

					const legacySeed = [
						{ id: "dr-1", userId: withDefault, organizationId: null, scope: "PERSONAL", type: "CLEAR", status: "PENDING" },
						{ id: "dr-2", userId: withDefault, organizationId: null, scope: "ORGANIZATION", type: "EXPORT", status: "COMPLETED" },
						{ id: "dr-3", userId: withDefault, organizationId: defaultOrgId, scope: "PERSONAL", type: "EXPORT", status: "PENDING" },
						{ id: "dr-4", userId: noDefault, organizationId: null, scope: "PERSONAL", type: "CLEAR", status: "PENDING" },
						{ id: "dr-5", userId: noDefault, organizationId: null, scope: "PERSONAL", type: "CLEAR", status: "COMPLETED" },
						{ id: "dr-6", userId: noDefault, organizationId: null, scope: "PERSONAL", type: "CLEAR", status: "CANCELLED" },
						{ id: "dr-7", userId: bare, organizationId: null, scope: "PERSONAL", type: "CLEAR", status: "COMPLETED" },
					];
					for (const item of legacySeed) {
						await tx.$executeRaw`
							INSERT INTO data_requests (id, user_id, organization_id, scope, type, status, requested_at, due_at)
							VALUES (${item.id}, ${item.userId}, ${item.organizationId}, ${item.scope}, ${item.type}, ${item.status}, ${W26_T0}, ${W26_DUE})`;
					}
					const beforeRows = await tx.$queryRaw<
						Array<{ id: string; createdAt: Date; updatedAt: Date }>
					>`
						SELECT id, created_at AS "createdAt", updated_at AS "updatedAt"
						FROM data_requests ORDER BY id`;

					for (const step of steps) {
						await step(tx);
					}

					const rows = await tx.$queryRaw<
						Array<{
							id: string;
							userId: string;
							organizationId: string | null;
							scope: string;
							type: string;
							status: string;
							requestedAt: Date;
							dueAt: Date;
							createdAt: Date;
							updatedAt: Date;
						}>
					>`
						SELECT id, user_id AS "userId", organization_id AS "organizationId",
							scope, type, status, requested_at AS "requestedAt", due_at AS "dueAt",
							created_at AS "createdAt", updated_at AS "updatedAt"
						FROM data_requests ORDER BY id`;
					expect(rows).toHaveLength(legacySeed.length);
					for (const row of rows) {
						const valid =
							(row.scope === "PERSONAL" && row.organizationId === null && ["EXPORT", "DELETION"].includes(row.type)) ||
							(row.scope === "ORGANIZATION" && row.organizationId !== null);
						expect(valid, `${row.userId} ${row.type} ${row.scope}`).toBe(true);
					}
					for (const before of beforeRows) {
						const after = rows.find((row) => row.id === before.id)!;
						expect([after.createdAt, after.updatedAt, after.requestedAt, after.dueAt]).toEqual([
							before.createdAt,
							before.updatedAt,
							W26_T0,
							W26_DUE,
						]);
					}
					const byKey = new Map(
						rows.map((row) => [`${row.userId}|${row.type}|${row.status}`, row]),
					);
					expect(byKey.get(`${withDefault}|CLEAR|PENDING`)).toMatchObject({
						scope: "ORGANIZATION",
						organizationId: defaultOrgId,
					});
					expect(byKey.get(`${withDefault}|EXPORT|COMPLETED`)).toMatchObject({
						scope: "PERSONAL",
						organizationId: null,
					});
					expect(byKey.get(`${withDefault}|EXPORT|PENDING`)).toMatchObject({
						scope: "ORGANIZATION",
						organizationId: defaultOrgId,
					});
					for (const status of ["PENDING", "COMPLETED", "CANCELLED"]) {
						expect(byKey.get(`${noDefault}|CLEAR|${status}`)).toMatchObject({
							scope: "ORGANIZATION",
							organizationId: migratedOrgId,
							status,
						});
					}
					expect(byKey.get(`${bare}|CLEAR|COMPLETED`)).toMatchObject({
						scope: "ORGANIZATION",
						organizationId: bareOrgId,
					});

					expect(await resolveDefaultOrganizationId(tx, noDefault)).toBe(migratedOrgId);
					expect(await resolveDefaultOrganizationId(tx, bare)).toBe(bareOrgId);
					const [orgRow] = await tx.$queryRaw<
						Array<{ name: string; createdAt: Date }>
					>`SELECT name, created_at AS "createdAt" FROM organizations WHERE id = ${migratedOrgId}`;
					const [membershipRow] = await tx.$queryRaw<
						Array<{ role: string; status: string; createdAt: Date; joinedAt: Date }>
					>`
						SELECT role, status, created_at AS "createdAt", joined_at AS "joinedAt"
						FROM memberships WHERE organization_id = ${migratedOrgId} AND user_id = ${noDefault}`;
					expect(membershipRow).toMatchObject({ role: "OWNER", status: "ACTIVE" });
					expect(membershipRow?.createdAt).toEqual(orgRow?.createdAt);
					expect(membershipRow?.joinedAt).toEqual(orgRow?.createdAt);
					expect(orgRow?.name).toBe("迁移补建的工作台");

					const [orgSettings] = await tx.$queryRaw<
						Array<{
							baseCurrency: string;
							prepPreference: string;
							reminderEnabled: boolean;
							ledgerStartedAt: Date | null;
						}>
					>`
						SELECT base_currency AS "baseCurrency", prep_preference AS "prepPreference",
							reminder_enabled AS "reminderEnabled", ledger_started_at AS "ledgerStartedAt"
						FROM organization_settings WHERE organization_id = ${migratedOrgId}`;
					expect(orgSettings).toMatchObject({
						baseCurrency: "USD",
						prepPreference: "cautious",
						reminderEnabled: false,
						ledgerStartedAt: W26_T0,
					});
					const bareSettings = await tx.$queryRaw<Array<{ id: string }>>`
						SELECT id FROM organization_settings WHERE organization_id = ${bareOrgId}`;
					expect(bareSettings).toHaveLength(0);

					// 幂等重跑 ①–⑥
					const snapshot = JSON.stringify(rows.map((row) => [row.id, row.scope, row.organizationId]));
					for (const step of steps.slice(0, 6)) await step(tx);
					const afterRerun = await tx.$queryRaw<
						Array<{ id: string; scope: string; organizationId: string | null }>
					>`SELECT id, scope, organization_id AS "organizationId" FROM data_requests ORDER BY id`;
					expect(
						JSON.stringify(afterRerun.map((row) => [row.id, row.scope, row.organizationId])),
					).toBe(snapshot);

					// ⑦ 步加上的约束在临时 schema 内已生效并拒绝违约写入
					await expect(
						tx.$executeRaw`
							INSERT INTO data_requests (id, user_id, organization_id, scope, type, status, requested_at, due_at)
							VALUES ('dr-invalid', ${bare}, NULL, 'PERSONAL', 'CLEAR', 'PENDING', ${W26_T0}, ${W26_DUE})`,
					).rejects.toThrow(CHECK_VIOLATION);
				}, { timeout: 60_000 });
			} finally {
				await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${tempSchema}" CASCADE`);
			}
		});
	});
});
