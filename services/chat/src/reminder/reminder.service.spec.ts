import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { ReminderService } from "./reminder.service";

/**
 * 提醒服务单元测试（W30（MIG-F））：
 * - 已读态只走**成员级** ReminderRead(reminderId, userId)：一名成员标已读
 *   不清除同组织其他成员的未读态；
 * - 查询恒为纯组织作用域（organizationId），不再有 organizationId IS NULL 分支；
 * - 落库不再写 Reminder.userId / Reminder.readAt（两列已删除）。
 *
 * 读侧口径（「未读全量 + 已读近 30 天」）与读时派生 matters 由纯函数层
 * reminder-rules 覆盖，本文件只钉住**服务层的组织作用域与成员级已读态**。
 */

/** 固定参照业务日（UTC+8 00:00 对应的 UTC 时刻） */
const REFERENCE_DAY = new Date("2026-09-16T16:00:00.000Z");
const READ_AT = new Date("2026-09-16T18:00:00.000Z");

const SCOPE = { userId: "u-member", organizationId: "org-1" };

function createPrismaMock() {
	const organizationSettings = {
		findUnique: vi.fn().mockResolvedValue({
			baseCurrency: "CNY",
			prepPreference: "balanced",
			reminderEnabled: false,
			ledgerStartedAt: REFERENCE_DAY,
		}),
	};
	const reminder = {
		findMany: vi.fn().mockResolvedValue([]),
		findFirst: vi.fn().mockResolvedValue(null),
		createMany: vi.fn().mockResolvedValue({ count: 0 }),
	};
	const reminderRead = {
		findMany: vi.fn().mockResolvedValue([]),
		findUnique: vi.fn().mockResolvedValue(null),
		upsert: vi.fn(),
		createMany: vi.fn().mockResolvedValue({ count: 0 }),
	};
	const plan = { findMany: vi.fn().mockResolvedValue([]) };
	const planAllocation = { findMany: vi.fn().mockResolvedValue([]) };
	const planInstallment = { findMany: vi.fn().mockResolvedValue([]) };
	const prisma = {
		organizationSettings,
		reminder,
		reminderRead,
		plan,
		planAllocation,
		planInstallment,
		$transaction: vi.fn(async (cb: (tx: typeof prisma) => unknown) => cb(prisma)),
	};
	return prisma;
}

/** 命中 R1（当日排期节点 + 缺口 > 0）与 R3（当日为预计使用日）的 ACTIVE 计划 */
function activePlan() {
	return {
		id: "plan-1",
		name: "换汇计划",
		status: "ACTIVE",
		targetCurrency: "USD",
		targetAmount: new Prisma.Decimal("1000"),
		latestPrepDate: new Date(REFERENCE_DAY.getTime() - 5 * 86400_000),
		expectUseDate: REFERENCE_DAY,
	};
}

describe("ReminderService", () => {
	let prisma: ReturnType<typeof createPrismaMock>;
	let service: ReminderService;

	beforeEach(() => {
		// 固定时钟到参照业务日：读侧「已读近 30 天」窗口与懒生成的「今天」都以此时刻为锚
		vi.useFakeTimers({ now: REFERENCE_DAY });
		prisma = createPrismaMock();
		service = new ReminderService(prisma as unknown as PrismaService);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("list（纯组织作用域 + 成员级已读态）", () => {
		it("未建账（无 OrganizationSettings）→ 409 ONBOARDING_NOT_COMPLETED", async () => {
			prisma.organizationSettings.findUnique.mockResolvedValue(null);

			await expect(service.list(SCOPE)).rejects.toThrow();
			expect(prisma.reminder.findMany).not.toHaveBeenCalled();
		});

		it("已读态按当前成员的 ReminderRead 派生：他人已读不影响本成员未读态", async () => {
			prisma.reminder.findMany.mockResolvedValue([
				{
					id: "rem-read",
					planId: "plan-1",
					type: "PREP_DUE",
					scheduledFor: REFERENCE_DAY,
				},
				{
					id: "rem-unread",
					planId: "plan-1",
					type: "PREP_DUE",
					scheduledFor: REFERENCE_DAY,
				},
			]);
			prisma.reminderRead.findMany.mockResolvedValue([
				{ reminderId: "rem-read", readAt: READ_AT },
			]);
			prisma.plan.findMany.mockResolvedValue([activePlan()]);
			prisma.planAllocation.findMany.mockResolvedValue([
				{
					planId: "plan-1",
					amount: new Prisma.Decimal("0"),
					usedAmount: new Prisma.Decimal("0"),
				},
			]);
			prisma.planInstallment.findMany.mockResolvedValue([
				{ planId: "plan-1", seq: 1, scheduledAt: REFERENCE_DAY, amount: new Prisma.Decimal("500") },
			]);

			const view = await service.list(SCOPE);

			expect(view.items).toHaveLength(2);
			const byId = new Map(view.items.map((item) => [item.id, item]));
			expect(byId.get("rem-read")?.readAt).toBe(READ_AT.toISOString());
			expect(byId.get("rem-unread")?.readAt).toBeNull();
			expect(view.unreadCount).toBe(1);
		});

		it("查询恒为纯组织作用域：无 organizationId IS NULL 分支、不再读共享 readAt 列", async () => {
			prisma.reminder.findMany.mockResolvedValue([]);

			await service.list(SCOPE);

			const [arg] = prisma.reminder.findMany.mock.calls[0];
			const serialized = JSON.stringify(arg.where);
			expect(serialized).toContain(`"organizationId":"${SCOPE.organizationId}"`);
			expect(serialized).not.toContain("null");
			expect(serialized).not.toContain("readAt");
			// 候选集按成员级已读态过滤：本人从未读过即入选
			expect(serialized).toContain(`"userId":"${SCOPE.userId}"`);
		});
	});

	describe("markRead / markAllRead（只写成员级 ReminderRead）", () => {
		it("标已读：按组织作用域校验归属，只 upsert 当前成员的 ReminderRead", async () => {
			prisma.reminder.findFirst.mockResolvedValue({ id: "rem-1" });
			prisma.reminderRead.upsert.mockResolvedValue({ readAt: READ_AT });

			const result = await service.markRead(SCOPE, "rem-1");

			expect(result).toEqual({ id: "rem-1", readAt: READ_AT.toISOString() });
			expect(prisma.reminder.findFirst).toHaveBeenCalledWith({
				where: { id: "rem-1", organizationId: SCOPE.organizationId },
				select: { id: true },
			});
			expect(prisma.reminderRead.upsert).toHaveBeenCalledWith({
				where: {
					reminderId_userId: { reminderId: "rem-1", userId: SCOPE.userId },
				},
				update: { readAt: REFERENCE_DAY },
				create: { reminderId: "rem-1", userId: SCOPE.userId, readAt: REFERENCE_DAY },
				select: { readAt: true },
			});
		});

		it("跨组织 / 不存在的提醒 → 404 REMINDER_NOT_FOUND", async () => {
			prisma.reminder.findFirst.mockResolvedValue(null);

			await expect(service.markRead(SCOPE, "rem-other")).rejects.toThrow(
				/提醒不存在/,
			);
			expect(prisma.reminderRead.upsert).not.toHaveBeenCalled();
		});

		it("全部已读：只为本成员尚未读过的行插入成员级已读，幂等（重复调用 inserted = 0）", async () => {
			prisma.reminder.findMany.mockResolvedValue([
				{ id: "rem-1" },
				{ id: "rem-2" },
			]);
			prisma.reminderRead.findMany.mockResolvedValue([
				{ reminderId: "rem-1" },
			]);
			prisma.reminderRead.createMany.mockResolvedValue({ count: 1 });

			const result = await service.markAllRead(SCOPE);

			expect(result.updatedCount).toBe(1);
			expect(prisma.reminderRead.createMany).toHaveBeenCalledWith({
				data: [{ reminderId: "rem-2", userId: SCOPE.userId, readAt: expect.any(Date) }],
				skipDuplicates: true,
			});
			// 只读 id：不再取行内 userId / readAt（两列已删除）
			const [arg] = prisma.reminder.findMany.mock.calls[0];
			expect(arg.select).toEqual({ id: true });
			expect(arg.where).toEqual({ organizationId: SCOPE.organizationId });
		});
	});

	describe("懒生成（组织维度落库）", () => {
		it("生成的提醒行只写 organizationId：不写 userId、不产生 NULL 组织行", async () => {
			prisma.organizationSettings.findUnique.mockResolvedValue({
				baseCurrency: "CNY",
				prepPreference: "balanced",
				reminderEnabled: true,
				ledgerStartedAt: REFERENCE_DAY,
			});
			prisma.plan.findMany.mockResolvedValue([activePlan()]);
			prisma.planAllocation.findMany.mockResolvedValue([
				{
					planId: "plan-1",
					amount: new Prisma.Decimal("0"),
					usedAmount: new Prisma.Decimal("0"),
				},
			]);
			prisma.planInstallment.findMany.mockResolvedValue([
				{ planId: "plan-1", seq: 1, scheduledAt: REFERENCE_DAY, amount: new Prisma.Decimal("500") },
			]);
			prisma.reminder.findMany.mockResolvedValue([]);

			await service.list(SCOPE);

			expect(prisma.reminder.createMany).toHaveBeenCalledTimes(1);
			const [arg] = prisma.reminder.createMany.mock.calls[0];
			expect(arg.skipDuplicates).toBe(true);
			for (const row of arg.data) {
				expect(row.organizationId).toBe(SCOPE.organizationId);
				expect("userId" in row).toBe(false);
			}
		});
	});
});
