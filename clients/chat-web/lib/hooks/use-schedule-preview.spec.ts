import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
	mapPreviewError,
	useSchedulePreview,
	type SchedulePreviewInput,
} from "./use-schedule-preview";
import { plansApi } from "@/lib/api/plans";
import { ApiError } from "@/lib/api/client";
import type { PlanSchedulePreviewResp } from "@/lib/api/contract";

// 真实 client.ts 顶层校验 NEXT_PUBLIC_API_BASE_URL（测试环境不存在），mock 掉；
// 类定义须置于工厂内（vi.mock 被提升），hook 内 instanceof 与本文件拿到的
// ApiError 即同一 mock 类。
vi.mock("@/lib/api/client", () => {
	class MockApiError extends Error {
		constructor(
			message: string,
			readonly status: number,
			readonly code?: string,
		) {
			super(message);
			this.name = "ApiError";
		}
	}
	return { ApiError: MockApiError };
});

vi.mock("@/lib/api/plans", () => ({
	plansApi: { preview: vi.fn(), create: vi.fn() },
}));

/** 关键字段齐备的基线输入（日期取远未来，不依赖执行日） */
const readyInput: SchedulePreviewInput = {
	targetCurrency: "USD",
	targetAmount: "50000",
	expectUseDate: "2030-08-01",
	prepLeadDays: "3",
	pacePreference: "balanced",
};

const previewResp: PlanSchedulePreviewResp = {
	latestPrepDate: "2030-07-29T00:00:00.000Z",
	installments: [
		{ seq: 1, scheduledAt: "2030-07-01T00:00:00.000Z", amount: "25000.0000" },
		{ seq: 2, scheduledAt: "2030-07-15T00:00:00.000Z", amount: "12500.0000" },
		{ seq: 3, scheduledAt: "2030-07-29T00:00:00.000Z", amount: "12500.0000" },
	],
	caps: { allocatableBalance: "12000.00", maxAllocatable: "12000.00" },
};

async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

function renderPreview(initialInput: SchedulePreviewInput) {
	return renderHook(({ input }) => useSchedulePreview(input), {
		initialProps: { input: initialInput },
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useSchedulePreview", () => {
	it("关键字段不齐备（缺币种/金额非法/日期过早/天数越界）时不发请求，状态保持全空", async () => {
		const cases: SchedulePreviewInput[] = [
			{ ...readyInput, targetCurrency: "" },
			{ ...readyInput, targetAmount: "0" },
			{ ...readyInput, expectUseDate: "2020-01-01" },
			{ ...readyInput, prepLeadDays: "0" },
		];

		for (const input of cases) {
			const { result } = renderPreview(input);
			await advance(1000);
			expect(plansApi.preview).not.toHaveBeenCalled();
			expect(result.current).toEqual({
				installments: [],
				caps: null,
				latestPrepDate: null,
				isPreviewing: false,
				previewError: null,
			});
		}
	});

	it("防抖 400ms：399ms 内不发请求，齐备即标记生成中，到点后仅发一次并落成功结果", async () => {
		vi.mocked(plansApi.preview).mockResolvedValueOnce(previewResp);

		const { result } = renderPreview(readyInput);

		// 防抖等待期即「生成中」
		expect(result.current.isPreviewing).toBe(true);

		await advance(399);
		expect(plansApi.preview).not.toHaveBeenCalled();

		await advance(1);
		expect(plansApi.preview).toHaveBeenCalledOnce();
		expect(plansApi.preview).toHaveBeenCalledWith({
			targetCurrency: "USD",
			targetAmount: "50000",
			expectUseDate: "2030-08-01T00:00:00.000Z",
			prepLeadDays: 3,
			pacePreference: "balanced",
		});
		expect(result.current).toEqual({
			installments: previewResp.installments,
			caps: previewResp.caps,
			latestPrepDate: previewResp.latestPrepDate,
			isPreviewing: false,
			previewError: null,
		});
	});

	it("防抖期间再次输入应重置计时（300ms + 300ms 不触发，再 100ms 才触发）", async () => {
		vi.mocked(plansApi.preview).mockResolvedValue(previewResp);

		const { rerender } = renderPreview({ ...readyInput, targetAmount: "1" });
		await advance(300);
		rerender({ input: { ...readyInput, targetAmount: "2" } });
		await advance(300);
		expect(plansApi.preview).not.toHaveBeenCalled();

		await advance(100);
		expect(plansApi.preview).toHaveBeenCalledOnce();
		expect(plansApi.preview).toHaveBeenCalledWith(
			expect.objectContaining({ targetAmount: "2" }),
		);
	});

	it.each([
		["NO_AVAILABLE_DATES", "用途日期过早"],
		["AMOUNT_TOO_SMALL", "净到账金额过小"],
		["INVALID_PLAN_PARAMS", "表单参数不合法"],
	] as const)(
		"preview 400 错误码 %s 应映射为中文文案，且失败清空 installments/caps",
		async (code, expectedFragment) => {
			vi.mocked(plansApi.preview).mockRejectedValueOnce(
				new ApiError("bad request", 400, code),
			);

			const { result } = renderPreview(readyInput);
			await advance(400);

			expect(result.current.previewError).toContain(expectedFragment);
			expect(result.current.installments).toEqual([]);
			expect(result.current.caps).toBeNull();
			expect(result.current.latestPrepDate).toBeNull();
			expect(result.current.isPreviewing).toBe(false);
		},
	);

	it("未知错误应落到兜底文案", async () => {
		vi.mocked(plansApi.preview).mockRejectedValueOnce(new Error("boom"));

		const { result } = renderPreview(readyInput);
		await advance(400);

		expect(result.current.previewError).toBe(
			"排期预览生成失败，请稍后重试",
		);
	});

	it("竞态防护：字段变更后旧请求晚到，只保留最后一次请求的结果", async () => {
		const laterResp: PlanSchedulePreviewResp = {
			...previewResp,
			latestPrepDate: "2030-09-28T00:00:00.000Z",
		};
		let resolveFirst!: (value: PlanSchedulePreviewResp) => void;
		let resolveSecond!: (value: PlanSchedulePreviewResp) => void;
		vi.mocked(plansApi.preview)
			.mockImplementationOnce(
				() =>
					new Promise<PlanSchedulePreviewResp>((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<PlanSchedulePreviewResp>((resolve) => {
						resolveSecond = resolve;
					}),
			);

		const { result, rerender } = renderPreview({
			...readyInput,
			targetAmount: "10000",
		});
		await advance(400); // 第一次请求发出
		rerender({ input: { ...readyInput, targetAmount: "50000" } });
		await advance(400); // 第二次请求发出（第一次已被 cleanup 置 cancelled）

		// 后发请求先返回
		resolveSecond(laterResp);
		await act(async () => {});
		// 先发请求晚到，结果应被忽略
		resolveFirst(previewResp);
		await act(async () => {});

		expect(plansApi.preview).toHaveBeenCalledTimes(2);
		expect(plansApi.preview).toHaveBeenLastCalledWith(
			expect.objectContaining({ targetAmount: "50000" }),
		);
		expect(result.current.latestPrepDate).toBe(laterResp.latestPrepDate);
		expect(result.current.installments).toEqual(previewResp.installments);
		expect(result.current.previewError).toBeNull();
	});
});

describe("mapPreviewError", () => {
	it("非 ApiError 的任意抛出值应返回兜底文案", () => {
		expect(mapPreviewError(new Error("x"))).toBe("排期预览生成失败，请稍后重试");
		expect(mapPreviewError("string error")).toBe(
			"排期预览生成失败，请稍后重试",
		);
	});
});
