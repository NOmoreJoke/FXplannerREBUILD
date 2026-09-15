/**
 * 跳转登录页的统一出口（带防重复跳转保护）
 *
 * 认证失败（getMe 401 / 无 token / 登出）时统一走本函数，
 * 避免 layout 与 apiClient 各自跳转产生双重跳转竞争。
 * 使用硬导航：token 失效后应用状态不可信，重载页面以重置全部客户端状态。
 */
let redirecting = false;

export function resetRedirectToLoginForTest(): void {
	redirecting = false;
}

export function redirectToLogin(currentPath: string): void {
	if (typeof window === "undefined") return;
	if (redirecting) return;
	// 已在登录页则不再跳转（防重复）
	if (window.location.pathname === "/login") return;
	redirecting = true;
	window.location.assign(
		`/login?redirect=${encodeURIComponent(currentPath)}`,
	);
}
