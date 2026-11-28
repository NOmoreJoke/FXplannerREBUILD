import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TransactionDetail } from "./transaction-detail";
import type { TransactionDto } from "@/lib/api/contract";

vi.mock("@/lib/hooks/use-organization-capabilities", () => ({
	useOrganizationCapabilities: () => ({
		can: () => true,
		isLoading: false,
	}),
}));

vi.mock("@/components/business/correction", () => ({
	CorrectionHistoryList: () => <div data-testid="mock-history" />,
}));

const sampleTx: TransactionDto = {
	id: "tx-1",
	currencyCode: "JPY",
	quantity: "10000",
	principalAmount: "500.0000",
	feeAmount: "10.0000",
	feeKnown: true,
	totalCost: "510.0000",
	exchangeRate: "0.05000000",
	transactedAt: "2026-11-20T00:00:00.000Z",
	planId: null,
	planName: null,
	version: 1,
};

describe("TransactionDetail（动态本位币与保留说明）", () => {
	it("按传入 baseCurrency 动态展示本金/手续费/总成本单位，不写死 CNY", () => {
		const { rerender } = render(
			<TransactionDetail detail={sampleTx} baseCurrency="HKD" />,
		);

		expect(screen.getByText("500.0000 HKD")).toBeTruthy();
		expect(screen.getByText("10.0000 HKD")).toBeTruthy();
		expect(screen.getByText("510.0000 HKD")).toBeTruthy();
		expect(screen.queryByText(/CNY/)).toBeNull();
		expect(
			screen.getByText(/单笔更正保留原记录及修改历史，整套数据清理按账号与组织数据规则处理/),
		).toBeTruthy();

		rerender(<TransactionDetail detail={sampleTx} baseCurrency={null} />);
		expect(screen.getByText("500.0000")).toBeTruthy();
		expect(screen.queryByText(/CNY|HKD/)).toBeNull();
	});
});
