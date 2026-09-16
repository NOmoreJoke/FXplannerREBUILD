import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
	defaultTransactionFormValues,
	deriveQuantity,
	deriveRate,
	isSelfConsistent,
	toCreateRequest,
	totalCostOf,
	useTransactionForm,
	utc8TodayYmd,
	validateTransactionForm,
	type TransactionFormValues,
} from "./use-transaction-form";

/** 合法基线（填法 A：72480 ÷ 7.2480 → 10000.00，锚定 doc 05 例 / 方案 §8.1） */
const validValues: TransactionFormValues = {
	currencyCode: "USD",
	transactedAt: "2026-09-20",
	fillMode: "byRate",
	principalAmount: "72480",
	exchangeRate: "7.2480",
	quantity: "10000.00",
	feeAmount: "42.00",
	planId: "",
};

/**
 * 时钟隔离（方案 §8：涉「今天」的用例禁止依赖真实当前时间，防午夜 flaky）：
 * 全部用例统一固定到 2026-09-20 10:00 UTC（UTC+8 今天 = 2026-09-20，与基线日期一致）。
 */
const FROZEN_NOW = new Date("2026-09-20T10:00:00Z");

beforeEach(() => {
	vi.setSystemTime(FROZEN_NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("utc8TodayYmd", () => {
	it("按 UTC+8 日界返回今天（UTC 尚未到明天但 UTC+8 已到时取 UTC+8）", () => {
		// UTC 2026-09-19 20:00 = UTC+8 2026-09-20 04:00
		expect(utc8TodayYmd(new Date("2026-09-19T20:00:00Z"))).toBe("2026-09-20");
		expect(utc8TodayYmd(new Date("2026-09-20T15:59:00Z"))).toBe("2026-09-20");
		// UTC 2026-09-20 16:00 = UTC+8 2026-09-21 00:00（恰好跨日）
		expect(utc8TodayYmd(new Date("2026-09-20T16:00:00Z"))).toBe("2026-09-21");
	});
});

describe("deriveQuantity（填法 A：本金 + 汇率 → 到账）", () => {
	it("锚定例：72480 ÷ 7.2480 → 10000.00（2 位币种）", () => {
		expect(deriveQuantity("72480", "7.2480", 2)).toEqual({
			value: "10000.00",
		});
	});

	it("非整除例：1000 ÷ 7.31 → 136.80（四舍五入一次，不误杀）", () => {
		expect(deriveQuantity("1000", "7.31", 2)).toEqual({ value: "136.80" });
	});

	it("0 位币种（JPY/KRW）：1000 ÷ 7.31 → 137（整数）", () => {
		expect(deriveQuantity("1000", "7.31", 0)).toEqual({ value: "137" });
	});

	it("正数舍 0 拦截：极小本金 × 正常汇率 → 舍 0 文案", () => {
		const result = deriveQuantity("0.001", "7.248", 2);
		expect(result.value).toBe("");
		expect(result.error).toContain("舍入后为 0");
	});

	it("非正数/非法输入：按错误文案拦截", () => {
		expect(deriveQuantity("0", "7.248", 2).error).toBeDefined();
		expect(deriveQuantity("-100", "7.248", 2).error).toBeDefined();
		expect(deriveQuantity("1e999", "7.248", 2).error).toBeDefined();
		expect(deriveQuantity("72480", "abc", 2).error).toBeDefined();
	});

	it("输入中间态（空串）不报错：返回空串、error 为 undefined", () => {
		expect(deriveQuantity("", "7.248", 2)).toEqual({ value: "" });
		expect(deriveQuantity("72480", "", 2)).toEqual({ value: "" });
	});
});

describe("deriveRate（填法 B：本金 + 到账 → 反算汇率）", () => {
	it("锚定例：72480 ÷ 10000 → 7.24800000（8 位小数）", () => {
		expect(deriveRate("72480", "10000", 2)).toEqual({ value: "7.24800000" });
	});

	it("非整除例：1000 ÷ 136.80 → 7.30994152，反算值代回方向一仍得 136.80（双向不误杀）", () => {
		const derived = deriveRate("1000", "136.80", 2);
		expect(derived).toEqual({ value: "7.30994152" });
		// 反算汇率回填后，方向一 receivedAmountOf(p, r) == q 依旧成立
		expect(deriveQuantity("1000", derived.value, 2)).toEqual({
			value: "136.80",
		});
	});

	it("非正数/非法输入：按错误文案拦截", () => {
		expect(deriveRate("0", "136.80", 2).error).toBeDefined();
		expect(deriveRate("1000", "0", 2).error).toBeDefined();
		expect(deriveRate("1000", "-5", 2).error).toBeDefined();
		expect(deriveRate("1000", ".5", 2).error).toBeDefined();
	});
});

describe("isSelfConsistent（三值双向其一，对齐后端 assertSelfConsistent）", () => {
	const base = defaultTransactionFormValues(new Date("2026-09-20T10:00:00Z"));

	it("填法 A 提交（72480 / 7.2480 / 10000.00）：方向一成立", () => {
		expect(
			isSelfConsistent(
				{
					...base,
					principalAmount: "72480",
					exchangeRate: "7.2480",
					quantity: "10000.00",
				},
				2,
			),
		).toBe(true);
	});

	it("填法 B 提交（1000 / 7.30994152 / 136.80）：方向二成立", () => {
		expect(
			isSelfConsistent(
				{
					...base,
					principalAmount: "1000",
					exchangeRate: "7.30994152",
					quantity: "136.80",
				},
				2,
			),
		).toBe(true);
	});

	it("非整除填法 A（1000 / 7.31 / 136.80）不被误杀", () => {
		expect(
			isSelfConsistent(
				{
					...base,
					principalAmount: "1000",
					exchangeRate: "7.31",
					quantity: "136.80",
				},
				2,
			),
		).toBe(true);
	});

	it("三值两方向均不满足（72480 / 7.31 / 10000）→ false", () => {
		expect(
			isSelfConsistent(
				{
					...base,
					principalAmount: "72480",
					exchangeRate: "7.31",
					quantity: "10000",
				},
				2,
			),
		).toBe(false);
	});
});

describe("validateTransactionForm", () => {
	it("合法基线应无任何错误", () => {
		expect(validateTransactionForm(validValues)).toEqual({});
	});

	it("币种：必选且在 15 币种内", () => {
		expect(
			validateTransactionForm({ ...validValues, currencyCode: "" }),
		).toHaveProperty("currencyCode");
		expect(
			validateTransactionForm({ ...validValues, currencyCode: "XXX" }),
		).toHaveProperty("currencyCode");
		expect(
			validateTransactionForm({ ...validValues, currencyCode: "jpy" }),
		).not.toHaveProperty("currencyCode");
	});

	it("交易日期：必填、合法格式、UTC+8 口径不晚于今天", () => {
		vi.setSystemTime(new Date("2026-09-20T10:00:00Z")); // UTC+8 今天 = 2026-09-20
		try {
			expect(
				validateTransactionForm({ ...validValues, transactedAt: "" }),
			).toHaveProperty("transactedAt");
			expect(
				validateTransactionForm({ ...validValues, transactedAt: "2026/09/20" }),
			).toHaveProperty("transactedAt");
			expect(
				validateTransactionForm({ ...validValues, transactedAt: "2026-09-21" }),
			).toHaveProperty("transactedAt");
			expect(
				validateTransactionForm({ ...validValues, transactedAt: "2026-09-20" }),
			).not.toHaveProperty("transactedAt");
			expect(
				validateTransactionForm({ ...validValues, transactedAt: "2026-09-19" }),
			).not.toHaveProperty("transactedAt");
		} finally {
			vi.useRealTimers();
		}
	});

	it("本金：非法输入（1e999 / .5 / +100 / 负数 / 0 / 超上限）全部拦截", () => {
		for (const bad of ["1e999", ".5", "+100", "-100", "0", "100000000000"]) {
			expect(
				validateTransactionForm({ ...validValues, principalAmount: bad }),
			).toHaveProperty("principalAmount");
		}
		expect(
			validateTransactionForm({
				...validValues,
				principalAmount: "99999999999",
			}),
		).not.toHaveProperty("principalAmount");
	});

	it("汇率：非法输入拦截；超 8 位小数拒绝、8 位通过", () => {
		for (const bad of ["1e999", ".5", "+100", "-1", "0", "7.123456789"]) {
			expect(
				validateTransactionForm({ ...validValues, exchangeRate: bad }),
			).toHaveProperty("exchangeRate");
		}
		expect(
			validateTransactionForm({ ...validValues, exchangeRate: "7.12345678" }),
		).not.toHaveProperty("exchangeRate");
	});

	it("到账数量：小数位超币种精度拒绝（JPY 整数 / 2 位币种最多 2 位）", () => {
		// JPY（0 位）：带小数位拒绝，整数通过
		expect(
			validateTransactionForm({
				...validValues,
				currencyCode: "JPY",
				quantity: "100.5",
			}),
		).toHaveProperty("quantity");
		expect(
			validateTransactionForm({
				...validValues,
				currencyCode: "JPY",
				quantity: "100",
			}),
		).not.toHaveProperty("quantity");
		// USD（2 位）：3 位小数拒绝，2 位通过
		expect(
			validateTransactionForm({ ...validValues, quantity: "100.555" }),
		).toHaveProperty("quantity");
		expect(
			validateTransactionForm({ ...validValues, quantity: "100.55" }),
		).not.toHaveProperty("quantity");
	});

	it("到账数量：非法输入（1e999 / .5 / +100 / 负数 / 0 / 超上限）拦截", () => {
		for (const bad of ["1e999", ".5", "+100", "-1", "0", "100000000000"]) {
			expect(
				validateTransactionForm({ ...validValues, quantity: bad }),
			).toHaveProperty("quantity");
		}
	});

	it("手续费三态均合法：空（未知）/ 0（无）/ 数值", () => {
		expect(
			validateTransactionForm({ ...validValues, feeAmount: "" }),
		).not.toHaveProperty("feeAmount");
		expect(
			validateTransactionForm({ ...validValues, feeAmount: "0" }),
		).not.toHaveProperty("feeAmount");
		expect(
			validateTransactionForm({ ...validValues, feeAmount: "42.00" }),
		).not.toHaveProperty("feeAmount");
	});

	it("手续费：负数 / 非法输入 / 超上限拦截", () => {
		for (const bad of ["-1", "abc", "1e999", ".5", "100000000000"]) {
			expect(
				validateTransactionForm({ ...validValues, feeAmount: bad }),
			).toHaveProperty("feeAmount");
		}
	});

	it("三值不自洽：form 级错误且指明需按填法重新核对", () => {
		const errors = validateTransactionForm({
			...validValues,
			exchangeRate: "7.31",
			quantity: "10000",
		});
		expect(errors.form).toContain("不匹配");
	});
});

describe("totalCostOf（成本 = 本金 + 手续费，未知费用 → null）", () => {
	it("费用明确：72480.00 + 42.00 → 72522.00", () => {
		expect(totalCostOf("72480.00", "42.00", 2)).toBe("72522.00");
	});

	it("费用未知（空串）→ null（成本不完整，绝不当 0 计算）", () => {
		expect(totalCostOf("72480.00", "", 2)).toBeNull();
	});

	it("费用为 0（无手续费）→ 本金原值", () => {
		expect(totalCostOf("72480.00", "0", 2)).toBe("72480.00");
	});
});

describe("toCreateRequest（提交组装：三值同送 + 手续费三态）", () => {
	it("填法 A + 明确费用：三值同送、日期转 UTC 0 点 ISO", () => {
		const req = toCreateRequest(validValues);
		expect(req).not.toBeNull();
		expect(req?.currencyCode).toBe("USD");
		expect(req?.principalAmount).toBe("72480");
		expect(req?.exchangeRate).toBe("7.2480");
		expect(req?.quantity).toBe("10000.00");
		expect(req?.feeAmount).toBe("42.00");
		expect(req?.transactedAt).toBe("2026-09-20T00:00:00.000Z");
		expect(req?.planId).toBeUndefined();
	});

	it('手续费 "0"（无手续费）原样上送，区别于缺省', () => {
		const req = toCreateRequest({ ...validValues, feeAmount: "0" });
		expect(req?.feeAmount).toBe("0");
	});

	it("手续费留空（未知）→ 请求不含 feeAmount 字段（服务端落 null）", () => {
		const req = toCreateRequest({ ...validValues, feeAmount: "" });
		expect(req).not.toBeNull();
		expect("feeAmount" in (req ?? {})).toBe(false);
	});

	it("关联计划：planId 非空时上送", () => {
		const req = toCreateRequest({ ...validValues, planId: "cmb1" });
		expect(req?.planId).toBe("cmb1");
	});

	it("填法 B：反算汇率（8 位）与到账、本金三值同送", () => {
		const req = toCreateRequest({
			...validValues,
			fillMode: "byReceived",
			principalAmount: "1000",
			exchangeRate: "7.30994152",
			quantity: "136.80",
			feeAmount: "",
		});
		expect(req).not.toBeNull();
		expect(req?.principalAmount).toBe("1000");
		expect(req?.exchangeRate).toBe("7.30994152");
		expect(req?.quantity).toBe("136.80");
		expect(req?.transactedAt).toBe("2026-09-20T00:00:00.000Z");
	});

	it("校验不通过（缺币种）→ null（防御层）", () => {
		expect(toCreateRequest({ ...validValues, currencyCode: "" })).toBeNull();
	});
});

describe("useTransactionForm（hook 状态与本地互算）", () => {
	it("初始值：交易日期默认今天（UTC+8），其余为空", () => {
		vi.setSystemTime(new Date("2026-09-20T10:00:00Z"));
		try {
			const { result } = renderHook(() => useTransactionForm());
			expect(result.current.values.transactedAt).toBe("2026-09-20");
			expect(result.current.values.fillMode).toBe("byRate");
			expect(result.current.values.principalAmount).toBe("");
			expect(result.current.isValid).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("初始值：支持 URL 预填 planId + currencyCode（计划详情页「录入买入」入口），日期仍默认今天", () => {
		vi.setSystemTime(new Date("2026-09-20T10:00:00Z"));
		try {
			const { result } = renderHook(() =>
				useTransactionForm(undefined, {
					planId: "plan-1",
					currencyCode: "USD",
				}),
			);
			expect(result.current.values.planId).toBe("plan-1");
			expect(result.current.values.currencyCode).toBe("USD");
			expect(result.current.values.transactedAt).toBe("2026-09-20");
			// 未预填字段保持默认空值，不影响其余初始态
			expect(result.current.values.principalAmount).toBe("");
			expect(result.current.values.fillMode).toBe("byRate");
		} finally {
			vi.useRealTimers();
		}
	});

	it("初始值：不传 initial 时与旧默认完全一致（planId/currencyCode 为空）", () => {
		const { result } = renderHook(() => useTransactionForm());
		expect(result.current.values.planId).toBe("");
		expect(result.current.values.currencyCode).toBe("");
	});

	it("defaultTransactionFormValues：initial 仅覆盖指定字段，未指定字段不受影响", () => {
		const values = defaultTransactionFormValues(
			new Date("2026-09-20T10:00:00Z"),
			{ planId: "plan-9" },
		);
		expect(values.planId).toBe("plan-9");
		expect(values.currencyCode).toBe("");
		expect(values.transactedAt).toBe("2026-09-20");
	});

	it("填法 A：填本金 + 汇率 → 到账实时互算（72480 ÷ 7.2480 → 10000.00），isValid 变 true", () => {
		const { result } = renderHook(() => useTransactionForm());
		act(() => {
			result.current.setField("currencyCode", "USD");
			result.current.setField("transactedAt", "2026-09-19");
			result.current.setField("principalAmount", "72480");
			result.current.setField("exchangeRate", "7.2480");
		});
		expect(result.current.values.quantity).toBe("10000.00");
		expect(result.current.values.fillMode).toBe("byRate");
		expect(result.current.getError("quantity")).toBeUndefined();
		expect(result.current.isValid).toBe(true);
	});

	it("填法 B：填本金 + 到账 → 汇率反算回填（1000 ÷ 136.80 → 7.30994152）", () => {
		const { result } = renderHook(() => useTransactionForm());
		act(() => {
			result.current.setField("currencyCode", "USD");
			result.current.setField("transactedAt", "2026-09-19");
			result.current.setField("fillMode", "byReceived");
			result.current.setField("principalAmount", "1000");
			result.current.setField("quantity", "136.80");
		});
		expect(result.current.values.exchangeRate).toBe("7.30994152");
		expect(result.current.isValid).toBe(true);
	});

	it("正数舍 0：互算错误即时暴露在到账字段，isValid 为 false", () => {
		const { result } = renderHook(() => useTransactionForm());
		act(() => {
			result.current.setField("currencyCode", "USD");
			result.current.setField("principalAmount", "0.001");
			result.current.setField("exchangeRate", "7.248");
		});
		expect(result.current.values.quantity).toBe("");
		expect(result.current.getError("quantity")).toContain("舍入后为 0");
		expect(result.current.isValid).toBe(false);
	});

	it("币种切换重算：USD（2 位）→ JPY（0 位），到账回填由 10000.00 变 10000", () => {
		const { result } = renderHook(() => useTransactionForm());
		act(() => {
			result.current.setField("currencyCode", "USD");
			result.current.setField("principalAmount", "72480");
			result.current.setField("exchangeRate", "7.2480");
		});
		expect(result.current.values.quantity).toBe("10000.00");
		act(() => {
			result.current.setField("currencyCode", "JPY");
		});
		expect(result.current.values.quantity).toBe("10000");
	});

	it("程序化回填参考汇率（touch: false）同样触发互算", () => {
		const { result } = renderHook(() => useTransactionForm());
		act(() => {
			result.current.setField("currencyCode", "USD");
			result.current.setField("principalAmount", "72480");
			result.current.setField("exchangeRate", "7.2480", { touch: false });
		});
		expect(result.current.values.quantity).toBe("10000.00");
		expect(result.current.touched.exchangeRate).toBeUndefined();
	});

	it("提交组装（hook 级）：合法表单可产出请求", () => {
		const { result } = renderHook(() => useTransactionForm());
		act(() => {
			result.current.setField("currencyCode", "USD");
			result.current.setField("transactedAt", "2026-09-19");
			result.current.setField("principalAmount", "72480");
			result.current.setField("exchangeRate", "7.2480");
			result.current.setField("feeAmount", "42.00");
		});
		expect(result.current.isValid).toBe(true);
		expect(toCreateRequest(result.current.values)?.quantity).toBe("10000.00");
	});
});
