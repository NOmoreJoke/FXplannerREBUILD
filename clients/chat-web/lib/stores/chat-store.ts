import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AiPlanDraft } from "@/lib/api/chat";

/**
 * 聊天工作台运行时状态（ai-assistant 方案 §5.2）。
 *
 * 职责边界：
 * - 当前会话 id（会话切换的唯一事实）；
 * - 流式中会话集合（防同会话重发；后端同会话并发流 409 AI_CONVERSATION_BUSY）；
 * - 流式运行时数据（增量文本 / 工具提示态 / 错误态）按会话 id 分桶，
 *   支持流式中切换会话再切回不丢进度。
 *
 * 交互约定：聊天工作台同一时刻只允许一个流（send 前检查 anyStreaming，
 * UI 输入框禁用 + hook 兜底双重把关）；后端本身支持跨会话并发流。
 * chat-store 无单测（方案 §8.1 有意豁免，走 E2E）。
 *
 * 持久化（ai-model-whitelist 方案 §5.2）：仅 selectedModel 落 localStorage
 * （key 与 LingJi 同名 "preferred-chat-model"）；运行时态（streamingIds/
 * streamTexts/errors 等）禁止落盘——否则刷新后 selectAnyStreaming 恒真，
 * 输入框被永久锁死。
 */
interface ChatStore {
	/** 当前会话 id；null = 未选择（新建对话入口态） */
	activeConversationId: string | null;
	/** 流式回复进行中的会话 id 集合 */
	streamingIds: string[];
	/** 「以首条消息新建会话」的流进行中（meta 帧返回会话 id 前的过渡态） */
	creatingStream: boolean;
	/** 各会话流式中的增量文本 */
	streamTexts: Record<string, string>;
	/** 各会话流式中最近一次草稿建议卡片（done 收敛后随消息落库） */
	streamDrafts: Record<string, AiPlanDraft | null>;
	/** 正在执行工具查询的会话 id 集合 */
	toolActiveIds: string[];
	/** 各会话当前正在执行的工具名（未执行为 null） */
	activeTools: Record<string, string | null>;
	/** 各会话最近一次发送失败的错误信息（成功发送时清除；endStream 不动它） */
	errors: Record<string, string | null>;
	/** 新建会话（尚无会话 id）视图的错误信息 */
	newChatError: string | null;
	/** 新建会话场景的乐观用户消息（meta 帧转正前挂空态视图，防「发送无反馈」） */
	pendingUserContent: string | null;
	/** 已选白名单模型 key；null = 未选择（发消息不传 modelKey，走服务端默认回退）。
	 * 唯一持久化字段（persist partialize） */
	selectedModel: string | null;

	setActiveConversation: (id: string | null) => void;
	/** 开始流：id 传 null 表示创建中 */
	beginStream: (id: string | null) => void;
	/** 创建流拿到真实会话 id：退出 creatingStream，挂入 streamingIds */
	promoteStream: (id: string) => void;
	/** 结束流：清理该会话流式文本与工具态（错误态保留供 UI 展示）；null = 创建流未转正即结束 */
	endStream: (id: string | null) => void;
	appendStreamText: (id: string, delta: string) => void;
	setStreamDraft: (id: string, draft: AiPlanDraft | null) => void;
	setToolActive: (id: string, active: boolean, toolName?: string) => void;
	setError: (id: string, message: string | null) => void;
	setNewChatError: (message: string | null) => void;
	setPendingUserContent: (content: string | null) => void;
	/** 选择模型；传 null 回退「跟随服务端默认」（白名单缩编自愈也走此入口） */
	setSelectedModel: (key: string | null) => void;
		/**
		 * 重置运行时态（保留 selectedModel 偏好）：旧组织的会话选择、流式态与错误态
		 * 不得带入新上下文。外部中止入口 abortActiveStream 会自动调用；登出等
		 * 「中止 + 重置」场景一律经该入口，不要只调本方法。
	 */
	resetRuntime: () => void;
}

export const useChatStore = create<ChatStore>()(
	persist(
		(set) => ({
			activeConversationId: null,
			streamingIds: [],
			creatingStream: false,
			streamTexts: {},
			streamDrafts: {},
			toolActiveIds: [],
			activeTools: {},
			errors: {},
			newChatError: null,
			pendingUserContent: null,
			selectedModel: null,

			setActiveConversation: (id) =>
				set({ activeConversationId: id, newChatError: null }),

			beginStream: (id) =>
				set((state) => {
					if (id === null) return { creatingStream: true };
					if (state.streamingIds.includes(id)) return {};
					return { streamingIds: [...state.streamingIds, id] };
				}),

			promoteStream: (id) =>
				set((state) => ({
					creatingStream: false,
					streamingIds: state.streamingIds.includes(id)
						? state.streamingIds
						: [...state.streamingIds, id],
				})),

			endStream: (id: string | null) =>
				id === null
					? set({ creatingStream: false })
					: set((state) => {
							const streamTexts = { ...state.streamTexts };
							delete streamTexts[id];
							const streamDrafts = { ...state.streamDrafts };
							delete streamDrafts[id];
							const activeTools = { ...state.activeTools };
							delete activeTools[id];
							return {
								streamingIds: state.streamingIds.filter((item) => item !== id),
								toolActiveIds: state.toolActiveIds.filter(
									(item) => item !== id,
								),
								streamTexts,
								streamDrafts,
								activeTools,
							};
						}),

			appendStreamText: (id, delta) =>
				set((state) => ({
					streamTexts: {
						...state.streamTexts,
						[id]: (state.streamTexts[id] ?? "") + delta,
					},
				})),

			setStreamDraft: (id, draft) =>
				set((state) => ({
					streamDrafts: { ...state.streamDrafts, [id]: draft },
				})),

			setToolActive: (id, active, toolName) =>
				set((state) => {
					const has = state.toolActiveIds.includes(id);
					const nextTools = {
						...state.activeTools,
						[id]: active ? (toolName ?? state.activeTools[id] ?? null) : null,
					};
					if (active && !has) {
						return {
							toolActiveIds: [...state.toolActiveIds, id],
							activeTools: nextTools,
						};
					}
					if (!active && has) {
						return {
							toolActiveIds: state.toolActiveIds.filter((item) => item !== id),
							activeTools: nextTools,
						};
					}
					return { activeTools: nextTools };
				}),

			setError: (id, message) =>
				set((state) => ({ errors: { ...state.errors, [id]: message } })),

			setNewChatError: (message) => set({ newChatError: message }),

			setPendingUserContent: (content) => set({ pendingUserContent: content }),

			setSelectedModel: (key) => set({ selectedModel: key }),

			resetRuntime: () =>
				set({
					activeConversationId: null,
					streamingIds: [],
					creatingStream: false,
					streamTexts: {},
					streamDrafts: {},
					toolActiveIds: [],
					activeTools: {},
					errors: {},
					newChatError: null,
					pendingUserContent: null,
				}),
		}),
		{
			// key 与 LingJi 同名：同用户跨产品偏好语义一致
			name: "preferred-chat-model",
			// 仅持久化 selectedModel：运行时态落盘会在刷新后锁死输入框（见接口注释）
			partialize: (state) => ({ selectedModel: state.selectedModel }),
		},
	),
);

/**
 * 当前流的中断句柄（模块级而非 store 状态：AbortController 不进状态树、不参与渲染）。
 * 切换组织/登出时由外部调 abortActiveStream——旧组织的流不得继续写入新上下文
 * （评审 I-18）。use-chat 开流时登记、收尾时注销。
 */
let activeStreamAbort: AbortController | null = null;

export function registerActiveStreamAbort(
	controller: AbortController | null,
): void {
	activeStreamAbort = controller;
}

/**
 * 中断当前流并重置聊天运行时态（无流时仅重置）。
 *
 * 切换组织 / 退出组织 / 会话重置的统一入口。「外部中止」与「运行时态重置」必须同时
 * 发生（评审 R3-I04）：use-chat 的收尾以句柄归属判定自己是否仍是当前流，不是则不再
 * 按会话 id 清理流式态——若只中止不重置，被中止的流就没有人清理，输入框永久锁死。
 * 由本函数自身保证这一配对，不依赖调用点自律。
 *
 * 用户主动停止走 use-chat 的 stop()：只 abort、不从注册表摘句柄，流自己完成收尾。
 */
export function abortActiveStream(): void {
	activeStreamAbort?.abort();
	activeStreamAbort = null;
	useChatStore.getState().resetRuntime();
}

/**
 * 注销句柄：仅当登记的仍然是该句柄时才清空，并返回是否由本流完成注销（评审 R2-I09）。
 * 返回 false = 登记在册的已不是它（被 abortActiveStream 摘掉，或已有后来者接管）。
 *
 * 流 #1 被切换组织中止后，其收尾要等缓存失效（含网络往返）才走到注销这一步；
 * 期间用户可能已在新组织开出流 #2——无条件置空会抹掉 #2 的句柄，之后再切组织
 * 就中止不了 #2。迟到的收尾只能带走自己的句柄，调用方以返回值判定自己是否仍是
 * 当前流（归属判定必须在任何 await 之前完成）。
 */
export function releaseActiveStreamAbort(
	controller: AbortController,
): boolean {
	if (activeStreamAbort !== controller) return false;
	activeStreamAbort = null;
	return true;
}

/** 发送前置检查（选择器）：任意流进行中（含创建中）→ true */
export const selectAnyStreaming = (state: ChatStore): boolean =>
	state.creatingStream || state.streamingIds.length > 0;
