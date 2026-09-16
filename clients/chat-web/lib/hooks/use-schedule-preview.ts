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
				return "净到账金额过小，无法拆分为 3 批排期，请调大金额";
			case "INVALID_PLAN_PARAMS":
				return "表单参数不合法，请检查各字段后重试";
			default:
				break;
		}
	}
	return "排期预览生成失败，请稍后重试";
}

/** 关键字段齐备判定：币种非空、金额合法、日期晚于今天、天数为 1~30 整数（复用表单校验） */
function isPreviewReady(input: SchedulePreviewInput): boolean {
	const probe: PlanFormValues = {
		...DEFAULT_PLAN_FORM_VALUES,
		targetCurrency: input.targetCurrency,
		targetAmount: input.targetAmount,
		expectUseDate: input.expectUseDate,
		prepLeadDays: input.prepLeadDays,
	};
	const errors = validatePlanForm(probe, null);
	return (
		errors.targetCurrency === undefined &&
		errors.targetAmount === undefined &&
		errors.expectUseDate === undefined &&
		errors.prepLeadDays === undefined
	);
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
	]);

	return state;
}
