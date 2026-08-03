import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogServer } from "./server.js";
import { cnDate } from "./time.js";
import { LogWriter } from "./writer.js";

describe("createLogServer", () => {
	let dir: string;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-log-server-"));
		server = createLogServer({
			writer: new LogWriter({ dir }),
			maxBodyBytes: 64,
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no address");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		await new Promise((resolve) => server.close(resolve));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function todayFile(): string {
		return path.join(dir, `frontend-error-${cnDate()}.log`);
	}

	interface LogQueryResponse {
		ok: boolean;
		count: number;
		entries: Array<{
			kind?: string;
			type?: string;
			level?: string;
			message?: string;
			pageUrl?: string;
			exception?: string;
			stack?: string[];
			discarded?: unknown;
			raw?: string;
			data?: { message?: string };
			breadcrumbs?: Array<{ message?: string }>;
		}>;
	}

	it("POST /frontend-log 写入脱敏后的日志行", async () => {
		const res = await fetch(`${baseUrl}/frontend-log`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "boom", url: "/api/x?token=abc123" }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		const line = JSON.parse(fs.readFileSync(todayFile(), "utf8").trim());
		expect(line.body).toContain("boom");
		expect(line.body).toContain("token=***");
		expect(line.body).not.toContain("abc123");
		expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
	});

	it("非 /frontend-log 路径返回 404", async () => {
		const res = await fetch(`${baseUrl}/other`, { method: "POST", body: "x" });
		expect(res.status).toBe(404);
	});

	it("GET /frontend-log 返回最近的日志条目（正序）", async () => {
		const post = (message: string) =>
			fetch(`${baseUrl}/frontend-log`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message }),
			});
		await post("first");
		await post("second");

		const res = await fetch(`${baseUrl}/frontend-log`);
		expect(res.status).toBe(200);

		const data = (await res.json()) as LogQueryResponse;
		expect(data.ok).toBe(true);
		expect(data.count).toBe(2);
		expect(data.entries[0].data).toEqual({ message: "first" });
		expect(data.entries[1].data).toEqual({ message: "second" });
	});

	it("GET /frontend-log 支持 lines 参数限制条数", async () => {
		const post = (message: string) =>
			fetch(`${baseUrl}/frontend-log`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message }),
			});
		await post("a1");
		await post("b2");
		await post("c3");

		const res = await fetch(`${baseUrl}/frontend-log?lines=2`);
		const data = (await res.json()) as LogQueryResponse;
		expect(data.count).toBe(2);
		expect(data.entries[0].data).toEqual({ message: "b2" });
		expect(data.entries[1].data).toEqual({ message: "c3" });
	});

	it("GET /frontend-log 指定无日志的日期返回空列表", async () => {
		const res = await fetch(`${baseUrl}/frontend-log?date=2000-01-01`);
		const data = (await res.json()) as LogQueryResponse;
		expect(data.ok).toBe(true);
		expect(data.count).toBe(0);
		expect(data.entries).toEqual([]);
	});

	it("GET /frontend-log 对 Sentry envelope 提取错误摘要", async () => {
		// envelope 体积较大，单独起一个默认上限的服务
		const bigServer = createLogServer({ writer: new LogWriter({ dir }) });
		await new Promise<void>((resolve) =>
			bigServer.listen(0, "127.0.0.1", resolve),
		);
		const address = bigServer.address();
		if (!address || typeof address === "string") throw new Error("no address");
		const bigBaseUrl = `http://127.0.0.1:${address.port}`;

		try {
			const envelope = [
				JSON.stringify({ event_id: "e1" }),
				JSON.stringify({ type: "event" }),
				JSON.stringify({
					message: "API Error: 400 POST /auth/register",
					level: "error",
					tags: { type: "api_error" },
				}),
			].join("\n");

			await fetch(`${bigBaseUrl}/frontend-log`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					source: "sentry-browser",
					pageUrl: "http://localhost:3001/register",
					envelope,
				}),
			});

			const res = await fetch(`${bigBaseUrl}/frontend-log`);
			const data = (await res.json()) as LogQueryResponse;

			expect(data.count).toBe(1);
			expect(data.entries[0].kind).toBe("error");
			expect(data.entries[0].message).toBe(
				"API Error: 400 POST /auth/register",
			);
			expect(data.entries[0].type).toBe("api_error");
			expect(data.entries[0].pageUrl).toBe("http://localhost:3001/register");
			expect(data.entries[0].raw).toBeUndefined();

			// raw=1 时附带原始上报体
			const rawRes = await fetch(`${bigBaseUrl}/frontend-log?raw=1`);
			const rawData = (await rawRes.json()) as LogQueryResponse;
			expect(rawData.entries[0].raw).toContain(
				"API Error: 400 POST /auth/register",
			);
		} finally {
			await new Promise((resolve) => bigServer.close(resolve));
		}
	});

	it("GET /frontend-log 异常事件提取堆栈，client_report 单独展示", async () => {
		const bigServer = createLogServer({ writer: new LogWriter({ dir }) });
		await new Promise<void>((resolve) =>
			bigServer.listen(0, "127.0.0.1", resolve),
		);
		const address = bigServer.address();
		if (!address || typeof address === "string") throw new Error("no address");
		const bigBaseUrl = `http://127.0.0.1:${address.port}`;

		try {
			const exceptionEnvelope = [
				"{}",
				JSON.stringify({ type: "event" }),
				JSON.stringify({
					level: "error",
					exception: {
						values: [
							{
								type: "Error",
								value: "js verify",
								stacktrace: {
									frames: [
										{
											filename: "app/page.tsx",
											function: "handleClick",
											lineno: 42,
										},
									],
								},
							},
						],
					},
					breadcrumbs: [
						{
							timestamp: 1785724949.083,
							category: "fetch",
							data: { method: "POST", url: "/api/x", status_code: 400 },
						},
					],
				}),
			].join("\n");

			const reportEnvelope = [
				"{}",
				JSON.stringify({ type: "client_report" }),
				JSON.stringify({
					timestamp: 1785725360.741,
					discarded_events: [
						{ reason: "event_processor", category: "error", quantity: 4 },
					],
				}),
			].join("\n");

			const post = (envelope: string) =>
				fetch(`${bigBaseUrl}/frontend-log`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						source: "sentry-browser",
						pageUrl: "http://localhost:3001/",
						envelope,
					}),
				});
			await post(exceptionEnvelope);
			await post(reportEnvelope);

			const res = await fetch(`${bigBaseUrl}/frontend-log`);
			const data = (await res.json()) as LogQueryResponse;

			const [errorEntry, reportEntry] = data.entries;
			expect(errorEntry.kind).toBe("error");
			expect(errorEntry.type).toBe("js_error");
			expect(errorEntry.exception).toBe("Error: js verify");
			expect(errorEntry.stack).toEqual(["app/page.tsx:42 in handleClick"]);
			expect(errorEntry.breadcrumbs?.[0].message).toBe("POST /api/x 400");

			expect(reportEntry.kind).toBe("client_report");
			expect(reportEntry.discarded).toEqual([
				{ reason: "event_processor", category: "error", quantity: 4 },
			]);
		} finally {
			await new Promise((resolve) => bigServer.close(resolve));
		}
	});

	it("OPTIONS 预检返回 204 且带 localhost CORS 头", async () => {
		const res = await fetch(`${baseUrl}/frontend-log`, {
			method: "OPTIONS",
			headers: { Origin: "http://localhost:3001" },
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe(
			"http://localhost:3001",
		);
	});

	it("非 localhost 来源不返回 CORS 头", async () => {
		const res = await fetch(`${baseUrl}/frontend-log`, {
			method: "OPTIONS",
			headers: { Origin: "https://evil.example.com" },
		});
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("超过 maxBodyBytes 的请求不落日志", async () => {
		await fetch(`${baseUrl}/frontend-log`, {
			method: "POST",
			body: "x".repeat(1024),
		}).catch(() => {}); // 连接被销毁，客户端可能报错

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fs.existsSync(todayFile())).toBe(false);
	});
});
