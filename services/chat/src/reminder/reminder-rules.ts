import { Prisma } from "@prisma/client";
import { computeDerived } from "../plan/plan-calculator";

/**
 * 提醒规则纯函数层（reminders 技术方案 §4.3 判定 + §4.5 读时派生）。
 *
 * 对齐 plan-calculator / schedule-builder 范式：零框架依赖（禁止 import @nestjs/common）、
 * 零 IO，全部输入为 Decimal 与普通对象（字段拷贝，不含 Prisma 模型实例），
 * 由 ReminderService 负责取数与落库。
 *
 * 核心设计（§4.3 判定表，只生成「事件首日 == 今天」的行）：
 * - R1 PREP_DUE       今天 ∈ 排期节点日 且 缺口 > 0            （08:11；备齐停止）
 * - R2 PREP_OVERDUE   今天 == latestPrepDate 的次历天 且 缺口>0（08:14；逾期只发一次，
 *                      之后日期不满足 R2 → 不每天重发）
 * - R3 USE_DUE        今天 == expectUseDate                    （08:15；备齐也提醒）
 * - R4 COMPLETE_READY used == target 且 剩余分配 == 0 且 该计划
 *                      尚无 COMPLETE_READY 行                  （08:17；持续满足不逐日重发）
 *
 * 同计划同日合并：dedupKey = "PLAN:{planId}"（不含 type），唯一键
 * [userId, dedupKey, scheduledFor] 保证同计划同日仅一行；R1/R3 同日命中时
 * 多个 draft 由 createMany skipDuplicates 兜底丢弃，行内 matters 读时并列展示（§4.5）。
 *
 * 缺口口径复用 plan-calculator.computeDerived（gap = max(0, 还需使用 − 剩余分配)），
 * 零新公式，杜绝口径漂移。
 *
 * 业务日口径（§4.4）：「今天」= UTC+8 日历天（对齐 14 清单 §6 既有口径）；
 * scheduledFor 存该业务日 00:00 (+08:00) 对应的 UTC 时刻（utcPlus8Midnight）。
 */

/** 提醒类型值集（首写类型 recordedType 与事项 kind 共用） */
export const REMINDER_TYPES = [
	"PREP_DUE",
	"PREP_OVERDUE",
	"USE_DUE",
	"COMPLETE_READY",
] as const;
export type ReminderType = (typeof REMINDER_TYPES)[number];

/** 一天毫秒数（UTC 无夏令时，固定差值安全） */
const DAY_MS = 86_400_000;
/** UTC+8 固定偏移（无夏令时；14 清单 §6 既有口径） */
const UTC8_OFFSET_MS = 8 * 3_600_000;

/**
 * 截取为 UTC+8 日历天 0 点对应的 UTC 时刻（§4.4；与 transaction-calculator.utc8DayStart
 * 同公式，但在本模块独立实现以保持纯函数层零跨域依赖）。
 */
export function utcPlus8Midnight(instant: Date): Date {
	const shifted = instant.getTime() + UTC8_OFFSET_MS;
	return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - UTC8_OFFSET_MS);
}

/** UTC+8 业务日加减整天（入参须为 utcPlus8Midnight 产出） */
export function addUtc8Days(dayStart: Date, days: number): Date {
	return new Date(dayStart.getTime() + days * DAY_MS);
}

/** 同计划合并键（§4.3：不含 type，唯一键 [userId, dedupKey, scheduledFor] 的根基） */
export function reminderDedupKey(planId: string): string {
	return `PLAN:${planId}`;
}

// ────────────────────────── 输入快照 ──────────────────────────

/** 计划快照（内存形态；来自 Plan/PlanAllocation/PlanInstallment 行的字段拷贝） */
export interface ReminderPlanSnapshot {
	planId: string;
	name: string | null;
	status: string;
	targetCurrency: string;
	targetAmount: Prisma.Decimal;
	latestPrepDate: Date;
	expectUseDate: Date;
	installments: Array<{
		seq: number;
		scheduledAt: Date;
		amount: Prisma.Decimal;
	}>;
	/** 分配总额（PlanAllocation.amount；无分配行传 0） */
	allocAmount: Prisma.Decimal;
	/** 累计已使用（PlanAllocation.usedAmount；无分配行传 0） */
	usedAmount: Prisma.Decimal;
}

/** 已有提醒行快照（防重判定输入；仅须覆盖该用户 ACTIVE 计划的行） */
export interface ReminderRowSnapshot {
	planId: string | null;
	/** 首写类型 */
	type: string;
	scheduledFor: Date;
}

// ────────────────────────── 事项派生（§4.3/§4.5 共用底层）──────────────────────────

/** 单条事项（派生量 Decimal；出口由 service 序列化 4 位小数） */
export interface ReminderMatter {
	kind: ReminderType;
	/** 仅 PREP_DUE：参照日节点金额合计（同日多节点合计；其余 null） */
	installmentAmount: Prisma.Decimal | null;
	/** 仅 PREP_OVERDUE：参照日 − 最晚准备日（日历天，首日为 1） */
	daysOverdue: number | null;
}

/**
 * 参照业务日下该计划「成立」的事项集合（生成态参照日 = 今天；查询态 = 行 scheduledFor）。
 *
 * 无日期条件的事项（COMPLETE_READY）在任意参照日成立，由调用方施加
 * 「尚无 COMPLETE_READY 行」等防重条件；缺口的 hasGap 系条件（R1/R2）内置。
 */
export function computeMattersAt(
	plan: ReminderPlanSnapshot,
	referenceDay: Date,
): ReminderMatter[] {
	const derived = computeDerived({
		targetAmount: plan.targetAmount,
		usedAmount: plan.usedAmount,
		allocatedAmount: plan.allocAmount,
	});
	const gap = derived.gap;
	const matters: ReminderMatter[] = [];

	// R1：参照日 ∈ 排期节点日 且 缺口 > 0（备齐即停止准备类提醒，08:11）
	const dayInstallments = plan.installments.filter(
		(installment) =>
			utcPlus8Midnight(installment.scheduledAt).getTime() ===
			referenceDay.getTime(),
	);
	if (dayInstallments.length > 0 && gap.gt(0)) {
		const total = dayInstallments.reduce(
			(sum, installment) => sum.add(installment.amount),
			new Prisma.Decimal(0),
		);
		matters.push({
			kind: "PREP_DUE",
			installmentAmount: total,
			daysOverdue: null,
		});
	}

	// R2：参照日 == 最晚准备日的次历天 且 缺口 > 0（逾期首日；之后日期不满足 → 不重发）
	const latestDay = utcPlus8Midnight(plan.latestPrepDate);
	const daysOverdue = Math.round(
		(referenceDay.getTime() - latestDay.getTime()) / DAY_MS,
	);
	if (daysOverdue === 1 && gap.gt(0)) {
		matters.push({
			kind: "PREP_OVERDUE",
			installmentAmount: null,
			daysOverdue,
		});
	}

	// R3：参照日 == 预计使用日（备齐也提醒，08:15）
	if (
		referenceDay.getTime() === utcPlus8Midnight(plan.expectUseDate).getTime()
	) {
		matters.push({
			kind: "USE_DUE",
			installmentAmount: null,
			daysOverdue: null,
		});
	}

	// R4：已用 == 目标 且 剩余分配 == 0（可确认完成；「尚无 COMPLETE_READY 行」
	// 防重条件由生成入口的 existingRows 施加，本函数只判定数据事实）
	if (
		plan.usedAmount.eq(plan.targetAmount) &&
		derived.remainingAllocation.eq(0)
	) {
		matters.push({
			kind: "COMPLETE_READY",
			installmentAmount: null,
			daysOverdue: null,
		});
	}

	return matters;
}

/** 当前缺口（0 = 钱已备齐；事项 DTO 的 gapAmount/isFundsReady 共用口径） */
export function computePlanGap(plan: ReminderPlanSnapshot): Prisma.Decimal {
	return computeDerived({
		targetAmount: plan.targetAmount,
		usedAmount: plan.usedAmount,
		allocatedAmount: plan.allocAmount,
	}).gap;
}

// ────────────────────────── 生成判定（§4.3，只算今天）──────────────────────────

/** 待落库的提醒行草稿（dedupKey + scheduledFor 同日唯一） */
export interface ReminderDraft {
	planId: string;
	type: ReminderType;
	dedupKey: string;
	scheduledFor: Date;
}

export interface ComputeDueDraftsInput {
	/** 该用户全部 ACTIVE 计划快照（非 ACTIVE 在取数层排除，08:18） */
	plans: ReminderPlanSnapshot[];
	/** 请求时刻（内部截 UTC+8 业务日；测试注入以隔离系统时间） */
	today: Date;
	/** 该用户 ACTIVE 计划的已有提醒行（防重：同日行 + COMPLETE_READY 历史行） */
	existingRows: ReminderRowSnapshot[];
}

/**
 * 「今天」应新生成的提醒行集合（§4.3 判定表唯一实现）。
 *
 * 防重复生成（对齐 08:25-29 五条防打扰）：
 * - 同计划「业务今天」已有任一行 → 不再新写（读时 matters 并列展示，§4.5）；
 * - R4 仅在该计划无任何 COMPLETE_READY 历史行时参与（持续满足期间不逐日重发）；
 * - 只算今天 → 错过不补发；开关往返/刷新/重开不删行 → 唯一键天然防重发。
 * 并发兜底：createMany skipDuplicates 撞唯一键静默去重（§11）。
 */
export function computeDueDrafts(
	input: ComputeDueDraftsInput,
): ReminderDraft[] {
	const { plans, today, existingRows } = input;
	const todayUtc8 = utcPlus8Midnight(today);

	// 同计划同日已有行 → 今天不再新写（含并发先到者；skipDuplicates 第二道防线）
	const planIdsWithRowToday = new Set(
		existingRows
			.filter(
				(row) =>
					utcPlus8Midnight(row.scheduledFor).getTime() === todayUtc8.getTime(),
			)
			.map((row) => row.planId),
	);
	// R4 防逐日重发：该计划已存在任一 COMPLETE_READY 行（任意日期）
	const planIdsWithCompleteReady = new Set(
		existingRows
			.filter((row) => row.type === "COMPLETE_READY")
			.map((row) => row.planId),
	);

	const drafts: ReminderDraft[] = [];
	for (const plan of plans) {
		// 非 ACTIVE 计划停止一切主动提醒（08:18；service 已过滤，此处兜底防御）
		if (plan.status !== "ACTIVE") {
			continue;
		}
		if (planIdsWithRowToday.has(plan.planId)) {
			continue;
		}
		const matters = computeMattersAt(plan, todayUtc8).filter(
			(matter) =>
				matter.kind !== "COMPLETE_READY" ||
				!planIdsWithCompleteReady.has(plan.planId),
		);
		for (const matter of matters) {
			drafts.push({
				planId: plan.planId,
				type: matter.kind,
				dedupKey: reminderDedupKey(plan.planId),
				scheduledFor: todayUtc8,
			});
		}
	}
	return drafts;
}
