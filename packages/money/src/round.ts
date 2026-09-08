/**
 * 金额舍入与校验规则（纯函数，零 IO）。
 *
 * 规则来源：需求文档 3.2/3.4 与 doc 02「金额和小数怎么处理」：
 * - 四舍五入采用「5 及以上进一位」（ROUND_HALF_UP），不采用逢双才进位；
 * - 日元/韩元整数（0 位），其余币种最多 2 位小数；
 * - 单笔金额上限：0 < amount < 100,000,000,000（各币种自身单位），不截断保存；
 * - 正数被舍入为 0 时不得入账。
 */
import Decimal from "decimal.js";
import {
	AmountLimitExceededError,
	InvalidAmountError,
	RoundToZeroError,
} from "./errors";

/** 单笔金额上限（开区间，不含） */
export const AMOUNT_UPPER_LIMIT = new Decimal("100000000000");

/**
 * 按币种精度四舍五入一次（ROUND_HALF_UP）。
 * 例：10.005 @2 位 → 10.01；100.5 @0 位（日元）→ 101。
 */
export function roundToCurrency(
	amount: Decimal.Value,
	decimalPlaces: 0 | 2,
): Decimal {
	return new Decimal(amount).toDecimalPlaces(
		decimalPlaces,
		Decimal.ROUND_HALF_UP,
	);
}

/**
 * 正数舍入后为 0 必须拦截（不得入账）。
 * 仅针对正数：非正数的合法性由 assertPositiveAmount 负责。
 */
export function assertNotRoundToZero(
	positive: Decimal.Value,
	decimalPlaces: 0 | 2,
): void {
	const value = new Decimal(positive);
	if (value.gt(0) && roundToCurrency(value, decimalPlaces).isZero()) {
		throw new RoundToZeroError();
	}
}

/** 金额必须为有效数字且 > 0，否则抛 InvalidAmountError */
export function assertPositiveAmount(amount: Decimal.Value): void {
	const value = new Decimal(amount);
	if (!value.isFinite() || value.lte(0)) {
		throw new InvalidAmountError();
	}
}

/**
 * 单笔金额上限校验：必须满足 0 < amount < 100,000,000,000。
 * - 非有效数字或 ≤ 0 → InvalidAmountError；
 * - ≥ 上限 → AmountLimitExceededError（提示修改，不截断保存）。
 */
export function assertAmountLimit(amount: Decimal.Value): void {
	const value = new Decimal(amount);
	if (!value.isFinite() || value.lte(0)) {
		throw new InvalidAmountError();
	}
	if (value.gte(AMOUNT_UPPER_LIMIT)) {
		throw new AmountLimitExceededError();
	}
}
