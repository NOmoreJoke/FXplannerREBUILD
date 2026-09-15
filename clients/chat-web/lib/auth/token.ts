/**
 * accessToken 存取（cookie 唯一事实来源）
 *
 * - 与 proxy.ts（边缘守卫）共享同一 cookie，消灭 localStorage/cookie 双存储分叉
 * - JWT 仅含 [A-Za-z0-9-_.]，无需 encodeURIComponent，直接写 cookie 值
 * - 有效期 7 天，与后端 JWT 签发有效期一致
 */
const TOKEN_COOKIE_NAME = "accessToken";
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

/** 写入 token cookie（path=/，max-age 7 天，SameSite=Lax；https 下附加 Secure） */
export function setToken(token: string): void {
	if (typeof document === "undefined") return;
	const secure = window.location.protocol === "https:" ? "; Secure" : "";
	document.cookie = `${TOKEN_COOKIE_NAME}=${token}; path=/; max-age=${SEVEN_DAYS_SECONDS}; SameSite=Lax${secure}`;
}

/** 读取 token cookie；不存在或不在浏览器环境时返回 null */
export function getToken(): string | null {
	if (typeof document === "undefined") return null;
	const match = document.cookie.match(
		/(?:^|;\s*)accessToken=([^;]*)/,
	);
	return match ? match[1] : null;
}

/** 清除 token cookie（立即过期） */
export function clearToken(): void {
	if (typeof document === "undefined") return;
	document.cookie = `${TOKEN_COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax`;
}
