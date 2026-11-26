import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	parseSseStream,
	streamMessage,
	type AiStreamEvent,
} from "@/lib/api/chat";
import {
	consumeDataRequestLock,
	consumeOrganizationContextError,
	getActiveOrganizationId,
	ApiError,
} from "@/lib/api/client";
import { clearToken, getToken } from "@/lib/auth/token";
import { captureApiError } from "@/lib/dev-log/monitor";

// 真实 client.ts 顶层校验 NEXT_PUBLIC_API_BASE_URL（测试环境不存在），mock 掉；
// 类定义须置于工厂内（vi.mock 被提升），被测模块与本文件拿到的 ApiError
// 即同一 mock 类，instanceof 断言成立。构造签名与真实类一致。
// 地址构造 / 组织上下文失效 / 401 / 双锁跳转的真实逻辑在 client.spec 覆盖；这里保持协议形状：
// handleUnauthorized 复刻「清 token」一侧（401 用例据此断言），
// consumeDataRequestLock 复刻「命中锁 → 纯 /data-requests」一侧（本文件只验证 chat.ts 的接线）。
vi.mock("@/lib/api/client", async () => {
	class MockApiError extends Error {
		constructor(
			message: string,
			readonly status: number,
			readonly code?: string,
			readonly body?: Record<string, unknown>,
		) {
			super(message);
			this.name = "ApiError";
		}
	}
	const { clearToken } = await import("@/lib/auth/token");
	return {
		ApiError: MockApiError,
		apiClient: vi.fn(),
		// ToB W20：chat.ts 经此读取组织头值（未选组织返回 null = 不注入）
		getActiveOrganizationId: vi.fn(() => null),
		buildApiUrl: (endpoint: string) => `http://api.test${endpoint}`,
		consumeOrganizationContextError: vi.fn(async () => null),
		handleUnauthorized: vi.fn(() => {
			clearToken();
		}),
		// Goal #3B W28：与 apiClient 共用的双锁处理（组织数据锁 / 个人账号锁）
		consumeDataRequestLock: vi.fn(async (response: Response) => {
			if (response.status !== 403) return false;
			const body = (await response
				.clone()
				.json()
				.catch(() => ({}))) as { code?: string };
			if (
				body.code !== "DATA_REQUEST_LOCKED" &&
				body.code !== "ACCOUNT_PENDING_DELETION" &&
				body.code !== "ORGANIZATION_DATA_LOCKED"
			) {
				return false;
			}
			if (!window.location.pathname.startsWith("/data-requests")) {
				window.location.href = "/data-requests";
			}
			return true;
		}),
		isExpectedControlFlowApiError: (status: number, code?: string) =>
			(status === 409 && code === "ONBOARDING_NOT_COMPLETED") ||
			(status === 403 &&
				(code === "DATA_REQUEST_LOCKED" ||
					code === "ACCOUNT_PENDING_DELETION" ||
					code === "ORGANIZATION_DATA_LOCKED" ||
					code === "PERMISSION_DENIED")),
	};
});

vi.mock("@/lib/auth/token", () => ({
	getToken: vi.fn(() => "tok-123"),
	clearToken: vi.fn(),
}));

vi.mock("@/lib/dev-log/monitor", () => ({ captureApiError: vi.fn() }));

/** 按帧协议构造一段 SSE 文本（event 行 + data 整包 JSON + 空行） */
const frame = (event: string, data: unknown): string =>
	`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** 把文本段构造成异步分块下发的流（每块一个 tick，模拟网络 chunk 边界） */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			controller.close();
		},
	});
}

async function collect(
	gen: AsyncGenerator<AiStreamEvent, void, unknown>,
): Promise<AiStreamEvent[]> {
	const events: AiStreamEvent[] = [];
	for await (const event of gen) {
		events.push(event);
	}
	return events;
}

const metaFrame = frame("meta", {
	conversationId: "conv-1",
	userMessageId: "msg-u1",
	title: "你好呀世界",
});
const doneFrame = frame("done", {
	assistantMessage: {
		id: "msg-a1",
		role: "assistant",
		content: "完整回复",
		createdAt: "2026-02-22T00:00:00.000Z",
		model: "gpt-5.5",
	},
	usage: { inputTokens: 12, outputTokens: 34 },
	model: "gpt-5.5",
});

describe("parseSseStream（SSE 帧解析器，§8.1 专属单测）", () => {
	it("基本帧序：meta → token* → done 依次产出，载荷字段完整", async () => {
		const body = streamFromChunks([
			metaFrame +
				frame("token", { delta: "你" }) +
				frame("token", { delta: "好" }) +
				doneFrame,
		]);
		const events = await collect(parseSseStream(body));

		expect(events).toEqual([
			{
				type: "meta",
				conversationId: "conv-1",
				userMessageId: "msg-u1",
				title: "你好呀世界",
			},
			{ type: "token", delta: "你" },
			{ type: "token", delta: "好" },
			{
				type: "done",
				assistantMessage: {
					id: "msg-a1",
					role: "assistant",
					content: "完整回复",
					createdAt: "2026-02-22T00:00:00.000Z",
					model: "gpt-5.5",
				},
				usage: { inputTokens: 12, outputTokens: 34 },
				model: "gpt-5.5",
			},
		]);
	});

	it("跨 chunk 帧边界与半帧：一帧被切成三段（event 行断开 / data 值内断开 / 空行断开）仍正确产出", async () => {
		const oneFrame = frame("token", { delta: "流式传输" });
		// 切点：event 行中间、data JSON 字符串值中间、帧尾空行前
		const cut1 = oneFrame.indexOf("token") + 2;
		const cut2 = oneFrame.indexOf("流式") + 1;
		const body = streamFromChunks([
			oneFrame.slice(0, cut1),
			oneFrame.slice(cut1, cut2),
			oneFrame.slice(cut2),
		]);
		const events = await collect(parseSseStream(body));
		expect(events).toEqual([{ type: "token", delta: "流式传输" }]);
	});

	it("CRLF 行尾与跨 chunk 的 \r\n 拆分（\r 与 \n 分落两个 chunk）均按帧边界处理", async () => {
		const crlf = frame("tool", { name: "query_exchange_rate", state: "start" })
			.split("\n")
			.join("\r\n");
		const tail = frame("token", { delta: "ok" });
		// CRLF 帧整体 + \r 在前一 chunk 末尾、\n 在下一 chunk 开头的拆分
		const body = streamFromChunks([
			crlf.slice(0, -2) + "\r",
			"\n" + tail.replaceAll("\n", "\r\n"),
		]);
		const events = await collect(parseSseStream(body));
		expect(events).toEqual([
			{ type: "tool", name: "query_exchange_rate", state: "start" },
			{ type: "token", delta: "ok" },
		]);
	});

	it("data 行 JSON 载荷含换行：转义 \\n 解析后还原为真实换行（跨行 delta 不裂帧）", async () => {
		const body = streamFromChunks([
			frame("token", { delta: "第一行\n第二行\n\n尾部" }),
		]);
		const events = await collect(parseSseStream(body));
		expect(events).toEqual([
			{ type: "token", delta: "第一行\n第二行\n\n尾部" },
		]);
	});

	it("error 帧产出且流正常结束；未知 event 名帧跳过不断流", async () => {
		const body = streamFromChunks([
			frame("token", { delta: "前半" }),
			frame("future_frame", { whatever: true }),
			frame("error", {
				code: "AI_UPSTREAM_FAILED",
				message: "回复生成失败，请稍后重试",
			}),
		]);
		const events = await collect(parseSseStream(body));
		expect(events).toEqual([
			{ type: "token", delta: "前半" },
			{
				type: "error",
				code: "AI_UPSTREAM_FAILED",
				message: "回复生成失败，请稍后重试",
			},
		]);
	});

	it("畸形 data 行（违反整包 JSON 契约）：跳过该帧，后续帧不受影响", async () => {
		const body = streamFromChunks([
			"event: token\ndata: {broken json\n\n" +
				frame("token", { delta: "恢复" }),
		]);
		const events = await collect(parseSseStream(body));
		expect(events).toEqual([{ type: "token", delta: "恢复" }]);
	});

	it("只有 event 行没有 data 行的空帧不产出；注释行（: 开头）忽略", async () => {
		const body = streamFromChunks([
			": keep-alive ping\n\n" +
				"event: token\n\n" +
				frame("token", { delta: "有效" }),
		]);
		const events = await collect(parseSseStream(body));
		expect(events).toEqual([{ type: "token", delta: "有效" }]);
	});

	it("流结束时无换行结尾的尾帧被 flush 兜底产出", async () => {
		const body = streamFromChunks(['event: token\ndata: {"delta":"尾帧"}']);
		const events = await collect(parseSseStream(body));
		expect(events).toEqual([{ type: "token", delta: "尾帧" }]);
	});

	it("消费方提前中断迭代：底层流被 cancel（finally 释放）", async () => {
		// reader.cancel() 委托到流的 cancel 算法，须挂 source 级 cancel 钩子才能监听
		const encoder = new TextEncoder();
		const cancelSpy = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(frame("token", { delta: "a" })));
				controller.enqueue(encoder.encode(frame("token", { delta: "b" })));
			},
			cancel: cancelSpy,
		});
		const gen = parseSseStream(body);
		await gen.next(); // 只消费第一帧
		await gen.return();
		expect(cancelSpy).toHaveBeenCalled();
	});
});

describe("streamMessage（fetch + 响应校验协议）", () => {
	const fetchMock = vi.fn();

	const mockResponse = (
		options: {
			status?: number;
			contentType?: string | null;
			body?: ReadableStream<Uint8Array>;
			jsonBody?: unknown;
		} = {},
	): Response =>
		({
			status: options.status ?? 200,
			ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
			headers: {
				get: (name: string) =>
					name.toLowerCase() === "content-type"
						? (options.contentType ?? null)
						: null,
			},
			body: options.body ?? null,
			json: vi.fn().mockResolvedValue(options.jsonBody ?? {}),
			clone() {
				return this;
			},
		}) as unknown as Response;

	beforeEach(() => {
		vi.clearAllMocks();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
		// jsdom location 替换：实现读取 pathname 并向 href 赋值（锁定跳转协议）
		Object.defineProperty(window, "location", {
			value: { href: "", pathname: "/chat" },
			writable: true,
			configurable: true,
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("追问：POST /ai/conversations/{id}/messages，携带 Authorization 与 JSON body，流帧可迭代", async () => {
		fetchMock.mockResolvedValue(
			mockResponse({
				contentType: "text/event-stream; charset=utf-8",
				body: streamFromChunks([
					metaFrame + frame("token", { delta: "答" }) + doneFrame,
				]),
			}),
		);

		const events = await collect(
			await streamMessage({
				conversationId: "conv-9",
				content: "现在美元兑日元是多少？",
			}),
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/ai/conversations/conv-9/messages");
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({
			"Content-Type": "application/json",
			Authorization: "Bearer tok-123",
		});
		expect(init.body).toBe(
			JSON.stringify({ content: "现在美元兑日元是多少？" }),
		);
		expect(events.map((event) => event.type)).toEqual([
			"meta",
			"token",
			"done",
		]);
	});

	it("新建会话：conversationId 缺省时 POST /ai/conversations（不带 id 段）", async () => {
		fetchMock.mockResolvedValue(
			mockResponse({
				contentType: "text/event-stream",
				body: streamFromChunks([metaFrame]),
			}),
		);
		await collect(await streamMessage({ content: "你好" }));
		const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/ai/conversations");
		expect(url).not.toContain("/ai/conversations/");
	});

	it("modelKey 已选择时进 body；未选择时不进 body（缺省走服务端默认）", async () => {
		const sseResponse = () =>
			mockResponse({
				contentType: "text/event-stream",
				body: streamFromChunks([metaFrame]),
			});
		// 两次请求各用独立 Response（同一 body 流二次 getReader 会锁定报错）
		fetchMock.mockResolvedValueOnce(sseResponse());
		await collect(
			await streamMessage({ content: "你好", modelKey: "gpt-5.5" }),
		);
		fetchMock.mockResolvedValueOnce(sseResponse());
		await collect(await streamMessage({ content: "你好" }));
		const [, init1] = fetchMock.mock.calls[0] as [string, RequestInit];
		const [, init2] = fetchMock.mock.calls[1] as [string, RequestInit];
		expect(init1.body).toBe(
			JSON.stringify({ content: "你好", modelKey: "gpt-5.5" }),
		);
		expect(init2.body).toBe(JSON.stringify({ content: "你好" }));
	});

	it("非 2xx JSON 错误体：抛 ApiError（status/code/message 透传）", async () => {
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 409,
				contentType: "application/json",
				jsonBody: {
					code: "AI_CONVERSATION_BUSY",
					message: "该会话正在回复中，请稍候",
				},
			}),
		);
		await expect(
			streamMessage({ conversationId: "conv-1", content: "追问" }),
		).rejects.toMatchObject({
			name: "ApiError",
			status: 409,
			code: "AI_CONVERSATION_BUSY",
			message: "该会话正在回复中，请稍候",
		});
		expect(captureApiError).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "http", status: 409 }),
		);
	});

	it("非 2xx 非 JSON（网关 HTML 502）：回落默认文案的 ApiError", async () => {
		fetchMock.mockResolvedValue(
			mockResponse({ status: 502, contentType: "text/html" }),
		);
		await expect(
			streamMessage({ conversationId: "conv-1", content: "追问" }),
		).rejects.toMatchObject({
			name: "ApiError",
			status: 502,
			message: "请求失败",
		});
	});

	it("2xx 但 content-type 非 event-stream：按协议异常抛 ApiError", async () => {
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 200,
				contentType: "application/json",
				jsonBody: { success: true, data: {}, message: "意外 JSON" },
			}),
		);
		await expect(
			streamMessage({ conversationId: "conv-1", content: "追问" }),
		).rejects.toMatchObject({ name: "ApiError", status: 200 });
	});

	it("401：清 token 并抛 ApiError（跳转由保护区 layout 统一处理）", async () => {
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 401,
				contentType: "application/json",
				jsonBody: { code: "UNAUTHORIZED", message: "Token 无效或已过期" },
			}),
		);
		await expect(
			streamMessage({ conversationId: "conv-1", content: "追问" }),
		).rejects.toMatchObject({ name: "ApiError", status: 401 });
		expect(clearToken).toHaveBeenCalledTimes(1);
	});

	it("组织上下文失效（400/404）：与 apiClient 共用处理，按发起流时的组织判定并抛出其错误", async () => {
		vi.mocked(getActiveOrganizationId).mockReturnValueOnce("org-a");
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 404,
				contentType: "application/json",
				jsonBody: {
					code: "ORGANIZATION_NOT_FOUND",
					message: "组织不存在或无权访问",
				},
			}),
		);
		vi.mocked(consumeOrganizationContextError).mockResolvedValueOnce(
			new ApiError("组织不存在或无权访问", 404, "ORGANIZATION_NOT_FOUND"),
		);

		await expect(
			streamMessage({ conversationId: "conv-1", content: "追问" }),
		).rejects.toMatchObject({
			name: "ApiError",
			status: 404,
			code: "ORGANIZATION_NOT_FOUND",
		});
		// 交给共用处理的正是「发起流时携带的组织」
		expect(consumeOrganizationContextError).toHaveBeenCalledTimes(1);
		expect(vi.mocked(consumeOrganizationContextError).mock.calls[0]?.[1]).toBe(
			"org-a",
		);
	});

	it("403 数据请求锁定：复用锁定跳转协议（location.href → /data-requests）并抛 ApiError", async () => {
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 403,
				contentType: "application/json",
				jsonBody: { code: "DATA_REQUEST_LOCKED", message: "数据处理中" },
			}),
		);
		await expect(
			streamMessage({ conversationId: "conv-1", content: "追问" }),
		).rejects.toBeInstanceOf(ApiError);
		expect(window.location.href).toBe("/data-requests");
		expect(captureApiError).not.toHaveBeenCalled();
	});

	it.each([
		["ORGANIZATION_DATA_LOCKED", "当前组织账本清空 / 删除处理中"],
		["ACCOUNT_PENDING_DELETION", "本人账号注销处理中"],
	])(
		"W28：403 %s 走与 apiClient 共用的 consumeDataRequestLock，跳纯 /data-requests 并抛 ApiError",
		async (code, message) => {
			fetchMock.mockResolvedValue(
				mockResponse({
					status: 403,
					contentType: "application/json",
					jsonBody: { code, message },
				}),
			);

			await expect(
				streamMessage({ conversationId: "conv-1", content: "追问" }),
			).rejects.toMatchObject({ name: "ApiError", status: 403, code });

			// 交给共用处理的正是这次响应：SSE 与 apiClient 只有一份锁语义
			expect(consumeDataRequestLock).toHaveBeenCalledTimes(1);
			const handled = vi.mocked(consumeDataRequestLock).mock.calls[0]?.[0];
			expect(handled?.status).toBe(403);
			// 纯路径（不拼 ?scope=），与 apiClient 的跳转目的地一致
			expect(window.location.href).toBe("/data-requests");
			// 锁是预期控制流，不进本地错误日志
			expect(captureApiError).not.toHaveBeenCalled();
		},
	);

	it("W28：403 PERMISSION_DENIED 不是锁——不跳转，按预期控制流静默", async () => {
		fetchMock.mockResolvedValue(
			mockResponse({
				status: 403,
				contentType: "application/json",
				jsonBody: { code: "PERMISSION_DENIED", message: "无权限" },
			}),
		);
		await expect(
			streamMessage({ conversationId: "conv-1", content: "追问" }),
		).rejects.toMatchObject({ status: 403, code: "PERMISSION_DENIED" });
		expect(window.location.href).toBe("");
		expect(captureApiError).not.toHaveBeenCalled();
	});

	it("无 token：请求头不带 Authorization", async () => {
		vi.mocked(getToken).mockReturnValueOnce(null);
		fetchMock.mockResolvedValue(
			mockResponse({
				contentType: "text/event-stream",
				body: streamFromChunks([metaFrame]),
			}),
		);
		await collect(await streamMessage({ content: "你好" }));
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(
			(init.headers as Record<string, string>).Authorization,
		).toBeUndefined();
	});

	it("主动中止（AbortError）：静默透传，不误报为 dev-log 网络错误", async () => {
		const controller = new AbortController();
		const abortError = new DOMException("Aborted", "AbortError");
		fetchMock.mockRejectedValueOnce(abortError);
		controller.abort();

		await expect(
			streamMessage({ content: "你好", signal: controller.signal }),
		).rejects.toThrow("Aborted");
		expect(captureApiError).not.toHaveBeenCalled();
	});
});
