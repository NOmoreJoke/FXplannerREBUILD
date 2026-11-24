import type { QueryClient } from "@tanstack/react-query";
import { clearToken, setToken } from "@/lib/auth/token";
import { abortActiveStream } from "@/lib/stores/chat-store";
import { useOrganizationStore } from "@/lib/stores/organization-store";
import { useAuthStore } from "@/lib/stores/auth-store";
import type { AuthUser } from "@/lib/api/contract";

/**
 * 会话级上下文重置（评审 R2-I10）：换账号 / 登出 / 401 的**唯一入口**。
 *
 * 清掉一切「跨账号不得继承」的客户端状态：
 * - 凭证 cookie；
 * - 组织选择（持久化在 localStorage，不随页面重载或 queryClient.clear() 消失）
 *   与会话级被拒绝的组织集合；
 * - 在途的 SSE 流与聊天运行时态（会话选择 / 流式态 / 错误态）；
 * - React Query 缓存（传入 queryClient 时；不传则由随后的整页跳转来清）。
 *
 * 为什么登录 / 注册成功也要调（此前只在登出时清）：账号 A 的凭证过期后经
 * proxy.ts 跳到 /login，localStorage 里仍是 A 的组织 id。账号 B 登录后首个请求
 * （建账状态）就带着 X-Organization-Id: org-A ——B 不是成员则 404 被吞、未建账的
 * 新用户被直接放进 /home 跳过建账向导；B 恰好也是成员则静默继承 A 的组织选择。
 * 所以必须在写入新 token **之前**重置，让首个请求以「未选组织」发出，由组织路由
 * 分流按 B 自己的成员关系重新选择。
 */
export function resetSessionContext(queryClient?: QueryClient): void {
	if (typeof window !== "undefined") {
		clearToken();
	}
	// 中止在途流的同时重置聊天运行时态（abortActiveStream 一步完成，评审 R3-I04）
	abortActiveStream();
	useOrganizationStore.getState().resetSession();
	queryClient?.clear();
}

/**
 * 开始新会话（登录 / 注册成功）：**先**结束旧会话上下文，**再**写入新凭证与用户。
 * 顺序即正确性——见 resetSessionContext；表单不要自己拼这三步。
 */
export function beginAuthenticatedSession(input: {
	accessToken: string;
	user: AuthUser;
	queryClient: QueryClient;
}): void {
	const { accessToken, user, queryClient } = input;
	resetSessionContext(queryClient);
	setToken(accessToken);
	useAuthStore.getState().setUser(user);
}
