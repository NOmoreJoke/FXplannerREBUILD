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
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import {
	registerActiveStreamAbort,
	releaseActiveStreamAbort,
	selectAnyStreaming,
	useChatStore,
} from "@/lib/stores/chat-store";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { useOrganizationStore } from "@/lib/stores/organization-store";

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
 * messagesKey 由调用方按**发起组织**组装（流式期间组织切换后不得再写新组织的键）。
 */
function reconcileOptimisticMessage(
	queryClient: QueryClient,
	messagesKey: readonly unknown[],
	userMessageId: string,
	content: string,
): void {
	const prev = queryClient.getQueryData<AiMessageListData>(messagesKey);
	if (!prev) return;
	const items = [...prev.items];
	const index = items.findIndex(
		(item) => isOptimistic(item) && item.content === content,
	);
	if (index !== -1) {
		items[index] = { ...items[index], id: userMessageId };
		queryClient.setQueryData<AiMessageListData>(messagesKey, { items });
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
	// ToB W20：组织未选中不发请求（会话按 (userId, organizationId) 隔离）
	const orgId = useActiveOrgId();
	const messagesQuery = useQuery({
		queryKey: aiMessagesQueryKey(activeId ?? ""),
		queryFn: () => chatApi.listMessages(activeId!),
		enabled: activeId !== null && orgId !== null,
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
			// 发送时刻的组织快照（评审 I-18）：流式期间的全部缓存写入都落在发起组织。
			// 中途切换组织 → 流被 useSwitchOrganization 中止；即便有迟到帧，
			// 也因键仍指向发起组织而不会写进新组织的缓存。
			const sendOrgId = useOrganizationStore.getState().activeOrganizationId;
			const messagesKey = (id: string): readonly unknown[] =>
				withOrgScope(sendOrgId, queryKeys.ai.messages(id));
			/** 组织已切换：当前流属于旧上下文，停止处理后续帧 */
			const contextChanged = (): boolean =>
				useOrganizationStore.getState().activeOrganizationId !== sendOrgId;

			// 1. 乐观插入用户消息（新建挂 pending；追问写消息缓存）
			if (isNew) {
				setPendingUserContent(content);
				setNewChatError(null);
			} else {
				const key = messagesKey(conversationId);
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
			// 登记到模块级注册表：切换组织时 useSwitchOrganization 可从外部中断本流
			registerActiveStreamAbort(abort);

			const rollbackOptimistic = () => {
				if (isNew) {
					setPendingUserContent(null);
					return;
				}
				const key = messagesKey(conversationId);
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
				// 用户消息未落库，回滚乐观项无残留；错误态提示（abort 静默）。
				// 归属判定（评审 R2-I09）：登记在册的仍是本流才清理运行时态——被切换组织
				// 摘掉句柄的流，其状态已由 resetRuntime 清空，不得再写（可能已有新组织的流）
				const ownsStream = releaseActiveStreamAbort(abort);
				if (abortRef.current === abort) abortRef.current = null;
				if (ownsStream) {
					rollbackOptimistic();
					if (!isAbortError(streamError) && !contextChanged()) {
						if (isNew) {
							setNewChatError(toErrorMessage(streamError));
						} else {
							setError(conversationId, toErrorMessage(streamError));
						}
					}
					endStream(conversationId);
				}
				return;
			}

			// 3. 逐帧消费（meta → tool/token* → done/error）
			let currentId = conversationId;
			try {
				for await (const event of events) {
					// 组织已切换，或本流已被外部中止：本流属于旧上下文，丢弃迟到帧并结束迭代。
					// 只比对组织 id 不够（评审 R3-I04）：A→B→A 之后比较结果回到「未变化」，
					// 被中止的旧流会把迟到帧写进同一会话上的新流；abort 信号是单调的，补上它
					if (abort.signal.aborted || contextChanged()) break;
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
									messagesKey(currentId),
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
									messagesKey(currentId),
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
							const key = messagesKey(currentId!);
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
				// 流中断（网络断开等）：已收文本丢弃，错误态提示。
				// 组织已切换或本流已被中止则不提示：前者是旧上下文的流，错误不得带进
				// 新组织的会话视图；后者是用户主动停止或切换组织（评审 R3-I04）
				if (
					!isAbortError(loopError) &&
					!abort.signal.aborted &&
					!contextChanged()
				) {
					if (currentId !== null) {
						setError(currentId, toErrorMessage(loopError));
					}
				}
			} finally {
				// 4. 收尾：清流式态 + invalidate 权威收敛（用户消息已落库，服务端为准）。
				//    评审 R2-I09：归属判定与注销必须在任何 await **之前**完成——下面的失效要等
				//    网络往返，期间（同一组织或切换后的新组织）可能已开出另一条流。
				//    评审 R3-I04：登记在册的已不是本流，只有两种情况——它被外部中止过
				//    （abortActiveStream 同时重置运行时态，本流的流式态已不存在），或已有
				//    后来者接管（同一会话 id 上现在是新流的流式态）。两种情况都不得再按
				//    会话 id 清理，否则会截断新流、清掉它的流式文本并解锁输入框。
				//    「外部中止必伴随运行时态重置」由 abortActiveStream 自身保证，不依赖
				//    调用点；用户主动 stop() 不摘句柄，仍判归本流，照常清理。
				const ownsStream = releaseActiveStreamAbort(abort);
				if (abortRef.current === abort) abortRef.current = null;
				if (ownsStream) {
					if (currentId !== null) {
						endStream(currentId);
					} else {
						// 创建中的流（meta 未到即结束）：清创建态与它的乐观消息——此刻没有后来者
						endStream(null);
						setPendingUserContent(null);
					}
				}
				// 失效范围限定在**发起组织**的前缀键：无前缀词根匹配不到带前缀的键
				// （评审 I-19），全形态失效又会波及切换后的新组织。
				// 组织已切换时发起组织的缓存已被移除，没有可失效的对象；本流已被取代时
				// 同一会话的缓存是新流的，重拉会抹掉它的乐观消息（评审 R3-I04）
				if (ownsStream && !contextChanged()) {
					if (currentId !== null) {
						await queryClient.invalidateQueries({
							queryKey: withOrgScope(sendOrgId, [...AI_MESSAGES_QUERY_STEM]),
						});
					}
					// 会话列表总是收敛（lastMessageAt/标题/计数；新建失败但已建会话的边缘场景也覆盖）
					await queryClient.invalidateQueries({
						queryKey: withOrgScope(sendOrgId, [...AI_CONVERSATIONS_QUERY_STEM]),
					});
				}
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
