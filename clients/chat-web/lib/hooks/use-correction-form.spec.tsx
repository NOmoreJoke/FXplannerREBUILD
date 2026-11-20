import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useCorrectionForm } from "./use-correction-form";
import { correctionsApi } from "@/lib/api/corrections";
import type {
	CorrectionApplyResult,
	CorrectionPreview,
	CorrectionTarget,
} from "@/lib/api/contract";

/**
 * 更正表单 hook 单测（corrections 技术方案 §8.1）：
 * 原因必填客户端拦截；preview 成功/含 blockers 两态；apply 409 TARGET_CHANGED 后
 * 自动重新加载目标（stale 标记）；提交中防重复点击。
 */
vi.mock("@/lib/api/corrections", () => ({
	correctionsApi: {
		preview: vi.fn(),
		apply: vi.fn(),
		target: vi.fn(),
		list: vi.fn(),
	},
}));

// ApiError 类定义须置于工厂内（vi.mock 被提升），instanceof 分支才能命中
// （构造签名对齐真实 client.ts：message, status, code?）
vi.mock("@/lib/api/client", () => {
	class ApiError extends Error {
		readonly status: number;
		readonly code?: string;
		constructor(message: string, status: number, code?: string) {
			super(message);
			this.status = status;
			this.code = code;
		}
	}
	return { ApiError };
});

import { ApiError } from "@/lib/api/client";

const mockedTarget = vi.mocked(correctionsApi.target);
const mockedPreview = vi.mocked(correctionsApi.preview);
const mockedApply = vi.mocked(correctionsApi.apply);

const targetFixture: CorrectionTarget = {
	targetType: "TRANSACTION" as const,
	targetId: "txn-1",
	target: {
		id: "txn-1",
		currencyCode: "USD",
		quantity: "1000.0000",
		principalAmount: "7800.0000",
		feeAmount: null,
		version: 1,
	},
};

const previewFixture: CorrectionPreview = {
	targetType: "TRANSACTION" as const,
	targetId: "txn-1",
	before: {},
	after: {},
	diff: [
		{
			field: "feeAmount",
			before: null,
			after: "20.0000",
			display: "未知 → 20.0000",
		},
	],
	impacts: { balances: [], allocations: [], costs: [], warnings: [] },
	blockers: [],
};

async function setup(target = targetFixture) {
	mockedTarget.mockResolvedValue(target);
	const { result } = renderHook(() =>
		useCorrectionForm(target.targetType, target.targetId),
	);
	await act(async () => {
		await result.current.loadTarget();
	});
	return { result };
}

describe("useCorrectionForm", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("原因必填：未填原因时 runPreview 直接拦截，不发请求", async () => {
		const { result } = await setup();
		act(() => {
			result.current.setField("feeMode", "value");
			result.current.setField("feeAmount", "20.00");
		});
		let ok = true;
		await act(async () => {
			ok = await result.current.runPreview();
		});
		expect(ok).toBe(false);
		expect(result.current.errors.reason).toBe("请填写修改原因");
		expect(mockedPreview).not.toHaveBeenCalled();
	});

	it("无任何变更时客户端拦截「至少一项」，不发请求", async () => {
		const { result } = await setup();
		act(() => {
			result.current.setField("reason", "没改内容");
		});
		let ok = true;
		await act(async () => {
			ok = await result.current.runPreview();
		});
		expect(ok).toBe(false);
		expect(result.current.submitError?.message).toContain("至少修改一项");
		expect(mockedPreview).not.toHaveBeenCalled();
	});

	it("preview 成功：携带 baseVersion/原因/changes，结果落位", async () => {
		const { result } = await setup();
		act(() => {
			result.current.setField("reason", "补录手续费");
			result.current.setField("feeMode", "value");
			result.current.setField("feeAmount", "20.00");
		});
		mockedPreview.mockResolvedValueOnce(previewFixture);
		let ok = false;
		await act(async () => {
			ok = await result.current.runPreview();
		});
		await waitFor(() => expect(ok).toBe(true));
		expect(mockedPreview).toHaveBeenCalledWith(
			expect.objectContaining({
				targetType: "TRANSACTION",
				targetId: "txn-1",
				baseVersion: 1,
				reason: "补录手续费",
				changes: { feeAmount: "20.00" },
			}),
		);
		expect(result.current.preview?.diff[0].display).toBe("未知 → 20.0000");
	});

	it("preview 含 blockers 时 confirm 不提交（确认按钮禁用语义）", async () => {
		const { result } = await setup();
		act(() => {
			result.current.setField("reason", "改币种");
			result.current.setField("currencyCode", "CAD");
		});
		mockedPreview.mockResolvedValueOnce({
			...previewFixture,
			blockers: [
				{
					code: "CORRECTION_INSUFFICIENT_FUNDS",
					message: "更正后 USD 余额将变为负数",
					details: [],
				},
			],
		} satisfies CorrectionPreview);
		await act(async () => {
			await result.current.runPreview();
		});
		expect(result.current.preview?.blockers).toHaveLength(1);
		const applied = await act(async () => result.current.confirm());
		expect(applied).toBeNull();
		expect(mockedApply).not.toHaveBeenCalled();
	});

	it("apply 409 TARGET_CHANGED：置 stale 标记并自动重新加载目标", async () => {
		const { result } = await setup();
		act(() => {
			result.current.setField("reason", "补录手续费");
			result.current.setField("feeMode", "value");
			result.current.setField("feeAmount", "20.00");
		});
		mockedPreview.mockResolvedValueOnce(previewFixture);
		await act(async () => {
			await result.current.runPreview();
		});
		mockedApply.mockRejectedValueOnce(
			new ApiError("已被其他修改更新", 409, "CORRECTION_TARGET_CHANGED"),
		);
		mockedTarget.mockResolvedValue({
			...targetFixture,
			target: { ...targetFixture.target, version: 2 },
		} satisfies CorrectionTarget);
		let applied: unknown = "pending";
		await act(async () => {
			applied = await result.current.confirm();
		});
		expect(applied).toBeNull();
		expect(result.current.submitError?.code).toBe("CORRECTION_TARGET_CHANGED");
		expect(result.current.stale).toBe(true);
		// 自动重新加载目标（乐观基准刷新到 version 2）
		expect(mockedTarget).toHaveBeenCalledTimes(2);
	});

	it.each([
		[409, "CORRECTION_QUOTE_CHANGED"],
		[400, "RATE_QUOTE_UNAVAILABLE"],
	] as const)("初始持仓提交 %i %s：清除旧报价，重新预览后才能确认", async (status, code) => {
		const baseUpdatedAt = "2026-09-20T12:00:00.000Z";
		mockedTarget.mockResolvedValueOnce({
			targetType: "INITIAL_HOLDING",
			targetId: "holding-1",
			target: { currencyCode: "USD", amount: "1000.0000", updatedAt: baseUpdatedAt },
		});
		const { result } = renderHook(() =>
			useCorrectionForm("INITIAL_HOLDING", "holding-1"),
		);
		await act(async () => {
			await result.current.loadTarget();
		});
		act(() => {
			result.current.setField("reason", "当时持有的是泰铢");
			result.current.setField("currencyCode", "THB");
		});
		const firstPreview: CorrectionPreview = {
			...previewFixture,
			targetType: "INITIAL_HOLDING",
			targetId: "holding-1",
			holdingQuote: {
				confirmationKey: "old-key",
				rate: "0.21000000",
				rawRate: "0.2100000000",
				source: "abc",
				observedAt: baseUpdatedAt,
			},
		};
		mockedPreview.mockResolvedValueOnce(firstPreview);
		await act(async () => {
			await result.current.runPreview();
		});
		mockedApply.mockRejectedValueOnce(new ApiError("报价需重新预览", status, code));
		await act(async () => {
			await result.current.confirm();
		});
		expect(mockedApply).toHaveBeenLastCalledWith(expect.objectContaining({
			baseUpdatedAt,
			previewQuoteKey: "old-key",
		}));
		expect(result.current.preview).toBeNull();
		expect(result.current.submitError?.message).toContain("重新查看影响");
		expect(mockedTarget).toHaveBeenCalledTimes(1);
		expect(await result.current.confirm()).toBeNull();
		expect(mockedApply).toHaveBeenCalledTimes(1);

		mockedPreview.mockResolvedValueOnce({
			...firstPreview,
			holdingQuote: {
				...firstPreview.holdingQuote!,
				confirmationKey: "new-key",
				rate: "0.23000000",
				rawRate: "0.2300000000",
			},
		});
		await act(async () => {
			await result.current.runPreview();
		});
		expect(mockedPreview).toHaveBeenLastCalledWith({
			targetType: "INITIAL_HOLDING",
			targetId: "holding-1",
			baseUpdatedAt,
			reason: "当时持有的是泰铢",
			changes: { currencyCode: "THB" },
		});
		expect(mockedApply).toHaveBeenCalledTimes(1);
		mockedApply.mockResolvedValueOnce({
			correctionId: "c1",
			status: "APPLIED",
			targetType: "INITIAL_HOLDING",
			targetId: "holding-1",
			targetVersion: null,
			createdAt: baseUpdatedAt,
		});
		const applied = await act(async () => result.current.confirm());
		expect(applied?.status).toBe("APPLIED");
		expect(mockedApply).toHaveBeenLastCalledWith(expect.objectContaining({
			previewQuoteKey: "new-key",
		}));
	});

	it("USAGE 只提交当前预览的影响指纹，资金来源冲突后须再次预览确认", async () => {
		const { result } = await setup({
			targetType: "USAGE",
			targetId: "usage-1",
			target: { version: 1 },
		});
		act(() => {
			result.current.setField("amount", "2000");
			result.current.setField("reason", "补录使用金额");
		});
		const usagePreview: CorrectionPreview = {
			...previewFixture,
			targetType: "USAGE",
			targetId: "usage-1",
			expectedUsageImpact: "before",
		};
		mockedPreview.mockResolvedValueOnce(usagePreview);
		await act(async () => { await result.current.runPreview(); });
		mockedApply.mockRejectedValueOnce(
			new ApiError("影响已变化，请重新查看影响", 409, "CORRECTION_TARGET_CHANGED"),
		);
		expect(await act(async () => result.current.confirm())).toBeNull();
		expect(mockedApply).toHaveBeenNthCalledWith(1, {
			targetType: "USAGE",
			targetId: "usage-1",
			baseVersion: 1,
			reason: "补录使用金额",
			changes: { amount: "2000" },
			expectedUsageImpact: "before",
		});
		expect(result.current.preview).toBeNull();
		expect(result.current.submitError?.message).toContain("重新查看影响");
		expect(await act(async () => result.current.confirm())).toBeNull();
		expect(mockedApply).toHaveBeenCalledTimes(1);

		mockedPreview.mockResolvedValueOnce({ ...usagePreview, expectedUsageImpact: "after" });
		await act(async () => { await result.current.runPreview(); });
		expect(mockedApply).toHaveBeenCalledTimes(1);
		mockedApply.mockResolvedValueOnce({
			correctionId: "correction-1",
			status: "APPLIED",
			targetType: "USAGE",
			targetId: "usage-1",
			targetVersion: 2,
			createdAt: "2026-09-20T12:00:00.000Z",
		});
		const accepted = await act(async () => result.current.confirm());
		expect(accepted?.status).toBe("APPLIED");
		expect(mockedApply).toHaveBeenNthCalledWith(2, expect.objectContaining({
			expectedUsageImpact: "after",
		}));
	});

	it("提交中防重复点击：applying 期间 confirm 直接返回 null", async () => {
		const { result } = await setup();
		act(() => {
			result.current.setField("reason", "补录手续费");
			result.current.setField("feeMode", "value");
			result.current.setField("feeAmount", "20.00");
		});
		mockedPreview.mockResolvedValueOnce(previewFixture);
		await act(async () => {
			await result.current.runPreview();
		});
		let resolveApply: (value: CorrectionApplyResult) => void = () => {};
		mockedApply.mockImplementationOnce(
			() =>
				new Promise<CorrectionApplyResult>((resolve) => {
					resolveApply = resolve;
				}),
		);
		const first = result.current.confirm();
		// 未 resolve 前的第二次点击：防重复拦截
		const second = await result.current.confirm();
		expect(second).toBeNull();
		await act(async () => {
			resolveApply({
				correctionId: "c1",
				status: "APPLIED",
				targetType: "TRANSACTION",
				targetId: "txn-1",
				targetVersion: 2,
				createdAt: "2026-09-20T12:00:00.000Z",
			});
			await first;
		});
		expect(mockedApply).toHaveBeenCalledTimes(1);
	});

	it("修改任一字段后既有预览失效（不按旧结果提交）", async () => {
		const { result } = await setup();
		act(() => {
			result.current.setField("reason", "补录手续费");
			result.current.setField("feeMode", "value");
			result.current.setField("feeAmount", "20.00");
		});
		mockedPreview.mockResolvedValueOnce(previewFixture);
		await act(async () => {
			await result.current.runPreview();
		});
		expect(result.current.preview).not.toBeNull();
		act(() => {
			result.current.setField("feeAmount", "25.00");
		});
		expect(result.current.preview).toBeNull();
	});
});
