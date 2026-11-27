// Node ≥26 在 globalThis 上自带返回 undefined 的 localStorage getter（vitest#8757），
// 覆盖恢复 jsdom localStorage 供 zustand persist store（chat-store）读取。
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
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	AI_MODELS_QUERY_STEM,
	useModels,
	useModelSelection,
} from "@/lib/hooks/use-models";
import { chatApi } from "@/lib/api/chat";
import { useChatStore } from "@/lib/stores/chat-store";
import type React from "react";

// mock API 封装层（传输层由 client.ts 承接，不在本层断言）
vi.mock("@/lib/api/chat", () => ({
	chatApi: {
		listModels: vi.fn(),
	},
}));

const modelsData = {
	items: [
		{
			key: "gpt-4.1-mini",
			displayName: "GPT-4.1 Mini",
			provider: "openai",
			capabilities: ["chat"],
			costTier: 1,
			icon: "⚡",
			description: "默认模型",
		},
		{
			key: "gpt-5.5",
			displayName: "GPT-5.5",
			provider: "openai",
			capabilities: ["chat"],
			costTier: 4,
			icon: "🚀",
			description: "旗舰模型",
		},
	],
	orgToolsEnabled: true,
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

describe("useModels", () => {
	it("拉取：chatApi.listModels 无参调用，data.items 透传", async () => {
		vi.mocked(chatApi.listModels).mockResolvedValue(modelsData);
		const { wrapper } = createWrapper();

		const { result } = renderHook(() => useModels(), { wrapper });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(chatApi.listModels).toHaveBeenCalledWith();
		expect(result.current.data).toEqual(modelsData);
	});

	it("查询 Key 符合约定：[ai, models]", () => {
		expect(AI_MODELS_QUERY_STEM).toEqual(["ai", "models"]);
	});

	it("staleTime 5 分钟：白名单封闭集合，静默期内不重拉", async () => {
		vi.mocked(chatApi.listModels).mockResolvedValue(modelsData);
		const { queryClient, wrapper } = createWrapper();

		const { result } = renderHook(() => useModels(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const query = queryClient.getQueryCache().find({
			queryKey: [...AI_MODELS_QUERY_STEM],
		});
		// v5.101 类型收紧：QueryOptions 声明不再含 staleTime（运行时 setOptions 仍携带），读取处窄化
		const staleTime = (query?.options as { staleTime?: number }).staleTime;
		expect(staleTime).toBe(5 * 60 * 1000);
	});

	it("拉取失败：error 透传不重试", async () => {
		vi.mocked(chatApi.listModels).mockRejectedValue(new Error("网络失败"));
		const { wrapper } = createWrapper();

		const { result } = renderHook(() => useModels(), { wrapper });

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.error).toMatchObject({ message: "网络失败" });
	});
});

describe("useModelSelection (P7 白名单自愈)", () => {
	it("持久化 selectedModel 不在白名单中时自动重置为 null 并回退首项默认模型", async () => {
		useChatStore.setState({ selectedModel: "removed-legacy-model" });
		vi.mocked(chatApi.listModels).mockResolvedValue(modelsData);
		const { wrapper } = createWrapper();

		const { result } = renderHook(() => useModelSelection(), { wrapper });

		await waitFor(() =>
			expect(useChatStore.getState().selectedModel).toBeNull(),
		);
		expect(result.current.current?.key).toBe("gpt-4.1-mini");
	});

	it("持久化 selectedModel 仍在白名单中时保持原选择不变", async () => {
		useChatStore.setState({ selectedModel: "gpt-5.5" });
		vi.mocked(chatApi.listModels).mockResolvedValue(modelsData);
		const { wrapper } = createWrapper();

		const { result } = renderHook(() => useModelSelection(), { wrapper });

		await waitFor(() => expect(result.current.items).toHaveLength(2));
		expect(useChatStore.getState().selectedModel).toBe("gpt-5.5");
		expect(result.current.current?.key).toBe("gpt-5.5");
	});
});
