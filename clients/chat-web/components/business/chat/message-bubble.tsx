"use client";

import { cn } from "@/lib/utils";
import type { AiMessageRole, AiPlanDraft } from "@/lib/api/chat";
import { useModels } from "@/lib/hooks/use-models";
import { PlanDraftCard } from "./plan-draft-card";

interface MessageBubbleProps {
	role: AiMessageRole;
	content: string;
	/** 流式中的助手气泡：末尾追加快闪光标（globals.css .chat-streaming-caret） */
	streaming?: boolean;
	/** 所用白名单模型 key（assistant 消息；null/undefined 不展示角标） */
	model?: string | null;
	/** 关联的计划草稿（仅助手消息；未保存，需人工确认） */
	planDraft?: AiPlanDraft | null;
}

/**
 * 消息气泡（ai-assistant 方案 §5.2 + ToB R2 §10.2）。
 * XSS 纪律：AI 输出按纯文本渲染（React 转义），禁用 dangerouslySetInnerHTML；
 * 未来若支持 markdown 必须过 sanitize 并补 XSS 用例（§8.3 场景 4）。
 * 助手气泡下角小字展示所用模型（ai-model-whitelist 方案 §5.2）：
 * model → displayName，列表缺失时回退原始 key；model 为 null 不展示。
 */
export function MessageBubble({
	role,
	content,
	streaming = false,
	model,
	planDraft = null,
}: MessageBubbleProps) {
	const isUser = role === "user";
	// react-query 缓存去重：多实例共享同一份模型列表，无额外请求
	const { data: modelsData } = useModels();
	const modelDisplayName =
		!isUser && model
			? (modelsData?.items.find((item) => item.key === model)?.displayName ??
					model)
			: null;

	return (
		<div
			className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
		>
			<div
				data-testid={isUser ? "message-user" : "message-assistant"}
				className={cn(
					"max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words",
					isUser
						? "bg-ink-900 text-white"
						: "border border-border bg-muted/50 text-foreground",
				)}
			>
				{content}
				{streaming && (
					<span className="chat-streaming-caret" aria-hidden="true">
						▍
					</span>
				)}
				{!isUser && planDraft && <PlanDraftCard draft={planDraft} />}
				{modelDisplayName !== null && (
					<div
						data-testid="message-model"
						className="mt-1 text-right text-[11px] leading-none whitespace-normal text-muted-foreground"
					>
						{modelDisplayName}
					</div>
				)}
			</div>
		</div>
	);
}
