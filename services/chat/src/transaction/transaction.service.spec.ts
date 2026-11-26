import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { AuditService } from "../audit/audit.service";
import { PermissionDeniedException } from "../authorization/authorization.errors";
import type { ActorContext } from "../authorization/authorization.types";
import { OnboardingNotCompletedException } from "../onboarding/onboarding.service";
import type { PrismaService } from "../prisma/prisma.service";
import {
	PlanCurrencyMismatchException,
	PlanNotFoundException,
	TransactionService,
} from "./transaction.service";

const T_YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const FINANCE_ACTOR: ActorContext = {
	userId: "u-fin",
	organizationId: "org-1",
	membershipId: "mem-fin",
	role: "FINANCE",
	authMethod: "USER",
};

function createAuditMock() {
	return {
		recordInTx: vi.fn().mockResolvedValue(undefined),
		recordStandalone: vi.fn().mockResolvedValue(undefined),
	} as unknown as {
		recordInTx: ReturnType<typeof vi.fn>;
		recordStandalone: ReturnType<typeof vi.fn>;
	} & AuditService;
}

function createPrismaMock(overrides: {
	lockedMembership?: {
		organizationId: string;
		role: string;
		status: string;
	} | null;
	organizationSettings?: Record<string, unknown> | null;
	existingOrgAccount?: { id: string; balance: Prisma.Decimal } | null;
	linkedPlan?: {
		id: string;
		organizationId: string | null;
		targetCurrency: string;
		name: string | null;
	} | null;
} = {}) {
	const $executeRaw = vi.fn().mockResolvedValue(1);
	const $queryRaw = vi.fn().mockResolvedValue([]);
	const membership = {
		findUnique: vi.fn().mockResolvedValue(
			overrides.lockedMembership === undefined
				? { organizationId: "org-1", role: "FINANCE", status: "ACTIVE" }
				: overrides.lockedMembership,
		),
	};
	const organizationSettings = {
		findUnique: vi.fn().mockResolvedValue(
			overrides.organizationSettings === undefined
				? {
						organizationId: "org-1",
						baseCurrency: "CNY",
						prepPreference: "balanced",
						reminderEnabled: true,
						ledgerStartedAt: null,
					}
				: overrides.organizationSettings,
		),
		upsert: vi.fn().mockResolvedValue({}),
	};
	const plan = {
		findFirst: vi.fn().mockResolvedValue(overrides.linkedPlan ?? null),
	};
	const account = {
		findUnique: vi.fn().mockResolvedValue(overrides.existingOrgAccount ?? null),
		upsert: vi.fn().mockResolvedValue({ id: "acc-org" }),
	};
	const initialHolding = {
		findUnique: vi.fn().mockResolvedValue(null),
		updateMany: vi.fn().mockResolvedValue({ count: 0 }),
	};
	const transaction = {
		create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
			id: "tx-created-1",
			version: 1,
			createdAt: new Date(),
			updatedAt: new Date(),
			...args.data,
		})),
		updateMany: vi.fn().mockResolvedValue({ count: 0 }),
	};
	const costLot = {
		create: vi.fn().mockResolvedValue({ id: "lot-1" }),
		updateMany: vi.fn().mockResolvedValue({ count: 0 }),
	};

	const prisma = {
		$executeRaw,
		$queryRaw,
		membership,
		organizationSettings,
		plan,
		account,
		initialHolding,
		transaction,
		costLot,
		$transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<unknown>) =>
			cb(prisma),
		),
	};
	return prisma;
}

const VALID_DTO = {
	currencyCode: "USD",
	principalAmount: "720.00",
	exchangeRate: "7.20000000",
	quantity: "100.00",
	feeAmount: "5.00",
	transactedAt: T_YESTERDAY,
};

describe("TransactionService（W23 单元测试）", () => {
	it("正常创建：先锁组织成员并复验权限，再取组织账本锁，写入组织字段与同事务审计", async () => {
		const prisma = createPrismaMock({
			existingOrgAccount: {
				id: "acc-org-usd",
				balance: new Prisma.Decimal("50"),
			},
		});
		const audit = createAuditMock();
		const service = new TransactionService(
			prisma as unknown as PrismaService,
			audit,
		);

		const result = await service.create(FINANCE_ACTOR, VALID_DTO, "req-tx-1");

		expect(result.id).toBe("tx-created-1");
		// 组织维度取锁：成员锁 + 组织账本锁（无用户维度 legacy 锁）
		const lockKeys = prisma.$executeRaw.mock.calls.map((c) => c[1] as string);
		expect(lockKeys).toEqual([
			"membership:org-1",
			"ledger-write:org:org-1:USD",
		]);
		// 组织内同币种唯一账户行：余额累加后写回（不再有 legacy 行合并）
		const upsertCall = prisma.account.upsert.mock.calls[0][0] as {
			where: unknown;
			create: { organizationId: string; createdById: string; balance: Prisma.Decimal };
			update: { balance: Prisma.Decimal };
		};
		expect(upsertCall.where).toEqual({
			organizationId_currencyCode: { organizationId: "org-1", currencyCode: "USD" },
		});
		expect(upsertCall.create.organizationId).toBe("org-1");
		expect(upsertCall.create.createdById).toBe("u-fin");
		expect(Number(upsertCall.create.balance.toString())).toBe(150);
		expect(Number(upsertCall.update.balance.toString())).toBe(150);
		// 交易行只带组织归属与作者，不再写 userId 兼容列
		const txData = prisma.transaction.create.mock.calls[0][0].data;
		expect(txData).toEqual(
			expect.objectContaining({
				organizationId: "org-1",
				createdById: "u-fin",
				currencyCode: "USD",
			}),
		);
		expect(txData).not.toHaveProperty("userId");
		expect(prisma.costLot.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				organizationId: "org-1",
				sourceType: "PURCHASE",
				sourceId: "tx-created-1",
			}),
		});
		expect(audit.recordInTx).toHaveBeenCalledWith(
			prisma,
			expect.objectContaining({
				organizationId: "org-1",
				actorUserId: "u-fin",
				action: "transaction.create",
				targetType: "transaction",
				targetId: "tx-created-1",
				result: "SUCCESS",
				requestId: "req-tx-1",
			}),
		);
	});

	it("未建账组织抛 409 ONBOARDING_NOT_COMPLETED 且不写入任何账本数据", async () => {
		const prisma = createPrismaMock({ organizationSettings: null });
		const audit = createAuditMock();
		const service = new TransactionService(
			prisma as unknown as PrismaService,
			audit,
		);

		await expect(service.create(FINANCE_ACTOR, VALID_DTO)).rejects.toThrow(
			OnboardingNotCompletedException,
		);
		expect(prisma.transaction.create).not.toHaveBeenCalled();
		expect(audit.recordInTx).not.toHaveBeenCalled();
	});

	it("锁内重读被降权为 OPERATOR：抛 403 并写 DENIED 独立审计（带 requestId）", async () => {
		const prisma = createPrismaMock({
			lockedMembership: {
				organizationId: "org-1",
				role: "OPERATOR",
				status: "ACTIVE",
			},
		});
		const audit = createAuditMock();
		const service = new TransactionService(
			prisma as unknown as PrismaService,
			audit,
		);

		await expect(
			service.create(FINANCE_ACTOR, VALID_DTO, "req-demote-tx"),
		).rejects.toThrow(PermissionDeniedException);
		expect(prisma.transaction.create).not.toHaveBeenCalled();
		expect(audit.recordInTx).not.toHaveBeenCalled();
		expect(audit.recordStandalone).toHaveBeenCalledWith({
			organizationId: "org-1",
			actorUserId: "u-fin",
			actorType: "USER",
			action: "permission.denied.transaction.create",
			result: "DENIED",
			requestId: "req-demote-tx",
			detail: { required: "transaction.create", role: "OPERATOR" },
		});
	});

	it("关联跨组织或不存在的 planId 抛 404 PLAN_NOT_FOUND；币种不一致抛 400 PLAN_CURRENCY_MISMATCH", async () => {
		const prismaMissing = createPrismaMock({ linkedPlan: null });
		const serviceMissing = new TransactionService(
			prismaMissing as unknown as PrismaService,
			createAuditMock(),
		);
		await expect(
			serviceMissing.create(FINANCE_ACTOR, {
				...VALID_DTO,
				planId: "plan-foreign",
			}),
		).rejects.toThrow(PlanNotFoundException);

		const prismaMismatch = createPrismaMock({
			linkedPlan: {
				id: "plan-jpy",
				organizationId: "org-1",
				targetCurrency: "JPY",
				name: "日元计划",
			},
		});
		const serviceMismatch = new TransactionService(
			prismaMismatch as unknown as PrismaService,
			createAuditMock(),
		);
		await expect(
			serviceMismatch.create(FINANCE_ACTOR, {
				...VALID_DTO,
				planId: "plan-jpy",
			}),
		).rejects.toThrow(PlanCurrencyMismatchException);
	});

	it("审计 recordInTx 抛出时异常穿透令事务回滚（N-1）", async () => {
		const prisma = createPrismaMock();
		const audit = createAuditMock();
		audit.recordInTx.mockRejectedValueOnce(new Error("audit down"));
		let rolledBack = false;
		prisma.$transaction.mockImplementationOnce(async (cb) => {
			try {
				return await cb(prisma);
			} catch (err) {
				rolledBack = true;
				throw err;
			}
		});
		const service = new TransactionService(
			prisma as unknown as PrismaService,
			audit,
		);

		await expect(service.create(FINANCE_ACTOR, VALID_DTO)).rejects.toThrow(
			"audit down",
		);
		expect(rolledBack).toBe(true);
		expect(audit.recordStandalone).not.toHaveBeenCalled();
	});
});
