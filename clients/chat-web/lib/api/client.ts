import { captureApiError } from "@/lib/dev-log/monitor";
import { getToken } from "@/lib/auth/token";
import { resetSessionContext } from "@/lib/auth/session-reset";
import { useOrganizationStore } from "@/lib/stores/organization-store";

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

/**
 * 站内 API 地址构造的唯一出口（绕过 apiClient 的 fetch——SSE 流、文件下载——必须经此）：
 * base 是启动时校验过的 API_BASE_URL（仅 http/https、无凭据），endpoint 只允许
 * 以单个 / 开头的相对路径，调用方无法把请求引向其他主机（CWE-918）。
 */
export function buildApiUrl(endpoint: string): string {
	if (typeof endpoint !== "string" || !endpoint.startsWith("/")) {
		throw new Error(`endpoint 必须是以 / 开头的相对路径：${endpoint}`);
	}
	if (endpoint.startsWith("//")) {
		throw new Error(`endpoint 不允许是协议相对 URL：${endpoint}`);
	}
	return `${API_BASE_URL}${endpoint}`;
}

interface RequestConfig extends RequestInit {
	skipAuth?: boolean;
	/**
	 * 个人域端点（/settings/personal、/data-requests/*）：不注入 X-Organization-Id。
	 * 个人数据权利与组织无关——0 组织 / 多组织未选 / 个人注销锁定用户都必须可达，
	 * 请求不得依赖组织选择；组织上下文失效处理也随之跳过（个人端点不解析组织）。
	 */
	skipOrganizationScope?: boolean;
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

/**
 * 数据请求进度页地址（双锁重定向的**唯一**目的地）。
 * 必须保持纯路径：不得拼接 ?scope= 之类的查询参数——E2E（12-account-data）按
 * `${BASE_URL}/data-requests` 精确匹配，且个人/组织两个进度分区同页展示、无需参数分流。
 */
export const DATA_REQUESTS_PAGE_PATH = "/data-requests";

/**
 * 数据请求锁错误码（W27 双锁守卫）：
 * - ORGANIZATION_DATA_LOCKED：当前组织账本清空/删除处理中（只锁当前组织）；
 * - ACCOUNT_PENDING_DELETION：本人账号注销处理中（只锁本人）；
 * - DATA_REQUEST_LOCKED：W27 之前单一守卫的合并锁码，后端已不再产出，仅为兼容保留。
 */
export function isDataRequestLockCode(code: string | undefined): boolean {
	return (
		code === "ORGANIZATION_DATA_LOCKED" ||
		code === "ACCOUNT_PENDING_DELETION" ||
		code === "DATA_REQUEST_LOCKED"
	);
}

/**
 * 数据请求锁的统一处理（apiClient 与 SSE 封装共用，二者只应有一份语义）：
 * 命中锁错误码且当前不在进度页 → 整页跳转纯 /data-requests。
 *
 * 两把锁的差别不在跳转目标，而在组织选择的去留（W28）：
 * - ACCOUNT_PENDING_DELETION：个人域进度不依赖组织，/data-requests 对 0 组织 /
 *   多组织未选同样放行（isOrglessRouteAllowed），随时可查看与撤回个人注销；
 * - ORGANIZATION_DATA_LOCKED：**不清空** activeOrganizationId——锁只针对当前组织，
 *   保留选择后侧栏切换器仍可切到未锁定的其他组织。
 * 本函数因此不触碰 organization-store。
 *
 * @returns 是否命中数据请求锁（未命中时响应体未被消费，调用方照常走错误解析）
 */
export async function consumeDataRequestLock(
	response: Response,
): Promise<boolean> {
	if (response.status !== 403 || typeof window === "undefined") return false;
	const body = await response
		.clone()
		.json()
		.catch(() => ({}) as ApiErrorBody);
	if (!isDataRequestLockCode(body.code)) return false;
	if (!window.location.pathname.startsWith(DATA_REQUESTS_PAGE_PATH)) {
		window.location.href = DATA_REQUESTS_PAGE_PATH;
	}
	return true;
}

/**
 * 预期业务控制流 HTTP 响应不记为 dev-log 错误事件（DEBT-06）——六种语义，状态码与
 * 错误码须同时匹配（同码配错的状态码不算预期控制流，照常上报）：
 * - 409 ONBOARDING_NOT_COMPLETED：首次建账前门控/降级语义
 * - 403 ORGANIZATION_DATA_LOCKED / ACCOUNT_PENDING_DELETION：双锁守卫重定向进度页语义
 *   （ORGANIZATION_DATA_LOCKED = 当前组织账本清空/删除处理中；ACCOUNT_PENDING_DELETION = 本人账号注销处理中）
 * - 403 PERMISSION_DENIED：角色无对应权限点（后端拒绝了一次越权写，前端门控的兜底）
 * - 400 ORGANIZATION_REQUIRED / 404 ORGANIZATION_NOT_FOUND：ToB 组织上下文语义
 *   （选择失效/权限变化由组织路由层接管，W20）
 */
export function isExpectedControlFlowApiError(
	status: number,
	code?: string,
): boolean {
	if (status === 409 && code === "ONBOARDING_NOT_COMPLETED") return true;
	if (status === 403 && isDataRequestLockCode(code)) return true;
	if (status === 403 && code === "PERMISSION_DENIED") return true;
	if (status === 400 && code === "ORGANIZATION_REQUIRED") return true;
	if (status === 404 && code === "ORGANIZATION_NOT_FOUND") return true;
	return false;
}

/**
 * 读取当前组织头值（ToB W20）：业务端点统一注入 X-Organization-Id；
 * 未选择组织（null）不注入——兼容窗口由后端回落唯一默认组织
 * （多组织用户会收到 400 ORGANIZATION_REQUIRED → 组织选择引导）。
 */
export function getActiveOrganizationId(): string | null {
	return useOrganizationStore.getState().activeOrganizationId;
}

/** 组织上下文失效错误码（400 未选/多组织未带头；404 选中组织已不可访问） */
function isOrganizationContextError(status: number, code?: string): boolean {
	return (
		(status === 400 && code === "ORGANIZATION_REQUIRED") ||
		(status === 404 && code === "ORGANIZATION_NOT_FOUND")
	);
}

/**
 * 处理组织上下文失效响应（ToB W20；技术方案 §10.1）。SSE 流与文件下载绕过
 * apiClient，与这里共用本函数。
 *
 * 评审 I-18：
 * - 仅当「发请求时携带的组织」仍是「当前选中的组织」才清除选择——旧组织的
 *   迟到响应不得清掉用户刚切换到的新组织；被拒绝的组织一律记入会话级拒绝
 *   集合，路由分流的自动选中不再选它（防「清除 → 自动选回 → 再 404」循环）；
 * - 不做硬跳转：选择清空后，受保护区 layout 的组织路由分流自动进入选择态。
 *
 * @returns 命中组织上下文失效时返回待抛出的 ApiError，否则返回 null
 */
export async function consumeOrganizationContextError(
	response: Response,
	sentOrganizationId: string | null,
): Promise<ApiError | null> {
	if (response.status !== 400 && response.status !== 404) return null;
	const body = await response
		.clone()
		.json()
		.catch(() => ({}) as ApiErrorBody);
	if (!isOrganizationContextError(response.status, body.code)) return null;
	useOrganizationStore.getState().rejectOrganizationContext(sentOrganizationId);
	return new ApiError(
		body.message || "组织上下文失效，请重新选择组织",
		response.status,
		body.code,
		body as Record<string, unknown>,
	);
}

/**
 * 401：凭证与会话上下文一并清除（评审 R2-I10）——换账号登录不得继承上一个账号的
 * 组织选择、会话级拒绝集合、在途 SSE 流与聊天运行时态。统一走 resetSessionContext。
 * 查询缓存不在此清：401 之后经整页跳转进入登录页，内存态随页面重载消失；登录成功时
 * resetSessionContext 还会再清一次。不做页面跳转（跳转统一由保护区 layout 处理）。
 */
export function handleUnauthorized(): void {
	resetSessionContext();
}

export async function apiClient<T>(
	endpoint: string,
	config: RequestConfig = {},
): Promise<T> {
	const {
		skipAuth = false,
		skipOrganizationScope = false,
		...fetchConfig
	} = config;

	// endpoint 只允许站内相对路径：拒绝绝对 URL 与协议相对 URL，
	// 防止调用方把请求转发到外部主机（CWE-918 整改；校验在 buildApiUrl 内）。
	// 置于网络 try 之外：校验失败是调用方缺陷，不记为网络层错误。
	const url = buildApiUrl(endpoint);

	// 自动添加 Authorization Header
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...(config.headers as Record<string, string>),
	};

	/** 实际注入的组织头（组织上下文失效处理据此判断是否仍为当前选择） */
	let sentOrganizationId: string | null = null;

	if (!skipAuth && typeof window !== "undefined") {
		const token = getToken();
		if (token) {
			headers["Authorization"] = `Bearer ${token}`;
		}
		// 组织上下文头（ToB W20）：已有选中组织时对业务请求注入；
		// 个人域端点显式 skipOrganizationScope——请求不带组织头，也不参与组织上下文失效处理
		// （个人数据权利不得依赖组织选择，W28）。其余个人端点（/auth、/organizations、
		// 邀请 token 端点）后端不读此头，沿用注入
		if (!skipOrganizationScope) {
			sentOrganizationId = getActiveOrganizationId();
			if (sentOrganizationId) {
				headers["X-Organization-Id"] = sentOrganizationId;
			}
		}
	}

	const method = (fetchConfig.method ?? "GET").toUpperCase();

	let response: Response;
	try {
		response = await fetch(url, {
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

	// 处理 401 错误：只清理凭证与组织选择并抛错，不做页面跳转（跳转统一由保护区 layout 处理）
	if (response.status === 401) {
		handleUnauthorized();
		throw new ApiError("Token 无效或已过期", 401);
	}

	// 组织上下文失效处理（评审 I-18，逻辑见 consumeOrganizationContextError）
	const orgError = await consumeOrganizationContextError(
		response,
		sentOrganizationId,
	);
	if (orgError) {
		throw orgError;
	}

	// 处理数据请求锁（account-data 技术方案 §8）：注销/清空处理中访问业务端点
	// → 统一跳转进度页，实现「登录只进进度页」与强制下线体验。
	// 组织锁不清空组织选择（保留切换到其他组织的能力），语义见 consumeDataRequestLock
	await consumeDataRequestLock(response);

	if (!response.ok) {
		const error = await response
			.json()
			.catch(() => ({ message: "请求失败" }) as ApiErrorBody);
		// HTTP 错误（401 及预期控制流 409/403 除外）：上报本地开发日志
		if (!isExpectedControlFlowApiError(response.status, error.code)) {
			captureApiError({
				endpoint,
				method,
				kind: "http",
				status: response.status,
				message: error.message || "请求失败",
			});
		}
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
