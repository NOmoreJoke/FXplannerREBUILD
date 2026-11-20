import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
	AMOUNT_UPPER_LIMIT,
	assertAmountLimit,
	assertNotRoundToZero,
	assertPositiveAmount,
	roundToCurrency,
} from "./round.ts";
import {
	AmountLimitExceededError,
	InvalidAmountError,
	RoundToZeroError,
} from "./errors.ts";
import { CURRENCIES } from "./currencies.ts";

describe("roundToCurrency（按币种精度舍入一次）", () => {
	it("JPY/KRW（0 位小数）取整，其余币种保留 2 位", () => {
		for (const currency of CURRENCIES) {
			if (currency.decimalPlaces === 0) {
				expect(roundToCurrency("100.5", 0).toString()).toBe("101");
				expect(roundToCurrency("100.4", 0).toString()).toBe("100");
			} else {
				expect(roundToCurrency("10.005", 2).toString()).toBe("10.01");
			}
		}
		expect(roundToCurrency("1234.567", 2).toString()).toBe("1234.57");
	});

	it("ROUND_HALF_UP：5 及以上进一位，不采用逢双才进位（doc 02：10.005 → 10.01）", () => {
		// 银行家舍入会把 10.005 记为 10.00、1.005 记为 1.00，这里必须进位
		expect(roundToCurrency("10.005", 2).toString()).toBe("10.01");
		expect(roundToCurrency("1.005", 2).toString()).toBe("1.01");
		expect(roundToCurrency("2.005", 2).toString()).toBe("2.01");
		expect(roundToCurrency("0.005", 2).toString()).toBe("0.01");
		expect(roundToCurrency("100.5", 0).toString()).toBe("101");
	});

	it("只舍入一次，不改变已合规数值", () => {
		expect(roundToCurrency("7200", 2).toString()).toBe("7200");
		expect(roundToCurrency("7200.00", 2).toString()).toBe("7200");
	});
});

describe("assertNotRoundToZero（正数舍 0 拦截）", () => {
	it("正数舍入后为 0 时抛 RoundToZeroError", () => {
		// doc 02：初始金额大于 0 但成本舍入为 0 时，不提交
		expect(() => assertNotRoundToZero("0.004", 2)).toThrow(RoundToZeroError);
		expect(() => assertNotRoundToZero("0.4", 0)).toThrow(RoundToZeroError);
		expect(() => assertNotRoundToZero(new Decimal("0.0001"), 2)).toThrow(
			RoundToZeroError,
		);
	});

	it("正数舍入后非 0（恰为 0.005 类边界）不拦截", () => {
		expect(() => assertNotRoundToZero("0.005", 2)).not.toThrow();
		expect(() => assertNotRoundToZero("0.5", 0)).not.toThrow();
		expect(() => assertNotRoundToZero("0.01", 2)).not.toThrow();
	});

	it("舍零校验对无法解析的金额返回 InvalidAmountError 及其错误码", () => {
		expect(() => assertNotRoundToZero("0.005x", 2)).toThrow(
			expect.objectContaining({
				constructor: InvalidAmountError,
				code: "MONEY_INVALID_AMOUNT",
			}),
		);
	});
});

describe("assertPositiveAmount（金额有效性）", () => {
	it("大于 0 的有效数字通过", () => {
		expect(() => assertPositiveAmount("0.01")).not.toThrow();
		expect(() => assertPositiveAmount(1000)).not.toThrow();
		expect(() => assertPositiveAmount("99999999999.99")).not.toThrow();
	});

	it("0、负数、NaN、Infinity 拒绝", () => {
		expect(() => assertPositiveAmount("0")).toThrow(InvalidAmountError);
		expect(() => assertPositiveAmount("-0.01")).toThrow(InvalidAmountError);
		expect(() => assertPositiveAmount(-1000)).toThrow(InvalidAmountError);
		expect(() => assertPositiveAmount(Number.NaN)).toThrow(InvalidAmountError);
		expect(() => assertPositiveAmount(Number.POSITIVE_INFINITY)).toThrow(
			InvalidAmountError,
		);
	});
});

describe("assertAmountLimit（单笔上限）", () => {
	it("0 < 金额 < 100,000,000,000 通过（含 99999999999.99 边界）", () => {
		expect(() => assertAmountLimit("0.01")).not.toThrow();
		expect(() => assertAmountLimit("99999999999.99")).not.toThrow();
		expect(AMOUNT_UPPER_LIMIT.toString()).toBe("100000000000");
	});

	it("达到或超过 100,000,000,000 抛 AmountLimitExceededError（不截断保存）", () => {
		expect(() => assertAmountLimit("100000000000")).toThrow(
			AmountLimitExceededError,
		);
		expect(() => assertAmountLimit("100000000000.01")).toThrow(
			AmountLimitExceededError,
		);
	});

	it("0、负数、NaN、Infinity 抛 InvalidAmountError", () => {
		expect(() => assertAmountLimit("0")).toThrow(InvalidAmountError);
		expect(() => assertAmountLimit("-1")).toThrow(InvalidAmountError);
		expect(() => assertAmountLimit(Number.NaN)).toThrow(InvalidAmountError);
		expect(() => assertAmountLimit(Number.POSITIVE_INFINITY)).toThrow(
			InvalidAmountError,
		);
	});

	it("上限校验对无法解析的金额返回 InvalidAmountError 及其错误码", () => {
		expect(() => assertAmountLimit("99999999999.99x")).toThrow(
			expect.objectContaining({
				constructor: InvalidAmountError,
				code: "MONEY_INVALID_AMOUNT",
			}),
		);
	});
});
