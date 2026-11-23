import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthUser } from "@/lib/api/contract";
import { authApi } from "@/lib/api/auth";
import { queryKeys } from "@/lib/api/query-keys";
import {
	abortActiveStream,
	useChatStore,
} from "@/lib/stores/chat-store";
import { useOrganizationStore } from "@/lib/stores/organization-store";

/**
 * 当前用户查询 Key
 */
export const CURRENT_USER_QUERY_KEY = queryKeys.auth.me();

/**
 * 查询当前用户信息
 * - 缓存 10 分钟
 * - 401 错误不重试（由 apiClient 自动跳转登录）
 */
export function useCurrentUser() {
	return useQuery<AuthUser>({
		queryKey: CURRENT_USER_QUERY_KEY,
		queryFn: authApi.getMe,
		staleTime: 10 * 60 * 1000, // 用户信息缓存 10 分钟
		retry: false, // 401 不重试，直接跳转登录
	});
}

/**
 * 登出：清除全部缓存与**跨账号不得继承**的客户端状态后执行登出。
 *
 * 评审 I-18：组织选择持久化在 localStorage（"active-organization"），不随
 * queryClient.clear() 失效——不清的话换账号登录会带着上一个账号的组织 id
 * 发请求。聊天运行时态与进行中的 SSE 流同样在此终结。
 */
export function useLogout() {
	const queryClient = useQueryClient();

	return () => {
		authApi.logout();
		abortActiveStream();
		useChatStore.getState().resetRuntime();
		useOrganizationStore.getState().clearActiveOrganization();
		queryClient.clear(); // 清除所有缓存
	};
}
