import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { AuditService } from "../audit/audit.service";
import { PermissionDeniedException } from "../authorization/authorization.errors";
import type { ActorContext } from "../authorization/authorization.types";
import { OnboardingNotCompletedException } from "../onboarding/onboarding.service";
import type { PrismaService } from "../prisma/prisma.service";
import {
	PlanNotFoundException,
	PlanService,
} from "./plan.service";

const OPERATOR_ACTOR: ActorContext = {
	userId: "u-op",
	organizationId: "org-1",
	membershipId: "mem-op",
	role: "OPERATOR",
	authMethod: "USER",
};

const EXPECT_USE_DATE = "2030-02-15T00:00:00.000Z";
const START_DATE = "2030-01-01T00:00:00.000Z";

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
	planRow?: Record<string, unknown> | null;
	allocationRow?: Record<string, unknown> | null;
	accountRows?: Array<{ balance: Prisma.Decimal }>;
} = {}) {
	const defaultPlan =
		overrides.planRow === undefined
			? {
					id: "plan-1",
					organizationId: "org-1",
					createdById: "u-owner",
					name: "USD 计划",
					pacePreference: "balanced",
					targetCurrency: "USD",
					targetAmount: new Prisma.Decimal("10000"),
					expectUseDate: new Date(EXPECT_USE_DATE),
					prepLeadDays: 3,
					latestPrepDate: new Date("2030-02-12T00:00:00.000Z"),
					planStartDate: new Date(START_DATE),
					status: "ACTIVE",
					createdAt: new Date("2026-10-01T00:00:00.000Z"),
					updatedAt: new Date("2026-10-01T00:00:00.000Z"),
				}
			: overrides.planRow;
	const defaultAllocation =
		overrides.allocationRow === undefined
			? {
					id: "alloc-1",
					planId: "plan-1",
					amount: new Prisma.Decimal("2000"),
					usedAmount: new Prisma.Decimal("0"),
				}
			: overrides.allocationRow;

	const $executeRaw = vi.fn().mockResolvedValue(1);
	const $queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
		const sql = strings.join("?");
		if (sql.includes("FROM plans")) {
			return defaultPlan ? [{ id: defaultPlan.id }] : [];
		}
		return [];
	});
	const membership = {
		findUnique: vi.fn().mockResolvedValue(
			overrides.lockedMembership === undefined
				? { organizationId: "org-1", role: "OPERATOR", status: "ACTIVE" }
				: overrides.lockedMembership,
		),
		findFirst: vi.fn().mockResolvedValue(null),
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
	const userSettings = {
		findUnique: vi.fn().mockResolvedValue(null),
	};
	const account = {
		findMany: vi
			.fn()
			.mockResolvedValue(
				overrides.accountRows ?? [{ balance: new Prisma.Decimal("10000") }],
			),
	};
	const plan = {
		findFirst: vi.fn().mockResolvedValue(defaultPlan),
		findMany: vi.fn().mockResolvedValue([]),
		findUnique: vi.fn().mockResolvedValue(defaultPlan),
		create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
			id: "plan-created-1",
			status: "ACTIVE",
			createdAt: new Date(),
			updatedAt: new Date(),
			...args.data,
		})),
		update: vi.fn().mockResolvedValue(defaultPlan),
		updateMany: vi.fn().mockResolvedValue({ count: defaultPlan ? 1 : 0 }),
	};
	const planAllocation = {
		findMany: vi.fn().mockResolvedValue([]),
		findUnique: vi.fn().mockResolvedValue(defaultAllocation),
		create: vi.fn().mockResolvedValue({ id: "alloc-created" }),
		update: vi.fn().mockResolvedValue(defaultAllocation),
	};
	const planInstallment = {
		findMany: vi.fn().mockResolvedValue([]),
		createMany: vi.fn().mockResolvedValue({ count: 3 }),
		deleteMany: vi.fn().mockResolvedValue({ count: 3 }),
	};
	const planChangeLog = {
		findMany: vi.fn().mockResolvedValue([]),
		create: vi.fn().mockResolvedValue({ id: "log-1" }),
	};

	const prisma = {
		$executeRaw,
		$queryRaw,
		membership,
		organizationSettings,
		userSettings,
		account,
		plan,
		planAllocation,
		planInstallment,
		planChangeLog,
		$transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<unknown>) =>
			cb(prisma),
		),
	};
	return prisma;
}

describe("PlanService（W23 单元测试）", () => {
	it("OPERATOR 创建计划：先锁组织复验 plan.create，再锁组织账本，写入 organizationId/createdById 与同事务审计", async () => {
		const prisma = createPrismaMock();
		const audit = createAuditMock();
		const service = new PlanService(
			prisma as unknown as PrismaService,
			audit,
		);

		const created = await service.create(
			OPERATOR_ACTOR,
			{
				targetCurrency: "USD",
				targetAmount: "10000",
				expectUseDate: EXPECT_USE_DATE,
				prepLeadDays: 3,
				pacePreference: "balanced",
				startDate: START_DATE,
				allocatedAmount: "2000",
			},
			"req-plan-create",
		);

		expect(created.id).toBe("plan-created-1");
		const lockKeys = prisma.$executeRaw.mock.calls.map((c) => c[1] as string);
		expect(lockKeys).toEqual(["membership:org-1", "ledger-write:org:org-1:USD"]);
		expect(prisma.plan.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				organizationId: "org-1",
				createdById: "u-op",
				targetCurrency: "USD",
			}),
		});
		// W30（MIG-E）：共享账本表已无 userId 列——计划只按 organizationId 归属
		expect(prisma.plan.create).not.toHaveBeenCalledWith({
			data: expect.objectContaining({ userId: expect.anything() }),
		});
		expect(audit.recordInTx).toHaveBeenCalledWith(
			prisma,
			expect.objectContaining({
				organizationId: "org-1",
				actorUserId: "u-op",
				action: "plan.create",
				targetType: "plan",
				targetId: "plan-created-1",
				result: "SUCCESS",
				requestId: "req-plan-create",
			}),
		);
	});

	it("未建账组织创建计划抛 409 ONBOARDING_NOT_COMPLETED", async () => {
		const prisma = createPrismaMock({ organizationSettings: null });
		const service = new PlanService(
			prisma as unknown as PrismaService,
			createAuditMock(),
		);

		await expect(
			service.create(OPERATOR_ACTOR, {
				targetCurrency: "USD",
				targetAmount: "10000",
				expectUseDate: EXPECT_USE_DATE,
				prepLeadDays: 3,
				pacePreference: "balanced",
				startDate: START_DATE,
			}),
		).rejects.toThrow(OnboardingNotCompletedException);
	});

	it("锁内降权为 VIEWER：create 与 adjust 均抛 403 并写 DENIED 审计（带 requestId）", async () => {
		const prisma = createPrismaMock({
			lockedMembership: {
				organizationId: "org-1",
				role: "VIEWER",
				status: "ACTIVE",
			},
		});
		const audit = createAuditMock();
		const service = new PlanService(
			prisma as unknown as PrismaService,
			audit,
		);

		await expect(
			service.create(
				OPERATOR_ACTOR,
				{
					targetCurrency: "USD",
					targetAmount: "10000",
					expectUseDate: EXPECT_USE_DATE,
					prepLeadDays: 3,
					pacePreference: "balanced",
					startDate: START_DATE,
				},
				"req-demote-create",
			),
		).rejects.toThrow(PermissionDeniedException);
		expect(audit.recordStandalone).toHaveBeenCalledWith({
			organizationId: "org-1",
			actorUserId: "u-op",
			actorType: "USER",
			action: "permission.denied.plan.create",
			result: "DENIED",
			requestId: "req-demote-create",
			detail: { required: "plan.create", role: "VIEWER" },
		});

		await expect(
			service.adjust(
				OPERATOR_ACTOR,
				"plan-1",
				{
					newTargetAmount: "12000",
					expectedUpdatedAt: "2026-10-01T00:00:00.000Z",
				},
				"req-demote-adjust",
			),
		).rejects.toThrow(PermissionDeniedException);
		expect(audit.recordStandalone).toHaveBeenCalledWith({
			organizationId: "org-1",
			actorUserId: "u-op",
			actorType: "USER",
			action: "permission.denied.plan.adjust",
			result: "DENIED",
			requestId: "req-demote-adjust",
			detail: { required: "plan.adjust", role: "VIEWER" },
		});
	});

	it("adjust / complete / cancel 对跨组织计划抛 404 PLAN_NOT_FOUND，正常执行写 organizationId + actorUserId + 同事务审计", async () => {
		const prismaMissing = createPrismaMock({ planRow: null });
		const serviceMissing = new PlanService(
			prismaMissing as unknown as PrismaService,
			createAuditMock(),
		);
		await expect(
			serviceMissing.cancel(OPERATOR_ACTOR, "foreign-plan"),
		).rejects.toThrow(PlanNotFoundException);

		const prisma = createPrismaMock();
		const audit = createAuditMock();
		const service = new PlanService(
			prisma as unknown as PrismaService,
			audit,
		);

		await service.adjust(
			OPERATOR_ACTOR,
			"plan-1",
			{
				newTargetAmount: "12000",
				expectedUpdatedAt: "2026-10-01T00:00:00.000Z",
			},
			"req-adj-1",
		);
		expect(prisma.planChangeLog.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				planId: "plan-1",
				organizationId: "org-1",
				actorUserId: "u-op",
				changeType: "TARGET_ADJUSTED",
			}),
		});
		expect(audit.recordInTx).toHaveBeenCalledWith(
			prisma,
			expect.objectContaining({
				action: "plan.adjust",
				targetType: "plan",
				targetId: "plan-1",
				result: "SUCCESS",
				requestId: "req-adj-1",
			}),
		);

		await service.cancel(OPERATOR_ACTOR, "plan-1", "req-cnc-1");
		expect(audit.recordInTx).toHaveBeenCalledWith(
			prisma,
			expect.objectContaining({
				action: "plan.cancel",
				targetType: "plan",
				targetId: "plan-1",
				result: "SUCCESS",
				requestId: "req-cnc-1",
			}),
		);
	});

	it("R2-I1 受邀成员 computeCaps / loadAdjustContext 按当前组织计入同币种其他计划占用（组织共享账本）", async () => {
		const prisma = createPrismaMock({
			accountRows: [{ balance: new Prisma.Decimal("100") }],
			allocationRow: {
				id: "alloc-1",
				planId: "plan-1",
				amount: new Prisma.Decimal("0"),
				usedAmount: new Prisma.Decimal("0"),
			},
		});
		(prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation(
			async (strings: TemplateStringsArray) => {
			const sql = strings.join("?");
			if (sql.includes("FROM memberships")) {
				return [{ organizationId: "org-1" }];
			}
			if (sql.includes("FROM plans")) {
				return [{ id: "plan-1" }];
			}
			return [];
		});
		prisma.plan.findMany.mockResolvedValue([{ id: "plan-org-other" }]);
		prisma.planAllocation.findMany.mockResolvedValue([
			{
				id: "alloc-org-other",
				planId: "plan-org-other",
				amount: new Prisma.Decimal("80"),
				usedAmount: new Prisma.Decimal("0"),
			},
		]);

		const service = new PlanService(
			prisma as unknown as PrismaService,
			createAuditMock(),
		);
		const previewRes = await service.preview(OPERATOR_ACTOR, {
			targetCurrency: "USD",
			targetAmount: "100",
			expectUseDate: EXPECT_USE_DATE,
			prepLeadDays: 3,
			pacePreference: "balanced",
			startDate: START_DATE,
		});
		expect(previewRes.caps).toEqual({
			allocatableBalance: "20.0000",
			maxAllocatable: "20.0000",
		});
		// W30（MIG-D/F）：读取恒为纯组织作用域——无 legacy 回落分支、无 userId 旁路
		expect(prisma.plan.findMany).toHaveBeenCalledWith({
			where: {
				targetCurrency: "USD",
				organizationId: "org-1",
			},
			select: { id: true },
		});
		expect(prisma.account.findMany).toHaveBeenCalledWith({
			where: { currencyCode: "USD", organizationId: "org-1" },
			select: { balance: true },
		});

		await expect(
			service.previewAdjust(OPERATOR_ACTOR, "plan-1", {
				newAllocAmount: "2000",
			}),
		).rejects.toThrow("分配总额超出上限 20.0000");

		const adjustPreviewRes = await service.previewAdjust(
			OPERATOR_ACTOR,
			"plan-1",
			{ newAllocAmount: "20" },
		);
		expect(adjustPreviewRes.caps?.unallocatedBalance).toBe("20.0000");
		expect(adjustPreviewRes.caps?.limit).toBe("20.0000");
	});
});
