/**
 * rate-invert 属性与夹具测试（MVP-F0-1 / FX-01 验收）。
 *
 * 覆盖：固定夹具锁定方向（4.7567 → 0.2102297812 等）、
 * 取倒数一次守恒（|r·inv − 1| ≤ r·5e-11）、二次取倒数往返不发散、
 * 零/负/非法字符串/恒等边界、落库范围与舍入归零拦截。
 * oracle 用 decimal.js（64 位有效数字）独立计算倒数和 HALF_UP 舍入。
 */
import { BadGatewayException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import Decimal from "decimal.js";
import { invertQuoteRate } from "./rate-invert";

const THEORY = Decimal.clone({ precision: 64 });
const HALF_UP = Decimal.ROUND_HALF_UP;
const HALF_ULP = THEORY("5e-11");
const MAX_STORABLE_RATE = THEORY("9999999999.9999999999");

/** [2e-10, 1e6] 上取倒数两次的中间和最终结果均可落库。 */
const fcRoundTripRate = fc.oneof(
	fc.integer({ min: 1, max: 1_000_000 }).map(String),
	fc.bigInt({ min: 2n, max: 10_000_000_000_000_000n }).map((units) => {
		const digits = units.toString().padStart(11, "0");
		return `${digits.slice(0, -10)}.${digits.slice(-10)}`;
	}),
);

const fcOverflowRate = fc
	.bigInt({ min: 1n, max: 10_000_000_000n })
	.map((units) => `0.${units.toString().padStart(20, "0")}`);
const fcRoundToZeroRate = fc
	.bigInt({ min: 20_000_000_001n, max: 1_000_000_000_000n })
	.map(String);

describe("invertQuoteRate 固定夹具（FX-01 方向锁定）", () => {
	it("验收夹具：4.7567 → 0.2102297812、4.0572 → 0.2464754018、0.2 → 5（仅一次 HALF_UP 到 10 位）", () => {
		expect(invertQuoteRate("4.7567", "CNY", "TWD")).toBe("0.2102297812");
		expect(invertQuoteRate("4.0572", "HKD", "TWD")).toBe("0.2464754018");
		expect(invertQuoteRate("0.2", "CNY", "XXX")).toBe("5.0000000000");
	});

	it("number 入参经 String 归一后与字符串同结果（JSON 数值无精度引入）", () => {
		expect(invertQuoteRate(4.7567, "CNY", "TWD")).toBe("0.2102297812");
		expect(invertQuoteRate(0.2, "CNY", "XXX")).toBe("5.0000000000");
	});

	it("边界保留：落库范围内极大/极小牌价正确取倒数", () => {
		// 1e10 的倒数 = 1e-10（Decimal(20,10) 最小非零精度，可落库）
		expect(invertQuoteRate("10000000000", "CNY", "XXX")).toBe("0.0000000001");
		// 2e-10 的倒数 = 5e9（10 位整数上限内，可落库）
		expect(invertQuoteRate("0.0000000002", "CNY", "XXX")).toBe(
			"5000000000.0000000000",
		);
	});
});

describe("invertQuoteRate 属性", () => {
	it("可表示域：倒数匹配独立 HALF_UP 结果，且乘积误差不超过半个量化单位传播后的上界", () => {
		const property = fc.property(fcRoundTripRate, (raw) => {
			const value = THEORY(raw);
			const expected = THEORY(1).div(value).toFixed(10, HALF_UP);
			const inverted = invertQuoteRate(raw, "CNY", "XXX");
			expect(inverted).toBe(expected);
			const drift = THEORY(inverted).mul(value).minus(1).abs();
			expect(drift.lte(value.mul(HALF_ULP))).toBe(true);
		});
		fc.assert(property, { numRuns: 300 });
	});

	it("二次取倒数往返不发散：|inv(inv(r)) − r| 在量化误差界内", () => {
		const property = fc.property(fcRoundTripRate, (raw) => {
			const value = THEORY(raw);
			const first = THEORY(invertQuoteRate(raw, "CNY", "XXX"));
			const second = THEORY(
				invertQuoteRate(first.toFixed(10), "CNY", "XXX"),
			);
			// first = 1/r + e，|e| ≤ HALF_ULP → |1/first − r| = r²·|e|/(1 + r·e)。
			// r ≤ 1e6 保证分母为正，再加第二次舍入的 HALF_ULP。
			const bound = value
				.pow(2)
				.mul(HALF_ULP)
				.div(THEORY(1).minus(value.mul(HALF_ULP)))
				.plus(HALF_ULP);
			expect(second.minus(value).abs().lte(bound)).toBe(true);
		});
		fc.assert(property, { numRuns: 300 });
	});

	it("倒数超出落库范围的正报价抛出 BadGatewayException", () => {
		fc.assert(
			fc.property(fcOverflowRate, (raw) => {
				const expected = THEORY(1).div(raw).toDecimalPlaces(10, HALF_UP);
				expect(expected.gt(MAX_STORABLE_RATE)).toBe(true);
				const invert = () => invertQuoteRate(raw, "CNY", "TWD");
				expect(invert).toThrowError(BadGatewayException);
				expect(invert).toThrowError(/超出落库范围/);
			}),
			{ numRuns: 300 },
		);
	});

	it("倒数舍入归零的正报价抛出 BadGatewayException", () => {
		fc.assert(
			fc.property(fcRoundToZeroRate, (raw) => {
				const expected = THEORY(1).div(raw).toDecimalPlaces(10, HALF_UP);
				expect(expected.isZero()).toBe(true);
				const invert = () => invertQuoteRate(raw, "CNY", "TWD");
				expect(invert).toThrowError(BadGatewayException);
				expect(invert).toThrowError(/舍入为 0/);
			}),
			{ numRuns: 300 },
		);
	});
});

describe("invertQuoteRate 拒绝性（502 语义）", () => {
	it("零 / 负数 / 非法字符串 / 科学计数法 → BadGatewayException（无效牌价）", () => {
		for (const bad of ["0", "0.0000", "-3", "-0.01", "abc", "", "NaN", "Infinity", "1e-15"]) {
			expect(() => invertQuoteRate(bad, "CNY", "TWD")).toThrowError(
				BadGatewayException,
			);
			expect(() => invertQuoteRate(bad, "CNY", "TWD")).toThrowError(
				/无效牌价/,
			);
		}
	});

	it("取倒数后舍入归零（raw > 2e10，1/raw < 0.5×10^-10）→ BadGatewayException；恰为 2e10 时 HALF_UP 进位为 1e-10", () => {
		// 恰好 0.5 ulp：1/2e10 = 5e-11，HALF_UP → 0.0000000001（可落库，不拒绝）
		expect(invertQuoteRate("20000000000", "CNY", "TWD")).toBe("0.0000000001");
		// 严格小于 0.5 ulp：1/20000000001 ≈ 4.9999999975e-11 → 舍入为 0 → 拒绝
		expect(() =>
			invertQuoteRate("20000000001", "CNY", "TWD"),
		).toThrowError(/舍入为 0/);
	});

	it("取倒数后超出 Decimal(20,10) 落库范围（raw ≤ 1e-10）→ BadGatewayException", () => {
		// W2-01 反例：1e-10 的倒数恰为 1e10，已有 11 位整数。
		expect(() => invertQuoteRate("0.0000000001", "CNY", "TWD")).toThrowError(
			/超出落库范围/,
		);
		expect(() => invertQuoteRate("0.00000000001", "CNY", "TWD")).toThrowError(
			/超出落库范围/,
		);
	});
});
