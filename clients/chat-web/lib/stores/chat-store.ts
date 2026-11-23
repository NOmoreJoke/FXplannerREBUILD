import { create } from "zustand";
import { persist } from "zustand/middleware";

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
	/** 正在执行汇率工具查询的会话 id 集合（展示「正在查询汇率…」） */
	toolActiveIds: string[];
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
	setToolActive: (id: string, active: boolean) => void;
	setError: (id: string, message: string | null) => void;
	setNewChatError: (message: string | null) => void;
	setPendingUserContent: (content: string | null) => void;
	/** 选择模型；传 null 回退「跟随服务端默认」（白名单缩编自愈也走此入口） */
	setSelectedModel: (key: string | null) => void;
	/**
	 * 重置运行时态（保留 selectedModel 偏好）：切换组织/登出时调用——
	 * 旧组织的会话选择、流式态与错误态不得带入新上下文。
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
			toolActiveIds: [],
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
							return {
								streamingIds: state.streamingIds.filter((item) => item !== id),
								toolActiveIds: state.toolActiveIds.filter(
									(item) => item !== id,
								),
								streamTexts,
							};
						}),

			appendStreamText: (id, delta) =>
				set((state) => ({
					streamTexts: {
						...state.streamTexts,
						[id]: (state.streamTexts[id] ?? "") + delta,
					},
				})),

			setToolActive: (id, active) =>
				set((state) => {
					const has = state.toolActiveIds.includes(id);
					if (active && !has) {
						return { toolActiveIds: [...state.toolActiveIds, id] };
					}
					if (!active && has) {
						return {
							toolActiveIds: state.toolActiveIds.filter((item) => item !== id),
						};
					}
					return {};
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
					toolActiveIds: [],
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

/** 中断当前流（无流时为空操作）；AbortError 由 use-chat 静默终止 */
export function abortActiveStream(): void {
	activeStreamAbort?.abort();
	activeStreamAbort = null;
}

/** 发送前置检查（选择器）：任意流进行中（含创建中）→ true */
export const selectAnyStreaming = (state: ChatStore): boolean =>
	state.creatingStream || state.streamingIds.length > 0;
