import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { DataRequestView } from "@/lib/api/contract";
import { RequestProgress } from "./request-progress";

const { canMock } = vi.hoisted(() => ({
	canMock: vi.fn<(permission: string) => boolean>(),
}));

vi.mock("@/lib/hooks/use-organization-capabilities", () => ({
	useOrganizationCapabilities: () => ({
		can: canMock,
		isLoading: false,
		isError: false,
		role: "ADMIN",
		capabilities: {},
		onboardingCompleted: true,
		dataRequestLock: { active: false, type: null },
	}),
}));

vi.mock("@/lib/hooks/use-data-request", () => ({
	useCancelPersonalDataRequest: () => ({ mutate: vi.fn(), isPending: false }),
	useCancelOrganizationDataRequest: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/stores/auth-store", () => ({
	useAuthStore: (selector: (s: { user: { email: string } | null }) => unknown) =>
		selector({ user: { email: "tester@example.com" } }),
}));

function Wrapper({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient();
	return (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

const baseOrgClearView: DataRequestView = {
	id: "req-org-clear-1",
	scope: "ORGANIZATION",
	organizationId: "org-1",
	type: "CLEAR",
	status: "PENDING",
	requestedAt: "2026-11-26T00:00:00.000Z",
	dueAt: "2026-12-03T00:00:00.000Z",
	processedAt: null,
	displayStatus: "SUBMITTED",
	canCancel: true,
	isRequester: true,
	withdrawDeadline: null,
	download: null,
};

const baseOrgExportView: DataRequestView = {
	...baseOrgClearView,
	id: "req-org-export-1",
	type: "EXPORT",
	status: "COMPLETED",
	displayStatus: "COMPLETED",
	canCancel: false,
	download: {
		url: "/api/organizations/current/data-requests/req-org-export-1/download",
		expiresAt: "2026-11-27T00:00:00.000Z",
	},
};

describe("RequestProgress (N4 isRequester gating)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("组织 CLEAR 请求：发起人本人且具备 data.clear 权限时展示撤回按钮、不展示非发起人提示", () => {
		canMock.mockImplementation((perm) => perm === "data.clear");
		render(<RequestProgress view={{ ...baseOrgClearView, isRequester: true }} />, {
			wrapper: Wrapper,
		});

		expect(screen.getByTestId("request-cancel")).toBeTruthy();
		expect(
			screen.queryByTestId("organization-request-non-requester-hint"),
		).toBeNull();
	});

	it("组织 CLEAR / EXPORT 请求：具备权限但非发起人本人时隐藏按钮并提示仅发起人可操作", () => {
		canMock.mockImplementation(
			(perm) => perm === "data.clear" || perm === "data.export",
		);
		const { rerender } = render(
			<RequestProgress view={{ ...baseOrgClearView, isRequester: false }} />,
			{ wrapper: Wrapper },
		);

		expect(screen.queryByTestId("request-cancel")).toBeNull();
		expect(
			screen.getByTestId("organization-request-non-requester-hint").textContent,
		).toContain("仅发起人本人可撤回或下载导出包");

		rerender(
			<RequestProgress view={{ ...baseOrgExportView, isRequester: false }} />,
		);
		expect(screen.queryByTestId("request-download")).toBeNull();
		expect(
			screen.getByTestId("organization-request-non-requester-hint"),
		).toBeTruthy();
	});

	it("组织请求对无权成员（Viewer）仅展示进度，不展示撤回/下载按钮也不展示非发起人提示", () => {
		canMock.mockReturnValue(false);
		render(
			<RequestProgress view={{ ...baseOrgClearView, isRequester: false }} />,
			{ wrapper: Wrapper },
		);

		expect(screen.getByTestId("request-progress")).toBeTruthy();
		expect(screen.queryByTestId("request-cancel")).toBeNull();
		expect(
			screen.queryByTestId("organization-request-non-requester-hint"),
		).toBeNull();
	});

	it("组织 EXPORT 请求：发起人本人具备 data.export 时展示下载按钮；降权为 Viewer 时隐藏且无非发起人提示", () => {
		canMock.mockImplementation((perm) => perm === "data.export");
		const { rerender } = render(
			<RequestProgress view={{ ...baseOrgExportView, isRequester: true }} />,
			{ wrapper: Wrapper },
		);
		expect(screen.getByTestId("request-download")).toBeTruthy();
		expect(
			screen.queryByTestId("organization-request-non-requester-hint"),
		).toBeNull();

		canMock.mockReturnValue(false);
		rerender(
			<RequestProgress view={{ ...baseOrgExportView, isRequester: true }} />,
		);
		expect(screen.queryByTestId("request-download")).toBeNull();
		expect(
			screen.queryByTestId("organization-request-non-requester-hint"),
		).toBeNull();
	});

	it("个人请求不受组织 capabilities 限制，始终允许本人撤回", () => {
		canMock.mockReturnValue(false);
		render(
			<RequestProgress
				view={{
					...baseOrgClearView,
					scope: "PERSONAL",
					organizationId: null,
					type: "DELETION",
					displayStatus: "WITHDRAWAL_PERIOD",
					isRequester: true,
				}}
			/>,
			{ wrapper: Wrapper },
		);

		expect(screen.getByTestId("request-cancel")).toBeTruthy();
	});
});
