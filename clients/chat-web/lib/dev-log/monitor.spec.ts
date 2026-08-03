import * as Sentry from "@sentry/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	captureApiError,
	initDevErrorMonitor,
	isDevLogEnabled,
} from "./monitor";

const DEV_LOG_URL = "http://localhost:8787/frontend-log";

describe("dev-log monitor", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("NEXT_PUBLIC_DEV_LOG_URL", DEV_LOG_URL);
		fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("未配置上报地址时不启用", () => {
		vi.stubEnv("NEXT_PUBLIC_DEV_LOG_URL", "");
		expect(isDevLogEnabled()).toBe(false);
	});

	it("非 development 环境不启用", () => {
		vi.stubEnv("NODE_ENV", "production");
		expect(isDevLogEnabled()).toBe(false);
	});

	it("captureApiError 经自定义 transport 上报到本地地址，且内容已脱敏", async () => {
		expect(isDevLogEnabled()).toBe(true);
		initDevErrorMonitor();

		captureApiError({
			endpoint: "/api/x?token=secret1",
			method: "GET",
			kind: "http",
			status: 500,
			message: "boom",
		});
		await Sentry.flush(2000);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(DEV_LOG_URL);
		expect(init.method).toBe("POST");

		const payload = JSON.parse(init.body as string);
		expect(payload.source).toBe("sentry-browser");
		expect(payload.envelope).toContain("api_error");
		expect(payload.envelope).toContain("token=***");
		expect(payload.envelope).not.toContain("secret1");
	});

	it("JS 异常经 captureException 上报（InboundFilters 已关闭）", async () => {
		initDevErrorMonitor();
		Sentry.captureException(new Error("boom-verify"));
		await Sentry.flush(2000);

		expect(fetchMock).toHaveBeenCalled();
		const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
		const payload = JSON.parse(init.body as string);
		expect(payload.envelope).toContain("boom-verify");
	});

	it("未启用时 captureApiError 为空操作", async () => {
		vi.stubEnv("NEXT_PUBLIC_DEV_LOG_URL", "");
		captureApiError({
			endpoint: "/api/x",
			method: "GET",
			kind: "network",
			message: "Failed to fetch",
		});
		await Sentry.flush(500);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
