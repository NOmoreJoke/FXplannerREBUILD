// Node ≥26 localStorage 回填（vitest#8757；use-organizations.spec 先例）——
// useCurrentOrganization 经 organization-store(persist) 读组织选择
vi.hoisted(() => {
	const dom = (
		globalThis as { jsdom?: { window: Window & { localStorage?: Storage } } }
	).jsdom;
	const jsdomStorage = dom?.window?.localStorage;
	if (!jsdomStorage) return;
	const globals = [globalThis, globalThis.window] as Array<
		Record<string, unknown>
	>;
	for (const target of globals) {
		if (target.localStorage === undefined) {
			Object.defineProperty(target, "localStorage", {
				value: jsdomStorage,
				configurable: true,
				writable: true,
			});
		}
	}
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LeaveOrganizationButton } from "./leave-organization-button";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { useOrganizationStore } from "@/lib/stores/organization-store";
import { queryKeys } from "@/lib/api/query-keys";
import { membersApi, organizationsApi } from "@/lib/api/organizations";
import type React from "react";

const { routerReplace } = vi.hoisted(() => ({ routerReplace: vi.fn() }));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: routerReplace }),
}));

vi.mock("@/lib/api/organizations", () => ({
	organizationsApi: {
		list: vi.fn(),
		current: vi.fn(),
		create: vi.fn(),
	},
	membersApi: {
		leave: vi.fn(),
	},
}));

/**
 * 复刻受保护区布局的早退（app/(protected)/layout.tsx）：组织选择被清空后，路由分流
 * 在剩余组织自动选中之前返回整屏加载态或选择页——业务子树整体卸载。
 */
function Shell({ children }: { children: React.ReactNode }) {
	const orgId = useActiveOrgId();
	if (orgId === null) {
		return <p data-testid="shell-loading">组织上下文未就绪</p>;
	}
	return <>{children}</>;
}

/**
 * 退出组织入口（需求 MEM-02.5；评审 R3-I02 回归）。
 *
 * 复现口径：退出成功的 hook 级回调同步清空组织选择，布局随即卸载本组件；
 * TanStack 只向仍挂载的观察者派发 mutate 的调用点回调——「回到首页」的导航若写在
 * 调用点回调里就永不执行，用户停留在已无权访问的成员页。
 */
describe("LeaveOrganizationButton", () => {
	let queryClient: QueryClient;
	const wrapper = ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);

	const currentOrganization = (role: "OWNER" | "VIEWER") =>
		({
			id: "org-a",
			name: "A 组织",
			role,
			capabilities: {},
			onboardingCompleted: true,
		}) as never;

	beforeEach(() => {
		vi.resetAllMocks();
		queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		});
		vi.mocked(organizationsApi.current).mockResolvedValue(
			currentOrganization("VIEWER"),
		);
		vi.mocked(membersApi.leave).mockResolvedValue({ status: "DISABLED" } as never);
		useOrganizationStore.setState({
			activeOrganizationId: "org-a",
			activeOrganizationSetAt: 0,
			rejectedOrganizationIds: [],
		});
	});

	afterEach(() => {
		queryClient.clear();
	});

	async function confirmLeave() {
		fireEvent.click(await screen.findByTestId("leave-organization-entry"));
		fireEvent.click(screen.getByTestId("leave-organization-confirm"));
	}

	it("确认退出：组织选择被清空、本组件被布局卸载后，仍然回到首页", async () => {
		render(
			<Shell>
				<LeaveOrganizationButton />
			</Shell>,
			{ wrapper },
		);

		await confirmLeave();

		await waitFor(() =>
			expect(useOrganizationStore.getState().activeOrganizationId).toBeNull(),
		);
		// 与真实布局一致：此刻组件已不在文档里，导航必须不依赖挂载态
		expect(screen.queryByTestId("leave-organization")).toBeNull();
		await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/home"));
		expect(membersApi.leave).toHaveBeenCalledTimes(1);
	});

	it("退出失败：不导航、不清组织选择，错误态留在组件内", async () => {
		vi.mocked(membersApi.leave).mockRejectedValue(new Error("网络错误"));
		render(<LeaveOrganizationButton />, { wrapper });

		await confirmLeave();

		await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
		expect(screen.getByRole("alert").textContent).toContain("网络错误");
		expect(routerReplace).not.toHaveBeenCalled();
		expect(useOrganizationStore.getState().activeOrganizationId).toBe("org-a");
	});

	it("Owner 不提供退出入口（最后 Owner 必须先转移所有权）", async () => {
		vi.mocked(organizationsApi.current).mockResolvedValue(
			currentOrganization("OWNER"),
		);
		render(<LeaveOrganizationButton />, { wrapper });
		// 当前组织详情已返回（角色为 OWNER）后才断言入口不存在，避免在加载态就断言
		await waitFor(() =>
			expect(
				queryClient.getQueryData(queryKeys.organizations.current("org-a")),
			).toBeDefined(),
		);
		expect(screen.queryByTestId("leave-organization-entry")).toBeNull();
		expect(membersApi.leave).not.toHaveBeenCalled();
	});
});
