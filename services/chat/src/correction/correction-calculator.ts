/**
 * 更正模块纯函数层（corrections 技术方案 §5.1/§5.2）：
 * - parseCorrectionChanges：拟变更白名单应用与参数解析（白名单外字段 / 非法值 → 400）；
 * - assertCorrectionBasics：V0 基础校验（原因非空、内容确有变化、日期上下界）；
 * - assertUsageCorrectionAllowed：V4 待确定项拦截（改 0 / 超目标 / COMPLETED / CANCELLED，
 *   doc 10:88-91；本期一律拦截并提示，方案假设 6）；
 * - computeAllocationDelta：使用改小/改大/补分配的 PlanAllocation 调整量（doc 14 例 02~05）。
 *
 * 无 IO、无框架状态，事务编排在 CorrectionService（分层先例与 transaction-calculator 一致）。
 * 本期 USAGE 更正入口被 CORRECTION_TARGET_TYPE_UNAVAILABLE 拦截（方案 §10 依赖边界），
 * V4 与分配调整量以纯函数先行落地并由单测锁定，M7 接线后零改动复用。
 */
import { HttpException, HttpStatus } from "@nestjs/common";
import { getCurrency } from "@fxplanner-new/money";
import { Prisma } from "@prisma/client";
import { assertAmountLimit, AMOUNT_UPPER_LIMIT } from "@fxplanner-new/money";
import {
	assertRateDecimalPlaces,
	assertSelfConsistent,
	assertTransactedAtInRange,
	parseAmountOrThrow,
	TransactionRoundToZeroException,
} from "../transaction/transaction-calculator";
import { assertUnitCostInRange } from "../account/account-calculator";
import { DAILY_QUOTE_LOOKBACK_DAYS, QUOTE_TTL_MS } from "../rate/rate.constants";

/** 更正目标类型（targetType；USAGE 依赖 M7，本期接口层降级拦截，方案 §10） */
export type CorrectionTargetType = "TRANSACTION" | "USAGE" | "INITIAL_HOLDING";

/** 各目标类型允许变更的字段白名单（方案 §6.1；白名单外 400 INVALID_CORRECTION_PARAMS） */
export const CORRECTION_CHANGE_WHITELIST: Record<
	CorrectionTargetType,
	readonly string[]
> = {
	TRANSACTION: [
		"currencyCode",
		"principalAmount",
		"quantity",
		"feeAmount",
		"transactedAt",
	] as const,
	USAGE: ["amount", "usedAt"] as const,
	INITIAL_HOLDING: ["amount", "currencyCode"] as const,
};

/** 模块参数错误（400 INVALID_CORRECTION_PARAMS，风格与 transaction-calculator 一致） */
export class CorrectionInvalidParamsException extends HttpException {
	constructor(message: string) {
		super(
			{ code: "INVALID_CORRECTION_PARAMS", message },
			HttpStatus.BAD_REQUEST,
		);
	}
}

/** 待确定项拦截（400 CORRECTION_NOT_ALLOWED，doc 10 待确定项本期先拦截） */
export class CorrectionNotAllowedException extends HttpException {
	constructor(message: string) {
		super({ code: "CORRECTION_NOT_ALLOWED", message }, HttpStatus.BAD_REQUEST);
	}
}

/** 原时点报价不可得（400 RATE_QUOTE_UNAVAILABLE，初始持仓币种更正，方案 §5.3） */
export class RateQuoteUnavailableException extends HttpException {
	constructor() {
		super(
			{
				code: "RATE_QUOTE_UNAVAILABLE",
				message:
					"无法取得原确认时点可用的报价。报价须有明确的发布时间，且最迟在原确认时点发布。" +
					`实时报价的发布时间须距原确认时点不足 ${QUOTE_TTL_MS / 60_000} 分钟，` +
					`日级报价按 UTC+8 同日优先、最多回看 ${DAILY_QUOTE_LOOKBACK_DAYS} 个自然日。` +
					"暂不能更正币种，仍可更正金额。",
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}

/**
 * 解析后的拟变更（仅保留提供的字段；feeProvided 区分「缺省不改」与「显式改回未知 null」）。
 * 解析阶段完成：有效数字、正负、上限、小数位、日期可解析与上下界（V0 静态部分）。
 */
export interface ParsedCorrectionChanges {
	// TRANSACTION
	currencyCode?: string;
	principalAmount?: Prisma.Decimal;
	quantity?: Prisma.Decimal;
	/** 提供时生效；null = 改回「未知」（≠ 0，方案 §5.2 手续费补录行） */
	feeAmount?: Prisma.Decimal | null;
	feeProvided: boolean;
	transactedAt?: Date;
	// USAGE（amount > 0）/ INITIAL_HOLDING（amount ≥ 0，允许改 0）
	amount?: Prisma.Decimal;
	usedAt?: Date;
}

/** 解析入参上下文：币种精度与日期校验所需的账本起点 / 当前时间（由 service 注入） */
export interface ParseChangesContext {
	targetType: CorrectionTargetType;
	now: Date;
	ledgerStartedAt: Date | null;
	/** 目标当前币种（quantity/amount 精度与三值自洽校验基准） */
	currentCurrencyCode: string;
	/** TRANSACTION 的当前汇率（三值自洽校验基准；exchangeRate 不可更正） */
	currentExchangeRate: Prisma.Decimal;
	/** TRANSACTION 目标当前三元组（变更本金/数量时的自洽与容量校验基准） */
	original: {
		principalAmount: Prisma.Decimal;
		quantity: Prisma.Decimal;
		feeAmount: Prisma.Decimal | null;
	};
}

/**
 * 拟变更白名单应用与解析（方案 §5.1 mutate 步骤前的静态校验，preview/apply 共用）。
 * 全部失败路径抛 400 INVALID_CORRECTION_PARAMS；「使用金额改 0」在此放行为合法数字，
 * 由 assertUsageCorrectionAllowed（V4）以 CORRECTION_NOT_ALLOWED 拦截（错误码区分）。
 */
export function parseCorrectionChanges(
	rawChanges: Record<string, unknown>,
	context: ParseChangesContext,
): ParsedCorrectionChanges {
	const whitelist = CORRECTION_CHANGE_WHITELIST[context.targetType];
	// ValidationPipe 转换后的 DTO 实例会带上值为 undefined 的声明属性，
	// 白名单判断只认「显式提供」（非 undefined）的字段
	const unknownFields = Object.keys(rawChanges).filter(
		(field) =>
			rawChanges[field] !== undefined &&
			!(whitelist as readonly string[]).includes(field),
	);
	if (unknownFields.length > 0) {
		throw new CorrectionInvalidParamsException(
			`该记录类型不允许修改字段：${unknownFields.join("、")}`,
		);
	}

	const changes: ParsedCorrectionChanges = { feeProvided: false };
	const has = (field: string) => rawChanges[field] !== undefined;

	if (context.targetType === "TRANSACTION") {
		const currencyInfo = getCurrency(context.currentCurrencyCode);
		if (has("currencyCode")) {
			const normalized = String(rawChanges.currencyCode).trim().toUpperCase();
			if (!getCurrency(normalized)) {
				throw new CorrectionInvalidParamsException(
					`币种必须是支持的 15 种币种之一，收到：${rawChanges.currencyCode}`,
				);
			}
			changes.currencyCode = normalized;
		}
		const targetCurrency = changes.currencyCode ?? context.currentCurrencyCode;
		const targetPrecision =
			getCurrency(targetCurrency)?.decimalPlaces ??
			currencyInfo?.decimalPlaces ??
			2;
		if (has("principalAmount")) {
			const value = parsePositiveWithLimit(
				String(rawChanges.principalAmount),
				"本金金额",
			);
			changes.principalAmount = value;
			if (value.dp() > 4) {
				throw new CorrectionInvalidParamsException("本金金额最多支持 4 位小数");
			}
		}
		if (has("quantity")) {
			const value = parsePositiveWithLimit(
				String(rawChanges.quantity),
				"到账数量",
			);
			if (value.dp() > targetPrecision) {
				throw new CorrectionInvalidParamsException(
					targetPrecision === 0
						? "该币种（如日元/韩元）为整数币种，到账数量不能带小数位"
						: `到账数量最多支持 ${targetPrecision} 位小数`,
				);
			}
			changes.quantity = value;
		}
		if (rawChanges.feeAmount !== undefined) {
			// 显式提供（含 null = 改回未知）；字符串值须为非负有效数字且 ≤ 4 位小数
			changes.feeProvided = true;
			const rawFee = rawChanges.feeAmount;
			if (rawFee === null) {
				changes.feeAmount = null;
			} else {
				const value = parseAmountOrThrow(String(rawFee), "手续费");
				if (value.isNegative()) {
					throw new CorrectionInvalidParamsException("手续费不能为负数");
				}
				if (value.gte(AMOUNT_UPPER_LIMIT)) {
					throw new CorrectionInvalidParamsException(
						"手续费必须小于单笔上限 100,000,000,000",
					);
				}
				if (value.dp() > 4) {
					throw new CorrectionInvalidParamsException("手续费最多支持 4 位小数");
				}
				changes.feeAmount = value;
			}
		}
		if (has("transactedAt")) {
			changes.transactedAt = parseDateOrThrow(
				String(rawChanges.transactedAt),
				"交易日期",
			);
			assertTransactedAtInRange(
				changes.transactedAt,
				context.now,
				context.ledgerStartedAt,
			);
		}
		// 三值自洽与单位成本容量：以「变更后」的三值校验（汇率不可更正，沿用原值）
		const principal =
			changes.principalAmount ?? context.original.principalAmount;
		const quantity = changes.quantity ?? context.original.quantity;
		const fee = changes.feeProvided
			? (changes.feeAmount ?? null)
			: context.original.feeAmount;
		// 三值自洽：以「变更后」的三值校验（汇率不可更正，沿用原值）
		assertSelfConsistentOrThrow(
			principal,
			context.currentExchangeRate,
			quantity,
			targetPrecision,
		);
		// unitCost 容量预校验（Decimal(20,10) 溢出防御，§3.4 先例）：变更后本金/手续费/数量代入
		assertUnitCostInRange(principal, fee, quantity);
	}

	if (context.targetType === "USAGE") {
		if (has("amount")) {
			const value = parsePositiveWithLimit(
				String(rawChanges.amount),
				"使用金额",
			);
			const precision =
				getCurrency(context.currentCurrencyCode)?.decimalPlaces ?? 2;
			if (value.dp() > precision) {
				throw new CorrectionInvalidParamsException(
					`使用金额最多支持 ${precision} 位小数`,
				);
			}
			changes.amount = value;
		}
		if (has("usedAt")) {
			changes.usedAt = parseDateOrThrow(String(rawChanges.usedAt), "使用日期");
			assertTransactedAtInRange(
				changes.usedAt,
				context.now,
				context.ledgerStartedAt,
			);
		}
	}

	if (context.targetType === "INITIAL_HOLDING") {
		if (has("amount")) {
			// 初始金额允许改 0（验收场景 13）；负数/超上限/精度照常拦截
			const value = parseAmountOrThrow(String(rawChanges.amount), "初始金额");
			if (value.isNegative()) {
				throw new CorrectionInvalidParamsException("初始金额不能为负数");
			}
			if (value.gte(AMOUNT_UPPER_LIMIT)) {
				throw new CorrectionInvalidParamsException(
					"初始金额必须小于单笔上限 100,000,000,000",
				);
			}
			const precisionCurrency =
				changes.currencyCode ?? context.currentCurrencyCode;
			const precision =
				getCurrency(precisionCurrency)?.decimalPlaces ??
				getCurrency(context.currentCurrencyCode)?.decimalPlaces ??
				2;
			if (value.dp() > precision) {
				throw new CorrectionInvalidParamsException(
					precision === 0
						? "该币种（如日元/韩元）为整数币种，初始金额不能带小数位"
						: `初始金额最多支持 ${precision} 位小数`,
				);
			}
			changes.amount = value;
		}
		if (has("currencyCode")) {
			const normalized = String(rawChanges.currencyCode).trim().toUpperCase();
			if (!getCurrency(normalized)) {
				throw new CorrectionInvalidParamsException(
					`币种必须是支持的 15 种币种之一，收到：${rawChanges.currencyCode}`,
				);
			}
			changes.currencyCode = normalized;
		}
	}

	return changes;
}

/** 变更后的值是否与原值完全一致（「内容确有变化」V0 判定；逐字段 Decimal 语义比较） */
export function hasEffectiveChange(
	changes: ParsedCorrectionChanges,
	original: {
		currencyCode: string;
		principalAmount?: Prisma.Decimal;
		quantity?: Prisma.Decimal;
		feeAmount?: Prisma.Decimal | null;
		transactedAt?: Date;
		amount?: Prisma.Decimal;
		usedAt?: Date;
	},
): boolean {
	if (
		changes.currencyCode !== undefined &&
		changes.currencyCode !== original.currencyCode
	)
		return true;
	if (
		changes.principalAmount !== undefined &&
		!changes.principalAmount.eq(original.principalAmount!)
	)
		return true;
	if (
		changes.quantity !== undefined &&
		!changes.quantity.eq(original.quantity!)
	)
		return true;
	if (changes.feeProvided) {
		const originalFee = original.feeAmount ?? null;
		const nextFee = changes.feeAmount ?? null;
		if (originalFee === null || nextFee === null) {
			if (originalFee !== nextFee) return true;
		} else if (!nextFee.eq(originalFee)) {
			return true;
		}
	}
	if (
		changes.transactedAt !== undefined &&
		changes.transactedAt.getTime() !== original.transactedAt?.getTime()
	)
		return true;
	if (changes.amount !== undefined && !changes.amount.eq(original.amount!))
		return true;
	if (
		changes.usedAt !== undefined &&
		changes.usedAt.getTime() !== original.usedAt?.getTime()
	)
		return true;
	return false;
}

/** V0 基础校验（方案 §5.1 校验表）：原因非空 + 内容确有变化（日期上下界已在解析期完成） */
export function assertCorrectionBasics(
	reason: string,
	hasChange: boolean,
): void {
	if (!reason || reason.trim().length === 0) {
		throw new CorrectionInvalidParamsException("修改原因必填，请说明更正缘由");
	}
	if (!hasChange) {
		throw new CorrectionInvalidParamsException(
			"更正内容与原记录一致，未发生任何变化，无需提交",
		);
	}
}

/**
 * V4 待确定项拦截矩阵（doc 10:88-91 待确定项本期一律拦截，方案假设 6）：
 * - 使用金额改 0；改大后计划累计使用 > 目标；
 * - COMPLETED 计划改大或改日期；CANCELLED 计划任何使用更正。
 * 全部抛 400 CORRECTION_NOT_ALLOWED。本期 USAGE 入口降级，本函数由单测锁定、M7 接线后复用。
 */
export function assertUsageCorrectionAllowed(input: {
	planStatus: string;
	planTargetAmount: Prisma.Decimal;
	/** 计划累计已使用（PlanAllocation.usedAmount，含本笔） */
	planCumulativeUsed: Prisma.Decimal;
	currentAmount: Prisma.Decimal;
	changes: ParsedCorrectionChanges;
}): void {
	if (input.planStatus === "CANCELLED") {
		throw new CorrectionNotAllowedException(
			"已取消计划的使用记录暂不支持更正（待后续版本支持）",
		);
	}
	if (input.changes.amount !== undefined && input.changes.amount.eq(0)) {
		throw new CorrectionNotAllowedException(
			"使用金额改为 0 暂不支持（如需作废请待后续版本）",
		);
	}
	if (input.changes.usedAt !== undefined && input.planStatus === "COMPLETED") {
		throw new CorrectionNotAllowedException(
			"已完成计划的使用日期修改暂不支持（待后续版本支持）",
		);
	}
	if (input.changes.amount !== undefined) {
		const isIncrease = input.changes.amount.gt(input.currentAmount);
		if (isIncrease && input.planStatus === "COMPLETED") {
			throw new CorrectionNotAllowedException(
				"已完成计划的使用金额调大暂不支持（待后续版本支持）",
			);
		}
		if (isIncrease) {
			const cumulativeAfter = input.planCumulativeUsed
				.sub(input.currentAmount)
				.add(input.changes.amount);
			if (cumulativeAfter.gt(input.planTargetAmount)) {
				throw new CorrectionNotAllowedException(
					"更正后将超过计划目标金额，暂不支持超额使用（请先调整计划目标）",
				);
			}
		}
	}
}

/** 使用更正的分配调整量（doc 14 例 02~05，方案 §5.2 使用改小/改大/补分配三行） */
export interface UsageAllocationDelta {
	/** PlanAllocation.amount 调整量：改小 = −diff（同减回未分配）；补分配 = +supplement；其余 0 */
	amountDelta: Prisma.Decimal;
	/** PlanAllocation.usedAmount 调整量：改小 = −diff、改大 = +diff（只扣增量，验收场景 7） */
	usedAmountDelta: Prisma.Decimal;
	/** 需从未分配余额补入原计划的分配额（> 0 时同次确认整体生效并写 PlanChangeLog） */
	supplement: Prisma.Decimal;
}

/**
 * computeAllocationDelta（方案 §5.1 校验表同一层级的纯函数）：
 * - 改小（diff < 0）：amount 与 usedAmount 同减差额 → 剩余分配不变、差额自然回未分配；
 * - 改大（diff > 0）：先用原剩余分配；不足部分 supplement 从未分配补入并立即使用（例 05）；
 * - 剩余分配是否足够覆盖 supplement 由调用方结合未分配余额校验（V1/V2）。
 */
export function computeAllocationDelta(input: {
	currentAmount: Prisma.Decimal;
	newAmount: Prisma.Decimal;
	remainingAllocation: Prisma.Decimal;
}): UsageAllocationDelta {
	const diff = input.newAmount.sub(input.currentAmount);
	if (diff.lt(0)) {
		// 改小：amount/usedAmount 同减差额（doc 10:24-28 数值反推，方案假设 4）
		return {
			amountDelta: diff,
			usedAmountDelta: diff,
			supplement: new Prisma.Decimal(0),
		};
	}
	if (diff.gt(0)) {
		const fromAllocation = Prisma.Decimal.min(input.remainingAllocation, diff);
		const supplement = diff.sub(fromAllocation);
		return {
			amountDelta: supplement,
			usedAmountDelta: diff,
			supplement,
		};
	}
	return {
		amountDelta: new Prisma.Decimal(0),
		usedAmountDelta: new Prisma.Decimal(0),
		supplement: new Prisma.Decimal(0),
	};
}

// ────────────────────────── 私有辅助 ──────────────────────────

/** 正金额解析：有效数字、> 0、< 单笔上限（money 包 assertAmountLimit 失败转 400） */
function parsePositiveWithLimit(value: string, label: string): Prisma.Decimal {
	const amount = parseAmountOrThrow(value, label);
	try {
		assertAmountLimit(amount);
	} catch {
		throw new CorrectionInvalidParamsException(
			`${label}必须为大于 0 且小于单笔上限 100,000,000,000 的有效数字，收到：${value}`,
		);
	}
	return amount;
}

/** ISO 日期解析（非法字符串 400） */
function parseDateOrThrow(value: string, label: string): Date {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new CorrectionInvalidParamsException(
			`${label}必须是有效的 ISO 8601 日期，收到：${value}`,
		);
	}
	return date;
}

/** 三值自洽校验：RoundToZero 与 calculator 错误语义与录入路径一致 */
function assertSelfConsistentOrThrow(
	principal: Prisma.Decimal,
	rate: Prisma.Decimal,
	quantity: Prisma.Decimal,
	decimalPlaces: 0 | 2,
): void {
	assertRateDecimalPlaces(rate);
	try {
		assertSelfConsistent(principal, rate, quantity, decimalPlaces);
	} catch (error) {
		if (error instanceof TransactionRoundToZeroException) {
			throw new CorrectionInvalidParamsException(
				"按当前本金与汇率计算的到账金额舍入后为 0，已拦截，请调整本金",
			);
		}
		throw error;
	}
}
