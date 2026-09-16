/**
 * plan-calculator 纯函数单测（plan-management 技术方案 §8.1 用例表）。
 * 覆盖：#1/1b/2/3/4/5/6/7/8/10/11/12/13（#9 与 R5/R6 归 schedule-builder.spec.ts）。
 * 口径锁定（§3.4）：剩余分配 max(0) clamp / 未分配余额同币种 / 修改总额上限加回原分配总额 /
 * 5 条拦截 / 重新开启判定（valid + reopen 标记；状态流转不在纯函数职责内）。
 *
 * 日期锚定：today 注入 2026-09-16（周三），planStartDate 2026-09-17（周四，工作日）——
 * 纯函数不碰真实时钟。
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
	PlanCalcError,
	checkCompleteReady,
	computeAdjustPreview,
	computeCaps,
	computeDerived,
	type AdjustPreviewCaps,
	type AdjustPreviewChange,
	type AdjustPreviewContext,
	type AdjustPreviewPlanState,
} from "./plan-calculator";

const TODAY = new Date("2026-09-16T00:00:00.000Z"); // 周三
const TOMORROW = new Date("2026-09-17T00:00:00.000Z"); // 周四（工作日）
const EXPECT_USE_DATE = new Date("2027-08-01T00:00:00.000Z"); // 周日，往前 3 个工作日 = 2027-07-28（周三）

function dec(value: string | number): Prisma.Decimal {
	return new Prisma.Decimal(value);
}

function activePlan(
	overrides: Partial<AdjustPreviewPlanState> = {},
): AdjustPreviewPlanState {
	return {
		status: "ACTIVE",
		targetAmount: dec("10000"),
		allocAmount: dec("6000"),
		usedAmount: dec("0"),
		pacePreference: "balanced",
		prepLeadDays: 3,
		expectUseDate: EXPECT_USE_DATE,
		planStartDate: TOMORROW,
		...overrides,
	};
}

function context(
	overrides: Partial<AdjustPreviewContext> = {},
): AdjustPreviewContext {
	return {
		accountBalance: dec("10000"),
		otherPlanAllocations: [],
		decimalPlaces: 2,
		today: TODAY,
		...overrides,
	};
}

function preview(
	plan: AdjustPreviewPlanState,
	change: AdjustPreviewChange,
	ctx: AdjustPreviewContext = context(),
) {
	return computeAdjustPreview({ plan, change, context: ctx });
}

/** 断言抛出指定 code 的 PlanCalcError 并返回 data（供 used/差额/caps 断言） */
function expectCalcError(
	fn: () => unknown,
	code: PlanCalcError["code"],
): Record<string, unknown> {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(PlanCalcError);
		const err = error as PlanCalcError;
		expect(err.code).toBe(code);
		return (err.data ?? {}) as Record<string, unknown>;
	}
	throw new Error(`预期抛出 PlanCalcError(${code})，但未抛错`);
}

function capsOf(data: unknown): AdjustPreviewCaps {
	return (data as { caps: AdjustPreviewCaps }).caps;
}

// ────────────────────────── computeCaps（#1/1b/2 + 币种口径） ──────────────────────────

describe("computeCaps（两套上限公式，§3.4）", () => {
	it("#1 创建上限（还缺 = target 口径）：target=4000、可分配 10000、无本计划 → 上限 4000（现状公式锁定）", () => {
		const caps = computeCaps({
			mode: "create",
			accountBalance: dec("10000"),
			otherPlanAllocations: [],
			ownPlan: null,
			targetAmount: dec("4000"),
		});
		expect(caps.unallocatedBalance.toFixed(4)).toBe("10000.0000");
		expect(caps.maxAllocatable.toFixed(4)).toBe("4000.0000");
	});

	it("#1b 追加/修改上限（06 原文口径）：还需 10000、原剩余 6000 → 新总额上限 10000（最多新增 4000）", () => {
		const caps = computeCaps({
			mode: "adjust",
			accountBalance: dec("10000"),
			otherPlanAllocations: [],
			ownPlan: { amount: dec("6000"), usedAmount: dec("0") },
			targetAmount: dec("10000"), // used = 0 → 还需使用 10000
		});
		expect(caps.unallocatedBalance.toFixed(4)).toBe("4000.0000");
		expect(caps.maxAllocatable.toFixed(4)).toBe("10000.0000");
		// 最多新增 = 10000 − 6000 = 4000
		expect(caps.maxAllocatable.sub(caps.ownAllocAmount).toFixed(4)).toBe(
			"4000.0000",
		);
	});

	it("#2 修改总额上限：加回原分配总额而非原剩余（used>0 沉淀不占未分配余额）", () => {
		// 沉淀构造：alloc 4000 全部已用（剩余 0），余额 4000，还需使用 6000
		const caps = computeCaps({
			mode: "adjust",
			accountBalance: dec("4000"),
			otherPlanAllocations: [],
			ownPlan: { amount: dec("4000"), usedAmount: dec("4000") },
			targetAmount: dec("10000"),
		});
		expect(caps.ownRemainingAllocation.toFixed(4)).toBe("0.0000");
		expect(caps.unallocatedBalance.toFixed(4)).toBe("4000.0000");
		// min(还需使用 6000, 未分配 4000 + 原分配总额 4000) = 6000；
		// 若错误地加回「原剩余(0)」则只能得到 4000 —— 本断言锁定正确口径
		expect(caps.maxAllocatable.toFixed(4)).toBe("6000.0000");
	});

	it("#12/#13 币种口径：caps 只汇总调用方传入的同币种快照，USD 与 JPY 相互独立", () => {
		// 合同：调用方必须按 targetCurrency 过滤（存量 computeCaps 即此行为）；
		// 纯函数对传入列表求和，两次独立调用互不共享状态
		const usd = computeCaps({
			mode: "create",
			accountBalance: dec("10000"),
			otherPlanAllocations: [
				{ amount: dec("2500.1234"), usedAmount: dec("0") },
			],
			ownPlan: null,
			targetAmount: dec("4000"),
		});
		expect(usd.unallocatedBalance.toFixed(4)).toBe("7499.8766");
		expect(usd.maxAllocatable.toFixed(4)).toBe("4000.0000"); // min(7499.8766, 4000)

		const jpy = computeCaps({
			mode: "create",
			accountBalance: dec("800"),
			otherPlanAllocations: [{ amount: dec("800"), usedAmount: dec("0") }],
			ownPlan: null,
			targetAmount: dec("100000"),
		});
		expect(jpy.unallocatedBalance.toFixed(4)).toBe("0.0000");
		expect(jpy.maxAllocatable.toFixed(4)).toBe("0.0000");
		// USD 侧结果不受 JPY 侧调用影响（无共享状态，跨币种互不挤占）
		expect(usd.unallocatedBalance.toFixed(4)).toBe("7499.8766");
	});
});

// ────────────────────────── computeDerived（#8 超用口径） ──────────────────────────

describe("computeDerived（剩余分配 / 缺口 / 还需使用）", () => {
	it("常规：target 10000、used 4000、alloc 6000 → 还需 6000 / 剩余 2000 / 缺口 4000", () => {
		const derived = computeDerived({
			targetAmount: dec("10000"),
			usedAmount: dec("4000"),
			allocatedAmount: dec("6000"),
		});
		expect(derived.stillNeeded.toFixed(4)).toBe("6000.0000");
		expect(derived.remainingAllocation.toFixed(4)).toBe("2000.0000");
		expect(derived.gap.toFixed(4)).toBe("4000.0000");
	});

	it("#8 超用口径：used > alloc 时剩余 = 0，恒等式按 clamp 口径闭合", () => {
		const derived = computeDerived({
			targetAmount: dec("10000"),
			usedAmount: dec("5000"),
			allocatedAmount: dec("4000"),
		});
		expect(derived.remainingAllocation.toFixed(4)).toBe("0.0000"); // 超用不计入剩余
		expect(derived.gap.toFixed(4)).toBe("5000.0000");

		// 恒等式：balance = Σ剩余分配 + 未分配余额（超用计划贡献 0，不产生负数）
		const balance = dec("9000");
		const caps = computeCaps({
			mode: "create",
			accountBalance: balance,
			otherPlanAllocations: [
				{ amount: dec("4000"), usedAmount: dec("5000") }, // 超用
				{ amount: dec("3000"), usedAmount: dec("3000") }, // 用满
			],
			ownPlan: null,
			targetAmount: dec("1000"),
		});
		expect(caps.unallocatedBalance.toFixed(4)).toBe("9000.0000"); // balance − 0
		expect(balance.sub(caps.unallocatedBalance).toFixed(4)).toBe("0.0000"); // Σ剩余 = 0，恒等式成立
	});
});

// ────────────────────────── computeAdjustPreview（#3~#7、#10~#13） ──────────────────────────

describe("computeAdjustPreview（§3.4 公式 + 拦截）", () => {
	it("#3 调低目标释放：目标 10000→8000、已用 4000、分配 6000 → 释放 2000（例 06）", () => {
		const result = preview(activePlan({ usedAmount: dec("4000") }), {
			newTargetAmount: dec("8000"),
		});
		expect(result.reopen).toBe(false);
		expect(result.impact.releasedAmount.toFixed(4)).toBe("2000.0000");
		// 分配自动释放至 新目标 − 已用 = 4000，剩余 0，缺口 0（钱已备齐 → 排期清空）
		expect(result.after.allocAmount.toFixed(4)).toBe("4000.0000");
		expect(result.after.remainingAllocation.toFixed(4)).toBe("0.0000");
		// 还需使用 = 8000 − 4000 = 4000，剩余 0 → 缺口 4000，排期按新缺口重建（非清空）
		expect(result.impact.newGap.toFixed(4)).toBe("4000.0000");
		expect(result.impact.newSchedule).toHaveLength(3);
		expect(result.impact.scheduleDropped).toBe(false);
	});

	it("#3 补充：释放下限 clamp 到 used（新目标 7000 时分配只降到 4000，不击穿已用沉淀）", () => {
		const result = preview(activePlan({ usedAmount: dec("4000") }), {
			newTargetAmount: dec("7000"),
		});
		expect(result.after.allocAmount.toFixed(4)).toBe("4000.0000"); // min(6000, max(3000, 4000))
		expect(result.impact.releasedAmount.toFixed(4)).toBe("2000.0000");
		expect(result.impact.newGap.toFixed(4)).toBe("3000.0000");
	});

	it("#4 目标低于已用：已用 4000 改 3000 → 拦截，附 used 与差额（例 08）", () => {
		const data = expectCalcError(
			() =>
				preview(activePlan({ usedAmount: dec("4000") }), {
					newTargetAmount: dec("3000"),
				}),
			"PLAN_TARGET_BELOW_USED",
		);
		expect((data.used as Prisma.Decimal).toFixed(4)).toBe("4000.0000");
		expect((data.shortfall as Prisma.Decimal).toFixed(4)).toBe("1000.0000");
	});

	it("#5 超上限不截断（总额口径）：上限 10000 输 11000 → 拦截，caps 三值齐备（例 09）", () => {
		const data = expectCalcError(
			() =>
				preview(activePlan(), {
					newAllocAmount: dec("11000"),
				}),
			"PLAN_ALLOCATION_LIMIT",
		);
		const caps = capsOf(data);
		// limit = min(还需使用 10000, 未分配 4000 + 原分配 6000) = 10000；超限 1000 不截断输入
		expect(caps.limit.toFixed(4)).toBe("10000.0000");
		expect(caps.unallocatedBalance.toFixed(4)).toBe("4000.0000");
		expect(caps.stillNeeded.toFixed(4)).toBe("10000.0000");
	});

	it("#6 调高目标：分配不动、缺口 +2000（例 06），排期按新缺口重建", () => {
		const result = preview(activePlan({ usedAmount: dec("4000") }), {
			newTargetAmount: dec("12000"),
		});
		expect(result.reopen).toBe(false);
		expect(result.before.gap.toFixed(4)).toBe("4000.0000");
		expect(result.impact.newGap.toFixed(4)).toBe("6000.0000"); // +2000
		expect(result.impact.releasedAmount.toFixed(4)).toBe("0.0000");
		expect(result.after.allocAmount.toFixed(4)).toBe("6000.0000"); // 分配不动
		expect(result.impact.newSchedule).not.toBeNull();
		expect(result.impact.newSchedule).toHaveLength(3);
		// 三批合计 = 新缺口；balanced 等分 2000/2000/2000
		const amounts = result.impact.newSchedule!.map((item) => item.amount);
		expect(amounts.map((amount) => amount.toFixed(4))).toEqual([
			"2000.0000",
			"2000.0000",
			"2000.0000",
		]);
	});

	it("#7 重新开启：COMPLETED 目标 10000→12000 → valid + reopen 标记 + 缺口 2000（例 14）", () => {
		const result = preview(
			activePlan({
				status: "COMPLETED",
				targetAmount: dec("10000"),
				usedAmount: dec("10000"),
				allocAmount: dec("10000"),
			}),
			{ newTargetAmount: dec("12000") },
		);
		expect(result.reopen).toBe(true);
		expect(result.impact.newGap.toFixed(4)).toBe("2000.0000"); // 12000 − 10000 − 剩余 0
		expect(result.impact.releasedAmount.toFixed(4)).toBe("0.0000");
		expect(result.after.allocAmount.toFixed(4)).toBe("10000.0000"); // 分配不动（沉淀保持）
		expect(result.impact.newSchedule).not.toBeNull(); // 缺口 > 0 → 生成新排期
		// 状态流转（回 ACTIVE / REOPENED 记录）不在纯函数职责内，由 service 层用例覆盖
	});

	it("#7 补充：非严格完成态或非调高目标 → PLAN_INVALID_TRANSITION；重开时携带分配参数被忽略", () => {
		const completed = activePlan({
			status: "COMPLETED",
			targetAmount: dec("10000"),
			usedAmount: dec("10000"),
			allocAmount: dec("10000"),
		});
		// 新目标未高于已使用
		expectCalcError(
			() => preview(completed, { newTargetAmount: dec("10000") }),
			"PLAN_INVALID_TRANSITION",
		);
		// M8 纠正后可能出现 used < target 的 COMPLETED：非严格完成态，拒绝重开
		expectCalcError(
			() =>
				preview(
					activePlan({
						status: "COMPLETED",
						targetAmount: dec("10000"),
						usedAmount: dec("9000"),
						allocAmount: dec("9000"),
					}),
					{ newTargetAmount: dec("12000") },
				),
			"PLAN_INVALID_TRANSITION",
		);
		// CANCELLED 终态不可修改
		expectCalcError(
			() => preview(activePlan({ status: "CANCELLED" }), {}),
			"PLAN_INVALID_TRANSITION",
		);
		// 重开只改目标：change 携带 newAllocAmount 被忽略（参数组合 400 归 service 校验）
		const reopen = preview(completed, {
			newTargetAmount: dec("12000"),
			newAllocAmount: dec("12000"),
		});
		expect(reopen.after.allocAmount.toFixed(4)).toBe("10000.0000");
	});

	it("#10 缺口为 0 → scheduleDropped（installments 清空）", () => {
		// target 6000、used 4000、alloc 6000 → 剩余 2000 ≥ 还需 2000，缺口 0；仅改节奏
		const result = preview(
			activePlan({
				targetAmount: dec("6000"),
				usedAmount: dec("4000"),
				allocAmount: dec("6000"),
			}),
			{ pacePreference: "aggressive" },
		);
		expect(result.impact.newGap.toFixed(4)).toBe("0.0000");
		expect(result.impact.newSchedule).toBeNull();
		expect(result.impact.scheduleDropped).toBe(true);
		expect(result.impact.releasedAmount.toFixed(4)).toBe("0.0000"); // 未动目标：分配不动
	});

	it("#11 新分配 < 已使用：alloc 6000→3000、used 4000 → 拦截，附差额（安全 #1）", () => {
		const data = expectCalcError(
			() =>
				preview(activePlan({ usedAmount: dec("4000") }), {
					newAllocAmount: dec("3000"),
				}),
			"PLAN_ALLOCATION_BELOW_USED",
		);
		expect((data.used as Prisma.Decimal).toFixed(4)).toBe("4000.0000");
		expect((data.shortfall as Prisma.Decimal).toFixed(4)).toBe("1000.0000");
	});

	it("#12 边界：新分配 == used 合法通过（承认全部已用沉淀）", () => {
		const result = preview(activePlan({ usedAmount: dec("4000") }), {
			newAllocAmount: dec("4000"),
		});
		expect(result.after.allocAmount.toFixed(4)).toBe("4000.0000");
		expect(result.impact.releasedAmount.toFixed(4)).toBe("2000.0000");
		expect(result.after.remainingAllocation.toFixed(4)).toBe("0.0000");
		expect(result.impact.newGap.toFixed(4)).toBe("6000.0000"); // 还需 6000 − 剩余 0
		expect(result.caps.limit.toFixed(4)).toBe("6000.0000"); // min(6000, 8000 + 6000)
	});

	it("#13 重建起始日：earliest 优先取（新）开始日，非「明天起」（架构 #1）", () => {
		// 原开始日 2026-10-01（周四）：重建第一批 = 原开始日
		const withStart = preview(
			activePlan({
				usedAmount: dec("4000"),
				planStartDate: new Date("2026-10-01T00:00:00.000Z"),
			}),
			{ newTargetAmount: dec("12000") },
		);
		expect(withStart.impact.newSchedule![0].scheduledAt.toISOString()).toBe(
			"2026-10-01T00:00:00.000Z",
		);

		// 修改接口显式传 startDate：第一批 = 新开始日 2026-10-05（周一）
		const withNewStart = preview(activePlan({ usedAmount: dec("4000") }), {
			newTargetAmount: dec("12000"),
			startDate: new Date("2026-10-05T00:00:00.000Z"),
		});
		expect(withNewStart.impact.newSchedule![0].scheduledAt.toISOString()).toBe(
			"2026-10-05T00:00:00.000Z",
		);

		// planStartDate 为 NULL（存量计划）：回退「明天起首个工作日」= 2026-09-17（注入 today 周三）
		const withoutStart = preview(
			activePlan({ usedAmount: dec("4000"), planStartDate: null }),
			{ newTargetAmount: dec("12000") },
		);
		expect(withoutStart.impact.newSchedule![0].scheduledAt.toISOString()).toBe(
			"2026-09-17T00:00:00.000Z",
		);
	});
});

// ────────────────────────── checkCompleteReady（拦截 5） ──────────────────────────

describe("checkCompleteReady（完成确认前置校验）", () => {
	it("达标（used == target 且剩余分配 == 0）→ 放行", () => {
		expect(() =>
			checkCompleteReady({
				targetAmount: dec("10000"),
				usedAmount: dec("10000"),
				allocAmount: dec("10000"),
			}),
		).not.toThrow();
	});

	it("未达标（used < target）→ PLAN_COMPLETE_NOT_READY 附差值", () => {
		const data = expectCalcError(
			() =>
				checkCompleteReady({
					targetAmount: dec("10000"),
					usedAmount: dec("8000"),
					allocAmount: dec("8000"),
				}),
			"PLAN_COMPLETE_NOT_READY",
		);
		expect((data.targetShortfall as Prisma.Decimal).toFixed(4)).toBe(
			"2000.0000",
		);
	});

	it("剩余分配未清零（alloc > used == target）→ PLAN_COMPLETE_NOT_READY", () => {
		const data = expectCalcError(
			() =>
				checkCompleteReady({
					targetAmount: dec("10000"),
					usedAmount: dec("10000"),
					allocAmount: dec("12000"),
				}),
			"PLAN_COMPLETE_NOT_READY",
		);
		expect((data.remainingAllocation as Prisma.Decimal).toFixed(4)).toBe(
			"2000.0000",
		);
	});

	it("超用（used > alloc）→ 拒绝完成，防带病完成（§3.4 显式决策）", () => {
		const data = expectCalcError(
			() =>
				checkCompleteReady({
					targetAmount: dec("10000"),
					usedAmount: dec("11000"),
					allocAmount: dec("10000"),
				}),
			"PLAN_COMPLETE_NOT_READY",
		);
		expect((data.overused as Prisma.Decimal).toFixed(4)).toBe("1000.0000");
	});
});
