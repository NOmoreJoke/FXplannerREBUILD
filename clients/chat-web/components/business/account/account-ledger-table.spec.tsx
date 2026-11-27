import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AccountLedgerResp } from "@/lib/api/accounts";
import { AccountLedgerTable } from "./account-ledger-table";

const { canMock } = vi.hoisted(() => ({
	canMock: vi.fn<(permission: string) => boolean>(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/hooks/use-organization-capabilities", () => ({
	useOrganizationCapabilities: () => ({
		can: canMock,
		isLoading: false,
		isError: false,
		role: "OWNER",
		capabilities: {},
		onboardingCompleted: true,
		dataRequestLock: { active: false, type: null },
	}),
}));

const sampleLedger: AccountLedgerResp = {
	baseCurrency: "CNY",
	items: [
		{
			id: "init-1",
			type: "INITIAL",
			occurredAt: "2026-11-20T00:00:00.000Z",
			quantity: "1000.0000",
			totalCost: "7100.0000",
			feeKnown: true,
			version: 1,
		},
		{
			id: "tx-1",
			type: "PURCHASE",
			occurredAt: "2026-11-21T00:00:00.000Z",
			quantity: "500.0000",
			totalCost: "3550.0000",
			feeKnown: true,
			version: 1,
		},
	],
};

describe("AccountLedgerTable (P1 correction.apply capability gate)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("具备 correction.apply 权限时渲染初始持仓更正入口", () => {
		canMock.mockImplementation((perm) => perm === "correction.apply");
		render(<AccountLedgerTable ledger={sampleLedger} />);

		expect(screen.getByTestId("initial-correction-entry")).toBeTruthy();
	});

	it("缺少 correction.apply 权限（如 Viewer/Operator）时不渲染初始持仓更正入口，但仍保留买入详情链接", () => {
		canMock.mockReturnValue(false);
		render(<AccountLedgerTable ledger={sampleLedger} />);

		expect(screen.queryByTestId("initial-correction-entry")).toBeNull();
		expect(screen.getByRole("link", { name: "查看买入详情" })).toBeTruthy();
	});
});
