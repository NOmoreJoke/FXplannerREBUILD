import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi } from "@/lib/api/auth";

interface User {
	id: string;
	email: string;
	name: string | null;
	avatar: string | null;
	createdAt: string;
}

/**
 * 当前用户查询 Key
 */
export const CURRENT_USER_QUERY_KEY = ["auth", "me"];

/**
 * 查询当前用户信息
 * - 缓存 10 分钟
 * - 401 错误不重试（由 apiClient 自动跳转登录）
 */
export function useCurrentUser() {
	return useQuery<User>({
		queryKey: CURRENT_USER_QUERY_KEY,
		queryFn: authApi.getMe,
		staleTime: 10 * 60 * 1000, // 用户信息缓存 10 分钟
		retry: false, // 401 不重试，直接跳转登录
	});
}

/**
 * 登出 hook
 * 清除所有缓存并执行登出
 */
export function useLogout() {
	const queryClient = useQueryClient();

	return () => {
		authApi.logout();
		queryClient.clear(); // 清除所有缓存
	};
}
