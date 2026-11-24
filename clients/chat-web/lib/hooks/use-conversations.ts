"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { chatApi } from "@/lib/api/chat";
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { useOrganizationStore } from "@/lib/stores/organization-store";

/**
 * 会话列表消费层（ai-assistant 方案 §5.2；ToB W20 组织作用域）：
 * useConversations 列表拉取；useDeleteConversation 删除 + 列表/消息缓存失效。
 * AI 会话按 (userId, organizationId) 隔离（技术方案 §8.4）——缓存键带组织前缀。
 */

/** 查询 Key 词根（[domain, action] 约定，先例：rates） */
export const AI_CONVERSATIONS_QUERY_STEM = queryKeys.ai.conversations();
export const AI_MESSAGES_QUERY_STEM = queryKeys.ai.messagesStem;

/** 组装完整消息查询 Key（按会话分桶；ToB W20：读 store 织入组织前缀） */
export function aiMessagesQueryKey(
	conversationId: string,
): readonly unknown[] {
	return withOrgScope(
		useOrganizationStore.getState().activeOrganizationId,
		queryKeys.ai.messages(conversationId),
	);
}

/** 会话列表（GET /ai/conversations，按 lastMessageAt 倒序） */
export function useConversations() {
	// ToB W20：组织作用域缓存键 + 未选组织不发业务请求
	const orgId = useActiveOrgId();
	return useQuery({
		queryKey: withOrgScope(orgId, [...AI_CONVERSATIONS_QUERY_STEM]),
		queryFn: () => chatApi.listConversations(),
		enabled: orgId !== null,
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
				queryKey: withOrgScope(
					useOrganizationStore.getState().activeOrganizationId,
					[...AI_CONVERSATIONS_QUERY_STEM],
				),
			});
			queryClient.removeQueries({
				queryKey: aiMessagesQueryKey(conversationId),
			});
		},
	});
}
