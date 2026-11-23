import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOrganizationStore } from "@/lib/stores/organization-store";

// Node ≥26 在 globalThis 上自带一个返回 undefined 的 localStorage 原生 getter，
// 会遮蔽 vitest 4 populateGlobal 注入的 jsdom localStorage（vitest#8757）——
// zustand persist 在 store 模块求值期通过 `window.localStorage` 取 storage，
// 拿到 undefined 后首次 setState 即崩。此处从 vitest 暴露的原始 jsdom 实例
// （globalThis.jsdom.window.localStorage 完好）回填，覆盖被遮蔽的 getter。
// 仅 use-chat 触发：全仓唯一 persist store 是 chat-store；若后续 setupFiles
// 方案落地或 vitest 修复 #8757，可整体移除本段。
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

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useChat } from "@/lib/hooks/use-chat";
import { aiMessagesQueryKey } from "@/lib/hooks/use-conversations";
import { chatApi, streamMessage } from "@/lib/api/chat";
import { ApiError } from "@/lib/api/client";
import { useChatStore } from "@/lib/stores/chat-store";
import type {
	AiMessageListData,
	AiStreamEvent,
	StreamMessageParams,
} from "@/lib/api/chat";
import type React from "react";

// 真实 client.ts 顶层校验 NEXT_PUBLIC_API_BASE_URL（测试环境不存在），mock 掉；
// 类定义须置于工厂内（vi.mock 被提升），hook 内 instanceof 与本文件拿到的
// ApiError 即同一 mock 类。构造签名与真实类一致。
vi.mock("@/lib/api/client", () => {
	class MockApiError extends Error {
		constructor(
			message: string,
			readonly status: number,
			readonly code?: string,
			readonly body?: Record<string, unknown>,
		) {
			super(message);
			this.name = "ApiError";
		}
	}
	return { ApiError: MockApiError, apiClient: vi.fn() };
});

// mock 传输层：streamMessage（流式）与 chatApi（REST）由本文件编排
vi.mock("@/lib/api/chat", () => ({
	chatApi: {
		listConversations: vi.fn(),
		listMessages: vi.fn(),
		deleteConversation: vi.fn(),
		streamMessage: vi.fn(),
	},
	streamMessage: vi.fn(),
}));

/** 构造立即逐帧下发的流（正常收尾） */
function streamOf(
	events: AiStreamEvent[],
): AsyncGenerator<AiStreamEvent, void, unknown> {
	return (async function* () {
		for (const event of events) {
			yield event;
		}
	})();
}

/** 构造在 yield 一个事件后挂起、由外部 resolve 放行的流（挂起/中断档） */
function hangingStream(
	params: StreamMessageParams,
	first: AiStreamEvent,
): AsyncGenerator<AiStreamEvent, void, unknown> {
	return (async function* () {
		yield first;
		await new Promise<void>((_resolve, reject) => {
			params.signal?.addEventListener("abort", () => {
				const error = new Error("The operation was aborted");
				error.name = "AbortError";
				reject(error);
			});
		});
	})();
}

const metaEvent = {
	type: "meta",
	conversationId: "conv-1",
	userMessageId: "msg-u1",
	title: "你好",
} as const satisfies AiStreamEvent;

const doneEvent = (content: string, id = "msg-a1", model = "gpt-4.1-mini") =>
	({
		type: "done",
		assistantMessage: {
			id,
			role: "assistant",
			content,
			createdAt: "2026-02-22T00:00:00.000Z",
			model,
		},
		usage: { inputTokens: 10, outputTokens: 20 },
		model,
	}) as const satisfies AiStreamEvent;

const userMessage = (
	id: string,
	content: string,
	createdAt = "2026-02-22T00:00:00.000Z",
) => ({ id, role: "user" as const, content, createdAt });

/** store 完整初始态（每用例重置，数组/Record 覆盖干净） */
const initialStoreState = {
	activeConversationId: null as string | null,
	streamingIds: [] as string[],
	creatingStream: false,
	streamTexts: {} as Record<string, string>,
	toolActiveIds: [] as string[],
	errors: {} as Record<string, string | null>,
	newChatError: null as string | null,
	pendingUserContent: null as string | null,
	selectedModel: null as string | null,
};

const createWrapper = () => {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	});
	// 流结束的 invalidate 会触发 refetch 并覆盖缓存——mock 掉以精确断言
	// meta 预填 / done 追加的中间态（invalidate 调用本身单独断言）
	vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
	return {
		queryClient,
		wrapper: ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		),
	};
};

/** 让 useQuery 的消息拉取挂起（fetch 永不 settle，缓存完全由 meta 预填/done 追加驱动） */
const hangMessagesFetch = () => {
	vi.mocked(chatApi.listMessages).mockReturnValue(new Promise(() => {}));
};

beforeEach(() => {
		// ToB W20：业务查询按组织门控（enabled: orgId !== null）——测试统一选中组织
		useOrganizationStore.setState({ activeOrganizationId: "org-test" });
	// 必须 reset（而非 clear）：clearAllMocks 不清 mockResolvedValue，
	// 前用例的 implementation 会泄漏到后续用例（409 用例曾因此串数据）
	vi.resetAllMocks();
	useChatStore.setState(initialStoreState);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("useChat 新建会话流（activeId=null）", () => {
	it("meta → token* → done：pending 乐观消息、转正 activeId、预填缓存、done 落助手消息并收敛", async () => {
		hangMessagesFetch();
		vi.mocked(streamMessage).mockResolvedValue(
			streamOf([
				metaEvent,
				{ type: "token", delta: "你" },
				{ type: "token", delta: "好呀" },
				doneEvent("你好呀"),
			]),
		);
		const { queryClient, wrapper } = createWrapper();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(() => useChat(), { wrapper });
		expect(result.current.status).toBe("idle");
		expect(result.current.activeId).toBeNull();
		// 发送前：乐观用户消息挂空态视图
		expect(result.current.messages).toHaveLength(0);

		await act(async () => {
			await result.current.send("你好");
		});

		// 请求参数：新建 = 不带 conversationId
		expect(streamMessage).toHaveBeenCalledTimes(1);
		expect(streamMessage).toHaveBeenCalledWith({
			content: "你好",
			conversationId: undefined,
			signal: expect.any(AbortSignal),
		});

		// meta 转正：activeId 更新、creatingStream 退出、pending 清除
		expect(result.current.activeId).toBe("conv-1");
		const store = useChatStore.getState();
		expect(store.creatingStream).toBe(false);
		expect(store.pendingUserContent).toBeNull();
		expect(store.streamingIds).toEqual([]);

		// done 后消息缓存：meta 预填用户消息 + done 追加助手消息，无乐观项
		const cached = queryClient.getQueryData<AiMessageListData>(
			aiMessagesQueryKey("conv-1"),
		);
		expect(cached?.items.map((item) => item.id)).toEqual(["msg-u1", "msg-a1"]);
		expect(cached?.items[1]).toMatchObject({
			role: "assistant",
			content: "你好呀",
		});

		// 权威收敛：消息 + 会话列表 invalidate
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["ai", "messages"],
		});
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["ai", "conversations"],
		});

		// 状态机回归 idle、流式文本已清理
		expect(result.current.status).toBe("idle");
		expect(result.current.streamText).toBeUndefined();
	});

	it("流式中的中间态：streamText 逐步拼接、status=streaming、anyStreaming 防重发", async () => {
		hangMessagesFetch();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(streamMessage).mockImplementation(async () =>
			(async function* () {
				yield metaEvent;
				yield { type: "token", delta: "流式" };
				await gate; // 挂起：模拟长流
				yield { type: "token", delta: "中" };
				yield doneEvent("流式中");
			})(),
		);
		const { wrapper } = createWrapper();

		const { result } = renderHook(() => useChat(), { wrapper });
		let sendPromise!: Promise<void>;
		act(() => {
			sendPromise = result.current.send("你好");
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		// 中间态断言
		expect(result.current.status).toBe("streaming");
		expect(result.current.anyStreaming).toBe(true);
		expect(useChatStore.getState().streamTexts["conv-1"]).toBe("流式");

		// 防重发：流进行中再 send 被忽略
		await act(async () => {
			await result.current.send("第二条");
		});
		expect(streamMessage).toHaveBeenCalledTimes(1);

		// 放行收尾
		release();
		await act(async () => {
			await sendPromise;
		});
		expect(result.current.status).toBe("idle");
		expect(useChatStore.getState().streamTexts["conv-1"]).toBeUndefined();
	});

	it("tool 帧：执行中 toolActiveIds 拉起，end 帧收回", async () => {
		hangMessagesFetch();
		let toolActiveDuringToolCall = false;
		vi.mocked(streamMessage).mockImplementation(async () =>
			(async function* () {
				yield metaEvent;
				yield { type: "tool", name: "query_exchange_rate", state: "start" };
				// 消费驱动的 generator：此处同步快照工具执行中的 store 状态
				toolActiveDuringToolCall = useChatStore
					.getState()
					.toolActiveIds.includes("conv-1");
				yield { type: "token", delta: "查到了" };
				yield { type: "tool", name: "query_exchange_rate", state: "end" };
				yield doneEvent("查到了");
			})(),
		);
		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useChat(), { wrapper });

		await act(async () => {
			await result.current.send("现在美元兑日元是多少？");
		});

		expect(toolActiveDuringToolCall).toBe(true);
		expect(useChatStore.getState().toolActiveIds).toEqual([]);
	});

	it("error 帧：status=error、错误文案落 store、用户消息保留", async () => {
		hangMessagesFetch();
		vi.mocked(streamMessage).mockResolvedValue(
			streamOf([
				metaEvent,
				{ type: "token", delta: "半截" },
				{
					type: "error",
					code: "AI_UPSTREAM_FAILED",
					message: "回复生成失败，请稍后重试",
				},
			]),
		);
		const { queryClient, wrapper } = createWrapper();
		const { result } = renderHook(() => useChat(), { wrapper });

		await act(async () => {
			await result.current.send("你好");
		});

		expect(result.current.status).toBe("error");
		expect(result.current.error).toBe("回复生成失败，请稍后重试");
		// 用户消息已落库（meta 预填），助手消息未落库
		const cached = queryClient.getQueryData<AiMessageListData>(
			aiMessagesQueryKey("conv-1"),
		);
		expect(cached?.items).toHaveLength(1);
		expect(cached?.items[0]).toMatchObject({ role: "user", content: "你好" });
		// 流式态已清理
		expect(useChatStore.getState().streamingIds).toEqual([]);
	});

	it("stop() 中断：AbortError 静默终止，不置 error 态，流式态清理", async () => {
		hangMessagesFetch();
		vi.mocked(streamMessage).mockImplementation(async (params) =>
			hangingStream(params as StreamMessageParams, metaEvent),
		);
		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useChat(), { wrapper });

		let sendPromise!: Promise<void>;
		act(() => {
			sendPromise = result.current.send("你好");
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(result.current.status).toBe("streaming");

		await act(async () => {
			result.current.stop();
			await sendPromise;
		});

		expect(result.current.status).toBe("idle");
		expect(result.current.error).toBeNull();
		expect(useChatStore.getState().streamingIds).toEqual([]);
	});

	it("请求建立失败（网络错误，新建场景）：pending 回滚、newChatError 记录", async () => {
		hangMessagesFetch();
		vi.mocked(streamMessage).mockRejectedValue(new Error("Failed to fetch"));
		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useChat(), { wrapper });

		await act(async () => {
			await result.current.send("你好");
		});

		expect(result.current.status).toBe("error");
		expect(result.current.error).toBe("Failed to fetch");
		expect(useChatStore.getState().pendingUserContent).toBeNull();
		expect(useChatStore.getState().creatingStream).toBe(false);
	});
});

describe("useChat 追问流（activeId=conv-1）", () => {
	it("乐观插入 → meta 修正 id → done 追加助手消息", async () => {
		const preset: AiMessageListData = {
			items: [
				userMessage("msg-u1", "你好"),
				{
					id: "msg-a1",
					role: "assistant",
					content: "完整回复",
					createdAt: "2026-02-22T00:00:00.100Z",
				},
			],
		};
		vi.mocked(chatApi.listMessages).mockResolvedValue(preset);
		vi.mocked(streamMessage).mockResolvedValue(
			streamOf([
				{
					type: "meta",
					conversationId: "conv-1",
					userMessageId: "msg-u2",
					title: "你好",
				},
				{ type: "token", delta: "第二答" },
				doneEvent("第二答", "msg-a2"),
			]),
		);
		const { queryClient, wrapper } = createWrapper();
		queryClient.setQueryData(aiMessagesQueryKey("conv-1"), preset);
		useChatStore.setState({ activeConversationId: "conv-1" });

		const { result } = renderHook(() => useChat(), { wrapper });
		await waitFor(() => expect(result.current.messages).toHaveLength(2));

		await act(async () => {
			await result.current.send("第二问");
		});

		// 请求参数：追问带 conversationId
		expect(streamMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: "第二问", conversationId: "conv-1" }),
		);

		const cached = queryClient.getQueryData<AiMessageListData>(
			aiMessagesQueryKey("conv-1"),
		);
		// 预置 2 条 + meta 修正后的用户消息 + done 追加的助手消息；乐观项无残留
		expect(cached?.items.map((item) => item.id)).toEqual([
			"msg-u1",
			"msg-a1",
			"msg-u2",
			"msg-a2",
		]);
		expect(
			cached?.items.every((item) => !item.id.startsWith("optimistic-")),
		).toBe(true);
		expect(useChatStore.getState().streamingIds).toEqual([]);
	});

	it("请求建立失败 409（同会话并发）：乐观回滚、错误落当前会话", async () => {
		vi.mocked(streamMessage).mockRejectedValue(
			new ApiError("该会话正在回复中，请稍候", 409, "AI_CONVERSATION_BUSY"),
		);
		// 显式 mock 自身 preset：resetAllMocks 后无泄漏，fetch settle 写入的即本用例数据
		const preset: AiMessageListData = {
			items: [userMessage("msg-u1", "你好")],
		};
		vi.mocked(chatApi.listMessages).mockResolvedValue(preset);
		const { queryClient, wrapper } = createWrapper();
		useChatStore.setState({ activeConversationId: "conv-1" });
		const { result } = renderHook(() => useChat(), { wrapper });

		await act(async () => {
			await result.current.send("并发问");
		});

		expect(result.current.status).toBe("error");
		expect(result.current.error).toBe("该会话正在回复中，请稍候");
		// 乐观项已回滚：仍为预置 1 条
		const cached = queryClient.getQueryData<AiMessageListData>(
			aiMessagesQueryKey("conv-1"),
		);
		expect(cached?.items.map((item) => item.id)).toEqual(["msg-u1"]);
		expect(useChatStore.getState().streamingIds).toEqual([]);
	});

	it("空内容 / 超长内容：不发起请求", async () => {
		const { wrapper } = createWrapper();
		useChatStore.setState({ activeConversationId: "conv-1" });
		const { result } = renderHook(() => useChat(), { wrapper });

		await act(async () => {
			await result.current.send("   ");
			await result.current.send("x".repeat(2001));
		});
		expect(streamMessage).not.toHaveBeenCalled();
	});
});

describe("useChat 模型选择（ai-model-whitelist 方案 §8.4）", () => {
	it("send() 读 store selectedModel 传入 streamMessage 的 modelKey", async () => {
		hangMessagesFetch();
		vi.mocked(streamMessage).mockResolvedValue(
			streamOf([metaEvent, doneEvent("收到", "msg-a1", "gpt-5.5")]),
		);
		useChatStore.setState({
			...initialStoreState,
			selectedModel: "gpt-5.5",
		});
		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useChat(), { wrapper });

		await act(async () => {
			await result.current.send("你好");
		});

		expect(streamMessage).toHaveBeenCalledWith(
			expect.objectContaining({ modelKey: "gpt-5.5" }),
		);
	});

	it("未选择模型（null）时不传 modelKey（缺省走服务端默认回退）", async () => {
		hangMessagesFetch();
		vi.mocked(streamMessage).mockResolvedValue(
			streamOf([metaEvent, doneEvent("收到")]),
		);
		// selectedModel 保持初始 null
		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useChat(), { wrapper });

		await act(async () => {
			await result.current.send("你好");
		});

		const params = vi.mocked(streamMessage).mock
			.calls[0]![0] as StreamMessageParams;
		expect(params).not.toHaveProperty("modelKey");
	});

	it("done 帧带 model 时 assistantMessage 缓存自然携带", async () => {
		hangMessagesFetch();
		vi.mocked(streamMessage).mockResolvedValue(
			streamOf([metaEvent, doneEvent("你好呀", "msg-a1", "claude-sonnet-4-6")]),
		);
		const { queryClient, wrapper } = createWrapper();
		const { result } = renderHook(() => useChat(), { wrapper });

		await act(async () => {
			await result.current.send("你好");
		});

		const cached = queryClient.getQueryData<AiMessageListData>(
			aiMessagesQueryKey("conv-1"),
		);
		expect(cached?.items[1]).toMatchObject({
			id: "msg-a1",
			model: "claude-sonnet-4-6",
		});
	});

	it("400 AI_MODEL_UNKNOWN：请求建立失败，错误文案展示（防御残留非法 key 直发）", async () => {
		vi.mocked(streamMessage).mockRejectedValue(
			new ApiError("该模型不可用，请重新选择", 400, "AI_MODEL_UNKNOWN"),
		);
		const preset: AiMessageListData = {
			items: [userMessage("msg-u1", "你好")],
		};
		vi.mocked(chatApi.listMessages).mockResolvedValue(preset);
		useChatStore.setState({
			activeConversationId: "conv-1",
			// 模拟白名单缩编后 localStorage 残留的非法 key（自愈前的直发防御）
			selectedModel: "gpt-4o",
		});
		const { queryClient, wrapper } = createWrapper();
		queryClient.setQueryData(aiMessagesQueryKey("conv-1"), preset);
		const { result } = renderHook(() => useChat(), { wrapper });

		await act(async () => {
			await result.current.send("追问");
		});

		expect(result.current.status).toBe("error");
		expect(result.current.error).toBe("该模型不可用，请重新选择");
		// 乐观项已回滚；非法 key 不被清除（选择器自愈负责），仅错误态提示
		const cached = queryClient.getQueryData<AiMessageListData>(
			aiMessagesQueryKey("conv-1"),
		);
		expect(cached?.items.map((item) => item.id)).toEqual(["msg-u1"]);
		expect(useChatStore.getState().streamingIds).toEqual([]);
	});
});

describe("useChat 会话切换与消息拉取", () => {
	it("selectConversation 切换：messages 按新会话 Key 拉取", async () => {
		vi.mocked(chatApi.listMessages).mockResolvedValue({
			items: [userMessage("m1", "历史消息", "2026-02-21T00:00:00.000Z")],
		});
		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useChat(), { wrapper });

		await act(async () => {
			result.current.selectConversation("conv-1");
		});
		await waitFor(() => {
			expect(result.current.messages).toHaveLength(1);
		});
		expect(chatApi.listMessages).toHaveBeenCalledWith("conv-1");
		expect(result.current.messages[0]).toMatchObject({
			role: "user",
			content: "历史消息",
		});
		expect(result.current.isLoadingMessages).toBe(false);
	});
});
