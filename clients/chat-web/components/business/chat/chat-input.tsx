"use client";

import { useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ModelSelector } from "./model-selector";

interface ChatInputProps {
	/** 任意流进行中：禁发，发送钮切换为停止钮（单流交互约定） */
	streaming: boolean;
	onSend: (content: string) => void;
	onStop: () => void;
}

/**
 * 输入框（ai-assistant 方案 §5.2）：Enter 发送 / Shift+Enter 换行（兼容中文
 * 输入法组词态）；流式中禁发并可停止生成。内容 trim 后为空不发（hook 再兜底）。
 * 左侧嵌模型选择器（ai-model-whitelist 方案 §5.2，流式中同步禁用）。
 */
export function ChatInput({ streaming, onSend, onStop }: ChatInputProps) {
	const [value, setValue] = useState("");
	const canSend = value.trim().length > 0 && !streaming;

	const submit = () => {
		if (!canSend) return;
		onSend(value);
		setValue("");
	};

	return (
		<div className="border-t border-border p-3">
			<div className="flex items-end gap-2">
				<div className="pb-1.5">
					<ModelSelector disabled={streaming} />
				</div>
				<Textarea
					data-testid="chat-input"
					aria-label="消息输入框"
					value={value}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (
							event.key === "Enter" &&
							!event.shiftKey &&
							!event.nativeEvent.isComposing
						) {
							event.preventDefault();
							submit();
						}
					}}
					placeholder={
						streaming
							? "回复生成中…"
							: "向 AI 助手提问，Enter 发送，Shift+Enter 换行"
					}
					disabled={streaming}
					className="max-h-40 min-h-11 resize-none"
				/>
				{streaming ? (
					<Button
						type="button"
						variant="outline"
						size="icon"
						data-testid="chat-stop"
						aria-label="停止生成"
						title="停止生成"
						onClick={onStop}
					>
						<Square className="size-4" />
					</Button>
				) : (
					<Button
						type="button"
						size="icon"
						data-testid="chat-send"
						aria-label="发送"
						title="发送"
						disabled={!canSend}
						onClick={submit}
					>
						<ArrowUp className="size-4" />
					</Button>
				)}
			</div>
		</div>
	);
}
