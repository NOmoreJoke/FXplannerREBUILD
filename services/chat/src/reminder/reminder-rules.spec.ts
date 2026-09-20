import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
	addUtc8Days,
	computeDueDrafts,
	computeMattersAt,
	utcPlus8Midnight,
	type ReminderPlanSnapshot,
	type ReminderRowSnapshot,
} from "./reminder-rules";

/**
 * 提醒规则纯函数单测（reminders 技术方案 §10.1，锁定 §4.3 判定表与 §4.5 派生规则）。
 *
 * 纯函数直接断言、无 mock、无 DB；「今天」显式注入，不依赖真实时钟。
 * 基准日：2026-09-17 = 周四（UTC+8 业务日口径下的工作日）。
 */

/** 基准「今天」：2026-09-17T02:00:00Z（北京 10:00，业务日 = 2026-09-17 周四） */
const TODAY = new Date("2026-09-17T02:00:00.000Z");
const TODAY_UTC8 = utcPlus8Midnight(TODAY);
expect(TODAY_UTC8.toISOString()).toBe("2026-09-16T16:00:00.000Z"); // 北京 9/17 00:00 == UTC 9/16 16:00

const DAY_MS = 86_400_000;

/** 构造计划快照（缺省：目标 10000、分配 0、已使用 0、远期使用日/最晚准备日、无排期） */
function makePlan(
	overrides: Partial<ReminderPlanSnapshot> = {},
): ReminderPlanSnapshot {
	return {
		planId: "plan-1",
		name: "美元计划",
		status: "ACTIVE",
		targetCurrency: "USD",
		targetAmount: new Prisma.Decimal("10000"),
		// 缺省最晚准备日 = 今天前 2 天（周二）；使用日 = 今天后 30 天——均不与「今天」撞日
		latestPrepDate: new Date(TODAY_UTC8.getTime() - 2 * DAY_MS),
		expectUseDate: new Date(TODAY_UTC8.getTime() + 30 * DAY_MS),
		installments: [],
		allocAmount: new Prisma.Decimal(0),
		usedAmount: new Prisma.Decimal(0),
		...overrides,
	};
}

/** 今天为排期节点日（金额 3000）的计划 */
function planWithInstallmentToday(
	overrides: Partial<ReminderPlanSnapshot> = {},
): ReminderPlanSnapshot {
	return makePlan({
		installments: [
			{ seq: 1, scheduledAt: TODAY_UTC8, amount: new Prisma.Decimal("3000") },
		],
		...overrides,
	});
}

function draftTypes(drafts: ReturnType<typeof computeDueDrafts>): string[] {
	return drafts.map((draft) => draft.type);
}

describe("reminder-rules 生成判定（computeDueDrafts，§4.3 判定表）", () => {
	it("#1 今天为节点日且缺口>0 → 生成 PREP_DUE（scheduledFor = 业务今天 0 点）", () => {
		const drafts = computeDueDrafts({
			plans: [planWithInstallmentToday()],
			today: TODAY,
			existingRows: [],
		});
		expect(drafts).toHaveLength(1);
		expect(drafts[0].type).toBe("PREP_DUE");
		expect(drafts[0].planId).toBe("plan-1");
		expect(drafts[0].dedupKey).toBe("PLAN:plan-1");
		expect(drafts[0].scheduledFor.toISOString()).toBe(
			"2026-09-16T16:00:00.000Z",
		);
	});

	it("#2 今天为节点日但缺口=0（已备齐）→ 不生成（08:11 备齐停止）", () => {
		const drafts = computeDueDrafts({
			plans: [
				planWithInstallmentToday({
					allocAmount: new Prisma.Decimal("10000"),
				}),
			],
			today: TODAY,
			existingRows: [],
		});
		expect(drafts).toHaveLength(0);
	});

	it("#3 今天 == latestPrepDate 次日且缺口>0 → 生成 PREP_OVERDUE（scheduledFor=今天）", () => {
		const drafts = computeDueDrafts({
			plans: [makePlan({ latestPrepDate: addUtc8Days(TODAY_UTC8, -1) })],
			today: TODAY,
			existingRows: [],
		});
		expect(drafts).toHaveLength(1);
		expect(drafts[0].type).toBe("PREP_OVERDUE");
		expect(drafts[0].scheduledFor.toISOString()).toBe(
			"2026-09-16T16:00:00.000Z",
		);
	});

	it("#4 逾期第 3 天（非首日）且缺口>0 → 不再生成（不每天重发）", () => {
		const drafts = computeDueDrafts({
			plans: [makePlan({ latestPrepDate: addUtc8Days(TODAY_UTC8, -3) })],
			today: TODAY,
			existingRows: [],
		});
		expect(drafts).toHaveLength(0);
	});

	it("#5 缺口=0 后查看原逾期行 → matters 为空（行隐藏；GWT 开关与状态联动 #4）", () => {
		const plan = makePlan({
			latestPrepDate: addUtc8Days(TODAY_UTC8, -1),
			allocAmount: new Prisma.Decimal("10000"),
		});
		// 原逾期行（scheduledFor = 逾期首日 = 今天前 0 天场景改为任一历史日）
		const row: ReminderRowSnapshot = {
			planId: "plan-1",
			type: "PREP_OVERDUE",
			scheduledFor: TODAY_UTC8,
		};
		const matters = computeMattersAt(plan, utcPlus8Midnight(row.scheduledFor));
		expect(matters).toHaveLength(0);
	});

	it("#6 今天 == expectUseDate 且已备齐 → 生成 USE_DUE（备齐也提醒，08:15）", () => {
		const drafts = computeDueDrafts({
			plans: [
				makePlan({
					expectUseDate: TODAY_UTC8,
					allocAmount: new Prisma.Decimal("10000"),
				}),
			],
			today: TODAY,
			existingRows: [],
		});
		expect(draftTypes(drafts)).toEqual(["USE_DUE"]);
	});

	it("#7 今天 == expectUseDate 且同为节点日且缺口>0 → 同日合并：draft 同键同日，matters 并列两项", () => {
		const plan = planWithInstallmentToday({ expectUseDate: TODAY_UTC8 });
		const drafts = computeDueDrafts({
			plans: [plan],
			today: TODAY,
			existingRows: [],
		});
		// 同计划同日仅一行由唯一键 [userId, dedupKey, scheduledFor] + skipDuplicates 承载：
		// 两个 draft 的 dedupKey/scheduledFor 完全一致，落库后必合并为一行
		expect(drafts).toHaveLength(2);
		expect(new Set(draftTypes(drafts))).toEqual(
			new Set(["PREP_DUE", "USE_DUE"]),
		);
		expect(new Set(drafts.map((draft) => draft.dedupKey)).size).toBe(1);
		expect(
			new Set(drafts.map((draft) => draft.scheduledFor.getTime())).size,
		).toBe(1);
		// 读时派生：同一行并列展示两事项
		const matters = computeMattersAt(plan, TODAY_UTC8);
		expect(matters.map((matter) => matter.kind)).toEqual([
			"PREP_DUE",
			"USE_DUE",
		]);
		expect(matters[0].installmentAmount?.toFixed(4)).toBe("3000.0000");
	});

	it("#8 used==target 且剩余分配==0 → 首次生成 COMPLETE_READY；已有该类型行 → 不再生成", () => {
		const plan = makePlan({
			allocAmount: new Prisma.Decimal("10000"),
			usedAmount: new Prisma.Decimal("10000"),
		});
		const first = computeDueDrafts({
			plans: [plan],
			today: TODAY,
			existingRows: [],
		});
		expect(draftTypes(first)).toEqual(["COMPLETE_READY"]);

		const existingRows: ReminderRowSnapshot[] = [
			{ planId: "plan-1", type: "COMPLETE_READY", scheduledFor: TODAY_UTC8 },
		];
		const second = computeDueDrafts({
			plans: [plan],
			today: TODAY,
			existingRows,
		});
		expect(second).toHaveLength(0);
	});

	it("#9 计划 status=COMPLETED/CANCELLED → 生成阶段跳过（08:18）", () => {
		const drafts = computeDueDrafts({
			plans: [
				planWithInstallmentToday({ status: "COMPLETED" }),
				planWithInstallmentToday({ planId: "plan-2", status: "CANCELLED" }),
			],
			today: TODAY,
			existingRows: [],
		});
		expect(drafts).toHaveLength(0);
	});

	it("#10 今天该计划已有行（重复生成）→ 幂等不新增（唯一键语义）", () => {
		const drafts = computeDueDrafts({
			plans: [planWithInstallmentToday()],
			today: TODAY,
			existingRows: [
				{ planId: "plan-1", type: "PREP_DUE", scheduledFor: TODAY_UTC8 },
			],
		});
		expect(drafts).toHaveLength(0);
	});

	it("#11 节点日行已存在且 matters 变化 → 不新发，读时 matters 更新（只更新内容）", () => {
		// 同日已有行 → 生成阶段不新发
		const drafts = computeDueDrafts({
			plans: [planWithInstallmentToday()],
			today: TODAY,
			existingRows: [
				{ planId: "plan-1", type: "PREP_DUE", scheduledFor: TODAY_UTC8 },
			],
		});
		expect(drafts).toHaveLength(0);

		// 调整分配后缺口变化 → 同一行读时派生出新的缺口金额（内容常新）
		const adjusted = planWithInstallmentToday({
			allocAmount: new Prisma.Decimal("1000"),
		});
		const matters = computeMattersAt(adjusted, TODAY_UTC8);
		expect(matters).toHaveLength(1);
		expect(matters[0].kind).toBe("PREP_DUE");
		expect(matters[0].installmentAmount?.toFixed(4)).toBe("3000.0000");
		// gap = max(0, 10000 − 0 − 1000) = 9000（由 service 附加到 DTO，此处口径复核）
	});

	it("#12 UTC+8 截日：UTC 16:00（北京次日 0 点）→ 业务日进位正确", () => {
		expect(utcPlus8Midnight(new Date("2026-09-17T16:00:00.000Z"))).toEqual(
			new Date("2026-09-17T16:00:00.000Z"),
		); // 北京 9/18 00:00 == UTC 9/17 16:00
		expect(utcPlus8Midnight(new Date("2026-09-17T15:59:59.999Z"))).toEqual(
			new Date("2026-09-16T16:00:00.000Z"),
		); // 北京 9/17 23:59 → 业务日仍为 9/17
		// R1 按业务日判定：UTC 9/17 16:00 时「今天」= 北京 9/18 → 9/18 节点命中、9/17 节点不命中
		const lateEvening = new Date("2026-09-17T16:00:00.000Z");
		const nextDayPlan = planWithInstallmentToday({
			installments: [
				{
					seq: 1,
					scheduledAt: utcPlus8Midnight(lateEvening),
					amount: new Prisma.Decimal("3000"),
				},
			],
		});
		expect(
			draftTypes(
				computeDueDrafts({
					plans: [nextDayPlan],
					today: lateEvening,
					existingRows: [],
				}),
			),
		).toEqual(["PREP_DUE"]);
	});
});

describe("reminder-rules 派生（computeMattersAt，§4.5）", () => {
	it("同日多节点 → PREP_DUE 的 installmentAmount 为节点金额合计", () => {
		const matters = computeMattersAt(
			planWithInstallmentToday({
				installments: [
					{
						seq: 1,
						scheduledAt: TODAY_UTC8,
						amount: new Prisma.Decimal("1000"),
					},
					{
						seq: 2,
						scheduledAt: TODAY_UTC8,
						amount: new Prisma.Decimal("2000"),
					},
				],
			}),
			TODAY_UTC8,
		);
		expect(matters).toHaveLength(1);
		expect(matters[0].installmentAmount?.toFixed(4)).toBe("3000.0000");
	});

	it("排期重建后原节点日已无节点 → matters 为空（行隐藏）", () => {
		const matters = computeMattersAt(
			makePlan(), // 无排期
			TODAY_UTC8,
		);
		expect(matters).toHaveLength(0);
	});

	it("非节点日/非逾期次日/非使用日/未备齐 → 无事项", () => {
		const matters = computeMattersAt(makePlan(), TODAY_UTC8);
		expect(matters).toHaveLength(0);
	});

	it("addUtc8Days 与 utcPlus8Midnight 组合：跨日推算稳定", () => {
		expect(addUtc8Days(TODAY_UTC8, 1).toISOString()).toBe(
			"2026-09-17T16:00:00.000Z",
		); // 北京 9/18 00:00
		expect(addUtc8Days(TODAY_UTC8, -30).toISOString()).toBe(
			"2026-08-17T16:00:00.000Z",
		); // 北京 8/18 00:00
	});
});
