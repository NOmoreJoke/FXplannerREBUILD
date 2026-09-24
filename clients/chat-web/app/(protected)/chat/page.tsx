import { ChatWorkspace } from "@/components/business/chat";

/**
 * AI 助手页（ai-assistant 技术方案 §5.2 瘦壳）。
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）；
 * 会话/消息/流式状态由 use-chat 承载，展示由 business/chat 组件承载。
 */
export default function ChatPage() {
	return <ChatWorkspace />;
}
