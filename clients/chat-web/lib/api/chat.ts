import { captureApiError } from "@/lib/dev-log/monitor";
import {
	ApiError,
	apiClient,
	buildApiUrl,
	consumeOrganizationContextError,
	handleUnauthorized,
	isExpectedControlFlowApiError,
} from "@/lib/api/client";
import type { components } from "@/lib/api/schema.gen";
import { getToken } from "@/lib/auth/token";
import { getActiveOrganizationId } from "@/lib/api/client";

/**
 * AI 助手 API 封装（ai-assistant 技术方案 §4/§5.2）
 *
 * - 会话 CRUD（list/delete）走 apiClient（统一 JSON 包装 / 401 / 403 协议）；
 * - 对话流式走 streamMessage()：后端 SSE 端点持有 res 直写、绕过全局拦截器
 *   （text/event-stream 不适用 JSON 包装），因此 401 清 token / 403 锁定跳转
 *   / 错误体解析必须在此本地复刻（§5.2 注解）。
 *
 * 类型说明：REST 响应与列表项全部取 schema.gen 别名（后端 DTO 为唯一事实），
 * 仅 SSE 帧协议保留本地定义（§4：text/event-stream 帧不进 OpenAPI）。
 */

type Schemas = components["schemas"];

/** 会话列表项（GET /ai/conversations 的 items 项） */
export type AiConversationSummary = Schemas["AiConversationSummaryDto"];

export type AiConversationListData = Schemas["AiConversationListDto"];

/** 消息角色（后端仅落 "user" | "assistant" 两种） */
export type AiMessageRole = Schemas["AiMessageDto"]["role"];

/** 消息（GET /ai/conversations/:id/messages 的 items 项；done 帧 assistantMessage 同形） */
export type AiMessage = Schemas["AiMessageDto"];

export type AiMessageListData = Schemas["AiMessageListDto"];

/** 模型列表项（GET /ai/models 的 items 项，按 costTier 升序）——密钥/baseURL/上游
 * model 名等敏感字段按契约不进响应体（ai-model-whitelist 方案 §4.1） */
export type ChatModelSummary = Schemas["ChatModelSummaryDto"];

export type ModelsListData = Schemas["ChatModelListDto"];

/** SSE token 用量（done 帧；本期仅透传展示来源，前端不持久化） */
export interface AiStreamUsage {
	inputTokens: number;
	outputTokens: number;
}

/**
 * SSE 帧判别联合（§4 帧协议：meta / tool / token / done / error）。
 * 每帧 data 行为 JSON.stringify(完整载荷对象)——delta 含换行时整体转义，
 * 解析后还原为真实换行。
 */
export type AiStreamEvent =
	| {
			type: "meta";
			conversationId: string;
			userMessageId: string;
			title: string;
	  }
	| { type: "tool"; name: string; state: "start" | "end" }
	| { type: "token"; delta: string }
	| {
			type: "done";
			assistantMessage: AiMessage;
			usage: AiStreamUsage;
			/** 本条回复实际使用的白名单 key（服务端 resolve 值，非客户端透传） */
			model: string;
	  }
	| { type: "error"; code: string; message: string };

/** 流式错误码族（§4；HTTP 侧错误经 ApiError.code 携带，此处仅为帧内 code 收敛） */
export type AiStreamErrorCode =
	| "AI_UPSTREAM_FAILED"
	| "AI_CONVERSATION_NOT_FOUND";

export const chatApi = {
	/**
	 * 会话列表（GET /ai/conversations，按 lastMessageAt 倒序；幂等只读）
	 * limit 缺省走后端默认 50（1~100）。
	 */
	async listConversations(limit?: number): Promise<AiConversationListData> {
		const query = limit === undefined ? "" : `?limit=${limit}`;
		return apiClient<AiConversationListData>(`/ai/conversations${query}`, {
			method: "GET",
		});
	},

	/**
	 * 会话消息列表（GET /ai/conversations/:id/messages，按 createdAt 升序；幂等只读）
	 * limit 缺省走后端默认 200（1~500）；非本人/不存在统一 404（防枚举）。
	 */
	async listMessages(
		conversationId: string,
		limit?: number,
	): Promise<AiMessageListData> {
		const query = limit === undefined ? "" : `?limit=${limit}`;
		return apiClient<AiMessageListData>(
			`/ai/conversations/${encodeURIComponent(conversationId)}/messages${query}`,
			{ method: "GET" },
		);
	},

	/**
	 * 模型白名单列表（GET /ai/models，按 costTier 升序；幂等只读）。
	 * 密钥全未配时仍 200 全量返回（可用性在发消息时判定）。
	 */
	async listModels(): Promise<ModelsListData> {
		return apiClient<ModelsListData>("/ai/models", { method: "GET" });
	},

	/**
	 * 删除会话（DELETE /ai/conversations/:id；物理删除，消息级联）
	 * 流进行中 409；非本人/不存在统一 404。成功响应无 data 字段。
	 */
	async deleteConversation(conversationId: string): Promise<void> {
		await apiClient<unknown>(
			`/ai/conversations/${encodeURIComponent(conversationId)}`,
			{ method: "DELETE" },
		);
	},
};

/** streamMessage 入参：conversationId 缺省 = 以首条消息创建会话（POST /ai/conversations） */
export interface StreamMessageParams {
	content: string;
	conversationId?: string;
	/** 白名单模型 key：缺省走服务端默认回退（AI_DEFAULT_CHAT_MODEL） */
	modelKey?: string;
	/** 客户端中断信号：透传 fetch，abort 时 reader 读取以 AbortError 拒绝 */
	signal?: AbortSignal;
}

/**
 * 发起流式对话：POST（SSE）→ 校验响应 → 返回帧迭代器。
 *
 * fetch 与响应校验在本函数内完成（非 2xx / content-type 非 event-stream
 * 按错误协议处理并抛 ApiError），调用方拿到返回值后即可安全迭代帧；
 * 迭代过程中的中断以 AbortError 冒泡（use-chat 捕获区分静默终止）。
 */
export async function streamMessage(
	params: StreamMessageParams,
): Promise<AsyncGenerator<AiStreamEvent, void, unknown>> {
	const response = await openStreamResponse(params);
	return parseSseStream(response.body!);
}

/** 发请求 + 响应校验（401 清凭证、组织上下文失效、403 锁定跳转、非 2xx/非 event-stream → ApiError） */
async function openStreamResponse(
	params: StreamMessageParams,
): Promise<Response> {
	const endpoint = params.conversationId
		? `/ai/conversations/${encodeURIComponent(params.conversationId)}/messages`
		: "/ai/conversations";

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	const token = getToken();
	if (token) {
		headers["Authorization"] = `Bearer ${token}`;
	}
	// 组织上下文头（ToB W20）：AI 会话按 (userId, organizationId) 隔离；
	// 与 apiClient 同源（organization-store），未选组织不注入（兼容窗口后端回落）
	const organizationId = getActiveOrganizationId();
	if (organizationId) {
		headers["X-Organization-Id"] = organizationId;
	}

	let response: Response;
	try {
		// 地址经 buildApiUrl 构造：base 启动时校验、endpoint 仅站内相对路径
		// （此前直接拼接未校验的 env，与 apiClient 的 CWE-918 整改不一致）
		response = await fetch(buildApiUrl(endpoint), {
			method: "POST",
			headers,
			// modelKey 未选择时不进 body（与「缺省走服务端默认」契约对齐，非显式 null）
			body: JSON.stringify({
				content: params.content,
				...(params.modelKey !== undefined
					? { modelKey: params.modelKey }
					: {}),
			}),
			signal: params.signal,
		});
	} catch (error) {
		// 主动中止（切换组织 / 用户点击停止）：属预期控制流，不记为网络故障
		const isAborted =
			params.signal?.aborted === true ||
			(error instanceof Error && error.name === "AbortError");
		if (!isAborted) {
			// 网络层失败（断网 / CORS / 服务不可用）：上报本地开发日志（与 apiClient 对齐）
			captureApiError({
				endpoint,
				method: "POST",
				kind: "network",
				message: error instanceof Error ? error.message : String(error),
			});
		}
		throw error;
	}

	// 401：只清理凭证与组织选择并抛错，跳转统一由保护区 layout 处理（与 apiClient 协议一致）
	if (response.status === 401) {
		handleUnauthorized();
		throw new ApiError("Token 无效或已过期", 401);
	}

	// 组织上下文失效（400 ORGANIZATION_REQUIRED / 404 ORGANIZATION_NOT_FOUND）：
	// 与 apiClient 同一处理，按**发起流时携带的组织**判定（评审 I-18）——此前 SSE
	// 路径完全漏掉，被移出组织的用户只会看到一句报错，选择却不会被纠正
	const orgError = await consumeOrganizationContextError(
		response,
		organizationId ?? null,
	);
	if (orgError) {
		throw orgError;
	}

	// 403 数据请求锁（account-data 方案 §8）：与 apiClient 同一跳转协议
	if (
		response.status === 403 &&
		typeof window !== "undefined" &&
		!window.location.pathname.startsWith("/data-requests")
	) {
		const lockError = await response
			.clone()
			.json()
			.catch(() => ({}) as { code?: string });
		if (
			lockError.code === "DATA_REQUEST_LOCKED" ||
			lockError.code === "ACCOUNT_PENDING_DELETION"
		) {
			window.location.href = "/data-requests";
		}
	}

	const contentType = response.headers.get("content-type") ?? "";
	const isEventStream = contentType.includes("text/event-stream");
	if (!response.ok || !isEventStream) {
		// 错误体统一 { code, message }；网关非 JSON（HTML 502 等）回落默认文案
		const errorBody = await response
			.json()
			.catch(() => ({}) as { code?: string; message?: string });
		if (!isExpectedControlFlowApiError(response.status, errorBody.code)) {
			captureApiError({
				endpoint,
				method: "POST",
				kind: "http",
				status: response.status,
				message: errorBody.message ?? "请求失败",
			});
		}
		throw new ApiError(
			errorBody.message ?? "请求失败",
			response.status,
			errorBody.code,
			errorBody as Record<string, unknown>,
		);
	}

	return response;
}

/**
 * SSE 帧解析器（§8.1 前端最高风险点的专属单测对象）
 *
 * 解析规则（§4 序列化规则）：
 * - 行分隔兼容 \n 与 \r\n；空行 = 帧结束（dispatch）；
 * - `event: <name>` / `data: <payload>`，冒号后单个空格按规范剥除；
 * - data 行 JSON.parse 整包载荷——delta 换行为转义 `\n`，解析后还原；
 * - 多个 data 行按 SSE 规范以 \n 拼接（后端当前单行，防御性兼容）；
 * - `:` 开头为注释行、未知 event 名、JSON 解析失败：一律跳过不断流
 *   （对服务端未来新增帧类型向前兼容）；
 * - 流结束（服务端 done/error 后 res.end()）后 flush 残余缓冲兜底。
 */
export function parseSseStream(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<AiStreamEvent, void, unknown> {
	async function* iterate(): AsyncGenerator<AiStreamEvent, void, unknown> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let eventName = "";
		let dataLines: string[] = [];

		const dispatchFrame = () => {
			if (dataLines.length === 0) return;
			const raw = dataLines.join("\n");
			try {
				const payload = JSON.parse(raw) as Record<string, unknown>;
				const event = toStreamEvent(eventName, payload);
				if (event) queue.push(event);
			} catch {
				// 畸形 data 行（违反整包 JSON 契约）：跳过该帧，不影响后续帧
			}
		};

		// generator 内无法直接 yield 出辅助闭包，用队列中转：
		// 行处理同步产出事件，主循环消费后 yield
		const queue: AiStreamEvent[] = [];
		const handleLine = (line: string) => {
			if (line === "") {
				dispatchFrame();
				eventName = "";
				dataLines = [];
				return;
			}
			if (line.startsWith(":")) return; // 注释行
			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1); // 规范：剥除单个前导空格
			if (field === "event") {
				eventName = value;
			} else if (field === "data") {
				dataLines.push(value);
			}
			// id:/retry: 等其他字段忽略
		};

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				let boundary = buffer.search(/\r?\n/);
				while (boundary !== -1) {
					const line = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary).replace(/^\r?\n/, "");
					handleLine(line);
					while (queue.length > 0) {
						yield queue.shift()!;
					}
					boundary = buffer.search(/\r?\n/);
				}
			}
			// 流结束：flush 多字节解码残余与无换行结尾的尾帧（服务端保证 \n\n 收尾，此为兜底）
			buffer += decoder.decode();
			if (buffer !== "") {
				handleLine(buffer);
			}
			dispatchFrame();
			eventName = "";
			dataLines = [];
			while (queue.length > 0) {
				yield queue.shift()!;
			}
		} finally {
			// 中断/提前退出：释放底层流（防连接泄漏；abort 时 cancel 以 AbortError 拒绝由调用方感知）
			void reader.cancel().catch(() => {});
		}
	}

	return iterate();
}

/** 帧载荷 → AiStreamEvent；未知 event 名返回 undefined（跳过，向前兼容） */
function toStreamEvent(
	eventName: string,
	payload: Record<string, unknown>,
): AiStreamEvent | undefined {
	switch (eventName) {
		case "meta":
			return {
				type: "meta",
				conversationId: String(payload.conversationId ?? ""),
				userMessageId: String(payload.userMessageId ?? ""),
				title: String(payload.title ?? ""),
			};
		case "tool":
			return {
				type: "tool",
				name: String(payload.name ?? ""),
				state: payload.state === "end" ? "end" : "start",
			};
		case "token":
			return { type: "token", delta: String(payload.delta ?? "") };
		case "done":
			return {
				type: "done",
				assistantMessage: payload.assistantMessage as AiMessage,
				usage: payload.usage as AiStreamUsage,
				model: payload.model as string,
			};
		case "error":
			return {
				type: "error",
				code: String(payload.code ?? ""),
				message: String(payload.message ?? ""),
			};
		default:
			return undefined;
	}
}
