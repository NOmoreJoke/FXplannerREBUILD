// Node ≥26 在 globalThis 上自带一个返回 undefined 的 localStorage 原生 getter，
// 会遮蔽 vitest 4 populateGlobal 注入的 jsdom localStorage（vitest#8757）——
// zustand persist 在 store 模块求值期通过 `window.localStorage` 取 storage，
// 拿到 undefined 后首次 setState 即崩。此处从 vitest 暴露的原始 jsdom 实例
// （globalThis.jsdom.window.localStorage 完好）回填，覆盖被遮蔽的 getter。
// （use-chat.spec 先例；ToB W20 起 organization-store 也用 persist，本文件同样需要）
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
import { useOrganizationStore } from "@/lib/stores/organization-store";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	AI_CONVERSATIONS_QUERY_STEM,
	aiMessagesQueryKey,
	useConversations,
	useDeleteConversation,
} from "@/lib/hooks/use-conversations";
import { chatApi } from "@/lib/api/chat";
import { withOrgScope } from "@/lib/api/query-keys";
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
		// ToB W20：业务查询按组织门控（enabled: orgId !== null）——测试统一选中组织
		useOrganizationStore.setState({ activeOrganizationId: "org-test" });
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
		// ToB W20：组织作用域键（选中 org-test → ["org","org-test",...] 前缀）
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: withOrgScope(
				"org-test",
				[...AI_CONVERSATIONS_QUERY_STEM],
			),
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
