"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { chatApi } from "@/lib/api/chat";

/**
 * 会话列表消费层（ai-assistant 方案 §5.2）：
 * useConversations 列表拉取；useDeleteConversation 删除 + 列表/消息缓存失效。
 */

/** 查询 Key 词根（[domain, action] 约定，先例：rates） */
export const AI_CONVERSATIONS_QUERY_STEM = ["ai", "conversations"] as const;
export const AI_MESSAGES_QUERY_STEM = ["ai", "messages"] as const;

/** 组装完整消息查询 Key（按会话分桶） */
export function aiMessagesQueryKey(
	conversationId: string,
): readonly [string, string, string] {
	return [...AI_MESSAGES_QUERY_STEM, conversationId] as const;
}

/** 会话列表（GET /ai/conversations，按 lastMessageAt 倒序） */
export function useConversations() {
	return useQuery({
		queryKey: [...AI_CONVERSATIONS_QUERY_STEM],
		queryFn: () => chatApi.listConversations(),
		// 列表静默期：切回页面不闪 loading；发送/删除后主动 invalidate 收敛
		staleTime: 30_000,
		retry: false, // 401 由 apiClient 统一处理；失败走错误分支
	});
}

/** 删除会话：成功后失效列表、移除该会话消息缓存（级联删除，服务端为准） */
export function useDeleteConversation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (conversationId: string) =>
			chatApi.deleteConversation(conversationId),
		onSuccess: async (_data, conversationId) => {
			await queryClient.invalidateQueries({
				queryKey: [...AI_CONVERSATIONS_QUERY_STEM],
			});
			queryClient.removeQueries({
				queryKey: aiMessagesQueryKey(conversationId),
			});
		},
	});
}
