"use client";

import { useState } from "react";
import { MessageSquarePlus, Trash2 } from "lucide-react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AiConversationSummary } from "@/lib/api/chat";

interface ConversationListProps {
	items: AiConversationSummary[];
	activeId: string | null;
	/** 流进行中的会话 id 集合（其删除按钮禁用，后端流中删除 409） */
	streamingIds: readonly string[];
	loading: boolean;
	onSelect: (id: string | null) => void;
	onDelete: (id: string) => void;
	deletePending: boolean;
}

/**
 * 会话列表（ai-assistant 方案 §5.2）：新建入口、切换（高亮当前）、
 * 删除（AlertDialog 确认弹窗，方案 §5.2 conversation-list 注解）。
 */
export function ConversationList({
	items,
	activeId,
	streamingIds,
	loading,
	onSelect,
	onDelete,
	deletePending,
}: ConversationListProps) {
	const [deleteTarget, setDeleteTarget] =
		useState<AiConversationSummary | null>(null);

	return (
		<aside
			data-testid="conversation-list"
			className="flex w-60 shrink-0 flex-col border-r border-border"
		>
			<div className="p-3">
				<Button
					variant="outline"
					className="w-full"
					data-testid="new-conversation"
					onClick={() => onSelect(null)}
				>
					<MessageSquarePlus className="size-4" />
					新建对话
				</Button>
			</div>

			<nav
				aria-label="会话列表"
				className="flex-1 space-y-1 overflow-y-auto px-3 pb-3"
			>
				{loading ? (
					<p className="px-3 py-6 text-center text-xs text-muted-foreground">
						加载中…
					</p>
				) : items.length === 0 ? (
					<p className="px-3 py-6 text-center text-xs text-muted-foreground">
						暂无会话
					</p>
				) : (
					items.map((item) => {
						const active = item.id === activeId;
						const busy = streamingIds.includes(item.id);
						return (
							<div
								key={item.id}
								className={cn(
									"group flex items-center gap-1 rounded-lg px-1 transition-colors",
									active
										? "bg-ink-900 text-white"
										: "text-ink-500 hover:bg-muted hover:text-foreground",
								)}
							>
								<button
									type="button"
									data-testid={`conversation-${item.id}`}
									aria-current={active ? "page" : undefined}
									onClick={() => onSelect(item.id)}
									className="min-w-0 flex-1 py-2.5 text-left text-sm"
									title={item.title}
								>
									<span className="block truncate">{item.title}</span>
								</button>
								<button
									type="button"
									aria-label={`删除会话 ${item.title}`}
									title={busy ? "回复生成中，暂不能删除" : "删除会话"}
									disabled={busy}
									onClick={() => setDeleteTarget(item)}
									className={cn(
										"shrink-0 rounded-md p-1.5 transition-opacity",
										active
											? "text-white/70 hover:text-white"
											: "text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-600",
										busy && "cursor-not-allowed opacity-30",
									)}
								>
									<Trash2 className="size-3.5" />
								</button>
							</div>
						);
					})
				)}
			</nav>

			<AlertDialog
				open={deleteTarget !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteTarget(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>确认删除这个会话？</AlertDialogTitle>
						<AlertDialogDescription>
							将删除「{deleteTarget?.title}」及其全部消息，删除后不可恢复。
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>取消</AlertDialogCancel>
						<AlertDialogAction
							className="bg-red-600 text-white hover:bg-red-600/90"
							disabled={deletePending}
							onClick={(event) => {
								event.preventDefault();
								if (deleteTarget !== null) {
									onDelete(deleteTarget.id);
									setDeleteTarget(null);
								}
							}}
						>
							{deletePending ? "删除中…" : "确认删除"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</aside>
	);
}
