"use client";

import { useAutoScrollToBottom } from "@/hooks/use-auto-scroll-to-bottom";
import { MessageBubble } from "./message-bubble";
import type { AiMessage, AiPlanDraft } from "@/lib/api/chat";

const TOOL_STATUS_LABELS: Record<string, string> = {
	query_exchange_rate: "正在查询汇率…",
	get_account_summary: "正在查询组织账户摘要…",
	list_plan_exposure: "正在查询换汇计划与缺口…",
	get_plan_cost_summary: "正在查询计划成本摘要…",
	list_upcoming_actions: "正在查询近期到期事项…",
	draft_fx_plan: "正在生成换汇计划草稿…",
};

interface MessageListProps {
	messages: AiMessage[];
	/** 当前会话流式增量文本（无流为 undefined） */
	streamingText?: string;
	/** 流式中已收到的计划草稿（无草稿为 null） */
	streamingDraft?: AiPlanDraft | null;
	/** 正在执行工具查询 */
	toolActive: boolean;
	/** 当前正在执行的工具名 */
	activeToolName?: string | null;
	/** 空态提示文案；null = 有消息不展示空态 */
	emptyHint: string | null;
}

/**
 * 消息流渲染（ai-assistant 方案 §5.2 + ToB R2）：已落库消息 + 流式气泡 + 工具提示，
 * 内容变化时自动滚动到底部。
 */
export function MessageList({
	messages,
	streamingText,
	streamingDraft = null,
	toolActive,
	activeToolName = null,
	emptyHint,
}: MessageListProps) {
	const streamLength = streamingText?.length ?? 0;
	const bottomRef = useAutoScrollToBottom<HTMLDivElement>(
		`${messages.length}:${streamLength}:${toolActive}:${streamingDraft !== null}`,
	);

	if (emptyHint !== null) {
		return (
			<div
				data-testid="message-empty"
				className="flex flex-1 items-center justify-center p-8"
			>
				<p className="max-w-sm text-center text-sm text-muted-foreground">
					{emptyHint}
				</p>
			</div>
		);
	}

	const toolLabel =
		(activeToolName && TOOL_STATUS_LABELS[activeToolName]) ||
		"正在查询汇率…";

	return (
		<div
			data-testid="message-list"
			className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
		>
			{messages.map((message) => (
				<MessageBubble
					key={message.id}
					role={message.role}
					content={message.content}
					model={message.model}
					planDraft={message.planDraft ?? null}
				/>
			))}
			{toolActive && (
				<div className="flex justify-start" data-testid="tool-indicator">
					<div className="rounded-2xl border border-border bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground">
						{toolLabel}
					</div>
				</div>
			)}
			{(streamingText !== undefined || streamingDraft !== null) && (
				<MessageBubble
					role="assistant"
					content={streamingText ?? ""}
					planDraft={streamingDraft}
					streaming={streamingText !== undefined}
				/>
			)}
			<div ref={bottomRef} aria-hidden="true" />
		</div>
	);
}
