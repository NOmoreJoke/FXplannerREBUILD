/**
 * 金额计算标准（纯函数，零 IO）。
 *
 * 规则来源：需求文档 3.4 与 doc 02/05：
 * - 所有金额计算使用十进制运算，中间过程不舍入、不截断；
 * - 仅对最终结果按对应币种精度四舍五入一次；
 * - 正数被舍入为 0 时不得入账；
 * - 除法不先截成固定小数位，再算金额。
 */
import Decimal from "decimal.js";
import { InvalidAmountError, RoundToZeroError } from "./errors.ts";
import { roundToCurrency } from "./round.ts";
import { roundRateTo8 } from "./rate.ts";

// 中间过程全精度：十进制运算精度提升到 32 位有效数字，
// 覆盖「16 位有效数字金额 × 12 位有效数字汇率」的最大精确积（约 28 位），
// 避免默认 20 位精度让中间乘除提前失真。仅影响本包依赖的 decimal.js 实例。
Decimal.set({ precision: 32 });

/**
 * 折算/到账金额 ＝ principal × rate。
 * 中间全精度运算，仅对最终结果按币种精度四舍五入一次；
 * 正数结果被舍入为 0 时抛 RoundToZeroError（不得入账）。
 */
export function finalAmountOf(
	principal: Decimal.Value,
	rate: Decimal.Value,
	decimalPlaces: 0 | 2,
): Decimal {
	const product = new Decimal(principal).mul(new Decimal(rate));
	const rounded = roundToCurrency(product, decimalPlaces);
	if (rounded.isZero() && product.gt(0)) {
		throw new RoundToZeroError();
	}
	return rounded;
}

/**
 * 到账外币金额 ＝ principal ÷ rate（买入填法 A：本金 + 汇率 → 到账）。
 * 与 finalAmountOf（× 方向）对称：除法不先截短，全精度相除后
 * 仅按买入币种精度四舍五入一次；正数结果被舍入为 0 时抛 RoundToZeroError。
 */
export function receivedAmountOf(
	principal: Decimal.Value,
	rate: Decimal.Value,
	decimalPlaces: 0 | 2,
): Decimal {
	const base = new Decimal(principal);
	const quote = new Decimal(rate);
	if (!base.isFinite() || base.lte(0) || !quote.isFinite() || quote.lte(0)) {
		throw new InvalidAmountError("本金与汇率必须为大于 0 的有效数字");
	}
	const quotient = base.div(quote);
	const rounded = roundToCurrency(quotient, decimalPlaces);
	if (rounded.isZero() && quotient.gt(0)) {
		throw new RoundToZeroError();
	}
	return rounded;
}

/**
 * 反算汇率 ＝ principal ÷ received（1 单位外币 ＝ X 本位币）。
 * 对应 doc 05 反算填法：支出本金、实际到账外币金额 → 汇率 = 本金 ÷ 实际到账外币金额。
 * 除法不先截短：全精度相除后按汇率精度（8 位小数）四舍五入一次。
 *
 * @param principal 支出本金（本位币金额，须 > 0）
 * @param received 实际到账外币金额（须 > 0，为 0 则汇率为 0，不合法）
 * @param _decimalPlaces 两笔金额所属币种精度；汇率精度固定 8 位，与币种无关，仅作调用方语义标注
 */
export function impliedRate(
	principal: Decimal.Value,
	received: Decimal.Value,
	_decimalPlaces: 0 | 2,
): Decimal {
	const base = new Decimal(principal);
	const quote = new Decimal(received);
	if (!base.isFinite() || base.lte(0) || !quote.isFinite() || quote.lte(0)) {
		throw new InvalidAmountError("本金与到账金额必须为大于 0 的有效数字");
	}
	return roundRateTo8(base.div(quote));
}
