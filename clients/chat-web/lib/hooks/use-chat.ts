"use client";

import { useCallback, useMemo, useRef } from "react";
import {
	useQuery,
	useQueryClient,
	type QueryClient,
} from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import {
	chatApi,
	streamMessage,
	type AiMessage,
	type AiMessageListData,
	type AiStreamEvent,
} from "@/lib/api/chat";
import {
	AI_CONVERSATIONS_QUERY_STEM,
	AI_MESSAGES_QUERY_STEM,
	aiMessagesQueryKey,
} from "@/lib/hooks/use-conversations";
import { selectAnyStreaming, useChatStore } from "@/lib/stores/chat-store";

/**
 * 对话消费层（ai-assistant 方案 §5.2）：发送状态机 idle/streaming/error。
 *
 * 职责：
 * - 当前会话消息拉取（react-query，按会话分桶缓存）；
 * - send()：乐观插入用户消息（追问 setQueryData / 新建挂 store pending）→
 *   streamMessage 逐帧消费（meta 转正 / tool 提示 / token 拼接 / done 落缓存 /
 *   error 记错误态）→ 结束后 invalidate 权威收敛；
 * - stop()：AbortController 中断（AbortError 静默终止，不置 error 态）。
 *
 * 一致性约定（§1.2）：用户消息先落库（meta 帧到达即已落库），助手消息只在
 * done 帧落库成功后出现——前端缓存始终是这两类「已落库」数据 + 乐观项的
 * 短暂叠加，invalidate 后以服务端为准。
 */

/** 发送状态机（当前视图维度：未选会话 → 新建视图的 creatingStream；选定 → 该会话流中） */
export type ChatStatus = "idle" | "streaming" | "error";

/** 乐观消息 id 前缀（done/invalidate 收敛时识别剔除） */
const OPTIMISTIC_PREFIX = "optimistic-";

/** 后端 SendMessageDto 契约：trim 后 1~2000 字符 */
const CONTENT_MAX_LENGTH = 2000;

function toErrorMessage(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	if (error instanceof Error && error.message) return error.message;
	return "发送失败，请稍后重试";
}

const isAbortError = (error: unknown): boolean =>
	error instanceof Error && error.name === "AbortError";

const isOptimistic = (message: AiMessage): boolean =>
	message.id.startsWith(OPTIMISTIC_PREFIX);

/**
 * 追问：把乐观用户消息的 id 修正为服务端 id（meta 帧 userMessageId）。
 * 独立成函数：switch case 内不做词法声明，流中 invalidate 也不产生重复。
 */
function reconcileOptimisticMessage(
	queryClient: QueryClient,
	conversationId: string,
	userMessageId: string,
	content: string,
): void {
	const key = aiMessagesQueryKey(conversationId);
	const prev = queryClient.getQueryData<AiMessageListData>(key);
	if (!prev) return;
	const items = [...prev.items];
	const index = items.findIndex(
		(item) => isOptimistic(item) && item.content === content,
	);
	if (index !== -1) {
		items[index] = { ...items[index], id: userMessageId };
		queryClient.setQueryData<AiMessageListData>(key, { items });
	}
}

export function useChat() {
	const queryClient = useQueryClient();
	const activeId = useChatStore((s) => s.activeConversationId);

	// store actions（zustand action 引用稳定）
	const setActiveConversation = useChatStore((s) => s.setActiveConversation);
	const beginStream = useChatStore((s) => s.beginStream);
	const promoteStream = useChatStore((s) => s.promoteStream);
	const endStream = useChatStore((s) => s.endStream);
	const appendStreamText = useChatStore((s) => s.appendStreamText);
	const setToolActive = useChatStore((s) => s.setToolActive);
	const setError = useChatStore((s) => s.setError);
	const setNewChatError = useChatStore((s) => s.setNewChatError);
	const setPendingUserContent = useChatStore((s) => s.setPendingUserContent);

	// 当前视图的运行时状态（原始值选择器，引用稳定）
	const streamText = useChatStore((s) =>
		activeId !== null ? (s.streamTexts[activeId] ?? undefined) : undefined,
	);
	const toolActive = useChatStore((s) =>
		activeId !== null ? s.toolActiveIds.includes(activeId) : false,
	);
	const error = useChatStore((s) =>
		activeId !== null ? (s.errors[activeId] ?? null) : s.newChatError,
	);
	const isStreamingCurrent = useChatStore((s) =>
		activeId === null ? s.creatingStream : s.streamingIds.includes(activeId),
	);
	const anyStreaming = useChatStore(selectAnyStreaming);
	const pendingUserContent = useChatStore((s) => s.pendingUserContent);

	// 当前会话消息（enabled 随 activeId 翻转；删除后缓存已 remove，重进重拉）
	const messagesQuery = useQuery({
		queryKey: aiMessagesQueryKey(activeId ?? ""),
		queryFn: () => chatApi.listMessages(activeId!),
		enabled: activeId !== null,
		staleTime: 30_000,
		retry: false,
	});

	const abortRef = useRef<AbortController | null>(null);

	const send = useCallback(
		async (rawContent: string): Promise<void> => {
			const content = rawContent.trim();
			if (content === "" || content.length > CONTENT_MAX_LENGTH) return;
			if (selectAnyStreaming(useChatStore.getState())) return; // 单流交互：UI 禁用外的兜底

			const conversationId = activeId;
			const isNew = conversationId === null;
			// 发送时刻的模型选择快照（getState 读一次，中途切换不影响本条请求）；
			// null = 未选择，不传 modelKey（缺省走服务端默认回退）
			const { selectedModel } = useChatStore.getState();

			// 1. 乐观插入用户消息（新建挂 pending；追问写消息缓存）
			if (isNew) {
				setPendingUserContent(content);
				setNewChatError(null);
			} else {
				const key = aiMessagesQueryKey(conversationId);
				const prev = queryClient.getQueryData<AiMessageListData>(key);
				queryClient.setQueryData<AiMessageListData>(key, {
					items: [
						...(prev?.items ?? []),
						{
							id: `${OPTIMISTIC_PREFIX}${Date.now().toString(36)}`,
							role: "user",
							content,
							createdAt: new Date().toISOString(),
						},
					],
				});
				setError(conversationId, null);
			}

			// 2. 开流 + 发请求（请求建立失败 → 回滚乐观并置 error 态）
			beginStream(conversationId);
			const abort = new AbortController();
			abortRef.current = abort;

			const rollbackOptimistic = () => {
				if (isNew) {
					setPendingUserContent(null);
					return;
				}
				const key = aiMessagesQueryKey(conversationId);
				const prev = queryClient.getQueryData<AiMessageListData>(key);
				if (prev) {
					queryClient.setQueryData<AiMessageListData>(key, {
						items: prev.items.filter(
							(item) => !(isOptimistic(item) && item.content === content),
						),
					});
				}
			};

			let events: AsyncGenerator<AiStreamEvent, void, unknown>;
			try {
				events = await streamMessage({
					content,
					conversationId: conversationId ?? undefined,
					...(selectedModel !== null ? { modelKey: selectedModel } : {}),
					signal: abort.signal,
				});
			} catch (streamError) {
				// 请求未建立（409 busy / 429 / 400 / 网络失败）或建立前中断：
				// 用户消息未落库，回滚乐观项无残留；错误态提示（abort 静默）
				rollbackOptimistic();
				if (!isAbortError(streamError)) {
					if (isNew) {
						setNewChatError(toErrorMessage(streamError));
					} else {
						setError(conversationId, toErrorMessage(streamError));
					}
				}
				endStream(conversationId);
				abortRef.current = null;
				return;
			}

			// 3. 逐帧消费（meta → tool/token* → done/error）
			let currentId = conversationId;
			try {
				for await (const event of events) {
					switch (event.type) {
						case "meta": {
							// meta 到达 = 用户消息已在服务端落库
							if (currentId === null) {
								currentId = event.conversationId;
								promoteStream(currentId);
								setActiveConversation(currentId);
								setPendingUserContent(null);
								// 预填消息缓存（零等待），done 后 invalidate 拉权威数据
								queryClient.setQueryData<AiMessageListData>(
									aiMessagesQueryKey(currentId),
									{
										items: [
											{
												id: event.userMessageId,
												role: "user",
												content,
												createdAt: new Date().toISOString(),
											},
										],
									},
								);
							} else {
								// 追问：乐观 id 修正为服务端 id（流中 invalidate 不产生重复）
								reconcileOptimisticMessage(
									queryClient,
									currentId,
									event.userMessageId,
									content,
								);
							}
							break;
						}
						case "tool":
							setToolActive(currentId!, event.state === "start");
							break;
						case "token":
							appendStreamText(currentId!, event.delta);
							break;
						case "done": {
							// 助手消息已在服务端落库：乐观项剔除 + 追加，零延迟呈现
							const key = aiMessagesQueryKey(currentId!);
							const prev = queryClient.getQueryData<AiMessageListData>(key);
							queryClient.setQueryData<AiMessageListData>(key, {
								items: [
									...(prev?.items.filter((item) => !isOptimistic(item)) ?? []),
									event.assistantMessage,
								],
							});
							break;
						}
						case "error":
							// 用户消息保留可重发；错误固定文案（§4 错误信息纪律）
							setError(currentId!, event.message);
							break;
					}
				}
			} catch (loopError) {
				if (!isAbortError(loopError)) {
					// 流中断（网络断开等）：已收文本丢弃，错误态提示
					if (currentId !== null) {
						setError(currentId, toErrorMessage(loopError));
					}
				}
			} finally {
				// 4. 收尾：清流式态 + invalidate 权威收敛（用户消息已落库，服务端为准）
				endStream(currentId);
				if (currentId !== null) {
					await queryClient.invalidateQueries({
						queryKey: [...AI_MESSAGES_QUERY_STEM],
					});
				} else {
					setPendingUserContent(null);
				}
				// 会话列表总是收敛（lastMessageAt/标题/计数；新建失败但已建会话的边缘场景也覆盖）
				await queryClient.invalidateQueries({
					queryKey: [...AI_CONVERSATIONS_QUERY_STEM],
				});
				abortRef.current = null;
			}
		},
		[
			activeId,
			queryClient,
			setActiveConversation,
			beginStream,
			promoteStream,
			endStream,
			appendStreamText,
			setToolActive,
			setError,
			setNewChatError,
			setPendingUserContent,
		],
	);

	/** 中断当前流（AbortError 静默终止：助手消息不落库，用户消息保留） */
	const stop = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	const messages = useMemo<AiMessage[]>(() => {
		const items = messagesQuery.data?.items ?? [];
		// 新建视图挂乐观用户消息（会话尚未存在，无缓存可写）
		if (activeId === null && pendingUserContent !== null) {
			return [
				{
					id: `${OPTIMISTIC_PREFIX}pending`,
					role: "user",
					content: pendingUserContent,
					createdAt: new Date().toISOString(),
				},
			];
		}
		return items;
	}, [messagesQuery.data, activeId, pendingUserContent]);

	const status: ChatStatus = isStreamingCurrent
		? "streaming"
		: error !== null
			? "error"
			: "idle";

	return {
		/** 当前会话 id；null = 新建视图 */
		activeId,
		/** 当前视图消息（已落库 + 新建视图乐观项） */
		messages,
		isLoadingMessages: messagesQuery.isPending && activeId !== null,
		/** 当前会话流式增量文本（无流为 undefined） */
		streamText,
		/** 当前会话正在执行汇率工具查询（「正在查询汇率…」） */
		toolActive,
		/** 当前视图最近一次发送错误 */
		error,
		/** 发送状态机（当前视图） */
		status,
		/** 任意流进行中（输入框禁用 / 防重发） */
		anyStreaming,
		/** 发送（trim 后空/超长忽略；流式中忽略） */
		send,
		/** 中断当前流 */
		stop,
		/** 切换会话（null = 新建视图） */
		selectConversation: setActiveConversation,
	};
}
