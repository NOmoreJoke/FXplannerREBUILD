/**
 * 买入交易录入的纯函数层（方案 §4.1/§4.6）：入参解析、精度校验、
 * 双向自洽校验与交易日期上下界校验。无 IO、无状态，事务编排在 TransactionService。
 *
 * 规则来源：doc 05 / doc 14 §2 与技术方案 §4：
 * - 金额字段 DTO 强制 string；解析统一 try/catch + isFinite + 上限校验（对齐 plan.service 先例）；
 * - 三值（本金/汇率/到账）自洽按「双向其一」判定：receivedAmountOf(p, r) == q
 *   或 impliedRate(p, q) == r——填法 A 的 quantity 是舍入后的近似值，
 *   严格 impliedRate 等值会系统性误杀合法录入（评审修正）；
 * - 交易日期按 UTC+8 日界判断「今天」（doc 14：记录日期按 UTC+8 判断），
 *   与 plan 模块的 utcMidnight（UTC 0 点排期日）属业务语义差异，UTC+8 以常量注入。
 */
import { HttpException, HttpStatus } from "@nestjs/common";
import {
	assertAmountLimit,
	AMOUNT_UPPER_LIMIT,
	impliedRate,
	InvalidAmountError,
	receivedAmountOf,
	RoundToZeroError,
} from "@fxplanner-new/money";
import { Prisma } from "@prisma/client";

/** 采用汇率的小数位上限（与 money 包 RATE_DECIMAL_PLACES 同源语义，超位数 400 不静默截断） */
const RATE_DECIMAL_PLACES_MAX = 8;

/** UTC+8 时区偏移（毫秒）；「今天」日界口径以常量注入，后续确认后统一替换 */
export const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 一天的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 模块参数错误（400 INVALID_TRANSACTION_PARAMS）：币种/金额/汇率/数量/自洽/日期校验
 * 任一失败均以此抛出，风格与 plan.service 的 PlanInvalidParamsException 一致。
 */
export class TransactionInvalidParamsException extends HttpException {
	constructor(message: string) {
		super(
			{ code: "INVALID_TRANSACTION_PARAMS", message },
			HttpStatus.BAD_REQUEST,
		);
	}
}

/** 到账金额正数舍 0（400 ROUND_TO_ZERO）：不得入账，必须拦截提示 */
export class TransactionRoundToZeroException extends HttpException {
	constructor() {
		super(
			{
				code: "ROUND_TO_ZERO",
				message:
					"按当前本金与汇率计算的到账金额舍入后为 0，已拦截，请调整本金或汇率",
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}

/**
 * 基础金额解析：有效数字字符串 → Decimal；非法字符串（含 "abc"、"Infinity"）
 * 统一转 400，不泄漏堆栈（对齐 plan.service parseDecimalOrThrow 先例）。
 */
export function parseAmountOrThrow(
	value: string,
	label: string,
): Prisma.Decimal {
	try {
		const amount = new Prisma.Decimal(value);
		if (!amount.isFinite()) {
			throw new Error("not finite");
		}
		return amount;
	} catch {
		throw new TransactionInvalidParamsException(
			`${label}必须是有效的数字字符串，收到：${value}`,
		);
	}
}

/** 解析正金额：有效数字、> 0、< 单笔上限 1e11（money 包校验，统一转 400） */
export function parsePositiveAmount(
	value: string,
	label: string,
): Prisma.Decimal {
	const amount = parseAmountOrThrow(value, label);
	try {
		assertAmountLimit(amount);
	} catch {
		throw new TransactionInvalidParamsException(
			`${label}必须为大于 0 且小于单笔上限 100,000,000,000 的有效数字，收到：${value}`,
		);
	}
	return amount;
}

/**
 * 解析手续费：缺省（undefined/null）= 未知（null）；提供则有效数字、≥ 0、< 单笔上限。
 * 「0」= 无手续费，与未知严格区分（doc 05 / 方案 §4.2）。
 */
export function parseFeeAmount(
	value: string | null | undefined,
): Prisma.Decimal | null {
	if (value === undefined || value === null) {
		return null;
	}
	const amount = parseAmountOrThrow(value, "手续费");
	if (amount.isNegative()) {
		throw new TransactionInvalidParamsException("手续费不能为负数");
	}
	if (amount.gte(AMOUNT_UPPER_LIMIT)) {
		throw new TransactionInvalidParamsException(
			"手续费必须小于单笔上限 100,000,000,000",
		);
	}
	return amount;
}

/** 汇率小数位校验：≤ 8 位（超位数 400 提示修改，不静默截断；方案 §4.3） */
export function assertRateDecimalPlaces(rate: Prisma.Decimal): void {
	if (rate.decimalPlaces() > RATE_DECIMAL_PLACES_MAX) {
		throw new TransactionInvalidParamsException(
			"汇率最多支持 8 位小数，请修改后重试",
		);
	}
}

/** 到账数量小数位校验：≤ 币种精度（JPY/KRW 必须为整数；方案 §4.6） */
export function assertQuantityPrecision(
	quantity: Prisma.Decimal,
	decimalPlaces: 0 | 2,
): void {
	if (quantity.decimalPlaces() > decimalPlaces) {
		throw new TransactionInvalidParamsException(
			decimalPlaces === 0
				? "该币种（如日元/韩元）为整数币种，到账数量不能带小数位"
				: "到账数量最多支持 2 位小数",
		);
	}
}

/**
 * 三值双向自洽校验（方案 §4.1，评审修正版）——满足其一即通过：
 * - 方向一（填法 A 口径）：receivedAmountOf(本金, 汇率, 精度) == 到账数量；
 * - 方向二（填法 B 口径）：impliedRate(本金, 到账) == 汇率。
 * 两方向均不满足 → 400 INVALID_TRANSACTION_PARAMS（message 指明需按填法重新核对）。
 * 方向一计算中触发正数舍 0 → 400 ROUND_TO_ZERO（方案 §4.6，优先于方向二判定）。
 */
export function assertSelfConsistent(
	principal: Prisma.Decimal,
	rate: Prisma.Decimal,
	quantity: Prisma.Decimal,
	decimalPlaces: 0 | 2,
): void {
	try {
		if (receivedAmountOf(principal, rate, decimalPlaces).eq(quantity)) {
			return;
		}
	} catch (error) {
		if (error instanceof RoundToZeroError) {
			throw new TransactionRoundToZeroException();
		}
		if (error instanceof InvalidAmountError) {
			// 解析层已保证本金/汇率为正有限数，此处仅为防御性兜底
			throw new TransactionInvalidParamsException(
				"本金与汇率必须为大于 0 的有效数字",
			);
		}
		throw error;
	}
	if (impliedRate(principal, quantity, decimalPlaces).eq(rate)) {
		return;
	}
	throw new TransactionInvalidParamsException(
		"本金、汇率与到账数量不匹配：请按其中一种填法重新核对（本金+汇率 → 到账，或 本金+到账 → 汇率）",
	);
}

/** 某时刻在 UTC+8 口径下的「当日 0 点」对应的 UTC 时刻 */
export function utc8DayStart(instant: Date): Date {
	const shifted = instant.getTime() + UTC8_OFFSET_MS;
	return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - UTC8_OFFSET_MS);
}

/**
 * 交易日期上下界校验（方案 §4.6）：
 * - UTC+8 口径不晚于今天（允许补录历史；上界按日历日窗口比较）；
 * - 不早于账本起点 ledgerStartedAt（未设置时跳过；下界按 UTC+8 日历日粒度——
 *   起点当日任意时刻可补录，早于起点所在日才拒绝。对齐 usage-calculator
 *   assertUsedAtInRange 同步修正，前端两处均按日期提交 T00:00Z）。
 * 两类失败的 message 必须可区分（接口测试 §8.2 #11 断言依据）。
 */
export function assertTransactedAtInRange(
	transactedAt: Date,
	now: Date,
	ledgerStartedAt: Date | null,
): void {
	const todayStart = utc8DayStart(now).getTime();
	if (transactedAt.getTime() >= todayStart + DAY_MS) {
		throw new TransactionInvalidParamsException(
			"交易日期不能晚于今天（UTC+8 口径）",
		);
	}
	if (
		ledgerStartedAt &&
		transactedAt.getTime() < utc8DayStart(ledgerStartedAt).getTime()
	) {
		throw new TransactionInvalidParamsException("交易日期不能早于账本起点");
	}
}
