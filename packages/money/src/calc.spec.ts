import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { assertValidRate, RATE_DECIMAL_PLACES, roundRateTo8 } from "./rate.ts";
import { InvalidRateError } from "./errors.ts";
import { finalAmountOf, impliedRate, receivedAmountOf } from "./calc.ts";
import { InvalidAmountError, RoundToZeroError } from "./errors.ts";

/** 独立理论值：64 位精度全精度算完再舍一次，与被测实现（32 位精度）互为对照 */
const THEORY = Decimal.clone({ precision: 64 });
const HALF_UP = Decimal.ROUND_HALF_UP;

describe("roundRateTo8（汇率 8 位舍入）", () => {
	it("来源报价四舍五入保留 8 位小数（验收 4：7.123456789123 → 7.12345679）", () => {
		expect(roundRateTo8("7.123456789123").toString()).toBe("7.12345679");
	});

	it("HALF_UP 边界与去尾", () => {
		expect(roundRateTo8("7.123456785").toString()).toBe("7.12345679");
		expect(roundRateTo8("7.123456784").toString()).toBe("7.12345678");
		expect(roundRateTo8("7.248").toString()).toBe("7.248");
	});

	it("汇率精度常量为 8", () => {
		expect(RATE_DECIMAL_PLACES).toBe(8);
	});
});

describe("assertValidRate（汇率有效性）", () => {
	it("大于 0 的有效数字通过", () => {
		expect(() => assertValidRate("7.12345679")).not.toThrow();
		expect(() => assertValidRate("0.00000001")).not.toThrow();
		expect(() => assertValidRate(1)).not.toThrow();
	});

	it("0、负数、NaN、Infinity 抛 InvalidRateError", () => {
		expect(() => assertValidRate("0")).toThrow(InvalidRateError);
		expect(() => assertValidRate("-7.2")).toThrow(InvalidRateError);
		expect(() => assertValidRate(Number.NaN)).toThrow(InvalidRateError);
		expect(() => assertValidRate(Number.POSITIVE_INFINITY)).toThrow(
			InvalidRateError,
		);
	});
});

describe("finalAmountOf（金额 × 汇率，最终舍一次）", () => {
	it("初始成本按本位币精度舍入（验收 6：1000 美元 × 7.20 = 7,200.00 人民币）", () => {
		expect(finalAmountOf("1000", "7.20", 2).toFixed(2)).toBe("7200.00");
	});

	it("初始成本按本位币精度取整（日元本位币：1000 × 152.12345678 → 152123）", () => {
		expect(finalAmountOf("1000", "152.12345678", 0).toString()).toBe("152123");
	});

	it("正数舍 0 拦截（验收 5：0.01 × 0.5，日元 0 位精度舍入为 0）", () => {
		expect(() => finalAmountOf("0.01", "0.5", 0)).toThrow(RoundToZeroError);
		expect(() => finalAmountOf("0.001", "1", 2)).toThrow(RoundToZeroError);
	});

	it("0.005 类边界在 2 位精度下舍为 0.01，不拦截", () => {
		expect(finalAmountOf("0.01", "0.5", 2).toString()).toBe("0.01");
	});

	it("大额上限内金额 × 汇率与全精度理论值一致", () => {
		const principal = "99999999999.99";
		const rate = "9.99999999";
		const expected = new THEORY(principal)
			.mul(rate)
			.toDecimalPlaces(2, HALF_UP);
		expect(finalAmountOf(principal, rate, 2).eq(expected)).toBe(true);
		expect(finalAmountOf(principal, rate, 2).toFixed(2)).toBe(
			"999999998999.90",
		);
	});
});

describe("impliedRate（到账 ÷ 本金，反算汇率）", () => {
	it("本金 ÷ 到账（doc 05：72,480 元 ÷ 10,000 美元 → 7.248）", () => {
		expect(impliedRate("72480", "10000", 2).toString()).toBe("7.248");
	});

	it("除法不先截短：100 ÷ 13.8 → 8 位舍入 7.24637681", () => {
		expect(impliedRate("100", "13.80", 2).toString()).toBe("7.24637681");
	});

	it("1 ÷ 3 反算汇率为 8 位精度而非提前截短（0.33333333）", () => {
		expect(impliedRate("1", "3", 2).toString()).toBe("0.33333333");
	});

	it("本金或到账金额非正数时抛 InvalidAmountError", () => {
		expect(() => impliedRate("0", "100", 2)).toThrow(InvalidAmountError);
		expect(() => impliedRate("100", "0", 2)).toThrow(InvalidAmountError);
		expect(() => impliedRate("-100", "10", 2)).toThrow(InvalidAmountError);
		expect(() => impliedRate("100", Number.NaN, 2)).toThrow(InvalidAmountError);
	});
});

describe("receivedAmountOf（本金 ÷ 汇率，到账金额，最终舍一次）", () => {
	it("doc 05 例：72,480 元 ÷ 7.2480 = 10,000.00 美元（2 位币种）", () => {
		expect(receivedAmountOf("72480", "7.248", 2).toFixed(2)).toBe("10000.00");
	});

	it("除法不先截短：1000 ÷ 7.31 全精度商后舍 2 位 = 136.80", () => {
		// 全精度商 136.79890533...，若先截短到 4 位再舍会得到同一结果，
		// 用理论值互为对照：64 位精度全除后舍 2 位
		const expected = new THEORY("1000").div("7.31").toDecimalPlaces(2, HALF_UP);
		expect(receivedAmountOf("1000", "7.31", 2).eq(expected)).toBe(true);
		expect(receivedAmountOf("1000", "7.31", 2).toFixed(2)).toBe("136.80");
	});

	it("0 位币种（日元）：10000 ÷ 152.12345678 → 66（四舍五入取整）", () => {
		const expected = new THEORY("10000")
			.div("152.12345678")
			.toDecimalPlaces(0, HALF_UP);
		expect(receivedAmountOf("10000", "152.12345678", 0).eq(expected)).toBe(
			true,
		);
		expect(receivedAmountOf("10000", "152.12345678", 0).toString()).toBe("66");
	});

	it("0 位币种（韩元）小数进位边界：1 ÷ 2 → 1", () => {
		expect(receivedAmountOf("1", "2", 0).toString()).toBe("1");
	});

	it("正数舍 0 拦截：0.01 ÷ 2（0 位币种）与 0.001 ÷ 2（2 位币种）均拦截", () => {
		expect(() => receivedAmountOf("0.01", "2", 0)).toThrow(RoundToZeroError);
		expect(() => receivedAmountOf("0.001", "2", 2)).toThrow(RoundToZeroError);
	});

	it("2 位币种 0.005 边界不拦截：0.01 ÷ 2 = 0.01", () => {
		expect(receivedAmountOf("0.01", "2", 2).toString()).toBe("0.01");
	});

	it("本金或汇率非正数、非有限数时抛 InvalidAmountError", () => {
		expect(() => receivedAmountOf("0", "7.248", 2)).toThrow(InvalidAmountError);
		expect(() => receivedAmountOf("-72480", "7.248", 2)).toThrow(
			InvalidAmountError,
		);
		expect(() => receivedAmountOf("72480", "0", 2)).toThrow(InvalidAmountError);
		expect(() => receivedAmountOf("72480", "-7.248", 2)).toThrow(
			InvalidAmountError,
		);
		expect(() => receivedAmountOf(Number.NaN, "7.248", 2)).toThrow(
			InvalidAmountError,
		);
		expect(() =>
			receivedAmountOf("72480", Number.POSITIVE_INFINITY, 2),
		).toThrow(InvalidAmountError);
	});
});

describe("链式计算中间不舍入（验收 7）", () => {
	it("多步乘除的最终结果与「全精度算完再舍一次」一致", () => {
		// 场景：来源报价 → 8 位采用汇率 → 买入到账 → 再按到账金额反算复核
		const rawRate = "7.123456789123";
		const adopted = roundRateTo8(rawRate); // 唯一允许的汇率舍入：8 位
		expect(adopted.toString()).toBe("7.12345679");

		const principal = "12345.67";
		const amount = finalAmountOf(principal, adopted, 2);
		expect(amount.toFixed(2)).toBe("87943.85");

		// 理论值：64 位精度下 principal × adopted 全精度，最后舍一次
		const theoretical = new THEORY(principal)
			.mul(adopted)
			.toDecimalPlaces(2, HALF_UP);
		expect(amount.eq(theoretical)).toBe(true);

		// 用舍入后的到账金额反算汇率：与「舍入后金额 ÷ 到账外币全精度商再舍 8 位」的理论值一致；
		// 差值 7.12345705 - 7.12345679 ≈ 2.6e-7 恰好等于金额 2 位舍入带来的影响，
		// 证明中间没有除固定小数位截短之类的额外舍入损耗
		const backRate = impliedRate(amount.toFixed(2), principal, 2);
		const backTheoretical = new THEORY(amount.toFixed(2))
			.div(principal)
			.toDecimalPlaces(8, HALF_UP);
		expect(backRate.eq(backTheoretical)).toBe(true);
		expect(backRate.toString()).toBe("7.12345705");
	});

	it("99999.99 × 7.12345679 全精度理论值一致（712345.61）", () => {
		const principal = "99999.99";
		const rate = "7.12345679";
		const theoretical = new THEORY(principal)
			.mul(rate)
			.toDecimalPlaces(2, HALF_UP);
		const actual = finalAmountOf(principal, rate, 2);
		expect(actual.eq(theoretical)).toBe(true);
		expect(actual.toFixed(2)).toBe("712345.61");
	});

	it("买入 → 使用链：两步金额各按币种精度舍一次，与理论值一致", () => {
		// 第一步：72,480 元买入 → 到账 10,000 美元（doc 05）
		// 第二步：使用 2,500.25 美元，成本按汇率 7.25123456 折算人民币
		const rate = "7.25123456";
		const usage = finalAmountOf("2500.25", rate, 2);
		const theoretical = new THEORY("2500.25")
			.mul(rate)
			.toDecimalPlaces(2, HALF_UP);
		expect(usage.eq(theoretical)).toBe(true);
		expect(usage.toFixed(2)).toBe("18129.90");
	});
});
