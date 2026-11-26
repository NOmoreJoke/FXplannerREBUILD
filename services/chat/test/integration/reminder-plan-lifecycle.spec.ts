import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	cleanupUser,
	createTestApp,
	orgBearer,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";
import {
	createOnboardedUser,
	getReminders,
	REMINDER_TODAY_ISO,
	REMINDER_WORKDAY,
} from "../helpers/reminder-test-helper";
import {
	cleanupOrgLedgers,
	createOrgLedger,
	orgHeaders,
	type OrgLedger,
} from "../helpers/organization-ledger-test-helper";
import { ensureAccount } from "../helpers/plan-test-helper";
import { utcPlus8Midnight } from "../../src/reminder/reminder-rules";

// 关闭全局接口限流（先例：transaction.spec/plan.spec——APP_GUARD token 被 scanner 改写，只能 mock 类）
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
 * 组织标签随机后缀：本文件冻结了 Date（`vi.useFakeTimers`），createTestUser 的
 * 邮箱后缀取 Date.now() 会恒定不变——同一工作日内重复运行会撞邮箱唯一约束 409。
 * 与 reminder-test-helper 的 `Math.random()` 后缀同款做法。
 */
const ORG_LABEL = `lc-org-${Math.random().toString(36).slice(2, 8)}`;

/**
 * 提醒 × 计划生命周期集成测试（reminders 技术方案 §10.3）：真库 + 真实接口链路。
 *
 * 跨模块联动断言（M7 使用录入 / M8 更正未建，按方案用直改 allocation 模拟）：
 * 1. 建计划→取消→GET：该计划提醒不再返回，行未删；
 * 2. 使用达标（直改模拟）→GET→确认完成→GET：COMPLETE_READY 出现一次；完成后行消失；
 * 3. 完成后重开（提高目标）+ 直改模拟更正回退使用：按规则恢复/隐藏，无补发；
 * 4. 调整分配使缺口 0→再调回缺口>0，同一节点日：无新行，matters 随状态更新。
 *
 * 时钟冻结与唯一邮箱策略同 reminder-test-helper 注释。
 */
describe("提醒 × 计划生命周期（集成）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	const users: TestUser[] = [];
	const orgs: OrgLedger[] = [];

	async function setupUser(label: string): Promise<TestUser> {
		const user = await createOnboardedUser(app, label);
		users.push(user);
		await ensureAccount(ctx.prisma, user.userId, "USD", "10000");
		return user;
	}

	/** 直插计划行（绕过创建接口的排期重建，自由控制 latestPrepDate/排期） */
	async function seedPlan(
		user: TestUser,
		options: {
			targetAmount?: string;
			allocAmount?: string;
			usedAmount?: string;
			/** 组织化写路径（W23 起计划带 organizationId） */
			organizationId?: string;
		} = {},
	): Promise<string> {
		const expectUseDate = new Date(
			REMINDER_WORKDAY.getTime() + 30 * 86_400_000,
		);
		const plan = await ctx.prisma.plan.create({
			data: {
				// W30（MIG-E）：计划直连组织（organization_id NOT NULL），无 user_id 列
				organizationId: options.organizationId ?? user.defaultOrganizationId,
				createdById: user.userId,
				name: null,
				targetCurrency: "USD",
				targetAmount: options.targetAmount ?? "10000",
				expectUseDate,
				latestPrepDate: REMINDER_WORKDAY,
				planStartDate: REMINDER_WORKDAY,
			},
		});
		await ctx.prisma.planAllocation.create({
			data: {
				planId: plan.id,
				amount: options.allocAmount ?? "0",
				usedAmount: options.usedAmount ?? "0",
			},
		});
		// 今天为节点日（R1 造数：首批命中业务今天）
		await ctx.prisma.planInstallment.create({
			data: {
				planId: plan.id,
				seq: 1,
				scheduledAt: REMINDER_WORKDAY,
				amount: options.targetAmount ?? "10000",
			},
		});
		return plan.id;
	}

	async function setAllocation(
		planId: string,
		data: { amount?: string; usedAmount?: string },
	): Promise<void> {
		await ctx.prisma.planAllocation.update({ where: { planId }, data });
	}

	beforeAll(async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: REMINDER_WORKDAY.getTime() });
		ctx = await createTestApp();
		app = ctx.app;
	});

	afterAll(async () => {
		vi.useRealTimers();
		// 组织用例的派生行与组织本身先清（不漏孤儿组织），再清个人用户
		for (const org of orgs) {
			await cleanupOrgLedgers(ctx.prisma, org);
		}
		for (const user of users) {
			await cleanupUser(ctx.prisma, user.userId);
		}
		await app.close();
	});

	it("流程 1：建计划→取消→该计划提醒不再返回；行未删", async () => {
		const user = await setupUser("lc-cancel");
		const planId = await seedPlan(user);

		const before = await getReminders(app, user).expect(200);
		expect(before.body.data.items).toHaveLength(1);
		expect(before.body.data.items[0].planId).toBe(planId);

		await request(app.getHttpServer())
			.post(`/api/plans/${planId}/cancel`)
			.set(orgBearer(user))
			.expect(200);

		const after = await getReminders(app, user).expect(200);
		expect(after.body.data.items).toHaveLength(0);
		const rows = await ctx.prisma.reminder.findMany({
			where: { organizationId: user.defaultOrganizationId },
		});
		expect(rows).toHaveLength(1); // 行保留不删，重开后按规则自然恢复
	});

	it("流程 2：使用达标→COMPLETE_READY 出现一次；确认完成后行消失", async () => {
		const user = await setupUser("lc-complete");
		const planId = await seedPlan(user, {
			allocAmount: "10000",
			usedAmount: "10000", // 直改模拟 M7 使用达标（M7 未建）
		});

		const first = await getReminders(app, user).expect(200);
		expect(first.body.data.items).toHaveLength(1);
		expect(first.body.data.items[0].recordedType).toBe("COMPLETE_READY");
		expect(first.body.data.items[0].matters[0].kind).toBe("COMPLETE_READY");
		expect(first.body.data.items[0].matters[0].isFundsReady).toBe(true);

		// 持续满足期间不逐日重发：再次 GET 不新增（唯一键 + 已有行防重）
		const second = await getReminders(app, user).expect(200);
		expect(second.body.data.items).toHaveLength(1);
		expect(second.body.data.items[0].id).toBe(first.body.data.items[0].id);

		await request(app.getHttpServer())
			.post(`/api/plans/${planId}/complete`)
			.set(orgBearer(user))
			.expect(200);

		const after = await getReminders(app, user).expect(200);
		expect(after.body.data.items).toHaveLength(0); // 非 ACTIVE 过滤
	});

	it("流程 3：完成后重开（提高目标）+ 更正回退使用 → 按规则恢复，无补发", async () => {
		const user = await setupUser("lc-reopen");
		const planId = await seedPlan(user, {
			allocAmount: "10000",
			usedAmount: "10000",
		});

		// 生成 COMPLETE_READY → 确认完成
		await getReminders(app, user).expect(200);
		await request(app.getHttpServer())
			.post(`/api/plans/${planId}/complete`)
			.set(orgBearer(user))
			.expect(200);

		// 重开：提高目标（严格完成态 + confirmReopen + startDate=今天使重建排期首批命中今天）
		await request(app.getHttpServer())
			.patch(`/api/plans/${planId}`)
			.set(orgBearer(user))
			.send({
				newTargetAmount: "12000",
				confirmReopen: true,
				startDate: REMINDER_TODAY_ISO,
				expectedUpdatedAt: (
					await ctx.prisma.plan.findUniqueOrThrow({ where: { id: planId } })
				).updatedAt.toISOString(),
			})
			.expect(200);

		// 重开后（ACTIVE，used=10000，target=12000，gap=2000）：同计划同日已有 COMPLETE_READY 行 →
		// 不新写行，同一行 matters 读时变为 PREP_DUE（内容随最新状态更新，§4.5）
		const firstRow = (await getReminders(app, user).expect(200)).body.data
			.items[0];
		const reopened = await getReminders(app, user).expect(200);
		expect(reopened.body.data.items).toHaveLength(1);
		expect(reopened.body.data.items[0].id).toBe(firstRow.id); // 无新行
		expect(reopened.body.data.items[0].recordedType).toBe("COMPLETE_READY"); // 首写类型不变（诊断用途）
		expect(
			reopened.body.data.items[0].matters.map((m: { kind: string }) => m.kind),
		).toEqual(["PREP_DUE"]);

		// 模拟 M8 更正误录：使用回退 0（直改；M8 更正流程未建）
		await setAllocation(planId, { usedAmount: "0" });

		const corrected = await getReminders(app, user).expect(200);
		// 内容随最新状态更新：缺口变为 2000（= 12000 − 0 已使用 − 10000 剩余分配，读时派生），
		// COMPLETE_READY 事项随重开（used ≠ target）消失
		expect(corrected.body.data.items).toHaveLength(1);
		expect(
			corrected.body.data.items[0].matters.map((m: { kind: string }) => m.kind),
		).toEqual(["PREP_DUE"]);
		expect(corrected.body.data.items[0].matters[0].gapAmount).toBe("2000.0000");
		const rows = await ctx.prisma.reminder.findMany({
			where: { organizationId: user.defaultOrganizationId },
		});
		expect(rows).toHaveLength(1); // 同日合并：始终仅一行，无任何补发
	});

	it("流程 4：分配往返（缺口 0 → 再调回 >0）同一节点日 → 无新行，matters 随状态更新", async () => {
		const user = await setupUser("lc-alloc");
		// 走创建接口：startDate=今天 → 首批=今天；分配 0 → 缺口 10000
		const created = await request(app.getHttpServer())
			.post("/api/plans")
			.set(orgBearer(user))
			.send({
				targetCurrency: "USD",
				targetAmount: "10000",
				expectUseDate: new Date(
					REMINDER_WORKDAY.getTime() + 30 * 86_400_000,
				).toISOString(),
				prepLeadDays: 3,
				pacePreference: "balanced",
				startDate: REMINDER_TODAY_ISO,
				allocatedAmount: "0",
			})
			.expect(201);
		const planId = created.body.data.id;

		const initial = await getReminders(app, user).expect(200);
		expect(initial.body.data.items).toHaveLength(1);
		const rowId = initial.body.data.items[0].id;
		expect(initial.body.data.items[0].matters[0].gapAmount).toBe("10000.0000");

		// 调高分配覆盖缺口 → gap=0 → 排期清空 + PREP_DUE matters 为空 → 行隐藏
		await request(app.getHttpServer())
			.patch(`/api/plans/${planId}`)
			.set(orgBearer(user))
			.send({
				newAllocAmount: "10000",
				expectedUpdatedAt: (
					await ctx.prisma.plan.findUniqueOrThrow({ where: { id: planId } })
				).updatedAt.toISOString(),
			})
			.expect(200);
		const funded = await getReminders(app, user).expect(200);
		expect(funded.body.data.items).toHaveLength(0);

		// 调回分配 5000 → gap=5000 → 排期重建（earliest=planStartDate=今天）→ 行恢复且为同一行
		await request(app.getHttpServer())
			.patch(`/api/plans/${planId}`)
			.set(orgBearer(user))
			.send({
				newAllocAmount: "5000",
				expectedUpdatedAt: (
					await ctx.prisma.plan.findUniqueOrThrow({ where: { id: planId } })
				).updatedAt.toISOString(),
			})
			.expect(200);
		const refilled = await getReminders(app, user).expect(200);
		expect(refilled.body.data.items).toHaveLength(1);
		expect(refilled.body.data.items[0].id).toBe(rowId); // 无新行
		expect(refilled.body.data.items[0].matters[0].kind).toBe("PREP_DUE");
		expect(refilled.body.data.items[0].matters[0].gapAmount).toBe("5000.0000");

		const rows = await ctx.prisma.reminder.findMany({
			where: { organizationId: user.defaultOrganizationId },
		});
		expect(rows).toHaveLength(1); // 同一节点日始终仅一行
		// scheduledFor 恒为业务今天 0 点（UTC+8 口径）
		expect(rows[0].scheduledFor.getTime()).toBe(
			utcPlus8Midnight(REMINDER_WORKDAY).getTime(),
		);
	});

	/**
	 * 流程 5（Goal #3B W25；LEDGER-03 成员级已读）：同一组织内成员的已读态互不影响。
	 * W30（MIG-F）：共享的 `Reminder.readAt` 列已删除——已读态**只**落成员级
	 * `ReminderRead(reminderId, userId)`，共享行不再承载任何读态。
	 */
	it("W25 流程 5：成员级已读——成员 A 标已读不影响成员 B 与行主的未读态；已读态只落成员级 ReminderRead", async () => {
		const org = await createOrgLedger(app, ctx.prisma, ORG_LABEL, [
			"VIEWER",
			"FINANCE",
		]);
		orgs.push(org);
		const planId = await seedPlan(org.owner, {
			organizationId: org.orgId,
		});

		// 行主读取 → 懒生成组织内提醒行（行归属当前组织）
		const ownerList = await request(app.getHttpServer())
			.get("/api/reminders")
			.set(orgHeaders(org.owner, org.orgId))
			.expect(200);
		expect(ownerList.body.data.items).toHaveLength(1);
		const reminderId = ownerList.body.data.items[0].id;
		expect(ownerList.body.data.items[0].planId).toBe(planId);

		// 成员 A 标已读 → 200
		await request(app.getHttpServer())
			.post(`/api/reminders/${reminderId}/read`)
			.set(orgHeaders(org.members[0], org.orgId))
			.expect(200);

		// 成员 B 仍未读
		const bList = await request(app.getHttpServer())
			.get("/api/reminders")
			.set(orgHeaders(org.members[1], org.orgId))
			.expect(200);
		expect(bList.body.data.items[0].readAt).toBeNull();
		expect(bList.body.data.unreadCount).toBe(1);

		// 行主仍未读（行主读不替他人清除，反之亦然）
		const ownerAfter = await request(app.getHttpServer())
			.get("/api/reminders")
			.set(orgHeaders(org.owner, org.orgId))
			.expect(200);
		expect(ownerAfter.body.data.items[0].readAt).toBeNull();

		// 数据库：只有成员 A 的成员级已读行（共享提醒行不再承载读态——MIG-F 已删 read_at 列）
		const reads = await ctx.prisma.reminderRead.findMany({
			where: { reminderId },
			select: { userId: true },
		});
		expect(reads.map((read) => read.userId)).toEqual([org.members[0].userId]);
		const row = await ctx.prisma.reminder.findUniqueOrThrow({
			where: { id: reminderId },
		});
		expect(row.organizationId).toBe(org.orgId); // 新行归属当前组织
	});
});
