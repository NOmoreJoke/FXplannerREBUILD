import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 公开路由（无需登录）：落地页、认证页
const PUBLIC_ROUTES = ["/", "/login", "/register"];

// 认证路由（已登录用户不可访问）
const AUTH_ROUTES = ["/login", "/register"];

export function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;

	// 获取 Token（从 cookie 或检查是否有 localStorage 的标记）
	const token = request.cookies.get("accessToken")?.value;

	// 1. 未登录用户访问受保护路由 → 跳转登录页
	if (!token && !PUBLIC_ROUTES.includes(pathname)) {
		const url = new URL("/login", request.url);
		url.searchParams.set("redirect", pathname);
		return NextResponse.redirect(url);
	}

	// 2. 已登录用户访问认证路由 → 跳转公开首页
	if (token && AUTH_ROUTES.includes(pathname)) {
		return NextResponse.redirect(new URL("/", request.url));
	}

	return NextResponse.next();
}

export const config = {
	matcher: [
		/*
		 * 匹配所有路径，除了：
		 * - api (API 路由)
		 * - _next/static (静态文件)
		 * - _next/image (图片优化)
		 * - favicon.ico (网站图标)
		 */
		"/((?!api|_next/static|_next/image|favicon.ico).*)",
	],
};
