import * as Sentry from "@sentry/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	captureApiError,
	initDevErrorMonitor,
	isDevLogEnabled,
	maskEventStrings,
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

	// 评审 R2-I12：此前 pageUrl 原样上报、breadcrumb.data 与 request.url 不过脱敏——
	// 访问邀请页期间的任何报错都会把一次性邀请 token 明文带出浏览器
	describe("一次性邀请 token 不出浏览器", () => {
		/** 工厂生成的占位邀请 token（非真实凭据） */
		const inviteToken = () =>
			`tok_${Math.random().toString(36).slice(2)}${Math.random()
				.toString(36)
				.slice(2)}`;

		afterEach(() => {
			window.history.replaceState({}, "", "/");
		});

		it("页面地址、面包屑 data（fetch / 导航）与事件内任意位置的 token 全部脱敏，路径形状保留", async () => {
			const value = inviteToken();
			window.history.pushState({}, "", `/invitations/${value}`);
			initDevErrorMonitor();
			Sentry.addBreadcrumb({
				category: "fetch",
				data: {
					method: "POST",
					url: `/api/organization-invitations/${value}/accept`,
					status_code: 409,
				},
			});
			Sentry.addBreadcrumb({
				category: "navigation",
				data: {
					from: `/login?redirect=%2Finvitations%2F${value}`,
					to: `/invitations/${value}`,
				},
			});

			captureApiError({
				endpoint: `/api/organization-invitations/${value}/summary`,
				method: "GET",
				kind: "http",
				status: 403,
				message: "邀请不存在或已失效",
			});
			await Sentry.flush(2000);

			const raw = (fetchMock.mock.calls.at(-1)?.[1] as RequestInit)
				.body as string;
			expect(raw).not.toContain(value);
			const payload = JSON.parse(raw) as {
				pageUrl: string;
				envelope: string;
			};
			// pageUrl 不经过 beforeSend，由 transport 单独脱敏
			expect(payload.pageUrl).toMatch(/\/invitations\/\*\*\*$/);
			// 面包屑 data 里仍是可读的请求形状
			expect(payload.envelope).toContain("/organization-invitations/***/accept");
			expect(payload.envelope).toContain(
				"/login?redirect=%2Finvitations%2F***",
			);
		});

		it("maskEventStrings：深度遍历字符串值、键不动、循环引用不栈溢出", () => {
			const value = inviteToken();
			interface Probe {
				request: { url: string; headers: { accept: string } };
				breadcrumbs: Array<{ category: string; data: { url: string } }>;
				self: Probe;
			}
			// 循环结构无法用对象字面量一次写全：先建再回指
			const event = {
				request: { url: `/invitations/${value}`, headers: { accept: "*/*" } },
				breadcrumbs: [{ category: "fetch", data: { url: `/invitations/${value}` } }],
			} as Probe;
			event.self = event;
			const masked = maskEventStrings(event) as Probe;
			// 循环引用回指到脱敏后的副本（不栈溢出、不丢字段）；环上的字符串同样已脱敏
			expect(masked.self).toBe(masked);
			expect(masked.self.request).toEqual({
				url: "/invitations/***",
				headers: { accept: "*/*" },
			});
			expect(masked.breadcrumbs).toEqual([
				{ category: "fetch", data: { url: "/invitations/***" } },
			]);
			// 键不动
			expect(Object.keys(masked.request)).toEqual(["url", "headers"]);
		});
	});
});
