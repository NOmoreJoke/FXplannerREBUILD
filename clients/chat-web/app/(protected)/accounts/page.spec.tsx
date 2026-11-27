import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { accountsApi } from "@/lib/api/accounts";
import AccountsPage from "./page";

const { canMock } = vi.hoisted(() => ({
	canMock: vi.fn<(permission: string) => boolean>(),
}));

vi.mock("@/lib/hooks/use-active-org", () => ({
	useActiveOrgId: () => "org-1",
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

vi.mock("@/lib/api/accounts", () => ({
	accountsApi: {
		list: vi.fn(),
	},
}));

describe("AccountsPage (P1 transaction.create capability gate)", () => {
	let queryClient: QueryClient;

	function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		vi.mocked(accountsApi.list).mockResolvedValue({
			baseCurrency: "CNY",
			accounts: [],
		});
	});

	it("具备 transaction.create 权限时在页眉与空态展示「录入换汇」入口", async () => {
		canMock.mockImplementation((perm) => perm === "transaction.create");
		render(<AccountsPage />, { wrapper: Wrapper });

		await waitFor(() =>
			expect(screen.getByTestId("accounts-create-transaction")).toBeTruthy(),
		);
		expect(screen.getByTestId("accounts-empty-create-transaction")).toBeTruthy();
	});

	it("缺少 transaction.create 权限（如 Viewer/Operator）时隐藏页眉与空态「录入换汇」入口", async () => {
		canMock.mockReturnValue(false);
		render(<AccountsPage />, { wrapper: Wrapper });

		await waitFor(() =>
			expect(screen.getByText("还没有任何外汇账户")).toBeTruthy(),
		);
		expect(screen.queryByTestId("accounts-create-transaction")).toBeNull();
		expect(screen.queryByTestId("accounts-empty-create-transaction")).toBeNull();
	});
});
