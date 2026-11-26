import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCurrentUser, useLogout, useLogoutAndRedirect } from "./use-auth";
import { authApi } from "@/lib/api/auth";
import { redirectToLogin } from "@/lib/auth/redirect-to-login";
import { useAuthStore } from "@/lib/stores/auth-store";
import { useOrganizationStore } from "@/lib/stores/organization-store";
import { useChatStore } from "@/lib/stores/chat-store";
import type React from "react";

// localStorage 回填（Node ≥26 原生 getter 遮蔽 jsdom localStorage，vitest#8757；
// use-chat.spec 先例——useLogout 现在会重置带 persist 的 chat-store / organization-store）
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

// Mock authApi
vi.mock("@/lib/api/auth", () => ({
	authApi: {
		getMe: vi.fn(),
		logout: vi.fn(),
	},
}));

// 跳转登录页是整页导航（jsdom 不支持），mock 掉以断言「带着哪个回跳地址跳」
vi.mock("@/lib/auth/redirect-to-login", () => ({
	redirectToLogin: vi.fn(),
}));

const createWrapper = () => {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
};

describe("useCurrentUser", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("应成功查询当前用户信息", async () => {
		const mockUser = {
			id: "user1",
			email: "test@example.com",
			name: "Test User",
			avatar: null,
			createdAt: "2024-01-01T00:00:00Z",
		};

		vi.mocked(authApi.getMe).mockResolvedValue(mockUser);

		const { result } = renderHook(() => useCurrentUser(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(result.current.data).toEqual(mockUser);
		expect(authApi.getMe).toHaveBeenCalledOnce();
	});

	it("401 错误时应返回错误状态", async () => {
		vi.mocked(authApi.getMe).mockRejectedValue(new Error("Unauthorized"));

		const { result } = renderHook(() => useCurrentUser(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isError).toBe(true));

		expect(result.current.error).toBeDefined();
	});
});

describe("useLogout", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("应清除所有缓存并执行登出", () => {
		const wrapper = createWrapper();
		const { result } = renderHook(() => useLogout(), { wrapper });

		const logout = result.current;
		logout();

		expect(authApi.logout).toHaveBeenCalledOnce();
	});

	it("评审 I-18：登出同时清除组织选择与聊天运行时态（换账号登录不得继承上一个账号的组织）", () => {
		useOrganizationStore.setState({
			activeOrganizationId: "org-a",
			rejectedOrganizationIds: ["org-x"],
		});
		useChatStore.setState({
			activeConversationId: "conv-1",
			streamingIds: ["conv-1"],
			creatingStream: false,
			streamTexts: { "conv-1": "进行中的回复" },
			selectedModel: "gpt-x",
		});
		const { result } = renderHook(() => useLogout(), {
			wrapper: createWrapper(),
		});

		act(() => {
			result.current();
		});

		expect(authApi.logout).toHaveBeenCalledOnce();
		expect(useOrganizationStore.getState().activeOrganizationId).toBeNull();
		const chat = useChatStore.getState();
		expect(chat.activeConversationId).toBeNull();
		expect(chat.streamingIds).toEqual([]);
		expect(chat.streamTexts).toEqual({});
		// 模型偏好是个人偏好，不随登出清除
		expect(chat.selectedModel).toBe("gpt-x");
	});
});

describe("useLogoutAndRedirect（侧栏 / 设置页 / 组织选择页共用的登出出口，Goal #3A §9.6）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("一次点击走完三步：登出 → 清用户态 → 回登录页（回跳地址为首页）", () => {
		useAuthStore.setState({
			user: {
				id: "user1",
				email: "test@example.com",
				name: "Test User",
				avatar: null,
				createdAt: "2024-01-01T00:00:00Z",
			},
			isAuthenticated: true,
		});
		const { result } = renderHook(() => useLogoutAndRedirect(), {
			wrapper: createWrapper(),
		});

		act(() => {
			result.current();
		});

		expect(authApi.logout).toHaveBeenCalledOnce();
		expect(useAuthStore.getState()).toMatchObject({
			user: null,
			isAuthenticated: false,
		});
		expect(redirectToLogin).toHaveBeenCalledTimes(1);
		expect(redirectToLogin).toHaveBeenCalledWith("/");
	});

	it("组织选择页的登出同样清掉组织选择、拒绝集合与聊天运行时态（换账号登录不继承上一个账号的上下文）", () => {
		// 选错账号进入选择页的典型现场：带着上一个账号的组织选择与被拒记录
		useOrganizationStore.setState({
			activeOrganizationId: "org-a",
			rejectedOrganizationIds: ["org-x"],
		});
		useChatStore.setState({
			activeConversationId: "conv-1",
			streamingIds: ["conv-1"],
			streamTexts: { "conv-1": "进行中的回复" },
		});
		const { result } = renderHook(() => useLogoutAndRedirect(), {
			wrapper: createWrapper(),
		});

		act(() => {
			result.current();
		});

		expect(useOrganizationStore.getState()).toMatchObject({
			activeOrganizationId: null,
			rejectedOrganizationIds: [],
		});
		const chat = useChatStore.getState();
		expect(chat.activeConversationId).toBeNull();
		expect(chat.streamingIds).toEqual([]);
		expect(redirectToLogin).toHaveBeenCalledWith("/");
	});

	it("登出与跳转的先后：先清完上下文再跳（跳转后不会有带着旧组织头的在途请求）", () => {
		const order: string[] = [];
		vi.mocked(authApi.logout).mockImplementation(() => {
			order.push("logout");
		});
		vi.mocked(redirectToLogin).mockImplementation(() => {
			// 跳转发生时，组织选择必须已经被清空
			order.push(`redirect(active=${useOrganizationStore.getState().activeOrganizationId})`);
		});
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		const { result } = renderHook(() => useLogoutAndRedirect(), {
			wrapper: createWrapper(),
		});

		act(() => {
			result.current();
		});

		expect(order).toEqual(["logout", "redirect(active=null)"]);
	});
});
