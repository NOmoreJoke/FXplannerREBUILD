"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { correctionsApi } from "@/lib/api/corrections";
import type {
	CorrectionApplyResult,
	CorrectionChanges,
	CorrectionPreview,
	CorrectionTarget,
	CorrectionTargetType,
} from "@/lib/api/contract";

/**
 * 更正表单两段式状态机（corrections 技术方案 §6 / 需求 §4 通用流程）
 *
 * 目标加载 →（填写新内容 + 原因）→ 查看影响（preview，只读）→ 确认（apply，事务）。
 * 关键分支：
 * - 原因必填：客户端先拦（后端 V0 同口径权威校验）；
 * - blockers 非空：确认按钮禁用（服务端为权威防线，客户端仅隐藏无效提交）；
 * - apply 409 CORRECTION_TARGET_CHANGED：重新加载目标并提示重新查看影响，USAGE 同时清除旧预览；
 * - apply 400/409 业务拦截（V1~V4）：submitError 展示 code + message，
 *   预览结果失效需重新查看影响。
 *
 * 表单值全程 string 口径（金额/日期），仅在组装 API 参数时转换（风格对齐 use-transaction-form）。
 */

/** 手续费三态（doc 05/09：未知 ≠ 0，绝不把 null 当 0 展示） */
export type FeeMode = "keep" | "value" | "unknown";

/** 更正表单值（string 口径；空串 = 该项不修改） */
export interface CorrectionFormValues {
	/** 新币种（TRANSACTION/INITIAL_HOLDING 可改；空串沿用现值） */
	currencyCode: string;
	/** 新本金（TRANSACTION；空串沿用现值） */
	principalAmount: string;
	/** 新到账数量（TRANSACTION；空串沿用现值） */
	quantity: string;
	/** 手续费模式：keep = 不修改、value = 补录金额、unknown = 改回「未知」 */
	feeMode: FeeMode;
	/** 手续费金额（feeMode = "value" 时生效） */
	feeAmount: string;
	/** 新交易日期（TRANSACTION；yyyy-MM-dd；空串沿用现值） */
	transactedAt: string;
	/** 新金额（INITIAL_HOLDING 允许 0 / USAGE 须 > 0；空串沿用现值） */
	amount: string;
	/** 新使用日期（USAGE；yyyy-MM-dd；空串沿用现值） */
	usedAt: string;
	/** 修改原因（必填） */
	reason: string;
}

export type CorrectionFormField = keyof CorrectionFormValues;

export type CorrectionFormErrors = Partial<Record<CorrectionFormField, string>>;

/** 提交错误（ApiError 的面向展示子集） */
export interface CorrectionSubmitError {
	code?: string;
	message: string;
}

/** 表单初始值：全部「沿用现值」+ 原因空 */
export function defaultCorrectionFormValues(): CorrectionFormValues {
	return {
		currencyCode: "",
		principalAmount: "",
		quantity: "",
		feeMode: "keep",
		feeAmount: "",
		transactedAt: "",
		amount: "",
		usedAt: "",
		reason: "",
	};
}

/** 金额/日期基础格式预检（非空时）；权威校验在服务端（体验层预检，风格对齐 use-plan-adjust） */
const AMOUNT_PATTERN = /^\d+(\.\d{1,4})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 表单校验（纯函数）：原因必填 + 已填字段的格式预检 */
export function validateCorrectionForm(
	form: CorrectionFormValues,
	targetType: CorrectionTargetType,
): CorrectionFormErrors {
	const errors: CorrectionFormErrors = {};
	if (form.reason.trim() === "") {
		errors.reason = "请填写修改原因";
	}
	if (
		form.principalAmount.trim() !== "" &&
		!AMOUNT_PATTERN.test(form.principalAmount.trim())
	) {
		errors.principalAmount = "本金需为正数字符串，最多 4 位小数";
	}
	if (
		form.quantity.trim() !== "" &&
		!AMOUNT_PATTERN.test(form.quantity.trim())
	) {
		errors.quantity = "到账数量需为正数字符串";
	}
	if (form.feeMode === "value") {
		const fee = form.feeAmount.trim();
		if (fee !== "" && !AMOUNT_PATTERN.test(fee)) {
			errors.feeAmount = "手续费需为非负数字，最多 4 位小数";
		}
	}
	if (
		form.transactedAt.trim() !== "" &&
		!DATE_PATTERN.test(form.transactedAt.trim())
	) {
		errors.transactedAt = "交易日期格式需为 yyyy-MM-dd";
	}
	if (form.amount.trim() !== "" && !AMOUNT_PATTERN.test(form.amount.trim())) {
		// INITIAL_HOLDING 允许 0；USAGE 的 >0 由服务端 V4/V0 拦截，这里只做格式预检
		errors.amount = "金额需为非负数字，最多 4 位小数";
	}
	if (form.usedAt.trim() !== "" && !DATE_PATTERN.test(form.usedAt.trim())) {
		errors.usedAt = "使用日期格式需为 yyyy-MM-dd";
	}
	if (
		form.currencyCode.trim() !== "" &&
		!/^[A-Z]{3}$/.test(form.currencyCode.trim().toUpperCase())
	) {
		errors.currencyCode = "币种需为 3 位字母代码";
	}
	void targetType;
	return errors;
}

/** 是否填写了至少一项变更（原因除外；全空 = 无变化，后端 V0 亦会拦截） */
export function hasAnyCorrectionChange(form: CorrectionFormValues): boolean {
	return (
		form.currencyCode.trim() !== "" ||
		form.principalAmount.trim() !== "" ||
		form.quantity.trim() !== "" ||
		form.feeMode !== "keep" ||
		form.transactedAt.trim() !== "" ||
		form.amount.trim() !== "" ||
		form.usedAt.trim() !== ""
	);
}

/** yyyy-MM-dd → UTC 0 点 ISO（与录入页 buildTransactionPayload 同口径） */
function dateToIso(value: string): string {
	return `${value.trim()}T00:00:00.000Z`;
}

/**
 * 组装 changes 请求体（金额原样字符串传输不补小数位；未填项不携带 = 后端缺省沿用）。
 * 全空返回 null（「至少一项」客户端拦截，与 use-plan-adjust.buildAdjustParams 同思路）。
 */
export function buildCorrectionChanges(
	form: CorrectionFormValues,
	targetType: CorrectionTargetType,
): CorrectionChanges | null {
	const changes: CorrectionChanges = {};
	if (form.currencyCode.trim() !== "") {
		changes.currencyCode = form.currencyCode.trim().toUpperCase();
	}
	if (targetType === "TRANSACTION") {
		if (form.principalAmount.trim() !== "") {
			changes.principalAmount = form.principalAmount.trim();
		}
		if (form.quantity.trim() !== "") {
			changes.quantity = form.quantity.trim();
		}
		if (form.feeMode === "value" && form.feeAmount.trim() !== "") {
			changes.feeAmount = form.feeAmount.trim();
		} else if (form.feeMode === "unknown") {
			changes.feeAmount = null; // 显式改回「未知」（null ≠ 0）
		}
		if (form.transactedAt.trim() !== "") {
			changes.transactedAt = dateToIso(form.transactedAt);
		}
	} else {
		if (form.amount.trim() !== "") {
			changes.amount = form.amount.trim();
		}
		if (targetType === "USAGE" && form.usedAt.trim() !== "") {
			changes.usedAt = dateToIso(form.usedAt);
		}
	}
	const provided = Object.entries(changes).filter(
		([, value]) => value !== undefined,
	);
	return provided.length > 0 ? changes : null;
}

/** 更正表单状态机（目标加载 + 变更收集 + preview/apply + 409 重新预览提示） */
export function useCorrectionForm(
	targetType: CorrectionTargetType,
	targetId: string,
) {
	const [target, setTarget] = useState<CorrectionTarget | null>(null);
	const [targetLoading, setTargetLoading] = useState(false);
	const [targetError, setTargetError] = useState<CorrectionSubmitError | null>(
		null,
	);
	const [form, setFormValues] = useState<CorrectionFormValues>(
		defaultCorrectionFormValues,
	);
	const [preview, setPreview] = useState<CorrectionPreview | null>(null);
	const [previewing, setPreviewing] = useState(false);
	const [applying, setApplying] = useState(false);
	const [submitError, setSubmitError] = useState<CorrectionSubmitError | null>(
		null,
	);
	/** 乐观校验失配标记：apply 409 TARGET_CHANGED 后置位（UI 提示「数据已更新，请重新确认影响」） */
	const [stale, setStale] = useState(false);
	/** apply 重入守卫：同步 ref（连续快速双击按一次提交处理，验收 §7「重复/并发操作」） */
	const applyingRef = useRef(false);

	const setField = useCallback((field: CorrectionFormField, value: string) => {
		setFormValues((previous) => ({ ...previous, [field]: value }));
		setPreview(null); // 变更已修改：既有预览失效，需重新查看影响（不按旧结果提交）
	}, []);

	const setFeeMode = useCallback((mode: FeeMode) => {
		setFormValues((previous) => ({ ...previous, feeMode: mode }));
		setPreview(null);
	}, []);

	/** 加载目标当前内容（更正页挂载时调用一次） */
	const loadTarget = useCallback(async () => {
		setTargetLoading(true);
		setTargetError(null);
		try {
			const loaded = await correctionsApi.target(targetType, targetId);
			setTarget(loaded);
		} catch (error) {
			setTargetError({
				code: error instanceof ApiError ? error.code : undefined,
				message:
					error instanceof ApiError &&
					error.code === "CORRECTION_TARGET_NOT_FOUND"
						? "该记录不存在或不属于当前账号"
						: "记录加载失败，请稍后重试",
			});
		} finally {
			setTargetLoading(false);
		}
	}, [targetType, targetId]);

	const errors = useMemo(
		() => validateCorrectionForm(form, targetType),
		[form, targetType],
	);

	/** 查看影响（只读预览）；原因/无变化客户端先拦，服务端 V0 权威复验 */
	const runPreview = useCallback(async (): Promise<boolean> => {
		setSubmitError(null);
		if (Object.keys(errors).length > 0) {
			return false;
		}
		const changes = buildCorrectionChanges(form, targetType);
		if (changes === null) {
			setSubmitError({ message: "请至少修改一项内容后再查看影响" });
			return false;
		}
		setPreviewing(true);
		try {
			const result = await correctionsApi.preview({
				targetType,
				targetId,
				reason: form.reason.trim(),
				changes,
				...(targetType === "INITIAL_HOLDING"
					? { baseUpdatedAt: (target?.target.updatedAt as string) ?? undefined }
					: { baseVersion: (target?.target.version as number) ?? undefined }),
			});
			setPreview(result);
			setStale(false);
			return true;
		} catch (error) {
			setPreview(null);
			const code = error instanceof ApiError ? error.code : undefined;
			setSubmitError({
				code,
				message:
					code === "CORRECTION_TARGET_CHANGED"
						? "该记录已被其他修改更新，已为您重新加载，请重新查看影响"
						: error instanceof ApiError
							? error.message
							: "影响预览失败，请稍后重试",
			});
			if (code === "CORRECTION_TARGET_CHANGED") {
				setStale(true);
				await loadTarget();
			}
			return false;
		} finally {
			setPreviewing(false);
		}
	}, [errors, form, targetType, targetId, target, loadTarget]);

	/** 确认提交。预览中的报价或资金来源失效时，要求用户重新预览。 */
	const confirm =
		useCallback(async (): Promise<CorrectionApplyResult | null> => {
			if (
				applyingRef.current ||
				preview === null ||
				preview.blockers.length > 0
			) {
				return null; // 重入守卫 + blockers 非空不可提交（验收场景 2）
			}
			const changes = buildCorrectionChanges(form, targetType);
			if (changes === null || form.reason.trim() === "") {
				return null;
			}
			applyingRef.current = true;
			setApplying(true);
			setSubmitError(null);
			try {
				const result = await correctionsApi.apply({
					targetType,
					targetId,
					reason: form.reason.trim(),
					changes,
					...(targetType === "USAGE"
						? { expectedUsageImpact: preview.expectedUsageImpact }
						: {}),
					...(targetType === "INITIAL_HOLDING"
						? {
								baseUpdatedAt:
									(target?.target.updatedAt as string) ?? undefined,
								...(preview.holdingQuote
									? { previewQuoteKey: preview.holdingQuote.confirmationKey }
									: {}),
							}
						: { baseVersion: (target?.target.version as number) ?? undefined }),
				});
				return result;
			} catch (error) {
				const code = error instanceof ApiError ? error.code : undefined;
				if (code === "CORRECTION_QUOTE_CHANGED" ||
					(code === "RATE_QUOTE_UNAVAILABLE" && preview.holdingQuote)
				) {
					setPreview(null);
					setSubmitError({
						code,
						message: code === "CORRECTION_QUOTE_CHANGED"
							? "历史报价已变动，请重新查看影响并确认。"
							: "原时点的历史报价暂不可用，请重新查看影响。",
					});
					return null;
				}
				setSubmitError({
					code,
					message:
						code === "CORRECTION_TARGET_CHANGED" && targetType !== "USAGE"
							? "该记录已被其他修改更新，已为您重新加载，请重新查看影响后再提交"
							: error instanceof ApiError
								? error.message
								: "提交失败，请稍后重试",
				});
				if (code === "CORRECTION_TARGET_CHANGED") {
					if (targetType === "USAGE") setPreview(null);
					setStale(true);
					await loadTarget();
				}
				return null;
			} finally {
				applyingRef.current = false;
				setApplying(false);
			}
		}, [preview, form, targetType, targetId, target, loadTarget]);

	return {
		target,
		targetLoading,
		targetError,
		loadTarget,
		form,
		setField,
		setFeeMode,
		errors,
		preview,
		previewing,
		applying,
		submitError,
		stale,
		runPreview,
		confirm,
	};
}
