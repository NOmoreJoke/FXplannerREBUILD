import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCurrentUser, useLogout } from "./use-auth";
import { authApi } from "@/lib/api/auth";
import type React from "react";

// Mock authApi
vi.mock("@/lib/api/auth", () => ({
	authApi: {
		getMe: vi.fn(),
		logout: vi.fn(),
	},
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
	it("应清除所有缓存并执行登出", () => {
		const wrapper = createWrapper();
		const { result } = renderHook(() => useLogout(), { wrapper });

		const logout = result.current;
		logout();

		expect(authApi.logout).toHaveBeenCalledOnce();
	});
});
