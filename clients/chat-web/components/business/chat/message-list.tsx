"use client";

import { useEffect, useRef } from "react";
import { MessageBubble } from "./message-bubble";
import type { AiMessage } from "@/lib/api/chat";

interface MessageListProps {
	messages: AiMessage[];
	/** 当前会话流式增量文本（无流为 undefined） */
	streamingText?: string;
	/** 正在执行汇率工具查询（展示「正在查询汇率…」提示） */
	toolActive: boolean;
	/** 空态提示文案；null = 有消息不展示空态 */
	emptyHint: string | null;
}

/**
 * 消息流渲染（ai-assistant 方案 §5.2）：已落库消息 + 流式气泡 + 工具提示，
 * 内容变化时自动滚动到底部。
 */
export function MessageList({
	messages,
	streamingText,
	toolActive,
	emptyHint,
}: MessageListProps) {
	const bottomRef = useRef<HTMLDivElement>(null);
	const streamLength = streamingText?.length ?? 0;

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ block: "end" });
	}, [messages.length, streamLength, toolActive]);

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
				/>
			))}
			{toolActive && (
				<div className="flex justify-start" data-testid="tool-indicator">
					<div className="rounded-2xl border border-border bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground">
						正在查询汇率…
					</div>
				</div>
			)}
			{streamingText !== undefined && (
				<MessageBubble role="assistant" content={streamingText} streaming />
			)}
			<div ref={bottomRef} aria-hidden="true" />
		</div>
	);
}
