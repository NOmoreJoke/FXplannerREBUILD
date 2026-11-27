"use client";

import { Building2 } from "lucide-react";
import { PageLoading } from "@/components/base";
import { ChatInput } from "./chat-input";
import { ConversationList } from "./conversation-list";
import { MessageList } from "./message-list";
import { useChat } from "@/lib/hooks/use-chat";
import {
	useConversations,
	useDeleteConversation,
} from "@/lib/hooks/use-conversations";
import { useModels } from "@/lib/hooks/use-models";
import { useOrganizationCapabilities } from "@/lib/hooks/use-organization-capabilities";
import { useCurrentOrganization } from "@/lib/hooks/use-organizations";
import { useChatStore } from "@/lib/stores/chat-store";

/**
 * 聊天工作台（ai-assistant 方案 §3.2/§5.2 + ToB R2 §10.2）：
 * 左会话列表 + 右对话区（含当前组织标识与组织工具状态）。
 * 状态编排集中在 use-chat / use-conversations（本组件只做组装与布局）；
 * 认证守卫在 (protected)/layout.tsx，页面（chat/page.tsx）只是本组件的瘦壳。
 */
export function ChatWorkspace() {
	const conversationsQuery = useConversations();
	const deleteMutation = useDeleteConversation();
	const chat = useChat();
	const streamingIds = useChatStore((s) => s.streamingIds);
	const { data: currentOrg, isError: orgError } = useCurrentOrganization();
	const { can, isLoading: capabilitiesLoading } = useOrganizationCapabilities();
	const { data: modelsData } = useModels();

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
				: "向 AI 助手提问公共汇率、当前组织余额与计划缺口，或起草换汇计划草稿。"
			: chat.isLoadingMessages
				? null
				: chat.messages.length === 0
					? "暂无消息，输入你的第一个问题。"
					: null;

	const orgToolsStatusText =
		modelsData?.orgToolsEnabled === false
			? "组织工具已临时关闭（仅公共汇率可用）"
			: orgError
				? "组织上下文加载失败"
				: !currentOrg || capabilitiesLoading
					? "组织工具检查中…"
					: !currentOrg.onboardingCompleted
						? "当前组织未建账（可查公共汇率）"
						: can("agent.draft")
							? "组织只读与草稿工具已就绪"
							: can("agent.business_read")
								? "组织只读工具已就绪（无草稿保存权限）"
								: "当前角色仅可用公共汇率查询";

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
				<header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
					<div>
						<h1 className="text-base font-semibold text-foreground">AI 助手</h1>
						<p className="text-xs text-muted-foreground">
							支持公共汇率、当前组织账本查询与计划草稿建议。请区分市场事实、组织账本与未保存草稿，关键入账请在业务页确认。
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2 text-xs">
						{currentOrg && (
							<span
								data-testid="chat-current-org"
								className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2.5 py-1 font-medium text-foreground"
							>
								<Building2
									className="size-3.5 text-muted-foreground"
									aria-hidden="true"
								/>
								<span>{currentOrg.name}</span>
							</span>
						)}
						<span
							data-testid="chat-org-tools-status"
							className="rounded-full bg-mint-50 px-2.5 py-1 font-medium text-mint-700"
						>
							{orgToolsStatusText}
						</span>
					</div>
				</header>

				{chat.isLoadingMessages ? (
					<PageLoading />
				) : (
					<MessageList
						messages={chat.messages}
						streamingText={chat.streamText}
						streamingDraft={chat.streamDraft}
						toolActive={chat.toolActive}
						activeToolName={chat.activeToolName}
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
