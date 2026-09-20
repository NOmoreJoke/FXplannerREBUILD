/**
 * 更正计算器单测（corrections 技术方案 §8.1）：
 * - parseCorrectionChanges：白名单、精度、日期边界、三值自洽、手续费三态；
 * - hasEffectiveChange / assertCorrectionBasics：原因必填与「内容确有变化」；
 * - assertUsageCorrectionAllowed：V4 拦截矩阵（doc 10 待确定项，方案假设 6）；
 * - computeAllocationDelta：使用改小/改大/补分配（doc 14 例 02~05）。
 * 无 IO：日期校验所需的 now/ledgerStartedAt 显式注入。
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
	assertCorrectionBasics,
	assertUsageCorrectionAllowed,
	computeAllocationDelta,
	hasEffectiveChange,
	parseCorrectionChanges,
	type ParseChangesContext,
} from "./correction-calculator";

const d = (value: string | number) => new Prisma.Decimal(value);

/** 固定时钟：2026-09-20（周日）08:00 UTC；账本起点 9/1 */
const NOW = new Date("2026-09-20T08:00:00.000Z");
const LEDGER_START = new Date("2026-09-01T00:00:00.000Z");

/** TRANSACTION 解析上下文（doc 05 例口径：72,480 本金 / 7.248 汇率 / 10,000 数量，方向一自洽；fee 未知） */
function txnContext(
	overrides: Partial<ParseChangesContext> = {},
): ParseChangesContext {
	return {
		targetType: "TRANSACTION",
		now: NOW,
		ledgerStartedAt: LEDGER_START,
		currentCurrencyCode: "USD",
		currentExchangeRate: d("7.24800000"),
		original: {
			principalAmount: d("72480.00"),
			quantity: d("10000.0000"),
			feeAmount: null,
		},
		...overrides,
	};
}

/** INITIAL_HOLDING 解析上下文 */
function holdingContext(
	overrides: Partial<ParseChangesContext> = {},
): ParseChangesContext {
	return {
		targetType: "INITIAL_HOLDING",
		now: NOW,
		ledgerStartedAt: LEDGER_START,
		currentCurrencyCode: "USD",
		currentExchangeRate: d(1),
		original: {
			principalAmount: d(0),
			quantity: d(0),
			feeAmount: null,
		},
		...overrides,
	};
}

describe("parseCorrectionChanges 白名单与三态", () => {
	it("TRANSACTION 白名单外字段 → 400 INVALID_CORRECTION_PARAMS", () => {
		expect(() =>
			parseCorrectionChanges(
				{ exchangeRate: "7.5", reason: "x" } as Record<string, unknown>,
				txnContext(),
			),
		).toThrowError(/不允许修改字段/);
	});

	it("TRANSACTION 全字段解析：币种大写规范化、金额/数量/日期逐项落位", () => {
		// 自洽组合：76,104 = 7.248 × 10,500（方向一精确成立）
		const changes = parseCorrectionChanges(
			{
				currencyCode: "cad",
				principalAmount: "76104.00",
				quantity: "10500.00",
				transactedAt: "2026-09-02T00:00:00.000Z",
			} as Record<string, unknown>,
			txnContext({ currentCurrencyCode: "USD" }),
		);
		expect(changes.currencyCode).toBe("CAD");
		expect(changes.principalAmount!.eq(d("76104.00"))).toBe(true);
		expect(changes.quantity!.eq(d("10500.00"))).toBe(true);
		expect(changes.transactedAt!.toISOString()).toBe(
			"2026-09-02T00:00:00.000Z",
		);
		expect(changes.feeProvided).toBe(false);
	});

	it("手续费三态：缺省 = 不修改；字符串 = 补录金额；null = 改回未知", () => {
		const untouched = parseCorrectionChanges(
			{} as Record<string, unknown>,
			txnContext(),
		);
		expect(untouched.feeProvided).toBe(false);

		const recorded = parseCorrectionChanges(
			{ feeAmount: "20.00" } as Record<string, unknown>,
			txnContext(),
		);
		expect(recorded.feeProvided).toBe(true);
		expect(recorded.feeAmount!.eq(d("20.00"))).toBe(true);

		const backToUnknown = parseCorrectionChanges(
			{ feeAmount: null } as Record<string, unknown>,
			txnContext(),
		);
		expect(backToUnknown.feeProvided).toBe(true);
		expect(backToUnknown.feeAmount).toBeNull();
	});

	it("INITIAL_HOLDING 白名单：只允许 amount / currencyCode；USAGE 只允许 amount / usedAt", () => {
		expect(() =>
			parseCorrectionChanges(
				{ transactedAt: NOW.toISOString() } as Record<string, unknown>,
				holdingContext(),
			),
		).toThrowError(/不允许修改字段/);
		expect(() =>
			parseCorrectionChanges(
				{ currencyCode: "HKD" } as Record<string, unknown>,
				{
					targetType: "USAGE",
					now: NOW,
					ledgerStartedAt: LEDGER_START,
					currentCurrencyCode: "USD",
					currentExchangeRate: d(1),
					original: { principalAmount: d(0), quantity: d(0), feeAmount: null },
				},
			),
		).toThrowError(/不允许修改字段/);
	});
});

describe("parseCorrectionChanges 精度与边界（V0 静态部分）", () => {
	it("本金 > 4 位小数 → 400；手续费负数 → 400；数量超币种精度（JPY）→ 400", () => {
		expect(() =>
			parseCorrectionChanges(
				{ principalAmount: "100.00005" } as Record<string, unknown>,
				txnContext(),
			),
		).toThrowError(/本金金额最多支持 4 位小数/);
		expect(() =>
			parseCorrectionChanges(
				{ feeAmount: "-1" } as Record<string, unknown>,
				txnContext(),
			),
		).toThrowError(/手续费不能为负数/);
		expect(() =>
			parseCorrectionChanges(
				{ quantity: "100.5" } as Record<string, unknown>,
				txnContext({ currentCurrencyCode: "JPY" }),
			),
		).toThrowError(/整数币种/);
	});

	it("交易日期晚于今天（UTC+8）→ 400；早于账本起点 → 400（message 可区分）", () => {
		expect(() =>
			parseCorrectionChanges(
				{ transactedAt: "2026-09-21T00:00:00.000Z" } as Record<string, unknown>,
				txnContext(),
			),
		).toThrowError(/不能晚于今天/);
		expect(() =>
			parseCorrectionChanges(
				{ transactedAt: "2026-08-31T00:00:00.000Z" } as Record<string, unknown>,
				txnContext(),
			),
		).toThrowError(/不能早于账本起点/);
	});

	it("改本金后与原汇率/数量不自洽 → 400；本金+数量同改为自洽组合则通过", () => {
		// 只改本金到 76000：方向一 76000/7.248 ≠ 10000、方向二 impliedRate(76000,10000)=7.6 ≠ 7.248 → 拒
		expect(() =>
			parseCorrectionChanges(
				{ principalAmount: "76000.00" } as Record<string, unknown>,
				txnContext(),
			),
		).toThrowError(/不匹配/);
		// 本金 + 数量同改（填法 A）：76,104 ÷ 7.248 = 10,500 精确 → 通过
		const ok = parseCorrectionChanges(
			{ principalAmount: "76104.00", quantity: "10500.00" } as Record<
				string,
				unknown
			>,
			txnContext(),
		);
		expect(ok.principalAmount!.eq(d("76104.00"))).toBe(true);
		expect(ok.quantity!.eq(d("10500.00"))).toBe(true);
	});

	it("改数量后与原汇率/本金不自洽 → 400（数量更正需连带本金使三值保持录入域）", () => {
		expect(() =>
			parseCorrectionChanges(
				{ quantity: "10500.00" } as Record<string, unknown>,
				txnContext(),
			),
		).toThrowError(/不匹配/);
	});

	it(
		"unitCost 容量与溢出防御由 transaction/account 模块单测锁定；汇率固定下自洽域内 unitCost 恒≈汇率，此处不再重复",
	);

	it("INITIAL_HOLDING 金额允许 0（验收场景 13）；负数与超精度照常拦截", () => {
		const zero = parseCorrectionChanges(
			{ amount: "0" } as Record<string, unknown>,
			holdingContext(),
		);
		expect(zero.amount!.eq(0)).toBe(true);
		expect(() =>
			parseCorrectionChanges(
				{ amount: "-5" } as Record<string, unknown>,
				holdingContext(),
			),
		).toThrowError(/不能为负数/);
		expect(() =>
			parseCorrectionChanges(
				{ amount: "10.005" } as Record<string, unknown>,
				holdingContext(),
			),
		).toThrowError(/最多支持 2 位小数/);
	});
});

describe("hasEffectiveChange 与 assertCorrectionBasics（V0）", () => {
	it("无变化 = false（含 fee 显式同值）；手续费 null ↔ 0 语义区分", () => {
		const noChange = { currencyCode: "USD" } as Record<string, unknown>;
		expect(
			hasEffectiveChange(parseCorrectionChanges(noChange, txnContext()), {
				currencyCode: "USD",
				principalAmount: d("7800.00"),
				quantity: d("1000.0000"),
				feeAmount: null,
				transactedAt: new Date("2026-09-01T00:00:00.000Z"),
			}),
		).toBe(false);

		// 原值未知（null）→ 更正为 0（有变化）；原值 0 → 改回未知（有变化）
		const toZero = parseCorrectionChanges(
			{ feeAmount: "0.00" } as Record<string, unknown>,
			txnContext(),
		);
		expect(
			hasEffectiveChange(toZero, {
				currencyCode: "USD",
				principalAmount: d("7800.00"),
				quantity: d("1000.0000"),
				feeAmount: null,
				transactedAt: new Date("2026-09-01T00:00:00.000Z"),
			}),
		).toBe(true);

		const toUnknown = parseCorrectionChanges(
			{ feeAmount: null } as Record<string, unknown>,
			txnContext(),
		);
		expect(
			hasEffectiveChange(toUnknown, {
				currencyCode: "USD",
				principalAmount: d("7800.00"),
				quantity: d("1000.0000"),
				feeAmount: d(0),
				transactedAt: new Date("2026-09-01T00:00:00.000Z"),
			}),
		).toBe(true);
	});

	it("原因空 / 内容无变化 → 400（message 可区分）", () => {
		expect(() => assertCorrectionBasics("   ", true)).toThrowError(/原因必填/);
		expect(() => assertCorrectionBasics("改错了", false)).toThrowError(
			/未发生任何变化/,
		);
	});
});

describe("assertUsageCorrectionAllowed（V4 拦截矩阵，doc 10 待确定项）", () => {
	const base = {
		planStatus: "ACTIVE",
		planTargetAmount: d("10000"),
		planCumulativeUsed: d("4000"),
		currentAmount: d("4000"),
	};

	it("使用金额改 0 → 拦截", () => {
		expect(() =>
			assertUsageCorrectionAllowed({
				...base,
				changes: { amount: d(0), feeProvided: false },
			}),
		).toThrowError(/改为 0 暂不支持/);
	});

	it("CANCELLED 计划任何更正 → 拦截（先于改 0 判定）", () => {
		expect(() =>
			assertUsageCorrectionAllowed({
				...base,
				planStatus: "CANCELLED",
				changes: { amount: d("3500"), feeProvided: false },
			}),
		).toThrowError(/已取消计划/);
	});

	it("COMPLETED 计划改大 / 改日期 → 拦截；改小放行（验收场景 11）", () => {
		expect(() =>
			assertUsageCorrectionAllowed({
				...base,
				planStatus: "COMPLETED",
				changes: { amount: d("4500"), feeProvided: false },
			}),
		).toThrowError(/已完成计划的使用金额调大/);
		expect(() =>
			assertUsageCorrectionAllowed({
				...base,
				planStatus: "COMPLETED",
				changes: {
					usedAt: new Date("2026-09-05T00:00:00.000Z"),
					feeProvided: false,
				},
			}),
		).toThrowError(/已完成计划的使用日期/);
		expect(() =>
			assertUsageCorrectionAllowed({
				...base,
				planStatus: "COMPLETED",
				changes: { amount: d("3600"), feeProvided: false },
			}),
		).not.toThrow();
	});

	it("改大后计划累计使用 > 目标 → 拦截（超目标）", () => {
		// 4000 → 4300、目标 4200：累计 4300 > 4200 → 拦
		expect(() =>
			assertUsageCorrectionAllowed({
				...base,
				planTargetAmount: d("4200"),
				changes: { amount: d("4300"), feeProvided: false },
			}),
		).toThrowError(/超过计划目标/);
		// 累计不超目标放行：4000 − 4000 + 4200 = 4200 ≤ 4200
		expect(() =>
			assertUsageCorrectionAllowed({
				...base,
				planTargetAmount: d("4200"),
				changes: { amount: d("4200"), feeProvided: false },
			}),
		).not.toThrow();
	});
});

describe("computeAllocationDelta（doc 14 例 02~05）", () => {
	it("例 02 改小：amount 与 usedAmount 同减差额、剩余分配不变、无补分配", () => {
		// 误录 4000 → 400：diff = −3600
		const delta = computeAllocationDelta({
			currentAmount: d("4000"),
			newAmount: d("400"),
			remainingAllocation: d("6000"),
		});
		expect(delta.amountDelta.eq(d("-3600"))).toBe(true);
		expect(delta.usedAmountDelta.eq(d("-3600"))).toBe(true);
		expect(delta.supplement.eq(0)).toBe(true);
		// 剩余分配不变：amount+Δ − (used+Δ) = 原剩余
		const remainingAfter = d("10000")
			.add(delta.amountDelta)
			.sub(d("4000").add(delta.usedAmountDelta));
		expect(remainingAfter.eq(d("6000"))).toBe(true);
	});

	it("例 03 改大且原剩余分配足够：仅 usedAmount +diff（只扣增量）、amount 不动", () => {
		const delta = computeAllocationDelta({
			currentAmount: d("4000"),
			newAmount: d("5000"),
			remainingAllocation: d("2000"),
		});
		expect(delta.amountDelta.eq(0)).toBe(true);
		expect(delta.usedAmountDelta.eq(d("1000"))).toBe(true);
		expect(delta.supplement.eq(0)).toBe(true);
	});

	it("例 05 改大且原剩余分配不足：补分配 = 缺口、amount +supplement、usedAmount +diff", () => {
		// 原分配 600、已用 0（剩余 600）→ 使用 +1000：补 400，连同原 600 一起使用
		const delta = computeAllocationDelta({
			currentAmount: d("600"),
			newAmount: d("1600"),
			remainingAllocation: d("600"),
		});
		expect(delta.supplement.eq(d("400"))).toBe(true);
		expect(delta.amountDelta.eq(d("400"))).toBe(true);
		expect(delta.usedAmountDelta.eq(d("1000"))).toBe(true);
	});

	it("diff = 0（无变化）全零；剩余分配恰好等于增量时无补分配", () => {
		const zero = computeAllocationDelta({
			currentAmount: d("500"),
			newAmount: d("500"),
			remainingAllocation: d("0"),
		});
		expect(zero.amountDelta.eq(0)).toBe(true);
		expect(zero.usedAmountDelta.eq(0)).toBe(true);
		expect(zero.supplement.eq(0)).toBe(true);

		const exact = computeAllocationDelta({
			currentAmount: d("500"),
			newAmount: d("800"),
			remainingAllocation: d("300"),
		});
		expect(exact.supplement.eq(0)).toBe(true);
		expect(exact.usedAmountDelta.eq(d("300"))).toBe(true);
	});
});
