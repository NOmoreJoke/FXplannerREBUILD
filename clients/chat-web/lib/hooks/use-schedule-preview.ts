import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { plansApi } from "@/lib/api/plans";
import type {
	PacePreference,
	PlanCaps,
	PlanInstallment,
} from "@/lib/api/contract";
import {
	DEFAULT_PLAN_FORM_VALUES,
	validatePlanForm,
	type PlanFormValues,
} from "./use-plan-form";

/**
 * 分批排期实时预览（changes/plan-creation/技术方案.md §6 时序图②③）
 *
 * 关键字段齐备后防抖 400ms 调 POST /plans/schedule-preview（只读不落库）；
 * cleanup 置 cancelled 防竞态，只保留最后一次请求的结果；失败清空全部预览数据。
 */

const PREVIEW_DEBOUNCE_MS = 400;

/** 触发预览的关键字段（金额/天数沿用表单 string 口径） */
export interface SchedulePreviewInput {
	targetCurrency: string;
	targetAmount: string;
	expectUseDate: string;
	prepLeadDays: string;
	pacePreference: PacePreference;
	/** 计入已有外币（金额字符串；空串按 "0"；参与分批总额扣减，与创建口径一致） */
	allocatedAmount: string;
}

/** 预览结果状态 */
export interface SchedulePreviewState {
	installments: PlanInstallment[];
	caps: PlanCaps | null;
	latestPrepDate: string | null;
	/** 防抖等待或请求进行中（体验上统称「生成中」） */
	isPreviewing: boolean;
	/** 映射后的中文错误文案；null = 无错误 */
	previewError: string | null;
}

const EMPTY_STATE: SchedulePreviewState = {
	installments: [],
	caps: null,
	latestPrepDate: null,
	isPreviewing: false,
	previewError: null,
};

/** preview 400 错误码 → 中文提示；未知错误兜底 */
export function mapPreviewError(error: unknown): string {
	if (error instanceof ApiError) {
		switch (error.code) {
			case "NO_AVAILABLE_DATES":
				return "用途日期过早，该区间内没有可安排的准备日，请放宽用途日期或调整提前天数";
			case "AMOUNT_TOO_SMALL":
				return "待准备金额过小，无法拆分排期；请调大目标金额或降低计入的已有外币";
			case "INVALID_PLAN_PARAMS":
				return "表单参数不合法，请检查各字段后重试";
			default:
				break;
		}
	}
	return "排期预览生成失败，请稍后重试";
}

/** 非负金额（不含符号/千分位）；与 use-plan-form 同规则（体验层，权威校验在服务端） */
const ALLOCATED_PATTERN = /^\d+(\.\d+)?$/;

/**
 * 关键字段齐备判定：币种非空、金额合法、日期晚于今天、天数为 1~30 整数、
 * 计入金额格式合法（复用表单校验）
 */
function isPreviewReady(input: SchedulePreviewInput): boolean {
	const probe: PlanFormValues = {
		...DEFAULT_PLAN_FORM_VALUES,
		targetCurrency: input.targetCurrency,
		targetAmount: input.targetAmount,
		expectUseDate: input.expectUseDate,
		prepLeadDays: input.prepLeadDays,
		allocatedAmount: input.allocatedAmount,
	};
	const errors = validatePlanForm(probe, null);
	return (
		errors.targetCurrency === undefined &&
		errors.targetAmount === undefined &&
		errors.expectUseDate === undefined &&
		errors.prepLeadDays === undefined &&
		errors.allocatedAmount === undefined
	);
}

/**
 * 「计入已有外币 ≥ 目标金额」本地预判：分批总额 ≤ 0，创建必被后端拒（AMOUNT_TOO_SMALL），
 * 发请求只会拿到误导性排期（FXP 缺陷修复：预览必须与创建口径一致）。
 * 返回专属提示文案；null = 未命中，正常走预览请求。
 */
function coveredByAllocated(input: SchedulePreviewInput): string | null {
	const allocatedText = input.allocatedAmount.trim() || "0";
	if (!ALLOCATED_PATTERN.test(allocatedText)) {
		return null; // 格式问题由 isPreviewReady 拦截，此处不重复处理
	}
	const allocated = Number(allocatedText);
	const target = Number(input.targetAmount.trim());
	if (allocated >= target) {
		return "计入已有外币已达到或超过目标金额，无需分批准备；请降低计入金额或调高目标金额";
	}
	return null;
}

export function useSchedulePreview(
	input: SchedulePreviewInput,
): SchedulePreviewState {
	const [state, setState] = useState<SchedulePreviewState>(EMPTY_STATE);

	useEffect(() => {
		if (!isPreviewReady(input)) {
			setState(EMPTY_STATE);
			return;
		}

		// 计入已有外币已覆盖目标：不发请求，直接给提示态（创建将同因被后端拒）
		const covered = coveredByAllocated(input);
		if (covered !== null) {
			setState({ ...EMPTY_STATE, previewError: covered });
			return;
		}

		// 防抖等待期即标记生成中，避免「填完却静默无响应」的体验断档
		setState({ ...EMPTY_STATE, isPreviewing: true });

		let cancelled = false;
		const timer = setTimeout(() => {
			plansApi
				.preview({
					targetCurrency: input.targetCurrency.trim(),
					targetAmount: input.targetAmount.trim(),
					expectUseDate: new Date(
						`${input.expectUseDate.trim()}T00:00:00.000Z`,
					).toISOString(),
					prepLeadDays: Number(input.prepLeadDays.trim()),
					pacePreference: input.pacePreference,
					allocatedAmount: input.allocatedAmount.trim() || "0",
				})
				.then((resp) => {
					if (cancelled) return;
					setState({
						installments: resp.installments,
						caps: resp.caps,
						latestPrepDate: resp.latestPrepDate,
						isPreviewing: false,
						previewError: null,
					});
				})
				.catch((error: unknown) => {
					if (cancelled) return;
					// 失败清空 installments/caps，只留错误文案
					setState({ ...EMPTY_STATE, previewError: mapPreviewError(error) });
				});
		}, PREVIEW_DEBOUNCE_MS);

		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [
		input.targetCurrency,
		input.targetAmount,
		input.expectUseDate,
		input.prepLeadDays,
		input.pacePreference,
		input.allocatedAmount,
	]);

	return state;
}
