import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { plansApi } from "@/lib/api/plans";
import type { PlanDetail } from "@/lib/api/contract";
import {
	buildAdjustParams,
	formValuesFromDetail,
	hasAnyChange,
	mapAdjustError,
	usePlanAdjust,
	validateAdjustForm,
	type PlanAdjustFormValues,
} from "./use-plan-adjust";

// Mock plansApi（状态机所有 IO 收敛于此，测试聚焦状态流转与参数组装）
vi.mock("@/lib/api/plans", () => ({
	plansApi: {
		adjustPreview: vi.fn(),
		adjust: vi.fn(),
		getDetail: vi.fn(),
	},
}));

// 真实 client.ts 顶层校验 NEXT_PUBLIC_API_BASE_URL（测试环境不存在），mock 掉；
// 类定义须置于工厂内（vi.mock 被提升），mapAdjustError 内 instanceof 与本文件
// 拿到的 ApiError 即同一 mock 类（范式对齐 use-schedule-preview.spec.ts）。
vi.mock("@/lib/api/client", () => {
	class MockApiError extends Error {
		constructor(
			message: string,
			readonly status: number,
			readonly code?: string,
			readonly body?: Record<string, unknown>,
		) {
			super(message);
			this.name = "ApiError";
		}
	}
	return { ApiError: MockApiError };
});

import { ApiError } from "@/lib/api/client";

/** 计划详情夹具（技术方案 §4.2 示例口径：目标 10000 / 已用 4000 / 分配 6000） */
const planDetail: PlanDetail = {
	id: "plan-1",
	name: "今年换 5 万美元",
	status: "ACTIVE",
	targetCurrency: "USD",
	targetAmount: "10000.0000",
	usedAmount: "4000.0000",
	allocatedAmount: "6000.0000",
	remainingAllocation: "2000.0000",
	stillNeeded: "6000.0000",
	fundStatus: "PREPARING",
	gap: "8000.0000",
	latestPrepDate: "2027-07-28T00:00:00.000Z",
	nextInstallmentAt: "2027-07-01T00:00:00.000Z",
	updatedAt: "2026-09-16T08:30:00.123Z",
	pacePreference: "balanced",
	prepLeadDays: 3,
	expectUseDate: "2027-08-01T00:00:00.000Z",
	planStartDate: null,
	installments: [],
	changeLogs: [],
	canModify: true,
	canCancel: true,
	canComplete: false,
	canReopen: false,
};

/** 预览响应夹具（非 reopen） */
const previewResult = {
	valid: true,
	reopen: false,
	caps: null,
	impact: {
		releasedAmount: "2000.0000",
		newGap: "8000.0000",
		newSchedule: null,
		scheduleDropped: true,
	},
	before: {
		targetAmount: "10000.0000",
		allocAmount: "6000.0000",
		usedAmount: "4000.0000",
		remainingAllocation: "2000.0000",
		gap: "8000.0000",
		pacePreference: "balanced",
		prepLeadDays: 3,
		planStartDate: null,
	},
	after: {
		targetAmount: "8000.0000",
		allocAmount: "4000.0000",
		usedAmount: "4000.0000",
		remainingAllocation: "0.0000",
		gap: "4000.0000",
		pacePreference: "balanced",
		prepLeadDays: 3,
		planStartDate: null,
	},
	newLatestPrepDate: "2027-07-28T00:00:00.000Z",
} as const;

/** 提交成功后的详情（updatedAt 推进，模拟乐观锁推进） */
const adjustedDetail: PlanDetail = {
	...planDetail,
	targetAmount: "8000.0000",
	allocatedAmount: "4000.0000",
	updatedAt: "2026-09-16T09:00:00.000Z",
};

/** 进入「预览就绪」态的公共前置：startEditing + 改目标 8000/分配 4000 + runPreview 成功 */
async function renderInConfirmingPhase() {
	vi.mocked(plansApi.adjustPreview).mockResolvedValueOnce(previewResult);
	const { result } = renderHook(() => usePlanAdjust());
	act(() => {
		result.current.startEditing(planDetail);
	});
	act(() => {
		result.current.setField("targetAmount", "8000");
		result.current.setField("allocatedAmount", "4000");
	});
	await act(async () => {
		await result.current.runPreview();
	});
	return { result };
}

describe("buildAdjustParams（金额字符串组装）", () => {
	const initial: PlanAdjustFormValues = {
		targetAmount: "10000.0000",
		allocatedAmount: "6000.0000",
		pacePreference: "balanced",
		prepLeadDays: "3",
	};

	it("表单与初始基线全同返回 null（至少一项拦截）", () => {
		expect(buildAdjustParams(initial, initial)).toBeNull();
		expect(hasAnyChange(initial, initial)).toBe(false);
	});

	it("金额原样字符串传输（trim，不补小数位），天数转整数", () => {
		const params = buildAdjustParams(
			{
				targetAmount: " 8000 ",
				allocatedAmount: "4000.5",
				pacePreference: "aggressive",
				prepLeadDays: " 7 ",
			},
			initial,
		);
		expect(params).toEqual({
			newTargetAmount: "8000",
			newAllocAmount: "4000.5",
			pacePreference: "aggressive",
			prepLeadDays: 7,
		});
	});

	it("未变项不携带（后端缺省沿用现值）；同值不同小数位不算修改", () => {
		const params = buildAdjustParams(
			{
				targetAmount: "9000",
				allocatedAmount: "6000",
				pacePreference: "balanced",
				prepLeadDays: "3",
			},
			initial,
		);
		// 分配 "6000" 与基线 "6000.0000" 数值同 → 不携带
		expect(params).toEqual({ newTargetAmount: "9000" });
	});

	it("从详情预填的表单全为现值 → 无修改返回 null", () => {
		const form = formValuesFromDetail(planDetail);
		expect(hasAnyChange(form, form)).toBe(false);
		expect(buildAdjustParams(form, form)).toBeNull();
	});
});

describe("validateAdjustForm / mapAdjustError", () => {
	it("金额超 4 位小数或非数字报格式错误；天数越界报错误", () => {
		const errors = validateAdjustForm({
			targetAmount: "100.00005",
			allocatedAmount: "abc",
			pacePreference: "",
			prepLeadDays: "0",
		});
		expect(errors.targetAmount).toContain("4 位小数");
		expect(errors.allocatedAmount).toContain("非负数字");
		expect(errors.prepLeadDays).toContain("1~30");
	});

	it("PLAN_ALLOCATION_LIMIT 映射 overLimit 并附 caps 三值", () => {
		const error = mapAdjustError(
			new ApiError("分配总额超出上限", 400, "PLAN_ALLOCATION_LIMIT", {
				code: "PLAN_ALLOCATION_LIMIT",
				message: "分配总额超出上限",
				data: {
					caps: {
						limit: "7000.0000",
						unallocatedBalance: "5000.0000",
						stillNeeded: "10000.0000",
					},
				},
			}),
		);
		expect(error.kind).toBe("overLimit");
		if (error.kind === "overLimit") {
			expect(error.caps.limit).toBe("7000.0000");
			// 内联提示文案含三值（交互规格表口径）
			expect(error.message).toBe(
				"当前未分配余额为 5000.0000，最多可分配 7000.0000（还需使用 10000.0000）",
			);
		}
	});

	it("PLAN_TARGET_BELOW_USED / PLAN_ALLOCATION_BELOW_USED 映射 belowUsed 并标注焦点字段", () => {
		const targetError = mapAdjustError(
			new ApiError(
				"新目标金额不能低于累计已使用金额",
				400,
				"PLAN_TARGET_BELOW_USED",
				{
					code: "PLAN_TARGET_BELOW_USED",
					message: "新目标金额不能低于累计已使用金额 4000.0000",
					data: { used: "4000.0000", shortfall: "1000.0000" },
				},
			),
		);
		expect(targetError.kind).toBe("belowUsed");
		if (targetError.kind === "belowUsed") {
			expect(targetError.field).toBe("target");
			expect(targetError.used).toBe("4000.0000");
			expect(targetError.shortfall).toBe("1000.0000");
		}

		const allocError = mapAdjustError(
			new ApiError(
				"分配总额不能低于累计已使用金额",
				400,
				"PLAN_ALLOCATION_BELOW_USED",
				{
					code: "PLAN_ALLOCATION_BELOW_USED",
					message: "分配总额不能低于累计已使用金额 4000.0000",
					data: { used: "4000.0000", shortfall: "1000.0000" },
				},
			),
		);
		expect(allocError.kind).toBe("belowUsed");
		if (allocError.kind === "belowUsed") {
			expect(allocError.field).toBe("allocation");
		}
	});
});

describe("usePlanAdjust 两段式状态机", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("编辑 → 预览成功 → confirming（预览结果就绪）→ 确认提交成功返回详情", async () => {
		vi.mocked(plansApi.adjustPreview).mockResolvedValueOnce(previewResult);
		vi.mocked(plansApi.adjust).mockResolvedValueOnce(adjustedDetail);
		const { result } = renderHook(() => usePlanAdjust());

		expect(result.current.phase).toBe("editing");

		act(() => {
			result.current.startEditing(planDetail);
		});
		expect(result.current.form).toEqual(formValuesFromDetail(planDetail));
		expect(result.current.expectedUpdatedAt).toBe(planDetail.updatedAt);

		act(() => {
			result.current.setField("targetAmount", "8000");
			result.current.setField("allocatedAmount", "4000");
		});

		let previewOk = false;
		await act(async () => {
			previewOk = await result.current.runPreview();
		});
		expect(previewOk).toBe(true);
		expect(result.current.phase).toBe("confirming");
		expect(result.current.preview?.reopen).toBe(false);
		// 预览请求携带组装后的金额字符串 + 乐观锁来源的 planId
		expect(plansApi.adjustPreview).toHaveBeenCalledWith("plan-1", {
			newTargetAmount: "8000",
			newAllocAmount: "4000",
		});

		const submitted = await act(async () => result.current.confirm());
		expect(submitted).not.toBeNull();
		expect(submitted?.updatedAt).toBe(adjustedDetail.updatedAt);
		expect(result.current.phase).toBe("editing");
		// 提交请求组装：表单参数 + expectedUpdatedAt 原值
		expect(plansApi.adjust).toHaveBeenCalledWith("plan-1", {
			newTargetAmount: "8000",
			newAllocAmount: "4000",
			expectedUpdatedAt: planDetail.updatedAt,
		});
	});

	it("未修改任何项时预览被拦截（至少一项）", async () => {
		const { result } = renderHook(() => usePlanAdjust());
		act(() => {
			result.current.startEditing(planDetail);
		});
		let previewOk = true;
		await act(async () => {
			previewOk = await result.current.runPreview();
		});
		expect(previewOk).toBe(false);
		expect(result.current.phase).toBe("editing");
		expect(result.current.error?.message).toContain("至少修改一项");
		expect(plansApi.adjustPreview).not.toHaveBeenCalled();
	});

	it("409 PLAN_STATE_CHANGED → conflict 态；重新预览用最新数据重开且已填参数保留", async () => {
		const { result } = await renderInConfirmingPhase();

		vi.mocked(plansApi.adjust).mockRejectedValueOnce(
			new ApiError(
				"计划已被其他修改更新，请重新预览后提交",
				409,
				"PLAN_STATE_CHANGED",
			),
		);
		const submitted = await act(async () => result.current.confirm());
		expect(submitted).toBeNull();
		expect(result.current.phase).toBe("editing");
		expect(result.current.error?.kind).toBe("conflict");

		// 「重新预览」：GET 最新详情（刷新乐观锁值）→ 用保留参数重新预览
		vi.mocked(plansApi.getDetail).mockResolvedValueOnce(adjustedDetail);
		vi.mocked(plansApi.adjustPreview).mockResolvedValueOnce(previewResult);
		let retryOk = false;
		await act(async () => {
			retryOk = await result.current.retryPreview();
		});
		expect(retryOk).toBe(true);
		expect(plansApi.getDetail).toHaveBeenCalledWith("plan-1");
		expect(result.current.expectedUpdatedAt).toBe(adjustedDetail.updatedAt);
		expect(result.current.phase).toBe("confirming");
		// 已填参数保留到预填：重新预览仍用原参数
		expect(plansApi.adjustPreview).toHaveBeenLastCalledWith("plan-1", {
			newTargetAmount: "8000",
			newAllocAmount: "4000",
		});

		// 重放后提交携带新乐观锁值
		vi.mocked(plansApi.adjust).mockResolvedValueOnce(adjustedDetail);
		await act(async () => {
			await result.current.confirm();
		});
		expect(plansApi.adjust).toHaveBeenLastCalledWith("plan-1", {
			newTargetAmount: "8000",
			newAllocAmount: "4000",
			expectedUpdatedAt: adjustedDetail.updatedAt,
		});
	});

	it("PLAN_ALLOCATION_LIMIT → 预填 caps.limit 到分配总额，其余已填字段不清空", async () => {
		const { result } = await renderInConfirmingPhase();

		vi.mocked(plansApi.adjust).mockRejectedValueOnce(
			new ApiError("分配总额超出上限", 400, "PLAN_ALLOCATION_LIMIT", {
				code: "PLAN_ALLOCATION_LIMIT",
				message: "分配总额超出上限 7000.0000",
				data: {
					caps: {
						limit: "7000.0000",
						unallocatedBalance: "5000.0000",
						stillNeeded: "10000.0000",
					},
				},
			}),
		);
		await act(async () => {
			await result.current.confirm();
		});
		expect(result.current.phase).toBe("editing");
		expect(result.current.error?.kind).toBe("overLimit");
		// 预填 caps.limit 新值，引导用户在此基础上改
		expect(result.current.form.allocatedAmount).toBe("7000.0000");
		// 目标金额等已填内容保留
		expect(result.current.form.targetAmount).toBe("8000");
	});

	it("提交网络层失败（结果不明）→ 自动重新 GET 详情核对，不盲目重发 PATCH", async () => {
		const { result } = await renderInConfirmingPhase();

		vi.mocked(plansApi.adjust).mockRejectedValueOnce(
			new TypeError("Failed to fetch"),
		);
		vi.mocked(plansApi.getDetail).mockResolvedValueOnce(adjustedDetail);
		const submitted = await act(async () => result.current.confirm());
		expect(submitted).toBeNull();
		expect(result.current.unknownOutcome).toBe(true);
		expect(result.current.reconciledDetail?.updatedAt).toBe(
			adjustedDetail.updatedAt,
		);
		expect(result.current.expectedUpdatedAt).toBe(adjustedDetail.updatedAt);
		// 只发了一次 PATCH（核对走 GET，不重发写请求）
		expect(plansApi.adjust).toHaveBeenCalledTimes(1);
		expect(plansApi.getDetail).toHaveBeenCalledTimes(1);
		expect(result.current.phase).toBe("editing");
	});

	it("reopen 预览（重新开启）确认时只送目标金额 + confirmReopen", async () => {
		const reopenPreview = {
			...previewResult,
			reopen: true,
		};
		vi.mocked(plansApi.adjustPreview).mockResolvedValueOnce(reopenPreview);
		const { result } = renderHook(() => usePlanAdjust());
		act(() => {
			result.current.startEditing({
				...planDetail,
				status: "COMPLETED",
				canModify: false,
				canReopen: true,
			});
		});
		// 重新开启只改目标金额（分配/节奏/准备缓冲不携带，后端拒绝组合参数）
		act(() => {
			result.current.setField("targetAmount", "12000");
		});
		await act(async () => {
			await result.current.runPreview();
		});
		expect(result.current.preview?.reopen).toBe(true);

		vi.mocked(plansApi.adjust).mockResolvedValueOnce(adjustedDetail);
		await act(async () => {
			await result.current.confirm();
		});
		expect(plansApi.adjust).toHaveBeenCalledWith("plan-1", {
			newTargetAmount: "12000",
			expectedUpdatedAt: planDetail.updatedAt,
			confirmReopen: true,
		});
	});

	it("reset 复位全部状态", async () => {
		const { result } = await renderInConfirmingPhase();
		act(() => {
			result.current.reset();
		});
		expect(result.current.phase).toBe("editing");
		expect(result.current.preview).toBeNull();
		expect(result.current.expectedUpdatedAt).toBeNull();
		expect(result.current.form).toEqual({
			targetAmount: "",
			allocatedAmount: "",
			pacePreference: "",
			prepLeadDays: "",
		});
	});

	it("预览返回的 error 分支写回 editing 态（如 PLAN_INVALID_TRANSITION）", async () => {
		vi.mocked(plansApi.adjustPreview).mockRejectedValueOnce(
			new ApiError("当前状态不可修改", 409, "PLAN_INVALID_TRANSITION"),
		);
		const { result } = renderHook(() => usePlanAdjust());
		act(() => {
			result.current.startEditing(planDetail);
		});
		act(() => {
			result.current.setField("targetAmount", "8000");
		});
		let previewOk = true;
		await act(async () => {
			previewOk = await result.current.runPreview();
		});
		expect(previewOk).toBe(false);
		expect(result.current.phase).toBe("editing");
		expect(result.current.error?.kind).toBe("invalidTransition");
	});

	it("confirm 后 error 可被 clearError 清除", async () => {
		const { result } = await renderInConfirmingPhase();
		vi.mocked(plansApi.adjust).mockRejectedValueOnce(
			new ApiError(
				"计划已被其他修改更新，请重新预览后提交",
				409,
				"PLAN_STATE_CHANGED",
			),
		);
		await act(async () => {
			await result.current.confirm();
		});
		expect(result.current.error?.kind).toBe("conflict");
		await waitFor(() => {
			expect(result.current.phase).toBe("editing");
		});
		act(() => {
			result.current.clearError();
		});
		expect(result.current.error).toBeNull();
	});
});
