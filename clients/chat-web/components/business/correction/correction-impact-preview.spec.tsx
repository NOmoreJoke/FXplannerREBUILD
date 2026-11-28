import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
	CorrectionImpactPreview,
	formatCorrectionFieldLabel,
	formatRateSourceLabel,
} from "./correction-impact-preview";

describe("CorrectionImpactPreview（字段与汇率源中文映射）", () => {
	it("将后端字段名与汇率源代号映射为中文，未知值安全回退原值", () => {
		expect(formatCorrectionFieldLabel("principalAmount")).toBe("本金金额");
		expect(formatCorrectionFieldLabel("totalCost")).toBe("交易总成本");
		expect(formatCorrectionFieldLabel("planId")).toBe("关联计划");
		expect(formatCorrectionFieldLabel("unknownField")).toBe("unknownField");

		expect(formatRateSourceLabel("abc")).toBe("中国农业银行");
		expect(formatRateSourceLabel("er-api")).toBe("ExchangeRate-API 参考源");
		expect(formatRateSourceLabel("frankfurter")).toBe(
			"欧洲央行参考源（Frankfurter）",
		);
		expect(formatRateSourceLabel("custom-source")).toBe("custom-source");
	});

	it("组件渲染时展示中文字段标签与中文汇率来源", () => {
		render(
			<CorrectionImpactPreview
				preview={{
					targetType: "INITIAL_HOLDING",
					targetId: "ih-1",
					before: {},
					after: {},
					blockers: [],
					diff: [
						{
							field: "principalAmount",
							before: "7000.0000",
							after: "7200.0000",
							display: "7000.0000 → 7200.0000",
						},
						{
							field: "feeAmount",
							before: null,
							after: "20.0000",
							display: "未知 → 20.0000",
						},
					],
					holdingQuote: {
						confirmationKey: "key-1",
						rate: "0.21000000",
						rawRate: "0.2100000000",
						source: "abc",
						observedAt: "2026-11-20T08:00:00.000Z",
					},
					impacts: {
						balances: [],
						allocations: [],
						costs: [],
						warnings: [],
					},
				}}
			/>,
		);

		expect(screen.getByText("本金金额")).toBeTruthy();
		expect(screen.getByText("手续费")).toBeTruthy();
		expect(screen.queryByText("principalAmount")).toBeNull();
		expect(screen.getByText(/来源 中国农业银行/)).toBeTruthy();
	});
});
