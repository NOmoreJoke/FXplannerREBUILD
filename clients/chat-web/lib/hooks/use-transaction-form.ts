import { useCallback, useMemo, useState } from "react";
import {
	CURRENCIES,
	impliedRate,
	InvalidAmountError,
	receivedAmountOf,
	RoundToZeroError,
} from "@fxplanner-new/money";
import Decimal from "decimal.js";
import type { CreateTransactionReq } from "@/lib/api/contract";

/**
 * 买入交易录入表单（changes/transaction-entry/技术方案.md §4/§6）
 *
 * 金额/汇率全程 string 传递（与后端金额字符串口径一致），仅在提交时组装请求；
 * 两种填法互算发生在前端本地（money 包纯函数 receivedAmountOf / impliedRate，
 * 零请求），提交时本金/汇率/到账三值同送，服务端做双向自洽校验（权威防线）。
 * 校验为纯函数 validateTransactionForm，hook 只负责状态、互算与错误暴露。
 *
 * 错误文案对齐 services/chat/src/transaction/transaction-calculator.ts。
 */

/** 填法：byRate = 本金 + 汇率 → 自动算到账（A）；byReceived = 本金 + 到账 → 反算汇率（B） */
export type TransactionFillMode = "byRate" | "byReceived";

/** 表单可编辑字段 */
export type TransactionFormField =
	| "currencyCode"
	| "transactedAt"
	| "fillMode"
	| "principalAmount"
	| "exchangeRate"
	| "quantity"
	| "feeAmount"
	| "planId";

/** 创建买入表单值 */
export interface TransactionFormValues {
	/** 买入币种（ISO 4217；空串 = 未选择） */
	currencyCode: string;
	/** 交易日期（本地 yyyy-MM-dd，提交时转 UTC 0 点 ISO；允许补录历史） */
	transactedAt: string;
	/** 当前填法（默认填法 A：本金 + 汇率） */
	fillMode: TransactionFillMode;
	/** 本金金额（本位币，金额字符串） */
	principalAmount: string;
	/** 成交汇率（1 外币 = X 本位币；byReceived 填法下由反算回填） */
	exchangeRate: string;
	/** 到账外币数量（byRate 填法下由互算回填） */
	quantity: string;
	/** 手续费（本位币；空串 = 未知（落库 null，≠ 0）；"0" = 无手续费） */
	feeAmount: string;
	/** 关联计划 ID（空串 = 不关联；仅标记不触发分配） */
	planId: string;
}

/** UTC+8 时区偏移（毫秒）；「今天」日界口径与后端一致（doc 14：记录日期按 UTC+8 判断） */
export const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 表单初始值（日期默认今天，UTC+8 口径）；initial 用于 URL 预填（计划详情页「录入买入」入口） */
export function defaultTransactionFormValues(
	now: Date = new Date(),
	initial?: Partial<Pick<TransactionFormValues, "planId" | "currencyCode">>,
): TransactionFormValues {
	return {
		currencyCode: initial?.currencyCode ?? "",
		transactedAt: utc8TodayYmd(now),
		fillMode: "byRate",
		principalAmount: "",
		exchangeRate: "",
		quantity: "",
		feeAmount: "",
		planId: initial?.planId ?? "",
	};
}

/** 非 negative 金额（不含符号/千分位/科学计数法 → "1e999"、".5"、"+100"、"-1" 全部拦截） */
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;
/** 汇率（≤ 8 位小数，对齐后端 DTO @Matches(/^\d+(\.\d{1,8})?$/)） */
const RATE_PATTERN = /^\d+(\.\d{1,8})?$/;
/** 本地日期 yyyy-MM-dd */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** 单笔金额上限（不含），与后端 money 包 AMOUNT_UPPER_LIMIT 一致：> 0 且 < 1e11 */
export const AMOUNT_UPPER_LIMIT = 1e11;
/** 汇率小数位上限 */
export const RATE_DECIMAL_PLACES_MAX = 8;

/** 某时刻在 UTC+8 口径下的「今天」（yyyy-MM-dd） */
export function utc8TodayYmd(now: Date = new Date()): string {
	return new Date(now.getTime() + UTC8_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 按代码查币种（保留字面量类型：CURRENCIES 元素经 as const，code 为 15 币种联合、
 * decimalPlaces 为 0|2；getCurrency 返回的 CurrencyInfo.code 是宽泛 string，
 * 无法直接赋给生成的 CreateTransactionReq.currencyCode 字面量联合）。
 */
export function findCurrency(
	code: string,
): (typeof CURRENCIES)[number] | undefined {
	return CURRENCIES.find(
		(currency) => currency.code === code.trim().toUpperCase(),
	);
}

/** 按币种代码取精度；未选币种（空串/未知）时按 2 位处理（互算在选币种前不精确，validate 兜底必填） */
function decimalPlacesOf(currencyCode: string): 0 | 2 {
	return findCurrency(currencyCode)?.decimalPlaces ?? 2;
}

/** 币种是否为整数币种（JPY/KRW） */
function isZeroDecimalCurrency(currencyCode: string): boolean {
	return decimalPlacesOf(currencyCode) === 0;
}

/** 互算结果：value = 回填显示值；error 非空时 value 恒为空串 */
export type DeriveResult =
	| { value: string; error?: undefined }
	| { value: ""; error: string };

/**
 * 填法 A 互算：本金 + 汇率 → 到账数量（money 包 receivedAmountOf，
 * 全精度相除后按买入币种精度四舍五入一次；正数舍 0 拦截）。
 * 输入为空/格式未完成时返回空串（输入中间态不报错，validate 兜底必填）。
 */
export function deriveQuantity(
	principal: string,
	rate: string,
	decimalPlaces: 0 | 2,
): DeriveResult {
	const principalText = principal.trim();
	const rateText = rate.trim();
	if (principalText === "" || rateText === "") return { value: "" };
	if (!AMOUNT_PATTERN.test(principalText)) {
		return { value: "", error: "本金金额格式不正确" };
	}
	if (!RATE_PATTERN.test(rateText)) {
		return { value: "", error: "汇率格式不正确" };
	}
	try {
		const received = receivedAmountOf(principalText, rateText, decimalPlaces);
		return { value: received.toFixed(decimalPlaces) };
	} catch (error) {
		if (error instanceof RoundToZeroError) {
			return {
				value: "",
				error:
					"按当前本金与汇率计算的到账金额舍入后为 0，已拦截，请调整本金或汇率",
			};
		}
		if (error instanceof InvalidAmountError) {
			return { value: "", error: "本金与汇率必须为大于 0 的有效数字" };
		}
		throw error;
	}
}

/**
 * 填法 B 互算：本金 + 到账 → 反算汇率（money 包 impliedRate，
 * 全精度相除后按汇率精度 8 位四舍五入一次）。语义：1 外币 = X 本位币。
 */
export function deriveRate(
	principal: string,
	received: string,
	decimalPlaces: 0 | 2,
): DeriveResult {
	const principalText = principal.trim();
	const receivedText = received.trim();
	if (principalText === "" || receivedText === "") return { value: "" };
	if (!AMOUNT_PATTERN.test(principalText)) {
		return { value: "", error: "本金金额格式不正确" };
	}
	if (!AMOUNT_PATTERN.test(receivedText)) {
		return { value: "", error: "到账数量格式不正确" };
	}
	try {
		const rate = impliedRate(principalText, receivedText, decimalPlaces);
		return { value: rate.toFixed(RATE_DECIMAL_PLACES_MAX) };
	} catch (error) {
		if (error instanceof InvalidAmountError) {
			return { value: "", error: "本金与到账数量必须为大于 0 的有效数字" };
		}
		throw error;
	}
}

/** 校验错误集合：字段 → 中文文案；form = 三值自洽等跨字段错误 */
export type TransactionFormErrors = Partial<
	Record<TransactionFormField | "form", string>
>;

/** 三值双向自洽（与后端 assertSelfConsistent 同判）：满足其一即通过 */
export function isSelfConsistent(
	values: TransactionFormValues,
	decimalPlaces: 0 | 2,
): boolean {
	const principal = values.principalAmount.trim();
	const rate = values.exchangeRate.trim();
	const quantity = values.quantity.trim();
	if (
		!AMOUNT_PATTERN.test(principal) ||
		!RATE_PATTERN.test(rate) ||
		!AMOUNT_PATTERN.test(quantity)
	) {
		return false;
	}
	// 方向一（填法 A 口径）：receivedAmountOf(p, r) == q
	try {
		if (receivedAmountOf(principal, rate, decimalPlaces).eq(quantity)) {
			return true;
		}
	} catch {
		// 舍 0 / 非正数：方向一不成立，继续尝试方向二（与后端一致，ROUND_TO_ZERO 由互算层提前提示）
	}
	// 方向二（填法 B 口径）：impliedRate(p, q) == r
	try {
		if (impliedRate(principal, quantity, decimalPlaces).eq(rate)) {
			return true;
		}
	} catch {
		return false;
	}
	return false;
}

/** 单个金额字段的通用格式/上限校验；返回错误文案或 undefined */
function validateAmountField(
	raw: string,
	label: string,
	pattern: RegExp,
): string | undefined {
	const text = raw.trim();
	if (text === "") return `请输入${label}`;
	if (!pattern.test(text)) return `${label}格式不正确，请输入有效数字`;
	const value = Number(text);
	if (!(value > 0)) return `${label}必须大于 0`;
	if (value >= AMOUNT_UPPER_LIMIT) {
		return `${label}必须小于单笔上限 100,000,000,000`;
	}
	return undefined;
}

/**
 * 纯函数校验（技术方案 §4.6，文案对齐 transaction-calculator.ts）：
 * - currencyCode 必选（15 币种内）
 * - transactedAt 必填、合法 yyyy-MM-dd、UTC+8 口径不晚于今天
 * - principalAmount：有效数字、> 0、< 1e11
 * - exchangeRate：有效数字、> 0、≤ 8 位小数、< 1e11
 * - quantity：有效数字、> 0、小数位 ≤ 币种精度（JPY/KRW 整数）、< 1e11
 * - feeAmount：空串 = 未知（合法）；提供则有效数字、≥ 0、< 1e11
 * - 三值自洽：双向其一（receivedAmountOf 或 impliedRate）
 * - planId：无本地校验（归属与币种一致性由服务端校验）
 */
export function validateTransactionForm(
	values: TransactionFormValues,
): TransactionFormErrors {
	const errors: TransactionFormErrors = {};

	if (findCurrency(values.currencyCode) === undefined) {
		errors.currencyCode = "请选择买入币种";
	}

	const dateText = values.transactedAt.trim();
	if (dateText === "") {
		errors.transactedAt = "请选择交易日期";
	} else if (!DATE_PATTERN.test(dateText)) {
		errors.transactedAt = "日期格式不正确";
	} else if (dateText > utc8TodayYmd()) {
		errors.transactedAt = "交易日期不能晚于今天（UTC+8 口径）";
	}

	const principalError = validateAmountField(
		values.principalAmount,
		"本金金额",
		AMOUNT_PATTERN,
	);
	if (principalError !== undefined) errors.principalAmount = principalError;

	const rateError = validateAmountField(
		values.exchangeRate,
		"汇率",
		RATE_PATTERN,
	);
	if (rateError !== undefined) {
		errors.exchangeRate = rateError;
	} else {
		const fraction = values.exchangeRate.trim().split(".")[1];
		if (fraction !== undefined && fraction.length > RATE_DECIMAL_PLACES_MAX) {
			errors.exchangeRate = "汇率最多支持 8 位小数，请修改后重试";
		}
	}

	const quantityError = validateAmountField(
		values.quantity,
		"到账数量",
		AMOUNT_PATTERN,
	);
	if (quantityError !== undefined) {
		errors.quantity = quantityError;
	} else {
		const fraction = values.quantity.trim().split(".")[1];
		if (isZeroDecimalCurrency(values.currencyCode) && fraction !== undefined) {
			errors.quantity = "该币种（如日元/韩元）为整数币种，到账数量不能带小数位";
		} else if (fraction !== undefined && fraction.length > 2) {
			errors.quantity = "到账数量最多支持 2 位小数";
		}
	}

	const feeText = values.feeAmount.trim();
	if (feeText !== "") {
		if (!AMOUNT_PATTERN.test(feeText)) {
			errors.feeAmount = "手续费格式不正确，请输入有效数字";
		} else if (Number(feeText) >= AMOUNT_UPPER_LIMIT) {
			errors.feeAmount = "手续费必须小于单笔上限 100,000,000,000";
		}
	}

	if (
		errors.principalAmount === undefined &&
		errors.exchangeRate === undefined &&
		errors.quantity === undefined &&
		!isSelfConsistent(values, decimalPlacesOf(values.currencyCode))
	) {
		errors.form =
			"本金、汇率与到账数量不匹配：请按其中一种填法重新核对（本金+汇率 → 到账，或 本金+到账 → 汇率）";
	}

	return errors;
}

/**
 * 交易总成本 = 本金 + 手续费；手续费未知（空串）返回 null（成本不完整，
 * UI 必须明示，绝不当 0 计算，方案 §4.2）。
 * 简单加法无舍入规则分歧（同精度字符串相加），直接用 decimal.js；
 * 除法类互算一律走 money 包纯函数，不在前端手写。
 */
export function totalCostOf(
	principal: string,
	fee: string,
	decimalPlaces: 0 | 2,
): string | null {
	const principalText = principal.trim();
	const feeText = fee.trim();
	if (
		principalText === "" ||
		feeText === "" ||
		!AMOUNT_PATTERN.test(principalText) ||
		!AMOUNT_PATTERN.test(feeText)
	) {
		return null;
	}
	return new Decimal(principalText).plus(feeText).toFixed(decimalPlaces);
}

/**
 * 表单值 → 创建请求（提交组装）。校验不通过返回 null（按钮已由 isValid 禁用，
 * 此为防御层）；手续费空串 = 缺省（服务端落 null 未知）、planId 空串 = 不关联。
 * 三值同送：byReceived 填法下 exchangeRate 为反算回填值（8 位）。
 */
export function toCreateRequest(
	values: TransactionFormValues,
): CreateTransactionReq | null {
	if (Object.keys(validateTransactionForm(values)).length > 0) return null;
	const currencyCode = findCurrency(values.currencyCode);
	if (!currencyCode) return null;

	const req: CreateTransactionReq = {
		currencyCode: currencyCode.code,
		principalAmount: values.principalAmount.trim(),
		exchangeRate: values.exchangeRate.trim(),
		quantity: values.quantity.trim(),
		transactedAt: new Date(
			`${values.transactedAt.trim()}T00:00:00.000Z`,
		).toISOString(),
	};
	const feeText = values.feeAmount.trim();
	if (feeText !== "") req.feeAmount = feeText;
	const planId = values.planId.trim();
	if (planId !== "") req.planId = planId;
	return req;
}

/** 当前填法下用户直接输入的字段（另一值为只读回填展示） */
export function primaryInputField(fillMode: TransactionFillMode): {
	input: "exchangeRate" | "quantity";
	derived: "exchangeRate" | "quantity";
} {
	return fillMode === "byRate"
		? { input: "exchangeRate", derived: "quantity" }
		: { input: "quantity", derived: "exchangeRate" };
}

/** 按填法互算回填（纯函数，hook 的 set 逻辑复用）：返回新 values 或互算错误 */
function recalculate(next: TransactionFormValues): {
	values: TransactionFormValues;
	deriveError?: string;
} {
	const decimalPlaces = decimalPlacesOf(next.currencyCode);
	const { input } = primaryInputField(next.fillMode);
	if (input === "exchangeRate") {
		const result = deriveQuantity(
			next.principalAmount,
			next.exchangeRate,
			decimalPlaces,
		);
		return {
			values: { ...next, quantity: result.error ? "" : result.value },
			deriveError: result.error,
		};
	}
	const result = deriveRate(next.principalAmount, next.quantity, decimalPlaces);
	return {
		values: {
			...next,
			exchangeRate: result.error ? next.exchangeRate : result.value,
		},
		deriveError: result.error,
	};
}

/**
 * 买入交易录入表单状态 hook
 *
 * 暴露 values / setField / touched / getError / isValid；
 * setField 对金额/汇率/到账/填法/币种的修改即时触发本地互算（零请求）；
 * 互算错误（如正数舍 0）不经 touched 过滤，立即展示。
 */
export function useTransactionForm(
	now: Date = new Date(),
	initial?: Partial<Pick<TransactionFormValues, "planId" | "currencyCode">>,
) {
	const [values, setValues] = useState<TransactionFormValues>(() =>
		defaultTransactionFormValues(now, initial),
	);
	const [touched, setTouched] = useState<
		Partial<Record<TransactionFormField, boolean>>
	>({});
	// 互算错误（RoundToZero 等）：与 validate 错误分开存放，映射到被回填的字段展示
	const [deriveErrors, setDeriveErrors] = useState<
		Partial<Record<"quantity" | "exchangeRate", string>>
	>({});

	const setField = useCallback(
		<K extends TransactionFormField>(
			field: K,
			value: TransactionFormValues[K],
			options?: { touch?: boolean },
		) => {
			setValues((prev) => {
				const next: TransactionFormValues = { ...prev, [field]: value };
				// 互算触发点：金额输入、汇率输入、到账输入、填法切换、币种切换
				if (
					field === "principalAmount" ||
					field === "exchangeRate" ||
					field === "quantity" ||
					field === "fillMode" ||
					field === "currencyCode"
				) {
					const { values: recalculated, deriveError } = recalculate(next);
					const { derived } = primaryInputField(next.fillMode);
					setDeriveErrors(deriveError ? { [derived]: deriveError } : {});
					return recalculated;
				}
				return next;
			});
			// 程序化回填（如参考汇率采用）传 touch: false，避免误判为用户手动修改
			if (options?.touch !== false) {
				setTouched((prev) => ({ ...prev, [field]: true }));
			}
		},
		[],
	);

	const errors = useMemo(() => validateTransactionForm(values), [values]);

	const getError = useCallback(
		(field: TransactionFormField | "form"): string | undefined => {
			// 互算错误（舍 0 等）优先且不过 touched 过滤：用户需要立即看到拦截原因
			if (field === "quantity" || field === "exchangeRate") {
				const deriveError = deriveErrors[field];
				if (deriveError !== undefined) return deriveError;
			}
			const error = errors[field];
			if (error === undefined) return undefined;
			// 字段未触碰且无值时不显示，避免初始全红（form 级错误不受此规则）
			if (field !== "form" && !touched[field] && values[field].trim() === "") {
				return undefined;
			}
			return error;
		},
		[deriveErrors, errors, touched, values],
	);

	const isValid = useMemo(
		() =>
			Object.keys(errors).length === 0 &&
			Object.keys(deriveErrors).length === 0,
		[errors, deriveErrors],
	);

	return { values, setField, touched, getError, isValid };
}
