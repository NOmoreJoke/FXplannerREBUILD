import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthUser } from "@/lib/api/contract";
import { authApi } from "@/lib/api/auth";
import { queryKeys } from "@/lib/api/query-keys";
import { redirectToLogin } from "@/lib/auth/redirect-to-login";
import { resetSessionContext } from "@/lib/auth/session-reset";
import { useAuthStore } from "@/lib/stores/auth-store";

/**
 * 当前用户查询 Key
 */
export const CURRENT_USER_QUERY_KEY = queryKeys.auth.me();

/**
 * 查询当前用户信息
 * - 缓存 10 分钟
 * - 401 错误不重试（由 apiClient 自动跳登录）
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
 * 评审 R2-I10：与登录 / 注册 / 401 共用 resetSessionContext（唯一入口）。
 */
export function useLogout() {
	const queryClient = useQueryClient();

	return () => {
		authApi.logout();
		resetSessionContext(queryClient);
	};
}

/**
 * 退出登录并回登录页——侧栏、设置页、组织选择页与组织加载失败页共用的唯一出口：
 * 登出（内部走 resetSessionContext：清缓存、组织选择、在途流）→ 清用户态 → 整页跳登录页。
 *
 * 组织选择页与组织加载失败页是整屏渲染的，没有侧栏：此前那里没有登出入口，
 * 0 组织或选错账号的用户只能手动清 cookie 才能换账号（Goal #3A §9.6）。
 */
export function useLogoutAndRedirect() {
	const logout = useLogout();
	const clearUser = useAuthStore((s) => s.clearUser);

	return () => {
		logout();
		clearUser();
		redirectToLogin("/");
	};
}
