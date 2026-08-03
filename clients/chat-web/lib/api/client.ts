import { captureApiError } from "@/lib/dev-log/monitor";

// 从环境变量读取后端 API 地址（必需）
if (!process.env.NEXT_PUBLIC_API_BASE_URL) {
	throw new Error(
		"环境变量 NEXT_PUBLIC_API_BASE_URL 未设置，请确保已加载 .env.local",
	);
}
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

interface RequestConfig extends RequestInit {
	skipAuth?: boolean;
}

interface ApiResponse<T> {
	data: T;
	message?: string;
}

export async function apiClient<T>(
	endpoint: string,
	config: RequestConfig = {},
): Promise<T> {
	const { skipAuth = false, ...fetchConfig } = config;

	// 自动添加 Authorization Header
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...(config.headers as Record<string, string>),
	};

	if (!skipAuth && typeof window !== "undefined") {
		const token = localStorage.getItem("accessToken");
		if (token) {
			headers["Authorization"] = `Bearer ${token}`;
		}
	}

	const method = (fetchConfig.method ?? "GET").toUpperCase();

	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}${endpoint}`, {
			...fetchConfig,
			headers,
		});
	} catch (error) {
		// 网络层失败（断网 / CORS / 服务不可用）：上报本地开发日志
		captureApiError({
			endpoint,
			method,
			kind: "network",
			message: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}

	// 处理 401 错误
	if (response.status === 401) {
		if (typeof window !== "undefined") {
			localStorage.removeItem("accessToken");
			// 清除 Cookie
			document.cookie = "accessToken=; path=/; max-age=0";
			window.location.replace("/login");
		}
		throw new Error("Token 无效或已过期");
	}

	if (!response.ok) {
		const error = await response.json().catch(() => ({ message: "请求失败" }));
		// HTTP 错误（4xx/5xx，401 除外）：上报本地开发日志
		captureApiError({
			endpoint,
			method,
			kind: "http",
			status: response.status,
			message: error.message || "请求失败",
		});
		throw new Error(error.message || "请求失败");
	}

	const result: ApiResponse<T> = await response.json();
	return result.data;
}
