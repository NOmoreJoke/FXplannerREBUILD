import { useCallback, useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { plansApi } from "@/lib/api/plans";
import type {
	AdjustCaps,
	AdjustPlanParams,
	AdjustPreviewResult,
	PacePreference,
	PlanDetail,
} from "@/lib/api/contract";

/**
 * 计划修改两段式状态机（changes/plan-management/技术方案.md §2 方案 A + §前端错误态交互规格）
 *
 * 编辑 →（adjust-preview）→ 预览确认 →（PATCH）→ 提交完成；
 * 关键分支：
 * - 409 PLAN_STATE_CHANGED：计划已被其他修改更新 →「重新预览」用最新数据
 *   重开预览（GET 详情刷新乐观锁值 + 重新 adjust-preview），已填参数保留预填；
 * - 400 PLAN_ALLOCATION_LIMIT：超分配上限 → 内联提示 caps 三值，并预填
 *   caps.limit 到分配总额字段引导改值（不清空其他已填内容）；
 * - 400 PLAN_TARGET_BELOW_USED / PLAN_ALLOCATION_BELOW_USED：附 used 与差额，
 *   红色内联提示并标注焦点字段（target / allocation）；
 * - 提交网络层失败（结果不明）：不盲目重发 PATCH，自动重新 GET 详情核对
 *   （verifying 态），由用户核对最新数据。
 *
 * 表单值全程 string 口径（金额/天数），仅在组装 API 参数时转类型
 * （风格对齐 use-plan-form）。
 */

// ────────────────────────── 表单值与参数组装 ──────────────────────────

/** 修改表单值（string 口径；空串 = 该项不修改） */
export interface PlanAdjustFormValues {
	/** 新目标金额（金额字符串；空串沿用现值） */
	targetAmount: string;
	/** 新分配总额（金额字符串；空串沿用现值） */
	allocatedAmount: string;
	/** 资金准备节奏（空串沿用现值） */
	pacePreference: PacePreference | "";
	/** 准备缓冲（1~30 整数字符串；空串沿用现值） */
	prepLeadDays: string;
}

/** 表单字段（错误标注用） */
export type PlanAdjustFormField = keyof PlanAdjustFormValues;

/** 表单校验错误集合 */
export type PlanAdjustFormErrors = Partial<Record<PlanAdjustFormField, string>>;

/** 金额：非负数字，最多 4 位小数（后端在解析层拒绝超 4 位，前端预检同口径） */
const ADJUST_AMOUNT_PATTERN = /^\d+(\.\d{1,4})?$/;

/**
 * 表单校验（纯函数）：各字段非空时格式预检；全空不算错（由「至少一项」
 * 的提交拦截兜底提示）。权威校验在服务端，这里只做体验层预检。
 */
export function validateAdjustForm(
	form: PlanAdjustFormValues,
): PlanAdjustFormErrors {
	const errors: PlanAdjustFormErrors = {};

	const target = form.targetAmount.trim();
	if (target !== "") {
		if (!ADJUST_AMOUNT_PATTERN.test(target)) {
			errors.targetAmount = "目标金额需为非负数字，最多 4 位小数";
		} else if (Number(target) <= 0) {
			errors.targetAmount = "目标金额必须大于 0";
		}
	}

	const alloc = form.allocatedAmount.trim();
	if (alloc !== "") {
		if (!ADJUST_AMOUNT_PATTERN.test(alloc)) {
			errors.allocatedAmount = "分配总额需为非负数字，最多 4 位小数";
		}
	}

	const lead = form.prepLeadDays.trim();
	if (lead !== "") {
		const leadNum = Number(lead);
		if (!Number.isInteger(leadNum) || leadNum < 1 || leadNum > 30) {
			errors.prepLeadDays = "准备缓冲需为 1~30 的整数";
		}
	}

	return errors;
}

/** 是否至少修改了一项（与初始基线 diff；全同 = 未修改） */
export function hasAnyChange(
	form: PlanAdjustFormValues,
	initial: PlanAdjustFormValues,
): boolean {
	return (
		!fieldUnchanged(form.targetAmount, initial.targetAmount) ||
		!fieldUnchanged(form.allocatedAmount, initial.allocatedAmount) ||
		form.pacePreference !== initial.pacePreference ||
		!fieldUnchanged(form.prepLeadDays, initial.prepLeadDays)
	);
}

/** 字段未变判定：trim 字符串相等，或数值相等（"10000" 与 "10000.0000" 同值；NaN 不等，交由格式校验拦截） */
function fieldUnchanged(current: string, initial: string): boolean {
	const a = current.trim();
	const b = initial.trim();
	if (a === b) return true;
	const na = Number(a);
	const nb = Number(b);
	return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

/**
 * 表单值 → 预览/提交参数组装（纯函数，「金额字符串组装」的唯一出处）：
 * 与初始基线 diff，仅携带真正变化的字段（金额原样字符串传输 trim，
 * 不手补小数位；天数转整数；未变项不携带，后端缺省沿用现值）。
 * 无任何变化返回 null。
 */
export function buildAdjustParams(
	form: PlanAdjustFormValues,
	initial: PlanAdjustFormValues,
): AdjustPlanParams | null {
	if (!hasAnyChange(form, initial)) return null;

	const params: AdjustPlanParams = {};
	if (!fieldUnchanged(form.targetAmount, initial.targetAmount)) {
		params.newTargetAmount = form.targetAmount.trim();
	}
	if (!fieldUnchanged(form.allocatedAmount, initial.allocatedAmount)) {
		params.newAllocAmount = form.allocatedAmount.trim();
	}
	if (
		form.pacePreference !== initial.pacePreference &&
		form.pacePreference !== ""
	) {
		params.pacePreference = form.pacePreference;
	}
	if (!fieldUnchanged(form.prepLeadDays, initial.prepLeadDays)) {
		params.prepLeadDays = Number(form.prepLeadDays.trim());
	}
	return params;
}

/** 从计划详情预填编辑表单（现值即初始值，用户在其基础上改） */
export function formValuesFromDetail(plan: PlanDetail): PlanAdjustFormValues {
	return {
		targetAmount: plan.targetAmount,
		allocatedAmount: plan.allocatedAmount,
		pacePreference: plan.pacePreference,
		prepLeadDays: String(plan.prepLeadDays),
	};
}

// ────────────────────────── 错误形态与映射 ──────────────────────────

/** 状态机错误形态（按「前端错误态交互规格」表分支） */
export type PlanAdjustError =
	| {
			/** 分配总额超上限：内联提示 caps 三值，已预填 caps.limit 引导改值 */
			kind: "overLimit";
			caps: AdjustCaps;
			message: string;
	  }
	| {
			/** 目标/分配低于累计已使用：红色内联提示，焦点定位字段 */
			kind: "belowUsed";
			field: "target" | "allocation";
			used: string;
			shortfall: string;
			message: string;
	  }
	| {
			/** 乐观锁失配：计划已被其他修改更新 →「重新预览」按钮 */
			kind: "conflict";
			message: string;
	  }
	| {
			/** 非法状态流转（已取消/已完成不可修改等） */
			kind: "invalidTransition";
			message: string;
	  }
	| {
			/** 其余错误（参数非法/排期不可生成/网络失败等） */
			kind: "generic";
			message: string;
	  };

/** 读取 ApiError.body.data（后端错误响应体 { code, message, data? }） */
function errorData(error: ApiError): Record<string, unknown> | null {
	const data = error.body?.data;
	return data !== null && typeof data === "object"
		? (data as Record<string, unknown>)
		: null;
}

/** 读取错误 data 内的 4 位小数金额字符串（非法/缺失回退 "0.0000"） */
function errorAmount(value: unknown): string {
	return typeof value === "string" ? value : "0.0000";
}

/** 收窄错误 data.caps 为 AdjustCaps（形状不合规返回 null） */
function errorCaps(error: ApiError): AdjustCaps | null {
	const caps = errorData(error)?.caps;
	if (caps === null || typeof caps !== "object") return null;
	const candidate = caps as AdjustCaps;
	if (typeof candidate.limit !== "string") return null;
	if (typeof candidate.unallocatedBalance !== "string") return null;
	if (typeof candidate.stillNeeded !== "string") return null;
	return candidate;
}

/**
 * ApiError → 状态机错误形态（纯函数，交互规格表的代码级落地）：
 * - PLAN_ALLOCATION_LIMIT → overLimit（附 caps 三值）
 * - PLAN_TARGET_BELOW_USED / PLAN_ALLOCATION_BELOW_USED → belowUsed（附 used/差额 + 焦点字段）
 * - PLAN_STATE_CHANGED → conflict
 * - PLAN_INVALID_TRANSITION → invalidTransition
 * - 其余 → generic（透出后端 message）
 */
export function mapAdjustError(error: unknown): PlanAdjustError {
	if (error instanceof ApiError) {
		const message = error.message || "操作失败，请稍后重试";
		switch (error.code) {
			case "PLAN_ALLOCATION_LIMIT": {
				const caps = errorCaps(error);
				if (caps !== null) {
					return {
						kind: "overLimit",
						caps,
						message: `当前未分配余额为 ${caps.unallocatedBalance}，最多可分配 ${caps.limit}（还需使用 ${caps.stillNeeded}）`,
					};
				}
				return { kind: "generic", message };
			}
			case "PLAN_TARGET_BELOW_USED":
			case "PLAN_ALLOCATION_BELOW_USED": {
				const data = errorData(error);
				return {
					kind: "belowUsed",
					field:
						error.code === "PLAN_TARGET_BELOW_USED" ? "target" : "allocation",
					used: errorAmount(data?.used),
					shortfall: errorAmount(data?.shortfall),
					message,
				};
			}
			case "PLAN_STATE_CHANGED":
				return {
					kind: "conflict",
					message: "计划已被其他修改更新，请重新预览后提交",
				};
			case "PLAN_INVALID_TRANSITION":
				return { kind: "invalidTransition", message };
			default:
				return { kind: "generic", message };
		}
	}
	return {
		kind: "generic",
		message: error instanceof Error ? error.message : "操作失败，请稍后重试",
	};
}

// ────────────────────────── 状态机 ──────────────────────────

/** 状态机阶段 */
export type PlanAdjustPhase =
	/** 编辑中（含因可恢复错误回到编辑） */
	| "editing"
	/** 预览请求进行中 */
	| "previewing"
	/** 预览就绪，展示影响待确认 */
	| "confirming"
	/** 提交请求进行中 */
	| "submitting"
	/** 提交结果不明，正在重新 GET 详情核对 */
	| "verifying";

export interface PlanAdjustState {
	phase: PlanAdjustPhase;
	/** 编辑表单值（超限预填直接改写此值，其余字段保留） */
	form: PlanAdjustFormValues;
	/** 初始基线（详情现值；diff 判定「至少一项」的对照） */
	initialForm: PlanAdjustFormValues;
	/** 字段格式预检错误（与提交错误分开，驱动内联红字） */
	formErrors: PlanAdjustFormErrors;
	/** 预览结果（confirming 及之后可读） */
	preview: AdjustPreviewResult | null;
	/** 乐观锁值（详情 updatedAt 原值；retryPreview 后刷新） */
	expectedUpdatedAt: string | null;
	/** 提交/预览错误（交互规格表分支） */
	error: PlanAdjustError | null;
	/** 提交结果不明（verifying 完成后置位，提示用户核对最新数据） */
	unknownOutcome: boolean;
	/** 核对拿回的最新详情（结果不明场景供页面刷新展示） */
	reconciledDetail: PlanDetail | null;
}

const EMPTY_FORM: PlanAdjustFormValues = {
	targetAmount: "",
	allocatedAmount: "",
	pacePreference: "",
	prepLeadDays: "",
};

const INITIAL_STATE: PlanAdjustState = {
	phase: "editing",
	form: EMPTY_FORM,
	initialForm: EMPTY_FORM,
	formErrors: {},
	preview: null,
	expectedUpdatedAt: null,
	error: null,
	unknownOutcome: false,
	reconciledDetail: null,
};

export interface UsePlanAdjustResult extends PlanAdjustState {
	/** 从详情进入编辑（预填现值 + 记录乐观锁值） */
	startEditing: (plan: PlanDetail) => void;
	/** 编辑表单字段更新（同步清该字段错误） */
	setField: <K extends PlanAdjustFormField>(
		field: K,
		value: PlanAdjustFormValues[K],
	) => void;
	/** 第一段：预览（当前 form 组装参数；成功进入 confirming） */
	runPreview: () => Promise<boolean>;
	/** 第二段：确认提交（成功返回提交后详情；409 等错误入 state 返回 null） */
	confirm: () => Promise<PlanDetail | null>;
	/** 409 后重放：GET 最新详情刷新乐观锁值 → 用保留参数重新预览 */
	retryPreview: () => Promise<boolean>;
	/** 预览确认态回退到编辑（保留已填表单，不重新预填现值） */
	backToEditing: () => void;
	/** 清错误（重新预览按钮点击前等场景） */
	clearError: () => void;
	/** 复位（关闭对话框时调用） */
	reset: () => void;
}

export function usePlanAdjust(): UsePlanAdjustResult {
	const [state, setState] = useState<PlanAdjustState>(INITIAL_STATE);
	// planId 由 startEditing 记录；requestId 防异步竞态（重置后旧响应不再写入）
	const planIdRef = useRef<string | null>(null);
	const requestIdRef = useRef(0);

	const nextRequestId = useCallback(() => {
		requestIdRef.current += 1;
		return requestIdRef.current;
	}, []);

	const isStale = useCallback((id: number) => id !== requestIdRef.current, []);

	const startEditing = useCallback((plan: PlanDetail) => {
		planIdRef.current = plan.id;
		requestIdRef.current += 1;
		const form = formValuesFromDetail(plan);
		setState({
			...INITIAL_STATE,
			form,
			initialForm: form,
			expectedUpdatedAt: plan.updatedAt,
		});
	}, []);

	const setField = useCallback(
		<K extends PlanAdjustFormField>(
			field: K,
			value: PlanAdjustFormValues[K],
		) => {
			setState((prev) => ({
				...prev,
				form: { ...prev.form, [field]: value },
				formErrors: { ...prev.formErrors, [field]: undefined },
			}));
		},
		[],
	);

	/** 预览的核心执行（runPreview 与 retryPreview 共用；stale 防竞态） */
	const runPreviewRequest = useCallback(
		async (params: AdjustPlanParams): Promise<boolean> => {
			const planId = planIdRef.current;
			if (planId === null) return false;
			const requestId = nextRequestId();
			setState((prev) => ({
				...prev,
				phase: "previewing",
				error: null,
			}));
			try {
				const preview = await plansApi.adjustPreview(planId, params);
				if (isStale(requestId)) return false;
				setState((prev) => ({
					...prev,
					phase: "confirming",
					preview,
					error: null,
				}));
				return true;
			} catch (error: unknown) {
				if (isStale(requestId)) return false;
				setState((prev) => ({
					...prev,
					phase: "editing",
					preview: null,
					error: mapAdjustError(error),
				}));
				return false;
			}
		},
		[isStale, nextRequestId],
	);

	const runPreview = useCallback(async (): Promise<boolean> => {
		const params = buildAdjustParams(state.form, state.initialForm);
		if (params === null) {
			setState((prev) => ({
				...prev,
				error: {
					kind: "generic",
					message: "请至少修改一项内容再生成预览",
				},
			}));
			return false;
		}
		const formErrors = validateAdjustForm(state.form);
		if (Object.keys(formErrors).length > 0) {
			setState((prev) => ({ ...prev, formErrors }));
			return false;
		}
		const ok = await runPreviewRequest(params);
		return ok;
	}, [runPreviewRequest, state.form]);

	const confirm = useCallback(async (): Promise<PlanDetail | null> => {
		const planId = planIdRef.current;
		const params = buildAdjustParams(state.form, state.initialForm);
		const expectedUpdatedAt = state.expectedUpdatedAt;
		if (planId === null || params === null || expectedUpdatedAt === null) {
			return null;
		}
		// 重新开启场景（preview.reopen）：只送目标金额 + confirmReopen，
		// 后端拒绝重开时携带分配/节奏/准备缓冲参数（400 INVALID_PLAN_PARAMS）
		const body = state.preview?.reopen
			? {
					newTargetAmount: params.newTargetAmount,
					expectedUpdatedAt,
					confirmReopen: true,
				}
			: { ...params, expectedUpdatedAt };
		const requestId = nextRequestId();
		setState((prev) => ({ ...prev, phase: "submitting", error: null }));
		try {
			const detail = await plansApi.adjust(planId, body);
			if (isStale(requestId)) return null;
			setState((prev) => ({ ...prev, phase: "editing", preview: null }));
			return detail;
		} catch (error: unknown) {
			if (isStale(requestId)) return null;
			// 提交结果不明（网络层失败，无 HTTP 响应）：不盲目重发 PATCH，
			// 重新 GET 详情核对，交由用户核对最新数据
			if (!(error instanceof ApiError)) {
				setState((prev) => ({ ...prev, phase: "verifying", error: null }));
				try {
					const latest = await plansApi.getDetail(planId);
					if (isStale(requestId)) return null;
					setState((prev) => ({
						...prev,
						phase: "editing",
						preview: null,
						unknownOutcome: true,
						reconciledDetail: latest,
						expectedUpdatedAt: latest.updatedAt,
					}));
				} catch {
					if (isStale(requestId)) return null;
					setState((prev) => ({
						...prev,
						phase: "editing",
						preview: null,
						unknownOutcome: true,
						error: {
							kind: "generic",
							message: "提交结果不明，且核对失败，请手动刷新页面核对计划状态",
						},
					}));
				}
				return null;
			}
			const mapped = mapAdjustError(error);
			// 超限：预填 caps.limit 到分配总额引导改值，不清空已填表单
			if (mapped.kind === "overLimit") {
				setState((prev) => ({
					...prev,
					phase: "editing",
					preview: null,
					error: mapped,
					form: { ...prev.form, allocatedAmount: mapped.caps.limit },
					formErrors: {},
				}));
				return null;
			}
			setState((prev) => ({
				...prev,
				phase: "editing",
				preview: null,
				error: mapped,
			}));
			return null;
		}
	}, [
		isStale,
		nextRequestId,
		state.expectedUpdatedAt,
		state.form,
		state.preview,
	]);

	const retryPreview = useCallback(async (): Promise<boolean> => {
		const planId = planIdRef.current;
		const params = buildAdjustParams(state.form, state.initialForm);
		if (planId === null || params === null) return false;
		const requestId = nextRequestId();
		setState((prev) => ({ ...prev, phase: "previewing", error: null }));
		// 先取最新详情刷新乐观锁值（旧 updatedAt 已被 409 判定失效）
		try {
			const latest = await plansApi.getDetail(planId);
			if (isStale(requestId)) return false;
			setState((prev) => ({
				...prev,
				expectedUpdatedAt: latest.updatedAt,
			}));
		} catch (error: unknown) {
			if (isStale(requestId)) return false;
			setState((prev) => ({
				...prev,
				phase: "editing",
				error: mapAdjustError(error),
			}));
			return false;
		}
		// 用保留的参数重新预览（已填内容不清空）
		return runPreviewRequest(params);
	}, [isStale, nextRequestId, runPreviewRequest, state.form]);

	const clearError = useCallback(() => {
		setState((prev) => ({ ...prev, error: null }));
	}, []);

	/** 预览确认态回退到编辑：保留已填表单与乐观锁值，仅清预览与错误 */
	const backToEditing = useCallback(() => {
		setState((prev) => ({
			...prev,
			phase: "editing",
			preview: null,
			error: null,
		}));
	}, []);

	const reset = useCallback(() => {
		planIdRef.current = null;
		requestIdRef.current += 1;
		setState(INITIAL_STATE);
	}, []);

	return {
		...state,
		startEditing,
		setField,
		runPreview,
		confirm,
		retryPreview,
		backToEditing,
		clearError,
		reset,
	};
}
