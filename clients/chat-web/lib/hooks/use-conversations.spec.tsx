import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	AI_CONVERSATIONS_QUERY_STEM,
	aiMessagesQueryKey,
	useConversations,
	useDeleteConversation,
} from "@/lib/hooks/use-conversations";
import { chatApi } from "@/lib/api/chat";
import type React from "react";

// mock API 封装层（传输层由 client.ts 承接，不在本层断言）
vi.mock("@/lib/api/chat", () => ({
	chatApi: {
		listConversations: vi.fn(),
		listMessages: vi.fn(),
		deleteConversation: vi.fn(),
		streamMessage: vi.fn(),
	},
}));

const conversationsData = {
	items: [
		{
			id: "conv-2",
			title: "最新会话",
			lastMessageAt: "2026-02-22T10:00:00.000Z",
			messageCount: 4,
		},
		{
			id: "conv-1",
			title: "较早会话",
			lastMessageAt: "2026-02-21T08:00:00.000Z",
			messageCount: 2,
		},
	],
};

const createWrapper = () => {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	});
	return {
		queryClient,
		wrapper: ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		),
	};
};

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("useConversations", () => {
	it("列表拉取：chatApi.listConversations 无参调用，data.items 透传", async () => {
		vi.mocked(chatApi.listConversations).mockResolvedValue(conversationsData);
		const { wrapper } = createWrapper();

		const { result } = renderHook(() => useConversations(), { wrapper });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(chatApi.listConversations).toHaveBeenCalledWith();
		expect(result.current.data).toEqual(conversationsData);
	});

	it("查询 Key 符合约定：[ai, conversations]", () => {
		expect(AI_CONVERSATIONS_QUERY_STEM).toEqual(["ai", "conversations"]);
	});

	it("拉取失败：error 透传不重试", async () => {
		vi.mocked(chatApi.listConversations).mockRejectedValue(
			new Error("网络失败"),
		);
		const { wrapper } = createWrapper();

		const { result } = renderHook(() => useConversations(), { wrapper });

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.error).toMatchObject({ message: "网络失败" });
	});
});

describe("useDeleteConversation", () => {
	it("删除成功：列表 invalidate + 该会话消息缓存移除", async () => {
		vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined);
		const { queryClient, wrapper } = createWrapper();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
		const removeSpy = vi.spyOn(queryClient, "removeQueries");

		// 预置消息缓存，验证被移除
		queryClient.setQueryData(aiMessagesQueryKey("conv-1"), { items: [] });

		const { result } = renderHook(() => useDeleteConversation(), { wrapper });
		await act(async () => {
			result.current.mutate("conv-1");
		});
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(chatApi.deleteConversation).toHaveBeenCalledWith("conv-1");
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: [...AI_CONVERSATIONS_QUERY_STEM],
		});
		expect(removeSpy).toHaveBeenCalledWith({
			queryKey: aiMessagesQueryKey("conv-1"),
		});
	});

	it("删除失败（如流进行中 409）：isError 且不 invalidate", async () => {
		vi.mocked(chatApi.deleteConversation).mockRejectedValue(
			new Error("该会话正在回复中，请稍后再删除"),
		);
		const { queryClient, wrapper } = createWrapper();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(() => useDeleteConversation(), { wrapper });
		await act(async () => {
			result.current.mutate("conv-1");
		});
		await waitFor(() => expect(result.current.isError).toBe(true));

		expect(result.current.error).toMatchObject({
			message: "该会话正在回复中，请稍后再删除",
		});
		expect(invalidateSpy).not.toHaveBeenCalled();
	});
});
