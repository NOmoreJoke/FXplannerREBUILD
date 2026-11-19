/**
 * calc / rate 模块属性测试（fast-check）。
 *
 * 依据 AGENTS.md「属性测试」防愚弄约定与 docs/VERIFY.md L1，覆盖四类不变量：
 * - 往返守恒（Round-trip）：本金→到账→反算汇率、到账→折算回本金，误差在量化界内；
 * - 不变量（Invariants）：分拆合计守恒（分片舍入合计与整笔舍入差 ≤ 1 个最小计价单位）；
 * - 幂等性（Idempotency）：汇率 8 位舍入重复执行结果稳定；
 * - 等价性（Equivalence）：与独立 64 位精度理论 oracle 逐位一致，杜绝 IEEE-754 漂移。
 *
 * 生成器全程以十进制字符串/整数分构造数值，任何一步都不经过 IEEE-754 中转。
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import Decimal from "decimal.js";
import { finalAmountOf, impliedRate, receivedAmountOf } from "./calc.ts";
import { roundRateTo8, assertValidRate } from "./rate.ts";
import { InvalidAmountError, InvalidRateError, RoundToZeroError } from "./errors.ts";

/** 独立理论对照：64 位精度（实现为 32 位） */
const THEORY = Decimal.clone({ precision: 64 });
const HALF_UP = Decimal.ROUND_HALF_UP;

/** 正金额（整数分，≤ 1e10 元），转十进制字符串数值 */
const fcMoney: fc.Arbitrary<Decimal> = fc
	.integer({ min: 1, max: 1_000_000_000_000 })
	.map((cents) => new Decimal(cents).div(100));

/**
 * 汇率：(0, 999.99999999999]，11 位小数字符串构造，过滤 0。
 * 第 9~11 位小数使 roundRateTo8 的属性真正执行 HALF_UP（覆盖 4/5/6 边界），
 * 而不是对已合规 8 位输入做恒等回显。
 */
const fcRate: fc.Arbitrary<Decimal> = fc
	.record({
		intPart: fc.integer({ min: 0, max: 999 }),
		frac: fc.integer({ min: 0, max: 99_999_999_999 }),
	})
	.map(({ intPart, frac }) => new Decimal(`${intPart}.${String(frac).padStart(11, "0")}`))
	.filter((rate) => rate.gt(0));

/** 汇率对：保证可买数量 ≥ 1（q = p/r ≥ 1），约束往返误差界有意义 */
const fcFxPair: fc.Arbitrary<[Decimal, Decimal]> = fc
	.tuple(fcMoney, fcRate)
	.filter(([principal, rate]) => principal.div(rate).gte(1));

describe("finalAmountOf 属性（本金 × 汇率 → 到账本位币）", () => {
	it("等价性：与 64 位精度理论值逐位一致；理论舍入为 0 时必须抛 RoundToZeroError", () => {
		const property = fc.property(
			fcMoney,
			fcRate,
			fc.constantFrom(0 as const, 2 as const),
			(principal, rate, dp) => {
				const product = THEORY(principal).mul(THEORY(rate));
				const oracle = product.toDecimalPlaces(dp, HALF_UP);
				if (oracle.isZero()) {
					expect(() => finalAmountOf(principal, rate, dp)).toThrow(
						RoundToZeroError,
					);
				} else {
					expect(finalAmountOf(principal, rate, dp).eq(oracle)).toBe(true);
				}
			},
		);
		fc.assert(property, { numRuns: 300 });
	});

	it("恒等汇率守恒：rate = 1 时结果恰为本金按精度舍入；舍入为 0 时同样拦截", () => {
		const property = fc.property(
			fcMoney,
			fc.constantFrom(0 as const, 2 as const),
			(principal, dp) => {
				const expected = principal.toDecimalPlaces(dp, HALF_UP);
				if (expected.isZero()) {
					expect(() => finalAmountOf(principal, 1, dp)).toThrow(
						RoundToZeroError,
					);
				} else {
					expect(finalAmountOf(principal, 1, dp).eq(expected)).toBe(true);
				}
			},
		);
		fc.assert(property, { numRuns: 200 });
	});

	it("分拆合计守恒：a + b = p 时，分片舍入合计与整笔舍入之差 ≤ 1 个最小计价单位", () => {
		const property = fc.property(
			fc.integer({ min: 1, max: 100_000_000_000 }).chain((totalCents) =>
				fc
					.integer({ min: 0, max: totalCents })
					.map((k) => ({ totalCents, k })),
			),
			fcRate.filter((rate) => rate.lte(100)),
			({ totalCents, k }, rate) => {
				const partA = new Decimal(k).div(100);
				const partB = new Decimal(totalCents - k).div(100);
				const total = new Decimal(totalCents).div(100);
				// 三个 oracle 任一舍入为 0 则该实现会抛 RoundToZeroError，跳过守恒断言
				const oracleRoundsZero = (x: Decimal) =>
					THEORY(x).mul(THEORY(rate)).toDecimalPlaces(2, HALF_UP).isZero();
				if (
					oracleRoundsZero(partA) ||
					oracleRoundsZero(partB) ||
					oracleRoundsZero(total)
				) {
					return;
				}
				const sum = finalAmountOf(partA, rate, 2).plus(
					finalAmountOf(partB, rate, 2),
				);
				const diff = sum.minus(finalAmountOf(total, rate, 2)).abs();
				// 三项均为 0.01 网格值且逐项舍入误差 ≤ 0.005：差值只能是 0.01 的整数倍且 ≤ 0.01
				expect(diff.lte(new Decimal("0.01"))).toBe(true);
			},
		);
		fc.assert(property, { numRuns: 300 });
	});
});

describe("receivedAmountOf 属性（本金 ÷ 汇率 → 到账外币）", () => {
	it("等价性：与 64 位精度理论值逐位一致；理论舍入为 0 时必须抛 RoundToZeroError", () => {
		const property = fc.property(
			fcMoney,
			fcRate,
			fc.constantFrom(0 as const, 2 as const),
			(principal, rate, dp) => {
				const quotient = THEORY(principal).div(THEORY(rate));
				const oracle = quotient.toDecimalPlaces(dp, HALF_UP);
				if (oracle.isZero()) {
					expect(() => receivedAmountOf(principal, rate, dp)).toThrow(
						RoundToZeroError,
					);
				} else {
					expect(receivedAmountOf(principal, rate, dp).eq(oracle)).toBe(true);
				}
			},
		);
		fc.assert(property, { numRuns: 300 });
	});

	it("非法输入拒绝：非正数本金/汇率一律 InvalidAmountError", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("0", "-5", "-0.01", "abc"),
				fc.constantFrom("1", "7.24"),
				(principal, rate) => {
					expect(() => receivedAmountOf(principal, rate, 2)).toThrow(
						InvalidAmountError,
					);
				},
			),
			{ numRuns: 50 },
		);
	});
});

describe("计算入口类型化错误契约", () => {
	it("finalAmountOf / impliedRate 非数字字符串拒绝：不裸抛底层 DecimalError", () => {
		expect(() => finalAmountOf("abc", "1", 2)).toThrow(InvalidAmountError);
		expect(() => finalAmountOf("1", "abc", 2)).toThrow(InvalidAmountError);
		expect(() => impliedRate("abc", "1", 2)).toThrow(InvalidAmountError);
		expect(() => impliedRate("1", "abc", 2)).toThrow(InvalidAmountError);
	});
});

describe("impliedRate 属性（本金 ÷ 到账 → 反算汇率）", () => {
	it("等价性：与 64 位精度理论值（8 位 HALF_UP）逐位一致", () => {
		const property = fc.property(
			fcMoney,
			fcMoney,
			(principal, received) => {
				const oracle = THEORY(principal)
					.div(THEORY(received))
					.toDecimalPlaces(8, HALF_UP);
				expect(impliedRate(principal, received, 2).eq(oracle)).toBe(true);
			},
		);
		fc.assert(property, { numRuns: 300 });
	});

	it("往返守恒：impliedRate(p, receivedAmountOf(p, r)) 距 r 的偏差在量化误差界内", () => {
		const property = fc.property(
			fcFxPair,
			fc.constantFrom(0 as const, 2 as const),
			([principal, rate], dp) => {
				const received = receivedAmountOf(principal, rate, dp);
				const implied = impliedRate(principal, received, 2);
				// received = round(p/r) = p/r ± 0.5×10^-dp，则 |implied_raw − r| = r·|e|/(q + e)
				// 量化界：r × 0.5×10^-dp / (q − 0.5×10^-dp) + 8 位舍入的 5e-9
				const q = THEORY(principal).div(THEORY(rate));
				const halfUnit = new Decimal("0.5").mul(new Decimal(10).pow(-dp));
				const bound = THEORY(rate)
					.mul(halfUnit)
					.div(q.minus(halfUnit))
					.plus(new Decimal("5e-9"));
				expect(implied.minus(rate).abs().lte(bound)).toBe(true);
			},
		);
		fc.assert(property, { numRuns: 300 });
	});

	it("本金往返守恒：finalAmountOf(receivedAmountOf(p, r)) 距 p 的偏差 ≤ r·0.5×10^-dp + 0.005", () => {
		const property = fc.property(
			fcFxPair,
			fc.constantFrom(0 as const, 2 as const),
			([principal, rate], dp) => {
				const received = receivedAmountOf(principal, rate, dp);
				const back = finalAmountOf(received, rate, 2);
				// received 舍入误差 e1（≤0.5×10^-dp）放大 r 倍 + 回程舍入 e2（≤0.005）
				const halfUnit = new Decimal("0.5").mul(new Decimal(10).pow(-dp));
				const bound = rate.mul(halfUnit).plus(new Decimal("0.005"));
				expect(back.minus(principal).abs().lte(bound)).toBe(true);
			},
		);
		fc.assert(property, { numRuns: 300 });
	});
});

describe("roundRateTo8 / assertValidRate 属性", () => {
	it("roundRateTo8 非数字字符串拒绝：不裸抛底层 DecimalError，统一 InvalidRateError", () => {
		expect(() => roundRateTo8("abc")).toThrow(InvalidRateError);
	});
	it("等价性：8 位 HALF_UP 与 64 位理论值一致", () => {
		const property = fc.property(fcRate, (rate) => {
			const oracle = THEORY(rate).toDecimalPlaces(8, HALF_UP);
			expect(roundRateTo8(rate).eq(oracle)).toBe(true);
		});
		fc.assert(property, { numRuns: 300 });
	});

	it("幂等性：round8(round8(x)) === round8(x)", () => {
		const property = fc.property(fcRate, (rate) => {
			const once = roundRateTo8(rate);
			expect(roundRateTo8(once).eq(once)).toBe(true);
		});
		fc.assert(property, { numRuns: 300 });
	});

	it("不变量：仅「有限且 > 0」放行；0/负数/NaN/Infinity 抛 InvalidRateError", () => {
		fc.assert(
			fc.property(fcRate, (rate) => {
				expect(() => assertValidRate(rate)).not.toThrow();
			}),
			{ numRuns: 200 },
		);
		fc.assert(
			fc.property(
				fc.constantFrom("0", "-1", "-0.00000001", "NaN", "Infinity"),
				(rate) => {
					expect(() => assertValidRate(rate)).toThrow(InvalidRateError);
				},
			),
			{ numRuns: 30 },
		);
	});
});
