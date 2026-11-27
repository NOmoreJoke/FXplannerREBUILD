import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { reportsApi } from "@/lib/api/reports";
import { ReportPlanList } from "./report-plan-list";

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

vi.mock("@/lib/api/reports", () => ({
	reportsApi: {
		listPlans: vi.fn(),
	},
}));

describe("ReportPlanList (P1 plan.create empty-state gate)", () => {
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
		vi.mocked(reportsApi.listPlans).mockResolvedValue({
			baseCurrency: "CNY",
			items: [],
		});
	});

	it("具备 plan.create 权限时在空态展示「去创建计划」入口", async () => {
		canMock.mockImplementation((perm) => perm === "plan.create");
		render(<ReportPlanList onDownload={vi.fn()} />, { wrapper: Wrapper });

		await waitFor(() =>
			expect(screen.getByTestId("reports-empty")).toBeTruthy(),
		);
		expect(screen.getByTestId("reports-empty-create")).toBeTruthy();
	});

	it("缺少 plan.create 权限（如 Viewer）时在空态隐藏「去创建计划」入口", async () => {
		canMock.mockReturnValue(false);
		render(<ReportPlanList onDownload={vi.fn()} />, { wrapper: Wrapper });

		await waitFor(() =>
			expect(screen.getByTestId("reports-empty")).toBeTruthy(),
		);
		expect(screen.queryByTestId("reports-empty-create")).toBeNull();
	});
});
