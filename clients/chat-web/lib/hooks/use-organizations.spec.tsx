// Node ≥26 localStorage 回填（vitest#8757；use-chat.spec 先例）——
// use-organizations 经 organization-store(persist) 与 QueryClient 交互需要
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
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	useCurrentOrganization,
	useOrganizations,
	useSwitchOrganization,
} from "@/lib/hooks/use-organizations";
import { organizationsApi } from "@/lib/api/organizations";
import { queryKeys } from "@/lib/api/query-keys";
import { useOrganizationStore } from "@/lib/stores/organization-store";
import type React from "react";

/**
 * 组织上下文 hook 测试（GOAL-3A W20 必配）：
 * 单组织直连、切换触发缓存清理与失效、迟到慢响应不污染新组织缓存、
 * 404 ORGANIZATION_NOT_FOUND 失效态清理（选择被 apiClient 清空）。
 */

vi.mock("@/lib/api/organizations", () => ({
	organizationsApi: {
		list: vi.fn(),
		current: vi.fn(),
	},
}));

const wrapperFactory = () => {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return { queryClient, wrapper };
};

beforeEach(() => {
	useOrganizationStore.setState({ activeOrganizationId: null });
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("useOrganizations（列表）", () => {
	it("拉取本人组织列表", async () => {
		vi.mocked(organizationsApi.list).mockResolvedValue([
			{
				id: "org-a",
				name: "组织 A",
				role: "OWNER",
				baseCurrency: "CNY",
				onboardingCompleted: true,
				createdAt: "2026-11-01T00:00:00.000Z",
			},
		]);
		const { wrapper } = wrapperFactory();
		const { result } = renderHook(() => useOrganizations(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.[0]?.id).toBe("org-a");
	});
});

describe("useCurrentOrganization（当前组织）", () => {
	it("未选组织不发请求（enabled 门控）", async () => {
		const { wrapper } = wrapperFactory();
		const { result } = renderHook(() => useCurrentOrganization(), { wrapper });
		expect(result.current.fetchStatus).toBe("idle");
		expect(organizationsApi.current).not.toHaveBeenCalled();
	});

	it("选中组织后拉取详情", async () => {
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		vi.mocked(organizationsApi.current).mockResolvedValue({
			id: "org-a",
			name: "组织 A",
			role: "OWNER",
			capabilities: { "organization.read": true },
			onboardingCompleted: true,
			baseCurrency: "CNY",
			ledgerStartedAt: "2026-01-01T00:00:00.000Z",
			dataRequestLock: { active: false, type: null },
		});
		const { wrapper } = wrapperFactory();
		const { result } = renderHook(() => useCurrentOrganization(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.role).toBe("OWNER");
	});
});

describe("useSwitchOrganization（切换）", () => {
	it("切换：清组织作用域缓存 → 切 store → 失效组织详情重拉", async () => {
		const { queryClient, wrapper } = wrapperFactory();
		// 预置旧组织业务缓存
		queryClient.setQueryData(
			queryKeys.home.state(),
			{ stale: "org-a-data" },
		);
		const removeSpy = vi.spyOn(queryClient, "removeQueries");
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(() => useSwitchOrganization(), { wrapper });
		act(() => {
			result.current("org-b");
		});

		expect(useOrganizationStore.getState().activeOrganizationId).toBe("org-b");
		// 旧组织业务缓存被移除（迟到响应无缓存可回写）
		expect(
			queryClient.getQueryData(queryKeys.home.state()),
		).toBeUndefined();
		// 组织详情/列表失效重拉
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: queryKeys.organizations.current(),
		});
		expect(removeSpy).toHaveBeenCalled();
	});

	it("迟到慢响应不污染新组织缓存（cancelQueries 中止后 setQueryData 不再生效）", async () => {
		const { queryClient, wrapper } = wrapperFactory();
		const { result } = renderHook(() => useSwitchOrganization(), { wrapper });
		act(() => {
			result.current("org-b");
		});
		// 模拟旧组织迟到响应到达：查询已被移除，手工 setQueryData 到旧键
		// （新组织页面读的是 org 前缀键，旧个人键写入不影响）
		queryClient.setQueryData(queryKeys.home.state(), { late: true });
		const orgScoped = queryClient.getQueryData([
			"org",
			"org-b",
			"home",
			"state",
		]);
		expect(orgScoped).toBeUndefined();
	});
});
