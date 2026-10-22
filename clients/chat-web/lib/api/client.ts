import { captureApiError } from "@/lib/dev-log/monitor";
import { clearToken, getToken } from "@/lib/auth/token";

// 从环境变量读取后端 API 地址（必需）。
// 仅允许 http/https 且不携带用户名/密码的地址，防止配置被注入成
// 其他协议或带凭据的 URL（CWE-918 整改：校验后再进入 fetch）。
function resolveApiBaseUrl(): string {
	const raw = process.env.NEXT_PUBLIC_API_BASE_URL;
	if (!raw) {
		throw new Error(
			"环境变量 NEXT_PUBLIC_API_BASE_URL 未设置，请确保已加载 .env.local",
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`NEXT_PUBLIC_API_BASE_URL 不是合法 URL：${raw}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(
			`NEXT_PUBLIC_API_BASE_URL 仅允许 http/https 协议，当前为 ${parsed.protocol}`,
		);
	}
	if (parsed.username || parsed.password) {
		throw new Error("NEXT_PUBLIC_API_BASE_URL 不允许携带用户名/密码");
	}
	return parsed.toString().replace(/\/+$/, "");
}
const API_BASE_URL = resolveApiBaseUrl();

interface RequestConfig extends RequestInit {
	skipAuth?: boolean;
}

interface ApiResponse<T> {
	data: T;
	message?: string;
}

/** 后端错误响应体（统一 { code, message }，如 plan 模块的 400/409 错误码） */
interface ApiErrorBody {
	code?: string;
	message?: string;
}

/** 带状态码与业务错误码的 API 错误（instanceof Error，不影响既有 catch 逻辑） */
export class ApiError extends Error {
	readonly status: number;
	readonly code?: string;
	/** 解析出的错误响应体（供消费方读取 code/message 之外的增量字段，如 502 的 lastObservedAt） */
	readonly body?: Record<string, unknown>;

	constructor(
		message: string,
		status: number,
		code?: string,
		body?: Record<string, unknown>,
	) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.body = body;
	}
}

export async function apiClient<T>(
	endpoint: string,
	config: RequestConfig = {},
): Promise<T> {
	const { skipAuth = false, ...fetchConfig } = config;

	// endpoint 只允许站内相对路径：拒绝绝对 URL 与协议相对 URL，
	// 防止调用方把请求转发到外部主机（CWE-918 整改）。
	if (typeof endpoint !== "string" || !endpoint.startsWith("/")) {
		throw new Error(`endpoint 必须是以 / 开头的相对路径：${endpoint}`);
	}
	if (endpoint.startsWith("//")) {
		throw new Error(`endpoint 不允许是协议相对 URL：${endpoint}`);
	}

	// 自动添加 Authorization Header
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...(config.headers as Record<string, string>),
	};

	if (!skipAuth && typeof window !== "undefined") {
		const token = getToken();
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

	// 处理 401 错误：只清理凭证并抛错，不做页面跳转（跳转统一由保护区 layout 处理）
	if (response.status === 401) {
		if (typeof window !== "undefined") {
			clearToken();
		}
		throw new ApiError("Token 无效或已过期", 401);
	}

	// 处理数据请求锁（account-data 技术方案 §8）：注销/清空处理中访问业务端点
	// → 统一跳转进度页，实现「登录只进进度页」与强制下线体验
	if (
		response.status === 403 &&
		typeof window !== "undefined" &&
		!window.location.pathname.startsWith("/data-requests")
	) {
		const lockError = await response
			.clone()
			.json()
			.catch(() => ({}) as ApiErrorBody);
		if (
			lockError.code === "DATA_REQUEST_LOCKED" ||
			lockError.code === "ACCOUNT_PENDING_DELETION"
		) {
			window.location.href = "/data-requests";
		}
	}

	if (!response.ok) {
		const error = await response
			.json()
			.catch(() => ({ message: "请求失败" }) as ApiErrorBody);
		// HTTP 错误（4xx/5xx，401 除外）：上报本地开发日志
		captureApiError({
			endpoint,
			method,
			kind: "http",
			status: response.status,
			message: error.message || "请求失败",
		});
		throw new ApiError(
			error.message || "请求失败",
			response.status,
			error.code,
			error as Record<string, unknown>,
		);
	}

	const result: ApiResponse<T> = await response.json();
	return result.data;
}
