/**
 * 计划域测试数据工具（test/helpers，禁止 spec 间复制——AGENTS.md 测试约定）。
 *
 * - 造数：账户 / 计划+分配（直插 DB，不依赖接口）；接口造数走 createPlanViaApi
 * - M7 模拟：setAllocationUsedAmount 直改 planAllocation.usedAmount
 *   （M7 未实现，后续用它锁定已使用口径；只动 allocation 行，不碰 plan.updatedAt，
 *   满足「预览过期」链路对乐观锁的隔离前提）
 * - 清理：plan_allocations 无外键无级联（migration 20260908035726 实证），
 *   cleanupUser 删除用户后 allocation 孤儿行残留——cleanupPlanData(prisma, planIds)
 *   按 planId 批量显式清理；plan_change_logs / plan_installments 由 FK 级联，无需处理
 *
 * 日期锚定：默认参数全部显式传 startDate / 远期 expectUseDate，断言不依赖真实时钟；
 * 固定日期星期几（用于选工作日）：
 * - 2030-01-01 = 周二（工作日）
 * - 2030-02-15 = 周五，往前数 3 个工作日 = 2030-02-12（周二）
 * - 2030-03-01 = 周五、2030-03-02 = 周六（NO_AVAILABLE_DATES 构造用）
 */
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { bearer, type TestUser } from "./test-app";
import type { PrismaService } from "../../src/prisma/prisma.service";

/** 远期用途日（不依赖真实时钟） */
export const PLAN_EXPECT_USE_DATE = "2030-02-15T00:00:00.000Z";
/** 显式开始准备日（工作日）——锁定排期首日 */
export const PLAN_START_DATE = "2030-01-01T00:00:00.000Z";

/** 确保某币种账户存在并写入余额（compat upsert） */
export async function ensureAccount(
	prisma: PrismaService,
	userId: string,
	currencyCode: string,
	balance: string,
): Promise<void> {
	const existing = await prisma.account.findFirst({
		where: { userId, currencyCode },
		select: { id: true },
	});
	if (existing) {
		await prisma.account.update({
			where: { id: existing.id },
			data: { balance },
		});
	} else {
		await prisma.account.create({
			data: { userId, currencyCode, balance },
		});
	}
}

export interface SeedPlanOptions {
	targetCurrency?: string;
	targetAmount?: string;
	allocatedAmount?: string;
	usedAmount?: string;
	name?: string;
}

/** 直插「计划 + 分配行」（不建排期；测试计划不参与排期断言） */
export async function seedPlanWithAllocation(
	prisma: PrismaService,
	userId: string,
	options: SeedPlanOptions = {},
): Promise<string> {
	const expectUseDate = new Date(PLAN_EXPECT_USE_DATE);
	const plan = await prisma.plan.create({
		data: {
			userId,
			name: options.name ?? null,
			targetCurrency: options.targetCurrency ?? "USD",
			targetAmount: options.targetAmount ?? "10000",
			expectUseDate,
			latestPrepDate: expectUseDate,
		},
	});
	await prisma.planAllocation.create({
		data: {
			planId: plan.id,
			amount: options.allocatedAmount ?? "0",
			usedAmount: options.usedAmount ?? "0",
		},
	});
	return plan.id;
}

/** 直改已使用金额（模拟 M7 写入） */
export async function setAllocationUsedAmount(
	prisma: PrismaService,
	planId: string,
	usedAmount: string,
): Promise<void> {
	await prisma.planAllocation.update({
		where: { planId },
		data: { usedAmount },
	});
}

/** 批量清理 allocation 孤儿行（无外键无级联，必须显式调用；afterAll 中执行） */
export async function cleanupPlanData(
	prisma: PrismaService,
	planIds: string[],
): Promise<void> {
	if (planIds.length === 0) return;
	await prisma.planAllocation.deleteMany({
		where: { planId: { in: planIds } },
	});
}

/** 接口造数：POST /api/plans（默认参数显式 startDate，日期断言不依赖时钟） */
export async function createPlanViaApi(
	app: INestApplication,
	user: TestUser,
	overrides: Record<string, unknown> = {},
): Promise<request.Response> {
	return request(app.getHttpServer())
		.post("/api/plans")
		.set(bearer(user.accessToken))
		.send({
			targetCurrency: "USD",
			targetAmount: "10000",
			expectUseDate: PLAN_EXPECT_USE_DATE,
			prepLeadDays: 3,
			pacePreference: "balanced",
			startDate: PLAN_START_DATE,
			...overrides,
		});
}
