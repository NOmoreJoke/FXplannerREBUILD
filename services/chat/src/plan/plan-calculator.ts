import { Prisma } from "@prisma/client";
import {
	buildInstallments,
	computeLatestPrepDate,
	type Installment,
	type PacePreference,
} from "./schedule-builder";

/**
 * 计划核心计算纯函数层（plan-management 技术方案 §3.4）。
 *
 * 对齐 schedule-builder 范式：零框架依赖（禁止 import @nestjs/common），
 * 错误以 PlanCalcError（领域错误，携带 code/message/data）抛出，由 PlanService
 * 捕获后映射为 HTTP（§4.4 错误码契约）；ScheduleBuildError（排期不可生成）
 * 原样上抛，同样由 service 映射。
 * ⚠️ transaction-calculator 实际耦合 HttpException，不作范式。
 *
 * 入参全部为 Decimal 与普通对象（不含 Prisma 模型实例），供
 * preview/create（本阶段）与 adjust-preview/adjust/complete（阶段 2）共用，
 * 杜绝预览与提交两处公式漂移（§2 结论：计算逻辑抽公共函数）。
 *
 * 口径（§3.4，plan-calculator.spec.ts 单测锁定）：
 * - 计划剩余分配 = max(0, alloc − min(used, alloc))
 *   （已使用恒从分配中优先扣减；超用部分不计入剩余——《06》"已使用4,000，目标不能改成3,000"）
 * - 未分配余额 = balance − Σ同币种各计划剩余分配（含本计划；下限 clamp 0）
 * - 还需使用金额 = max(0, target − used)
 * - 创建分配上限 = min(未分配余额, 还需准备金额)；还需准备金额 = max(0, 还需使用 − 本计划剩余分配)
 * - 修改分配总额上限 = min(还需使用金额, 未分配余额 + 本计划原分配总额 alloc)
 *   （⚠️ 加回的是原分配总额而非原剩余——已使用部分沉淀在 usedAmount，不占未分配余额）
 * - 调低目标的释放额 = max(0, alloc − (新目标 − used))
 *
 * 非法提交拦截（预览与提交同一函数内判断，共 5 条）：
 * 1. 新目标 < used → PLAN_TARGET_BELOW_USED（附 used 与差额）
 * 2. 新分配 > 修改总额上限 → PLAN_ALLOCATION_LIMIT（附 caps 三值，不截断用户输入）
 * 3. 新分配 < used → PLAN_ALLOCATION_BELOW_USED（附 used 与差额；边界 == used 合法）
 * 4. COMPLETED 计划修改且非「调高目标重开」/ CANCELLED 计划修改 → PLAN_INVALID_TRANSITION
 * 5. 完成确认 used ≠ target 或剩余分配 ≠ 0 → PLAN_COMPLETE_NOT_READY（见 checkCompleteReady）
 *
 * 同币种口径（§3.4 口径声明）：Σ剩余分配恒等式为同币种口径——调用方必须按
 * targetCurrency 过滤后传入 planAllocations（存量 computeCaps 即此行为），跨币种互不影响。
 */

/** calculator 错误码（与接口错误码一一对应，service 映射为 HTTP 后原样透出） */
export type PlanCalcErrorCode =
	| "PLAN_TARGET_BELOW_USED"
	| "PLAN_ALLOCATION_LIMIT"
	| "PLAN_ALLOCATION_BELOW_USED"
	| "PLAN_INVALID_TRANSITION"
	| "PLAN_COMPLETE_NOT_READY";

/** 计划计算错误（service 捕获后映射为 HTTP；data 随错误体返回，金额为 Decimal） */
export class PlanCalcError extends Error {
	readonly code: PlanCalcErrorCode;
	readonly data?: Record<string, unknown>;

	constructor(
		code: PlanCalcErrorCode,
		message: string,
		data?: Record<string, unknown>,
	) {
		super(message);
		this.name = new.target.name;
		this.code = code;
		this.data = data;
	}
}

/** 计划分配快照（内存形态；来自 PlanAllocation 行的字段拷贝，不含模型实例） */
export interface PlanAllocSnapshot {
	/** 分配总额（amount） */
	amount: Prisma.Decimal;
	/** 累计已使用（usedAmount） */
	usedAmount: Prisma.Decimal;
}

/** 计划剩余分配 = max(0, alloc − min(used, alloc))（口径唯一实现，M7 亦须复用，防公式漂移） */
export function computeRemainingAllocation(
	allocAmount: Prisma.Decimal,
	usedAmount: Prisma.Decimal,
): Prisma.Decimal {
	return Prisma.Decimal.max(
		allocAmount.sub(Prisma.Decimal.min(usedAmount, allocAmount)),
		0,
	);
}

// ────────────────────────── computeDerived ──────────────────────────

export interface ComputeDerivedInput {
	targetAmount: Prisma.Decimal;
	usedAmount: Prisma.Decimal;
	allocatedAmount: Prisma.Decimal;
}

/** 派生量（列表与详情复用）：还需使用金额 / 计划剩余分配 / 资金缺口 */
export interface DerivedAmounts {
	/** 还需使用金额 = max(0, target − used) */
	stillNeeded: Prisma.Decimal;
	/** 计划剩余分配 = max(0, alloc − min(used, alloc)) */
	remainingAllocation: Prisma.Decimal;
	/** 资金缺口 = max(0, 还需使用金额 − 剩余分配)；0 即「钱已备齐」 */
	gap: Prisma.Decimal;
}

/** 剩余分配 / 缺口 / 还需使用金额（§3.4 公式表，列表与详情复用） */
export function computeDerived(input: ComputeDerivedInput): DerivedAmounts {
	const { targetAmount, usedAmount, allocatedAmount } = input;
	const stillNeeded = Prisma.Decimal.max(targetAmount.sub(usedAmount), 0);
	const remainingAllocation = computeRemainingAllocation(
		allocatedAmount,
		usedAmount,
	);
	const gap = Prisma.Decimal.max(stillNeeded.sub(remainingAllocation), 0);
	return { stillNeeded, remainingAllocation, gap };
}

// ────────────────────────── computeCaps ──────────────────────────

/** caps 模式：create = 创建上限（现状公式）；adjust = 修改总额上限（§3.4 新公式） */
export type CapsMode = "create" | "adjust";

export interface ComputeCapsInput {
	mode: CapsMode;
	/** 同币种账户余额（无账户传 0） */
	accountBalance: Prisma.Decimal;
	/**
	 * 同币种「其他」计划的分配快照（⚠️ 调用方按 targetCurrency 过滤，恒等式为同币种口径）。
	 * 本计划单独经 ownPlan 传入（创建场景尚不存在，传 null）
	 */
	otherPlanAllocations: PlanAllocSnapshot[];
	/** 本计划分配快照（创建场景 null；adjust 场景必传） */
	ownPlan: PlanAllocSnapshot | null;
	/** 目标金额（create = 现目标；adjust = 新目标） */
	targetAmount: Prisma.Decimal;
}

export interface CapsResult {
	/** 未分配余额 = max(0, balance − Σ同币种各计划剩余分配)（含本计划） */
	unallocatedBalance: Prisma.Decimal;
	/** 还需使用金额 = max(0, target − 本计划 used)；本计划不存在时 used = 0 */
	stillNeeded: Prisma.Decimal;
	/**
	 * 分配上限：
	 * - create = min(未分配余额, 还需准备金额)，还需准备金额 = max(0, 还需使用 − 本计划剩余分配)
	 * - adjust = min(还需使用金额, 未分配余额 + 本计划原分配总额)
	 */
	maxAllocatable: Prisma.Decimal;
	/** 本计划原分配总额（无则 0）——adjust 公式的加回项 */
	ownAllocAmount: Prisma.Decimal;
	/** 本计划剩余分配（无则 0） */
	ownRemainingAllocation: Prisma.Decimal;
}

/**
 * caps 计算（创建/修改两套上限公式，§3.4 唯一实现）。
 * 创建路径与存量 computeCaps 在 usedAmount = 0 域内逐位一致（§3.4 口径注；
 * used > 0 时按本 max(0) 口径，存量无 clamp 裸减法废止）。
 */
export function computeCaps(input: ComputeCapsInput): CapsResult {
	const { mode, accountBalance, otherPlanAllocations, ownPlan, targetAmount } =
		input;

	const ownUsed = ownPlan?.usedAmount ?? new Prisma.Decimal(0);
	const ownAlloc = ownPlan?.amount ?? new Prisma.Decimal(0);
	const ownRemaining = computeRemainingAllocation(ownAlloc, ownUsed);

	const othersRemaining = otherPlanAllocations.reduce(
		(sum, allocation) =>
			sum.add(
				computeRemainingAllocation(allocation.amount, allocation.usedAmount),
			),
		new Prisma.Decimal(0),
	);
	const unallocatedBalance = Prisma.Decimal.max(
		accountBalance.sub(othersRemaining).sub(ownRemaining),
		0,
	);
	const stillNeeded = Prisma.Decimal.max(targetAmount.sub(ownUsed), 0);

	const maxAllocatable =
		mode === "create"
			? // 创建上限 = min(未分配余额, 还需准备金额)（15 清单「常用计算」第 1 条，即现状公式）
				Prisma.Decimal.min(
					unallocatedBalance,
					Prisma.Decimal.max(stillNeeded.sub(ownRemaining), 0),
				)
			: // 修改总额上限 = min(还需使用金额, 未分配余额 + 本计划原分配总额)（第 2 条；加回原分配总额）
				Prisma.Decimal.min(stillNeeded, unallocatedBalance.add(ownAlloc));

	return {
		unallocatedBalance,
		stillNeeded,
		maxAllocatable,
		ownAllocAmount: ownAlloc,
		ownRemainingAllocation: ownRemaining,
	};
}

// ────────────────────────── computeAdjustPreview ──────────────────────────

/** 修改预览的计算入参：计划当前状态（字段拷贝，不含模型实例） */
export interface AdjustPreviewPlanState {
	/** "ACTIVE" | "COMPLETED" | "CANCELLED" */
	status: string;
	/** 目标金额（现值） */
	targetAmount: Prisma.Decimal;
	/** 本计划原分配总额（amount） */
	allocAmount: Prisma.Decimal;
	/** 累计已使用 */
	usedAmount: Prisma.Decimal;
	pacePreference: PacePreference;
	prepLeadDays: number;
	/** 用途日期（UTC 0 点；计算最晚准备日基准，不可改） */
	expectUseDate: Date;
	/** 原开始准备日（重建 earliest 基准；null 回退「明天起首个工作日」） */
	planStartDate: Date | null;
}

/** 修改项（全部可选；字段缺省 = 沿用现值。至少一项由 service 首行判空保证） */
export interface AdjustPreviewChange {
	/** 新目标金额 */
	newTargetAmount?: Prisma.Decimal | null;
	/** 新分配总额（未提供且调低目标时，分配自动释放至 min(alloc, max(新目标 − used, used))） */
	newAllocAmount?: Prisma.Decimal | null;
	/** 新节奏 */
	pacePreference?: string | null;
	/** 新准备缓冲（1~30，service 已校验） */
	prepLeadDays?: number | null;
	/** 新开始准备日：缺省（undefined）= 沿用 planStartDate；null = 清空回退「明天起首个工作日」；Date = 替换 */
	startDate?: Date | null;
}

/** 修改预览的环境数据（同币种；Decimal 与普通对象） */
export interface AdjustPreviewContext {
	/** 同币种账户余额（无账户传 0） */
	accountBalance: Prisma.Decimal;
	/** 同币种「其他」计划的分配快照（⚠️ 调用方按 targetCurrency 过滤） */
	otherPlanAllocations: PlanAllocSnapshot[];
	/** 目标币种小数位（排期重建精度） */
	decimalPlaces: 0 | 2;
	/** 「今天」基准（缺省当前时刻；测试注入以隔离系统时间） */
	today?: Date;
}

/** caps 三值（PLAN_ALLOCATION_LIMIT 响应携带；Decimal，出口由 service 序列化 4 位小数） */
export interface AdjustPreviewCaps {
	/** 修改分配总额上限 = min(还需使用金额, 未分配余额 + 本计划原分配总额) */
	limit: Prisma.Decimal;
	/** 未分配余额 */
	unallocatedBalance: Prisma.Decimal;
	/** 还需使用金额（按新目标） */
	stillNeeded: Prisma.Decimal;
}

/** 修改影响（§4.3 impact） */
export interface AdjustPreviewImpact {
	/** 释放额 = max(0, 原分配总额 − 新分配总额) */
	releasedAmount: Prisma.Decimal;
	/** 新资金缺口 */
	newGap: Prisma.Decimal;
	/** 新排期（缺口 > 0 时生成；缺口 = 0 时为 null——清空 installments） */
	newSchedule: Installment[] | null;
	/** true = 现有排期将被清空（newSchedule 为 null 时恒 true） */
	scheduleDropped: boolean;
}

/** 修改前/后状态快照（Decimal，出口由 service 序列化） */
export interface AdjustPreviewStateSnapshot {
	targetAmount: Prisma.Decimal;
	allocAmount: Prisma.Decimal;
	usedAmount: Prisma.Decimal;
	remainingAllocation: Prisma.Decimal;
	gap: Prisma.Decimal;
	pacePreference: string;
	prepLeadDays: number;
	planStartDate: Date | null;
}

export interface AdjustPreviewResult {
	/** true = COMPLETED → ACTIVE 重新开启（写 REOPENED 记录由 service 负责） */
	reopen: boolean;
	/** caps 三值（PLAN_ALLOCATION_LIMIT 拦截失败时经 PlanCalcError.data 携带） */
	caps: AdjustPreviewCaps;
	impact: AdjustPreviewImpact;
	before: AdjustPreviewStateSnapshot;
	after: AdjustPreviewStateSnapshot;
	/** 新最晚准备日（按用途日期与新准备缓冲重算） */
	newLatestPrepDate: Date;
}

export interface ComputeAdjustPreviewInput {
	plan: AdjustPreviewPlanState;
	change: AdjustPreviewChange;
	context: AdjustPreviewContext;
}

/**
 * 修改预览计算（§3.4 全部公式 + 5 条拦截；预览/提交共用，提交侧由 service 事务内重调）。
 *
 * 抛出：PlanCalcError（拦截 1~4；data 携带 used/差额/caps）、
 * ScheduleBuildError（缺口 > 0 但排期不可生成 → NO_AVAILABLE_DATES / AMOUNT_TOO_SMALL，
 * service 映射既有 400 错误码）。
 *
 * 状态语义（§3.1/§4.3）：
 * - CANCELLED：终态不可修改 → PLAN_INVALID_TRANSITION
 * - COMPLETED：仅「严格完成态（used == target 且剩余分配 == 0）+ 新目标 > used」可重开
 *   （valid + reopen 标记；分配/节奏/缓冲不动，回 ACTIVE 由 service 负责）；其余 → PLAN_INVALID_TRANSITION
 * - ACTIVE：金额拦截 1~3 后计算释放额/新缺口/新排期
 */
export function computeAdjustPreview(
	input: ComputeAdjustPreviewInput,
): AdjustPreviewResult {
	const { plan, change, context } = input;

	const before = snapshotOf(
		plan.targetAmount,
		plan.allocAmount,
		plan.usedAmount,
		plan.pacePreference,
		plan.prepLeadDays,
		plan.planStartDate,
	);

	// ── 状态闸门（拦截 4）──
	if (plan.status === "CANCELLED") {
		throw new PlanCalcError(
			"PLAN_INVALID_TRANSITION",
			"已取消计划为终态，不可修改",
		);
	}
	if (plan.status === "COMPLETED") {
		const strictComplete =
			plan.usedAmount.eq(plan.targetAmount) && before.remainingAllocation.eq(0);
		const raiseTarget = (change.newTargetAmount ?? plan.targetAmount).gt(
			plan.usedAmount,
		);
		if (!strictComplete || !raiseTarget) {
			throw new PlanCalcError(
				"PLAN_INVALID_TRANSITION",
				"已完成计划仅支持提高目标重新开启（须为严格完成态且新目标大于累计已使用）",
			);
		}
		// 重开只改目标：分配/节奏/缓冲/开始日不动，新增部分体现为缺口（《06》例 14）
		return finalizePreview({
			plan,
			before,
			newTarget: change.newTargetAmount ?? plan.targetAmount,
			newAlloc: plan.allocAmount,
			newPace: plan.pacePreference,
			newPrepLeadDays: plan.prepLeadDays,
			newStartDate: plan.planStartDate,
			reopen: true,
			context,
		});
	}

	// ── ACTIVE：金额拦截（§3.4 拦截 1~3）──
	const newTarget = change.newTargetAmount ?? plan.targetAmount;
	if (newTarget.lt(plan.usedAmount)) {
		throw new PlanCalcError(
			"PLAN_TARGET_BELOW_USED",
			`新目标金额不能低于累计已使用金额 ${plan.usedAmount.toFixed(4)}`,
			{
				used: plan.usedAmount,
				shortfall: plan.usedAmount.sub(newTarget),
			},
		);
	}

	const requestedAlloc = change.newAllocAmount ?? null;
	if (requestedAlloc !== null && requestedAlloc.lt(plan.usedAmount)) {
		throw new PlanCalcError(
			"PLAN_ALLOCATION_BELOW_USED",
			`分配总额不能低于累计已使用金额 ${plan.usedAmount.toFixed(4)}`,
			{
				used: plan.usedAmount,
				shortfall: plan.usedAmount.sub(requestedAlloc),
			},
		);
	}

	// caps（修改口径：按新目标算还需使用；上限加回本计划原分配总额）
	const capsRaw = computeCaps({
		mode: "adjust",
		accountBalance: context.accountBalance,
		otherPlanAllocations: context.otherPlanAllocations,
		ownPlan: { amount: plan.allocAmount, usedAmount: plan.usedAmount },
		targetAmount: newTarget,
	});
	const caps: AdjustPreviewCaps = {
		limit: capsRaw.maxAllocatable,
		unallocatedBalance: capsRaw.unallocatedBalance,
		stillNeeded: capsRaw.stillNeeded,
	};

	// 新分配：显式指定优先；未指定且调低目标时自动释放（§3.4 释放额公式），
	// 下限 clamp 到 used（释放不得击穿已使用沉淀，与拦截 3 同 rationale）
	const finalAlloc =
		requestedAlloc ??
		(change.newTargetAmount === undefined || change.newTargetAmount === null
			? plan.allocAmount // 未动目标（仅节奏/缓冲/开始日）：分配不动
			: Prisma.Decimal.min(
					plan.allocAmount,
					Prisma.Decimal.max(newTarget.sub(plan.usedAmount), plan.usedAmount),
				));

	// 拦截 2 仅作用于显式新分配（自动释放只减不增，不可能新增占用；
	// 上限公式按原分配总额加回，自动释放额恒 ≤ 原分配，天然闭合）
	if (requestedAlloc !== null && requestedAlloc.gt(caps.limit)) {
		throw new PlanCalcError(
			"PLAN_ALLOCATION_LIMIT",
			`分配总额超出上限 ${caps.limit.toFixed(4)}（当前未分配余额 ${caps.unallocatedBalance.toFixed(4)}，还需使用 ${caps.stillNeeded.toFixed(4)}）`,
			{ caps },
		);
	}

	return finalizePreview({
		plan,
		before,
		newTarget,
		newAlloc: finalAlloc,
		newPace: (change.pacePreference ?? plan.pacePreference) as PacePreference,
		newPrepLeadDays: change.prepLeadDays ?? plan.prepLeadDays,
		newStartDate:
			change.startDate === undefined ? plan.planStartDate : change.startDate,
		reopen: false,
		context,
		caps,
	});
}

/** 汇总段：释放额/新缺口/新排期（缺口 > 0 时复用 buildInstallments；缺口 = 0 清空排期） */
function finalizePreview(args: {
	plan: AdjustPreviewPlanState;
	before: AdjustPreviewStateSnapshot;
	newTarget: Prisma.Decimal;
	newAlloc: Prisma.Decimal;
	newPace: PacePreference;
	newPrepLeadDays: number;
	newStartDate: Date | null;
	reopen: boolean;
	context: AdjustPreviewContext;
	caps?: AdjustPreviewCaps;
}): AdjustPreviewResult {
	const {
		plan,
		before,
		newTarget,
		newAlloc,
		newPace,
		newPrepLeadDays,
		newStartDate,
		reopen,
		context,
		caps,
	} = args;

	const after = snapshotOf(
		newTarget,
		newAlloc,
		plan.usedAmount,
		newPace,
		newPrepLeadDays,
		newStartDate,
	);
	const releasedAmount = Prisma.Decimal.max(plan.allocAmount.sub(newAlloc), 0);
	const newGap = after.gap;
	const newLatestPrepDate = computeLatestPrepDate(
		plan.expectUseDate,
		newPrepLeadDays,
	);

	// 排期重建（§3.4）：缺口为 0 → 清空 installments（不生成排期）；
	// 缺口 > 0 → 复用 builder（分批总额 = 新目标 − 已使用 − 新剩余分配），
	// earliest 优先取（新）开始日，为 NULL 回退「明天起首个工作日」——禁止无基准重建漂移
	let newSchedule: Installment[] | null = null;
	if (newGap.gt(0)) {
		newSchedule = buildInstallments({
			targetAmount: newTarget,
			usedAmount: plan.usedAmount,
			allocatedAmount: after.remainingAllocation,
			decimalPlaces: context.decimalPlaces,
			startDate: newStartDate,
			latestPrepDate: newLatestPrepDate,
			pacePreference: newPace,
			today: context.today,
		});
	}

	return {
		reopen,
		caps: caps ?? {
			limit: new Prisma.Decimal(0),
			unallocatedBalance: new Prisma.Decimal(0),
			stillNeeded: new Prisma.Decimal(0),
		},
		impact: {
			releasedAmount,
			newGap,
			newSchedule,
			scheduleDropped: newSchedule === null,
		},
		before,
		after,
		newLatestPrepDate,
	};
}

/** 前/后状态快照（派生量即时计算，保证口径单一来源） */
function snapshotOf(
	targetAmount: Prisma.Decimal,
	allocAmount: Prisma.Decimal,
	usedAmount: Prisma.Decimal,
	pacePreference: string,
	prepLeadDays: number,
	planStartDate: Date | null,
): AdjustPreviewStateSnapshot {
	const derived = computeDerived({
		targetAmount,
		usedAmount,
		allocatedAmount: allocAmount,
	});
	return {
		targetAmount,
		allocAmount,
		usedAmount,
		remainingAllocation: derived.remainingAllocation,
		gap: derived.gap,
		pacePreference,
		prepLeadDays,
		planStartDate,
	};
}

// ────────────────────────── checkCompleteReady ──────────────────────────

export interface CompleteReadinessInput {
	targetAmount: Prisma.Decimal;
	usedAmount: Prisma.Decimal;
	allocAmount: Prisma.Decimal;
}

/**
 * 完成确认前置校验（§3.4 拦截 5 + 超用显式决策）：`used == target 且 剩余分配 == 0`
 * 才放行；`used > alloc`（超用）拒绝——防带病完成，附「请先通过更正流程处理」。
 * 不满足抛 PLAN_COMPLETE_NOT_READY，data 附当前差值。
 * （「仅 ACTIVE 可完成」的状态流转归 service 条件更新负责，不在纯函数内。）
 */
export function checkCompleteReady(input: CompleteReadinessInput): void {
	const { targetAmount, usedAmount, allocAmount } = input;
	const remainingAllocation = computeRemainingAllocation(
		allocAmount,
		usedAmount,
	);
	if (usedAmount.gt(allocAmount)) {
		throw new PlanCalcError(
			"PLAN_COMPLETE_NOT_READY",
			`存在超用（已使用 ${usedAmount.toFixed(4)} 超过分配总额 ${allocAmount.toFixed(4)}），请先通过更正流程处理`,
			{
				targetAmount,
				usedAmount,
				remainingAllocation,
				overused: usedAmount.sub(allocAmount),
			},
		);
	}
	if (!usedAmount.eq(targetAmount) || remainingAllocation.gt(0)) {
		throw new PlanCalcError(
			"PLAN_COMPLETE_NOT_READY",
			`尚未备齐：还需使用 ${Prisma.Decimal.max(targetAmount.sub(usedAmount), 0).toFixed(4)}，剩余分配 ${remainingAllocation.toFixed(4)} 未清零`,
			{
				targetAmount,
				usedAmount,
				remainingAllocation,
				targetShortfall: Prisma.Decimal.max(targetAmount.sub(usedAmount), 0),
			},
		);
	}
}
