/**
 * transaction-calculator 单元测试（技术方案 §8.1）。
 * 覆盖点：双向自洽校验（填法 A/B、非整除不误杀、两方向均不满足报错、舍 0 优先）、
 * 金额解析（非数字/超上限）、小数位校验、feeAmount 三态、日期上下界（固定时钟）。
 * 接口层 DTO 校验路径由 test/api/transaction.spec.ts #13 承担。
 */
import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
	assertQuantityPrecision,
	assertRateDecimalPlaces,
	assertSelfConsistent,
	assertTransactedAtInRange,
	parseAmountOrThrow,
	parseFeeAmount,
	parsePositiveAmount,
	TransactionInvalidParamsException,
	TransactionRoundToZeroException,
	utc8DayStart,
} from "./transaction-calculator";

/** 取出 HttpException 的错误码（模块统一 { code, message } 错误体） */
function errorCode(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		return (error as { getResponse: () => { code: string } }).getResponse()
			.code;
	}
	throw new Error("预期抛出异常，但未抛出");
}

describe("assertSelfConsistent（三值双向自洽，方案 §4.1）", () => {
	it("填法 A 提交（本金+汇率→到账，方向一成立）通过：doc 05 例 72,480 ÷ 7.2480 = 10,000", () => {
		expect(() =>
			assertSelfConsistent(
				new Prisma.Decimal("72480"),
				new Prisma.Decimal("7.248"),
				new Prisma.Decimal("10000"),
				2,
			),
		).not.toThrow();
	});

	it("填法 B 提交（本金+到账→汇率，方向二成立）通过：1000 ÷ 136.80 → 7.30994152", () => {
		expect(() =>
			assertSelfConsistent(
				new Prisma.Decimal("1000"),
				new Prisma.Decimal("7.30994152"),
				new Prisma.Decimal("136.80"),
				2,
			),
		).not.toThrow();
	});

	it("双向「满足其一」即可：方向二成立而方向一不成立也放行（10 → 1e-8 汇率反算误差）", () => {
		// 方向一：10 ÷ 0.00000001 = 1,000,000,000.00 ≠ 1,000,000,000.01（不成立）
		// 方向二：impliedRate(10, 1000000000.01) = 0.00000001（成立）
		expect(() =>
			assertSelfConsistent(
				new Prisma.Decimal("10"),
				new Prisma.Decimal("0.00000001"),
				new Prisma.Decimal("1000000000.01"),
				2,
			),
		).not.toThrow();
	});

	it("非整除例不被误杀：1000 ÷ 7.31 → 136.80（方向一成立、方向二不成立，评审修正）", () => {
		// quantity 是 round₂(1000/7.31) 的近似值，反算汇率 7.30994152 ≠ 7.31，
		// 严格 impliedRate 等值会系统性误杀合法录入
		expect(() =>
			assertSelfConsistent(
				new Prisma.Decimal("1000"),
				new Prisma.Decimal("7.31"),
				new Prisma.Decimal("136.80"),
				2,
			),
		).not.toThrow();
	});

	it("三值两方向均不满足 → 400 INVALID_TRANSACTION_PARAMS（用户只改了到账数量）", () => {
		const throwFn = () =>
			assertSelfConsistent(
				new Prisma.Decimal("1000"),
				new Prisma.Decimal("7.31"),
				new Prisma.Decimal("999"),
				2,
			);
		expect(throwFn).toThrow(TransactionInvalidParamsException);
		expect(errorCode(throwFn)).toBe("INVALID_TRANSACTION_PARAMS");
	});

	it("方向一计算触发正数舍 0 → 400 ROUND_TO_ZERO（优先于方向二判定，方案 §4.6）", () => {
		const throwFn = () =>
			assertSelfConsistent(
				new Prisma.Decimal("0.001"),
				new Prisma.Decimal("2"),
				new Prisma.Decimal("0.01"),
				2,
			);
		expect(throwFn).toThrow(TransactionRoundToZeroException);
		expect(errorCode(throwFn)).toBe("ROUND_TO_ZERO");
	});

	it("0 位币种（JPY）按整数精度自洽：10,000 ÷ 152.12345678 → 66", () => {
		expect(() =>
			assertSelfConsistent(
				new Prisma.Decimal("10000"),
				new Prisma.Decimal("152.12345678"),
				new Prisma.Decimal("66"),
				0,
			),
		).not.toThrow();
	});
});

describe("金额解析（方案 §4.6：有效数字、> 0、< 1e11）", () => {
	it("合法金额解析为 Decimal", () => {
		expect(parsePositiveAmount("72480.00", "本金金额").toString()).toBe(
			"72480",
		);
		expect(parseAmountOrThrow("0.01", "金额").toString()).toBe("0.01");
	});

	it("非数字字符串拒绝（400，不泄漏堆栈）", () => {
		expect(() => parseAmountOrThrow("abc", "本金金额")).toThrow(
			TransactionInvalidParamsException,
		);
		expect(() => parsePositiveAmount("Infinity", "本金金额")).toThrow(
			TransactionInvalidParamsException,
		);
		expect(() => parsePositiveAmount("", "本金金额")).toThrow(
			TransactionInvalidParamsException,
		);
	});

	it("≤ 0 拒绝", () => {
		expect(() => parsePositiveAmount("0", "本金金额")).toThrow(
			TransactionInvalidParamsException,
		);
		expect(() => parsePositiveAmount("-1", "本金金额")).toThrow(
			TransactionInvalidParamsException,
		);
	});

	it("科学计数法超上限拒绝（1e999 可解析但 ≥ 1e11；上限开区间 1e11 恰等也拒绝）", () => {
		expect(() => parsePositiveAmount("1e999", "本金金额")).toThrow(
			TransactionInvalidParamsException,
		);
		expect(() => parsePositiveAmount("100000000000", "本金金额")).toThrow(
			TransactionInvalidParamsException,
		);
		// 范围内的科学计数法合法：1e2 = 100
		expect(parsePositiveAmount("1e2", "本金金额").toString()).toBe("100");
	});
});

describe("小数位校验（方案 §4.3/§4.6）", () => {
	it("汇率 ≤ 8 位通过、9 位拒绝（超位数 400 不静默截断）", () => {
		expect(() =>
			assertRateDecimalPlaces(new Prisma.Decimal("7.12345678")),
		).not.toThrow();
		expect(() =>
			assertRateDecimalPlaces(new Prisma.Decimal("7.123456789")),
		).toThrow(TransactionInvalidParamsException);
	});

	it("到账数量：2 位币种最多 2 位小数、0 位币种（JPY）必须整数", () => {
		expect(() =>
			assertQuantityPrecision(new Prisma.Decimal("100.12"), 2),
		).not.toThrow();
		expect(() =>
			assertQuantityPrecision(new Prisma.Decimal("100.123"), 2),
		).toThrow(TransactionInvalidParamsException);
		expect(() =>
			assertQuantityPrecision(new Prisma.Decimal("66"), 0),
		).not.toThrow();
		expect(() =>
			assertQuantityPrecision(new Prisma.Decimal("66.6"), 0),
		).toThrow(TransactionInvalidParamsException);
	});
});

describe("parseFeeAmount 三态（方案 §4.2：缺省=未知(null)，\"0\"=无手续费）", () => {
	it("缺省（undefined / null）→ null（未知 ≠ 0）", () => {
		expect(parseFeeAmount(undefined)).toBeNull();
		expect(parseFeeAmount(null)).toBeNull();
	});

	it("\"0\" → 0（无手续费）；数字 → 该值", () => {
		expect(parseFeeAmount("0")?.toString()).toBe("0");
		expect(parseFeeAmount("42.00")?.toString()).toBe("42");
	});

	it("负数、非数字、≥ 1e11 拒绝", () => {
		expect(() => parseFeeAmount("-1")).toThrow(
			TransactionInvalidParamsException,
		);
		expect(() => parseFeeAmount("abc")).toThrow(
			TransactionInvalidParamsException,
		);
		expect(() => parseFeeAmount("100000000000")).toThrow(
			TransactionInvalidParamsException,
		);
	});
});

describe("日期上下界（方案 §4.6，UTC+8 日界；vi.setSystemTime 固定时钟防午夜 flaky）", () => {
	// 固定「现在」：UTC 2026-01-20 10:00 = UTC+8 2026-01-20 18:00，「今天」= 01-20
	const NOW = new Date("2026-01-20T10:00:00.000Z");

	function freezeNow() {
		vi.useFakeTimers({ toFake: ["Date"], now: NOW.getTime() });
	}
	function unfreezeNow() {
		vi.useRealTimers();
	}

	it("utc8DayStart：UTC+8 当日 0 点对应 UTC 前一日 16:00", () => {
		expect(utc8DayStart(NOW).toISOString()).toBe(
			"2026-01-19T16:00:00.000Z",
		);
	});

	it("UTC+8 今天最晚一刻通过；明天 0 点（UTC+8）拒绝「不能晚于今天」", () => {
		freezeNow();
		try {
			// 今天（UTC+8 01-20）23:59:59.999 → 通过
			expect(() =>
				assertTransactedAtInRange(
					new Date("2026-01-20T15:59:59.999Z"),
					new Date(),
					null,
				),
			).not.toThrow();
			// UTC+8 01-21 00:00 = UTC 01-20T16:00Z → 拒绝
			const throwFn = () =>
				assertTransactedAtInRange(
					new Date("2026-01-20T16:00:00.000Z"),
					new Date(),
					null,
				);
			expect(throwFn).toThrow(TransactionInvalidParamsException);
			expect(errorCode(throwFn)).toBe("INVALID_TRANSACTION_PARAMS");
			expect(throwFn).toThrow(/晚于今天/);
		} finally {
			unfreezeNow();
		}
	});

	it("晚于今天（固定时钟下的次日）与早于账本起点的 message 可区分（接口测试 §8.2 #11 断言依据）", () => {
		freezeNow();
		try {
			const lateMessage = getThrownMessage(() =>
				assertTransactedAtInRange(
					new Date("2026-01-21T00:00:00.000Z"),
					new Date(),
					new Date("2026-01-10T00:00:00.000Z"),
				),
			);
			expect(lateMessage).toContain("晚于今天");

			const earlyMessage = getThrownMessage(() =>
				assertTransactedAtInRange(
					new Date("2026-01-09T00:00:00.000Z"),
					new Date(),
					new Date("2026-01-10T00:00:00.000Z"),
				),
			);
			expect(earlyMessage).toContain("账本起点");
			expect(earlyMessage).not.toBe(lateMessage);
		} finally {
			unfreezeNow();
		}
	});

	it("早于账本起点拒绝；恰为账本起点（边界含）通过", () => {
		freezeNow();
		try {
			const ledgerStart = new Date("2026-01-10T00:00:00.000Z");
			expect(() =>
				assertTransactedAtInRange(
					new Date("2026-01-09T23:59:59.999Z"),
					new Date(),
					ledgerStart,
				),
			).toThrow(/账本起点/);
			expect(() =>
				assertTransactedAtInRange(
					new Date("2026-01-10T00:00:00.000Z"),
					new Date(),
					ledgerStart,
				),
			).not.toThrow();
		} finally {
			unfreezeNow();
		}
	});

	it("账本起点未设置（null）不校验下界：任意历史日期通过", () => {
		freezeNow();
		try {
			expect(() =>
				assertTransactedAtInRange(
					new Date("2000-01-01T00:00:00.000Z"),
					new Date(),
					null,
				),
			).not.toThrow();
		} finally {
			unfreezeNow();
		}
	});

	it("service 同款调用口径（new Date() 走固定时钟）：昨天通过、明天拒绝", () => {
		freezeNow();
		try {
			const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
			expect(() =>
				assertTransactedAtInRange(yesterday, new Date(), null),
			).not.toThrow();
			const tomorrow = new Date(Date.now() + 48 * 60 * 60 * 1000);
			expect(() =>
				assertTransactedAtInRange(tomorrow, new Date(), null),
			).toThrow(/晚于今天/);
		} finally {
			unfreezeNow();
		}
	});
});

/** 取出被抛出 HttpException 的 message（供 message 区分断言） */
function getThrownMessage(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		return (error as { getResponse: () => { message: string } }).getResponse()
			.message;
	}
	throw new Error("预期抛出异常，但未抛出");
}
