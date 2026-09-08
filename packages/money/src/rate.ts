/**
 * 汇率精度规则（纯函数，零 IO）。
 *
 * 规则来源：需求文档 3.3 与 doc 02：
 * - 汇率统一按「1 单位外币 ＝ X 本位币」表达；
 * - 采用的汇率按来源报价四舍五入保留 8 位小数，显示与计算都用该值；
 * - 汇率必须是大于 0 的有效数字。
 */
import Decimal from "decimal.js";
import { InvalidRateError } from "./errors";

/** 采用汇率的小数位（固定 8 位，与币种精度无关） */
export const RATE_DECIMAL_PLACES = 8;

/** 汇率按来源报价四舍五入到 8 位小数（ROUND_HALF_UP） */
export function roundRateTo8(rate: Decimal.Value): Decimal {
	return new Decimal(rate).toDecimalPlaces(
		RATE_DECIMAL_PLACES,
		Decimal.ROUND_HALF_UP,
	);
}

/** 汇率必须为大于 0 的有效数字，否则抛 InvalidRateError */
export function assertValidRate(rate: Decimal.Value): void {
	const value = new Decimal(rate);
	if (!value.isFinite() || value.lte(0)) {
		throw new InvalidRateError();
	}
}
