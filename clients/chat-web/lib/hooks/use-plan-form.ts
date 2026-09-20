import { useCallback, useMemo, useState } from "react";
import type { PacePreference, PlanCaps } from "@/lib/api/contract";

/**
 * 创建换汇计划表单（changes/plan-creation/技术方案.md §6）
 *
 * 金额/天数全程 string 传递（与后端金额字符串口径一致），仅在提交时转类型；
 * 校验为纯函数 validatePlanForm，hook 只负责状态与错误暴露。
 */

/** 表单可编辑字段 */
export type PlanFormField =
	| "name"
	| "targetCurrency"
	| "targetAmount"
	| "expectUseDate"
	| "prepLeadDays"
	| "pacePreference"
	| "allocatedAmount";

/** 创建计划表单值 */
export interface PlanFormValues {
	/** 目标名称（可空） */
	name: string;
	/** 目标币种（ISO 4217；空串 = 未选择） */
	targetCurrency: string;
	/** 净到账金额（金额字符串） */
	targetAmount: string;
	/** 期望用汇日（本地 yyyy-MM-dd，提交时转 ISO UTC） */
	expectUseDate: string;
	/** 提前准备天数（1~30，字符串数值，默认 "3"） */
	prepLeadDays: string;
	/** 资金准备节奏（默认 "balanced"） */
	pacePreference: PacePreference;
	/** 计入已有外币（金额字符串；空串提交时按 "0"） */
	allocatedAmount: string;
}

/** 表单初始值 */
export const DEFAULT_PLAN_FORM_VALUES: PlanFormValues = {
	name: "",
	targetCurrency: "",
	targetAmount: "",
	expectUseDate: "",
	prepLeadDays: "3",
	pacePreference: "balanced",
	allocatedAmount: "0",
};

/**
 * 资金准备节奏合法值（pace 域；单一来源 = 后端 plan DTO / schedule-builder
 * PACE_PREFERENCES，经 OpenAPI 契约 PacePreference 收敛）。
 * satisfies 锁定：后端值集变更 → 此处编译报错强制同步（FE-03 根治，防漂移）。
 */
export const PACE_PREFERENCES = [
	"conservative",
	"balanced",
	"aggressive",
] as const satisfies readonly PacePreference[];

/** 判定是否为合法节奏值（运行时收窄） */
export function isPacePreference(value: unknown): value is PacePreference {
	return (
		typeof value === "string" &&
		(PACE_PREFERENCES as readonly string[]).includes(value)
	);
}

/**
 * settings prep 域（cautious 系）→ plan pace 域（conservative 系）跨域同义词桥
 * （FE-03：两域语义同源但词集不同，回填需显式映射而非直接赋值；
 * 非 pace/prep 合法值（含空）返回 null，由调用方决定是否回填默认值）。
 * 两侧类型均由契约收窄，新增枚举值时编译器迫使补全映射。
 */
export function toPacePreference(value: unknown): PacePreference | null {
	if (isPacePreference(value)) return value;
	if (value === "cautious") return "conservative";
	if (value === "proactive") return "aggressive";
	return null;
}

/** 非负金额（不含符号/千分位） */
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;
/** 本地日期 yyyy-MM-dd */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** 金额上限（不含），与技术方案 §4.3 一致：> 0 且 < 1e11 */
export const AMOUNT_UPPER_LIMIT = 1e11;

/** 本地时区今天（yyyy-MM-dd；用途日期须严格晚于该值） */
export function localTodayYmd(now: Date = new Date()): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/** 解析非负金额字符串为数值；格式非法返回 null（前端体验层预检，权威校验在服务端） */
function parseAmount(raw: string): number | null {
	const text = raw.trim();
	if (!AMOUNT_PATTERN.test(text)) return null;
	const parsed = Number(text);
	return Number.isFinite(parsed) ? parsed : null;
}

/** 校验错误集合：字段 → 中文文案 */
export type PlanFormErrors = Partial<Record<PlanFormField, string>>;

/**
 * 纯函数校验（技术方案 §4.3 + 任务约定）：
 * - targetAmount 必填、> 0 且 < 1e11
 * - expectUseDate 必填、格式合法且晚于今天（本地时区）
 * - prepLeadDays 为 1~30 的整数
 * - allocatedAmount 可空（空串视为 "0"）、≥ 0；caps 就绪时 ≤ caps.maxAllocatable，
 *   caps 未就绪时跳过上限校验
 * - name 无校验（可空）
 */
export function validatePlanForm(
	values: PlanFormValues,
	caps: PlanCaps | null,
): PlanFormErrors {
	const errors: PlanFormErrors = {};

	const targetAmountText = values.targetAmount.trim();
	if (targetAmountText === "") {
		errors.targetAmount = "请输入净到账金额";
	} else {
		const targetAmount = parseAmount(targetAmountText);
		if (targetAmount === null) {
			errors.targetAmount = "金额格式不正确，请输入非负数字";
		} else if (targetAmount <= 0) {
			errors.targetAmount = "净到账金额必须大于 0";
		} else if (targetAmount >= AMOUNT_UPPER_LIMIT) {
			errors.targetAmount = "净到账金额超出上限（需小于一千亿）";
		}
	}

	if (values.targetCurrency.trim() === "") {
		errors.targetCurrency = "请选择目标币种";
	}

	const expectUseDate = values.expectUseDate.trim();
	if (expectUseDate === "") {
		errors.expectUseDate = "请选择用途日期";
	} else if (!DATE_PATTERN.test(expectUseDate)) {
		errors.expectUseDate = "日期格式不正确";
	} else if (expectUseDate <= localTodayYmd()) {
		errors.expectUseDate = "用途日期必须晚于今天";
	}

	const leadText = values.prepLeadDays.trim();
	const lead = Number(leadText);
	if (leadText === "") {
		errors.prepLeadDays = "请输入提前准备天数";
	} else if (!Number.isInteger(lead) || lead < 1 || lead > 30) {
		errors.prepLeadDays = "提前准备天数需为 1~30 的整数";
	}

	const allocatedText = values.allocatedAmount.trim();
	if (allocatedText !== "") {
		const allocated = parseAmount(allocatedText);
		if (allocated === null) {
			errors.allocatedAmount = "金额格式不正确，请输入非负数字";
		} else if (caps !== null) {
			const maxAllocatable = Number(caps.maxAllocatable);
			if (Number.isFinite(maxAllocatable) && allocated > maxAllocatable) {
				errors.allocatedAmount = "超出可分配上限，请调低金额";
			}
		}
	}

	return errors;
}

/**
 * 创建计划表单状态 hook
 *
 * 暴露 values / setField / setCaps / touched / getError / isValid；
 * getError 在字段未触碰且无值时不返回错误，避免初始全红。
 */
export function usePlanForm() {
	const [values, setValues] = useState<PlanFormValues>(
		DEFAULT_PLAN_FORM_VALUES,
	);
	const [touched, setTouched] = useState<
		Partial<Record<PlanFormField, boolean>>
	>({});
	const [caps, setCapsState] = useState<PlanCaps | null>(null);

	const setField = useCallback(
		<K extends PlanFormField>(
			field: K,
			value: PlanFormValues[K],
			options?: { touch?: boolean },
		) => {
			setValues((prev) => ({ ...prev, [field]: value }));
			// 程序化回填（如 onboarding 偏好）传 touch: false，避免误判为用户手动修改
			if (options?.touch !== false) {
				setTouched((prev) => ({ ...prev, [field]: true }));
			}
		},
		[],
	);

	const setCaps = useCallback((next: PlanCaps | null) => {
		setCapsState((prev) => {
			if (prev === next) return prev;
			// 内容相同的引用替换不触发重渲染（preview 每次成功都返回新 caps 对象）
			if (
				prev !== null &&
				next !== null &&
				prev.allocatableBalance === next.allocatableBalance &&
				prev.maxAllocatable === next.maxAllocatable
			) {
				return prev;
			}
			return next;
		});
	}, []);

	const errors = useMemo(() => validatePlanForm(values, caps), [values, caps]);

	const getError = useCallback(
		(field: PlanFormField): string | undefined => {
			const error = errors[field];
			if (error === undefined) return undefined;
			// 字段未触碰且无值时不显示，避免初始全红
			if (!touched[field] && values[field].trim() === "") return undefined;
			return error;
		},
		[errors, touched, values],
	);

	const isValid = useMemo(() => Object.keys(errors).length === 0, [errors]);

	return { values, setField, setCaps, touched, getError, isValid };
}
