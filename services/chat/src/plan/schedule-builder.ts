import { Prisma } from "@prisma/client";
import {
	AMOUNT_UPPER_LIMIT,
	assertAmountLimit,
	assertPositiveAmount,
} from "@fxplanner-new/money";

/**
 * 分批排期纯函数（plan-creation 技术方案 §4.1 R1~R7）。
 *
 * 零框架依赖、零 IO：不触碰 Prisma/NestJS，错误以 ScheduleBuildError 抛出，
 * 由 PlanService 捕获后映射为 HTTP 400（{ code, message }）。
 * 全程 Prisma.Decimal 十进制运算，禁止浮点；日期一律截取为 UTC 0 点。
 *
 * - R1 可安排日期：[开始准备日, 最晚准备日] 闭区间内的工作日升序
 *   （MVP 工作日 = 跳过周六日；isWorkday 以参数注入，便于将来替换为节假日日历）
 * - R2 批次日期：取可安排日期的第 1、中间、最后 3 个；日期总数为偶数时中间取靠前
 * - R3 批次金额：conservative 50/30/20；balanced 三等分；aggressive 20/30/50
 *   （分批总额 = 目标金额 − 已使用 − 剩余分配；首次创建已使用 = 0，剩余分配 = 本次 allocatedAmount）
 * - R4 零头：按币种 decimalPlaces 向下取整，余数全部入最后一批，合计恒等于分批总额
 * - R5 退化：可安排日 2 天 → 60/40、50/50、40/60；1 天 → 单批 100%；0 天 → NO_AVAILABLE_DATES
 * - R6 金额过小：某批取整后为 0 → AMOUNT_TOO_SMALL
 * - R7 最晚准备日 = 用途日期起往前数 prepLeadDays 个工作日（跳过非工作日，结果必为工作日）
 */

/** 资金准备节奏（文档 07：安心/均衡/主动；值集含存量 UserSettings.prepPreference 的 "balanced"） */
export const PACE_PREFERENCES = [
	"conservative",
	"balanced",
	"aggressive",
] as const;
export type PacePreference = (typeof PACE_PREFERENCES)[number];

/** prepLeadDays 允许范围（技术方案 §10 假设值 1~30） */
export const PREP_LEAD_DAYS_MIN = 1;
export const PREP_LEAD_DAYS_MAX = 30;

/** builder 错误码（与接口错误码一一对应，service 原样透出） */
export type ScheduleBuildErrorCode =
	| "INVALID_PLAN_PARAMS"
	| "NO_AVAILABLE_DATES"
	| "AMOUNT_TOO_SMALL";

/** 排期构建错误（service 捕获后映射为对应 HTTP 400） */
export class ScheduleBuildError extends Error {
	readonly code: ScheduleBuildErrorCode;

	constructor(code: ScheduleBuildErrorCode, message: string) {
		super(message);
		this.name = new.target.name;
		this.code = code;
	}
}

/** 单条分批排期（内存形态；落库形态见 PlanInstallment 表） */
export interface Installment {
	seq: number;
	scheduledAt: Date;
	amount: Prisma.Decimal;
}

/**
 * 各节奏的批次金额配比（分子；分母 = 分子之和）。
 * balanced 特意为等分（1/n），conservative/aggressive 为百分比分母 100。
 */
const PACE_RATIOS: Record<PacePreference, Record<1 | 2 | 3, readonly number[]>> =
	{
		conservative: { 1: [100], 2: [60, 40], 3: [50, 30, 20] },
		balanced: { 1: [1], 2: [1, 1], 3: [1, 1, 1] },
		aggressive: { 1: [100], 2: [40, 60], 3: [20, 30, 50] },
	};

/** 一天毫秒数（UTC 无夏令时，固定差值安全） */
const DAY_MS = 86_400_000;

/** 防御性上限：可安排区间跨度（天），防恶意超大日期区间拖垮计算 */
const MAX_RANGE_DAYS = 100_000;

/** 截取为 UTC 0 点（任务约定：日期统一 UTC 0 点截取） */
export function utcMidnight(date: Date): Date {
	return new Date(
		Date.UTC(
			date.getUTCFullYear(),
			date.getUTCMonth(),
			date.getUTCDate(),
		),
	);
}

/** UTC 日期加减整天 */
function addDays(date: Date, days: number): Date {
	return new Date(date.getTime() + days * DAY_MS);
}

/** 默认工作日判断：跳过周六日（getUTCDay：0 = 周日，6 = 周六）；将来替换为节假日日历 */
export const defaultIsWorkday = (date: Date): boolean => {
	const day = date.getUTCDay();
	return day !== 0 && day !== 6;
};

/** prepLeadDays 防御校验（正常路径由 service 校验后传入，此处兜底抛同码错误） */
function assertPrepLeadDays(prepLeadDays: number): void {
	if (
		!Number.isInteger(prepLeadDays) ||
		prepLeadDays < PREP_LEAD_DAYS_MIN ||
		prepLeadDays > PREP_LEAD_DAYS_MAX
	) {
		throw new ScheduleBuildError(
			"INVALID_PLAN_PARAMS",
			`提前准备天数必须是 ${PREP_LEAD_DAYS_MIN}~${PREP_LEAD_DAYS_MAX} 的整数`,
		);
	}
}

/**
 * R7：最晚准备日 = 用途日期起往前数 prepLeadDays 个工作日（跳过非工作日）。
 * 回推过程只在工作日计数，结果必然落在工作日。
 */
export function computeLatestPrepDate(
	expectUseDate: Date,
	prepLeadDays: number,
	isWorkday: (date: Date) => boolean = defaultIsWorkday,
): Date {
	assertPrepLeadDays(prepLeadDays);
	let cursor = utcMidnight(expectUseDate);
	let counted = 0;
	while (counted < prepLeadDays) {
		cursor = addDays(cursor, -1);
		if (isWorkday(cursor)) {
			counted++;
		}
	}
	return cursor;
}

/** 自 date 起（含）首个工作日 */
function firstWorkdayAtOrAfter(
	date: Date,
	isWorkday: (date: Date) => boolean,
): Date {
	let cursor = utcMidnight(date);
	while (!isWorkday(cursor)) {
		cursor = addDays(cursor, 1);
	}
	return cursor;
}

/** R1：[earliest, latest] 闭区间内的工作日升序列表 */
function listAvailableDates(
	earliest: Date,
	latest: Date,
	isWorkday: (date: Date) => boolean,
): Date[] {
	if (latest.getTime() < earliest.getTime()) {
		return [];
	}
	if (
		(latest.getTime() - earliest.getTime()) / DAY_MS >
		MAX_RANGE_DAYS
	) {
		throw new ScheduleBuildError(
			"INVALID_PLAN_PARAMS",
			"可安排日期区间跨度过大",
		);
	}
	const dates: Date[] = [];
	for (let d = utcMidnight(earliest); d.getTime() <= latest.getTime(); d = addDays(d, 1)) {
		if (isWorkday(d)) {
			dates.push(d);
		}
	}
	return dates;
}

/** buildInstallments 入参（金额均为 Decimal；日期均应为 UTC 0 点，入口统一截取兜底） */
export interface BuildInstallmentsInput {
	/** 目标金额（> 0，≤ 单笔上限） */
	targetAmount: Prisma.Decimal;
	/** 已使用金额（创建场景恒 0；缺省 0） */
	usedAmount?: Prisma.Decimal;
	/** 剩余分配 = 本次计划分配额（≥ 0；分批总额扣除项） */
	allocatedAmount: Prisma.Decimal;
	/** 目标币种小数位（0 = 整数币种如 JPY/KRW，2 = 其余） */
	decimalPlaces: 0 | 2;
	/** 开始准备日；null = 最早可安排日（明天起首个工作日） */
	startDate: Date | null;
	/** 最晚准备日（由 computeLatestPrepDate 算出） */
	latestPrepDate: Date;
	/** 资金准备节奏 */
	pacePreference: PacePreference;
	/** 「今天」基准（缺省当前时刻；测试注入以隔离系统时间） */
	today?: Date;
	/** 工作日判断（缺省跳过周六日） */
	isWorkday?: (date: Date) => boolean;
}

/**
 * R1~R6：按可安排工作日生成 3/2/1 批排期。
 * 入参合法性由调用方（PlanService）校验；此处仅做防御性兜底（抛同码错误）。
 */
export function buildInstallments(
	input: BuildInstallmentsInput,
): Installment[] {
	const {
		targetAmount,
		usedAmount = new Prisma.Decimal(0),
		allocatedAmount,
		decimalPlaces,
		startDate,
		latestPrepDate: latestPrepDateRaw,
		pacePreference,
		today = new Date(),
		isWorkday = defaultIsWorkday,
	} = input;

	// ── 防御性金额校验（正常路径 service 已校验）────────────────────
	try {
		assertPositiveAmount(targetAmount.toString());
		assertAmountLimit(targetAmount.toString());
	} catch {
		throw new ScheduleBuildError(
			"INVALID_PLAN_PARAMS",
			"目标金额必须为大于 0 且小于单笔上限的有效数字",
		);
	}
	for (const [name, value] of [
		["剩余分配", allocatedAmount],
		["已使用金额", usedAmount],
	] as const) {
		// 非负、有限；为正时受单笔上限约束（防御性兜底，正常路径 service 已校验）
		if (
			!value.isFinite() ||
			value.isNegative() ||
			(value.gt(0) && value.gte(AMOUNT_UPPER_LIMIT))
		) {
			throw new ScheduleBuildError(
				"INVALID_PLAN_PARAMS",
				`${name}必须为非负且小于单笔上限的有效数字`,
			);
		}
	}

	// ── 分批总额（R3）：目标金额 − 已使用 − 剩余分配 ─────────────────
	const total = targetAmount.sub(usedAmount).sub(allocatedAmount);
	if (total.lte(0)) {
		throw new ScheduleBuildError(
			"AMOUNT_TOO_SMALL",
			"扣除已有分配后目标金额过小，无法生成分批方案",
		);
	}

	// ── 可安排日期（R1/R5）：0 天 → 报错 ───────────────────────────
	const latestPrepDate = utcMidnight(latestPrepDateRaw);
	const earliest = startDate
		? utcMidnight(startDate)
		: firstWorkdayAtOrAfter(addDays(utcMidnight(today), 1), isWorkday);
	const availableDates = listAvailableDates(earliest, latestPrepDate, isWorkday);
	if (availableDates.length === 0) {
		throw new ScheduleBuildError(
			"NO_AVAILABLE_DATES",
			"用途日期前没有可安排的工作日，请调整用途日期或提前天数",
		);
	}

	// ── 批次日期（R2/R5）：3 天取 1/中间(偶数靠前)/末位；2 天取两批；1 天单批 ──
	const count = availableDates.length;
	let batchDates: Date[];
	let ratios: readonly number[];
	if (count >= 3) {
		batchDates = [
			availableDates[0],
			availableDates[Math.floor((count - 1) / 2)],
			availableDates[count - 1],
		];
		ratios = PACE_RATIOS[pacePreference][3];
	} else if (count === 2) {
		batchDates = [availableDates[0], availableDates[1]];
		ratios = PACE_RATIOS[pacePreference][2];
	} else {
		batchDates = [availableDates[0]];
		ratios = PACE_RATIOS[pacePreference][1];
	}

	// ── 批次金额（R3/R4/R6）：按配比向下取整，余数全部入末批，合计恒等于分批总额 ──
	const ratioSum = ratios.reduce((sum, ratio) => sum + ratio, 0);
	const amounts: Prisma.Decimal[] = [];
	for (let i = 0; i < batchDates.length - 1; i++) {
		const floored = total
			.mul(ratios[i])
			.div(ratioSum)
			.toDecimalPlaces(decimalPlaces, Prisma.Decimal.ROUND_DOWN);
		if (floored.lte(0)) {
			throw new ScheduleBuildError(
				"AMOUNT_TOO_SMALL",
				"目标金额过小，分批取整后某批为 0，无法生成方案",
			);
		}
		amounts.push(floored);
	}
	// 末批兜底：总额 − 前批合计（零头全部入末批；防御性校验同前批）
	const lastAmount = total.sub(
		amounts.reduce((sum, amount) => sum.add(amount), new Prisma.Decimal(0)),
	);
	if (lastAmount.lte(0)) {
		throw new ScheduleBuildError(
			"AMOUNT_TOO_SMALL",
			"目标金额过小，分批取整后某批为 0，无法生成方案",
		);
	}
	amounts.push(lastAmount);

	return batchDates.map((scheduledAt, index) => ({
		seq: index + 1,
		scheduledAt,
		amount: amounts[index],
	}));
}
