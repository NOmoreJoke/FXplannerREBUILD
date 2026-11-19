/**
 * round 模块属性测试（fast-check）。
 *
 * 依据 AGENTS.md「属性测试」防愚弄约定与 docs/VERIFY.md L1，覆盖四类不变量：
 * - 幂等性（Idempotency）：重复舍入结果稳定，不因二次舍入漂移；
 * - 精度不退化（Invariants）：与独立 64 位精度理论值逐位对照，杜绝 IEEE-754 浮点漂移；
 * - 不变量（Invariants）：非正数拒绝、正数舍入为 0 拦截、上限区间精确；
 * - 等价性（Equivalence）：实现与理论 oracle 完全一致。
 *
 * 生成器全程以十进制字符串构造数值，任何一步都不经过 IEEE-754 中转。
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
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

/** 独立理论对照：64 位精度（实现为 32 位）；对精确乘法两者必须逐位一致 */
const THEORY = Decimal.clone({ precision: 64 });
const HALF_UP = Decimal.ROUND_HALF_UP;

/**
 * 合法金额字符串：≤9 位整数 + 可选 4 位小数（含 0，用于拒绝性属性）。
 * 第 3~4 位小数使 2 位/0 位舍入属性真正执行 HALF_UP（覆盖 4/5/6 边界），
 * 而不是对已合规输入做恒等回显。
 */
const fcAmount: fc.Arbitrary<string> = fc
	.integer({ min: 0, max: 999_999_999 })
	.chain((intPart) =>
		fc
			.option(fc.integer({ min: 0, max: 9999 }), { nil: null })
			.map((frac4) =>
				frac4 === null
					? String(intPart)
					: `${intPart}.${String(frac4).padStart(4, "0")}`,
			),
	);

describe("roundToCurrency 属性", () => {
	it("等价性：与 64 位精度理论 HALF_UP 逐位一致（精度不退化为浮点漂移）", () => {
		const property = fc.property(
			fcAmount,
			fc.constantFrom(0 as const, 2 as const),
			(amount, dp) => {
				const impl = roundToCurrency(amount, dp);
				const oracle = THEORY(amount).toDecimalPlaces(dp, HALF_UP);
				expect(impl.eq(oracle)).toBe(true);
			},
		);
		fc.assert(property, { numRuns: 300 });
	});

	it("幂等性：round(round(x)) === round(x)", () => {
		const property = fc.property(
			fcAmount,
			fc.constantFrom(0 as const, 2 as const),
			(amount, dp) => {
				const once = roundToCurrency(amount, dp);
				const twice = roundToCurrency(once, dp);
				expect(twice.eq(once)).toBe(true);
			},
		);
		fc.assert(property, { numRuns: 300 });
	});

	it("JPY/KRW 是仅有的 0 位小数币种，其余币种均为 2 位", () => {
		const zeroDp = CURRENCIES.filter((c) => c.decimalPlaces === 0).map(
			(c) => c.code,
		);
		expect(zeroDp).toEqual(["JPY", "KRW"]);
		expect(CURRENCIES.every((c) => c.decimalPlaces === 0 || c.decimalPlaces === 2)).toBe(
			true,
		);
	});

	it("0 位小数舍入结果必为整数（JPY/KRW 整数币种）", () => {
		const property = fc.property(fcAmount, (amount) => {
			const rounded = roundToCurrency(amount, 0);
			expect(rounded.mod(1).isZero()).toBe(true);
		});
		fc.assert(property, { numRuns: 200 });
	});
});

describe("roundToCurrency 类型化错误契约", () => {
	it("非数字字符串拒绝：不裸抛底层 DecimalError，统一 InvalidAmountError", () => {
		expect(() => roundToCurrency("abc", 2)).toThrow(InvalidAmountError);
		expect(() => roundToCurrency("abc", 0)).toThrow(InvalidAmountError);
	});
});

describe("assertPositiveAmount 属性", () => {
	it("不变量：仅对「有限且 > 0」放行，0/负数/非有效数字一律 InvalidAmountError", () => {
		const positive = fcAmount.filter((a) => THEORY(a).gt(0));
		const reject = fc.constantFrom("0", "0.00", "-1", "-0.01", "abc", "NaN");
		fc.assert(
			fc.property(positive, (amount) => {
				expect(() => assertPositiveAmount(amount)).not.toThrow();
			}),
			{ numRuns: 200 },
		);
		fc.assert(
			fc.property(reject, (amount) => {
				expect(() => assertPositiveAmount(amount)).toThrow(InvalidAmountError);
			}),
			{ numRuns: 50 },
		);
	});
});

describe("assertAmountLimit 属性", () => {
	it("不变量：0 < x < 上限放行；x ≥ 上限抛 AmountLimitExceededError（含恰好等于）", () => {
		// 以 0.01 步长在上限两侧 ±10 元内采样，覆盖开区间边界
		const nearBoundary = fc
			.integer({ min: -1000, max: 1000 })
			.map((offsetCents) =>
				THEORY(AMOUNT_UPPER_LIMIT).plus(THEORY(offsetCents).div(100)),
			);
		fc.assert(
			fc.property(nearBoundary, (amount) => {
				if (amount.gte(AMOUNT_UPPER_LIMIT)) {
					expect(() => assertAmountLimit(amount)).toThrow(
						AmountLimitExceededError,
					);
				} else {
					expect(() => assertAmountLimit(amount)).not.toThrow();
				}
			}),
			{ numRuns: 300 },
		);
	});
});

describe("assertNotRoundToZero 属性", () => {
	it("不变量：正数舍入为 0 必拦截；判定与理论 HALF_UP 结果一致", () => {
		const property = fc.property(
			fcAmount,
			fc.constantFrom(0 as const, 2 as const),
			(amount, dp) => {
				const value = THEORY(amount);
				const roundsToZero =
					value.gt(0) && value.toDecimalPlaces(dp, HALF_UP).isZero();
				if (roundsToZero) {
					expect(() => assertNotRoundToZero(amount, dp)).toThrow(
						RoundToZeroError,
					);
				} else {
					expect(() => assertNotRoundToZero(amount, dp)).not.toThrow();
				}
			},
		);
		fc.assert(property, { numRuns: 300 });
	});
});
