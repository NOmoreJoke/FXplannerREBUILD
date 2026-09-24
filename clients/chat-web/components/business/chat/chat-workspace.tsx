"use client";

import { PageLoading } from "@/components/base";
import { ChatInput } from "./chat-input";
import { ConversationList } from "./conversation-list";
import { MessageList } from "./message-list";
import { useChat } from "@/lib/hooks/use-chat";
import {
	useConversations,
	useDeleteConversation,
} from "@/lib/hooks/use-conversations";
import { useChatStore } from "@/lib/stores/chat-store";

/**
 * 聊天工作台（ai-assistant 方案 §3.2/§5.2）：左会话列表 + 右对话区。
 * 状态编排集中在 use-chat / use-conversations（本组件只做组装与布局）；
 * 认证守卫在 (protected)/layout.tsx，页面（chat/page.tsx）只是本组件的瘦壳。
 */
export function ChatWorkspace() {
	const conversationsQuery = useConversations();
	const deleteMutation = useDeleteConversation();
	const chat = useChat();
	const streamingIds = useChatStore((s) => s.streamingIds);

	const handleDelete = (id: string) => {
		deleteMutation.mutate(id, {
			onSuccess: () => {
				// 删除的是当前会话 → 回到新建视图（列表由 mutation onSuccess invalidate）
				if (chat.activeId === id) {
					chat.selectConversation(null);
				}
			},
		});
	};

	const emptyHint =
		chat.activeId === null
			? chat.messages.length > 0
				? null
				: "向 AI 助手提问汇率问题（如「现在美元兑日元是多少」），开始新的对话。"
			: chat.isLoadingMessages
				? null
				: chat.messages.length === 0
					? "暂无消息，输入你的第一个问题。"
					: null;

	return (
		<div data-testid="chat-page" className="flex h-[calc(100dvh-3.5rem)]">
			<ConversationList
				items={conversationsQuery.data?.items ?? []}
				activeId={chat.activeId}
				streamingIds={streamingIds}
				loading={conversationsQuery.isPending}
				onSelect={chat.selectConversation}
				onDelete={handleDelete}
				deletePending={deleteMutation.isPending}
			/>

			<section className="flex min-w-0 flex-1 flex-col">
				<header className="border-b border-border px-6 py-3">
					<h1 className="text-base font-semibold text-foreground">AI 助手</h1>
					<p className="text-xs text-muted-foreground">
						以自然语言查询汇率（最新 / 历史）。回复由 AI
						生成，关键数值请以行情页为准。
					</p>
				</header>

				{chat.isLoadingMessages ? (
					<PageLoading />
				) : (
					<MessageList
						messages={chat.messages}
						streamingText={chat.streamText}
						toolActive={chat.toolActive}
						emptyHint={emptyHint}
					/>
				)}

				{chat.error !== null && (
					<div
						data-testid="chat-error"
						role="alert"
						className="mx-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700"
					>
						{chat.error}
					</div>
				)}

				<ChatInput
					streaming={chat.anyStreaming}
					onSend={(content) => void chat.send(content)}
					onStop={chat.stop}
				/>
			</section>
		</div>
	);
}
