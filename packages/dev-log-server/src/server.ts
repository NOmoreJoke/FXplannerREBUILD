import http from "node:http";
import { maskSensitiveText, truncate } from "./mask.js";
import { cnDate, cnTimestamp } from "./time.js";
import type { LogWriter } from "./writer.js";

export interface LogServerOptions {
	writer: LogWriter;
	/** 请求体上限，默认 256KB */
	maxBodyBytes?: number;
}

/** 仅允许 localhost 来源（本地开发工具，不对外暴露） */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function setCorsHeaders(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): void {
	const origin = req.headers.origin;
	if (origin && LOCAL_ORIGIN.test(origin)) {
		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");
		res.setHeader("Access-Control-Max-Age", "86400");
	}
}

function sendJson(
	res: http.ServerResponse,
	status: number,
	body: unknown,
): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

interface SentryEventPayload {
	message?: string;
	level?: string;
	tags?: Record<string, string>;
	extra?: Record<string, unknown>;
	discarded_events?: unknown;
	exception?: {
		values?: Array<{
			type?: string;
			value?: string;
			stacktrace?: {
				frames?: Array<{
					filename?: string;
					function?: string;
					lineno?: number;
				}>;
			};
		}>;
	};
	breadcrumbs?: Array<{
		timestamp?: number;
		category?: string;
		message?: string;
		data?: Record<string, unknown>;
	}>;
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === "object"
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

type Breadcrumb = NonNullable<SentryEventPayload["breadcrumbs"]>[number];

/** 简化面包屑：只保留 时间 / 类别 / 可读消息 */
function simplifyBreadcrumb(crumb: Breadcrumb) {
	let message = crumb.message;
	if (!message && crumb.category === "fetch" && crumb.data) {
		message =
			`${crumb.data.method ?? ""} ${crumb.data.url ?? ""} ${crumb.data.status_code ?? ""}`.trim();
	}
	if (!message && crumb.category === "navigation" && crumb.data) {
		message = `${crumb.data.from ?? ""} → ${crumb.data.to ?? ""}`;
	}
	return {
		time: crumb.timestamp
			? cnTimestamp(new Date(crumb.timestamp * 1000))
			: undefined,
		category: crumb.category,
		message: message ? truncate(message, 150) : undefined,
	};
}

/**
 * 把存储的日志行格式化为可读结构：
 * - Sentry 事件 → 提取 message / 堆栈 / 精简面包屑
 * - client_report → 展示被 SDK 丢弃的事件统计
 * - 非 Sentry 上报（手工 curl 等）→ 原样展示
 * raw=true 时附带原始上报体
 */
function formatEntry(line: string, raw: boolean): unknown {
	const record = tryParseJson(line);
	if (!record) return line;

	const entry: Record<string, unknown> = { time: record.time };

	if (typeof record.body !== "string") return record;

	const body = tryParseJson(record.body);
	if (!body || typeof body.envelope !== "string") {
		entry.kind = "manual";
		entry.data = body ?? truncate(record.body, 500);
		return entry;
	}

	entry.pageUrl = body.pageUrl;

	// Sentry envelope 三行结构：headers / item header / payload
	const [, itemLine, payloadLine] = body.envelope.split("\n");
	const itemHeader = itemLine ? tryParseJson(itemLine) : undefined;
	const payload = payloadLine ? tryParseJson(payloadLine) : undefined;

	if (itemHeader?.type === "client_report") {
		entry.kind = "client_report";
		entry.discarded = payload?.discarded_events;
		return entry;
	}

	if (!payload) {
		entry.kind = "unknown";
		return entry;
	}

	const event = payload as unknown as SentryEventPayload;
	const exception = event.exception?.values?.[0];

	entry.kind = "error";
	entry.level = event.level;
	entry.type = event.tags?.type ?? (exception ? "js_error" : "message");
	entry.message = event.message ?? exception?.value;
	if (event.extra) entry.extra = event.extra;

	if (exception) {
		entry.exception = truncate(
			`${exception.type ?? "Error"}: ${exception.value ?? ""}`,
			300,
		);
		const frames = exception.stacktrace?.frames;
		if (frames?.length) {
			entry.stack = frames
				.slice(-10)
				.map(
					(frame) =>
						`${frame.filename ?? "?"}:${frame.lineno ?? "?"} in ${frame.function ?? "anonymous"}`,
				);
		}
	}

	if (event.breadcrumbs?.length) {
		entry.breadcrumbs = event.breadcrumbs.slice(-20).map(simplifyBreadcrumb);
	}

	if (raw) entry.raw = record.body;

	return entry;
}

export function createLogServer(options: LogServerOptions): http.Server {
	const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;

	return http.createServer((req, res) => {
		setCorsHeaders(req, res);

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		const url = new URL(req.url ?? "/", "http://127.0.0.1");

		// 读取日志：GET /frontend-log?lines=100&date=YYYY-MM-DD
		if (req.method === "GET" && url.pathname === "/frontend-log") {
			const linesParam = Number(url.searchParams.get("lines") ?? 100);
			const maxLines = Math.min(
				Math.max(1, Number.isFinite(linesParam) ? linesParam : 100),
				1000,
			);
			const dateParam = url.searchParams.get("date");
			const date =
				dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
					? dateParam
					: undefined;

			const includeRaw = url.searchParams.get("raw") === "1";
			const entries = options.writer
				.readRecent(maxLines, date)
				.map((line) => formatEntry(line, includeRaw));

			sendJson(res, 200, {
				ok: true,
				date: date ?? cnDate(),
				count: entries.length,
				entries,
			});
			return;
		}

		if (req.method !== "POST" || url.pathname !== "/frontend-log") {
			sendJson(res, 404, { ok: false, error: "Not Found" });
			return;
		}

		const chunks: Buffer[] = [];
		let received = 0;
		let tooLarge = false;

		req.on("data", (chunk: Buffer) => {
			received += chunk.length;
			if (received > maxBodyBytes) {
				tooLarge = true;
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});

		req.on("end", () => {
			if (tooLarge) return; // 连接已销毁，无法响应
			const rawBody = Buffer.concat(chunks).toString("utf8");
			const safeBody = truncate(maskSensitiveText(rawBody), maxBodyBytes);

			const line = JSON.stringify({
				time: cnTimestamp(),
				ip: req.socket.remoteAddress,
				userAgent: req.headers["user-agent"],
				origin: req.headers.origin,
				body: safeBody,
			});

			try {
				options.writer.write(line);
				sendJson(res, 200, { ok: true });
			} catch (error) {
				console.error("[dev-log-server] write failed:", error);
				sendJson(res, 500, { ok: false, error: "write failed" });
			}
		});

		req.on("error", () => {
			if (tooLarge && !res.headersSent) {
				sendJson(res, 413, { ok: false, error: "Payload Too Large" });
			}
		});
	});
}
