import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage 回填（Node ≥26 原生 getter 遮蔽 jsdom localStorage，vitest#8757；
// client.spec 先例——下载经 organization-store 读取当前组织）
vi.hoisted(() => {
	const dom = (
		globalThis as { jsdom?: { window: Window & { localStorage?: Storage } } }
	).jsdom;
	const jsdomStorage = dom?.window?.localStorage;
	if (!jsdomStorage) return;
	const globals = [globalThis, globalThis.window] as Array<
		Record<string, unknown>
	>;
	for (const target of globals) {
		if (target.localStorage === undefined) {
			Object.defineProperty(target, "localStorage", {
				value: jsdomStorage,
				configurable: true,
				writable: true,
			});
		}
	}
});

vi.mock("@/lib/dev-log/monitor", () => ({
	captureApiError: vi.fn(),
}));

/** 读取 token cookie（与被测模块同一事实来源） */
function readTokenCookie(): string | null {
	const match = document.cookie.match(/(?:^|;\s*)accessToken=([^;]*)/);
	return match ? match[1] : null;
}

/**
 * 导出包下载（data-requests.ts download）绕过 apiClient，直接 fetch：
 * 组织头 / 地址构造 / 错误协议必须与 apiClient 对齐（外部评审前端批次 I-18）。
 */
describe("dataRequestsApi.download", () => {
	const fetchMock = vi.fn();
	let clickSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://127.0.0.1:4001/api");
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockReset();
		document.cookie = "accessToken=tok-123; path=/";
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);
		useOrganizationStore.setState({
			activeOrganizationId: null,
			rejectedOrganizationIds: [],
		});
		clickSpy = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});
		Object.defineProperty(URL, "createObjectURL", {
			value: vi.fn(() => "blob:download"),
			configurable: true,
			writable: true,
		});
		Object.defineProperty(URL, "revokeObjectURL", {
			value: vi.fn(),
			configurable: true,
			writable: true,
		});
	});

	afterEach(() => {
		document.cookie = "accessToken=; path=/; max-age=0";
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const okResponse = () =>
		new Response(new Blob(["zip-bytes"]), {
			status: 200,
			headers: { "Content-Disposition": 'attachment; filename="export.zip"' },
		});

	const fetchInit = (): RequestInit =>
		(fetchMock.mock.calls[0]?.[1] as RequestInit | undefined) ?? {};

	it("携带 Authorization 与当前组织的 X-Organization-Id；地址经校验的 base 构造", async () => {
		const { dataRequestsApi } = await import("./data-requests");
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);
		useOrganizationStore.setState({ activeOrganizationId: "org-b" });
		fetchMock.mockResolvedValue(okResponse());

		await dataRequestsApi.download("req123abc");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://127.0.0.1:4001/api/data-requests/req123abc/download",
		);
		expect(fetchInit().headers).toEqual({
			Authorization: "Bearer tok-123",
			"X-Organization-Id": "org-b",
		});
	});

	it("未选组织时不注入组织头", async () => {
		const { dataRequestsApi } = await import("./data-requests");
		fetchMock.mockResolvedValue(okResponse());

		await dataRequestsApi.download("req123abc");

		const headers = fetchInit().headers as Record<string, string>;
		expect(headers["Authorization"]).toBe("Bearer tok-123");
		expect(headers["X-Organization-Id"]).toBeUndefined();
	});

	it("非法 requestId：发请求前即拒绝（不把任意输入拼进 URL）", async () => {
		const { dataRequestsApi } = await import("./data-requests");

		for (const bad of ["../admin", "req/1", "a?x=1", "a#b", ""]) {
			await expect(dataRequestsApi.download(bad)).rejects.toMatchObject({
				name: "ApiError",
				status: 400,
				code: "INVALID_REQUEST_ID",
			});
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("404 ORGANIZATION_NOT_FOUND：按发请求时携带的组织走统一处理并抛 ApiError", async () => {
		const { dataRequestsApi } = await import("./data-requests");
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);
		useOrganizationStore.setState({ activeOrganizationId: "org-gone" });
		fetchMock.mockResolvedValue(
			Response.json(
				{ success: false, code: "ORGANIZATION_NOT_FOUND", message: "gone" },
				{ status: 404 },
			),
		);

		await expect(dataRequestsApi.download("req123abc")).rejects.toMatchObject({
			name: "ApiError",
			status: 404,
			code: "ORGANIZATION_NOT_FOUND",
		});
		const state = useOrganizationStore.getState();
		expect(state.activeOrganizationId).toBeNull();
		expect(state.rejectedOrganizationIds).toEqual(["org-gone"]);
	});

	it("401：清除凭证与组织选择", async () => {
		const { dataRequestsApi } = await import("./data-requests");
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		fetchMock.mockResolvedValue(Response.json({}, { status: 401 }));

		await expect(dataRequestsApi.download("req123abc")).rejects.toMatchObject({
			status: 401,
		});
		expect(readTokenCookie()).toBeNull();
		expect(useOrganizationStore.getState().activeOrganizationId).toBeNull();
	});

	it("成功：以 Content-Disposition 的文件名触发浏览器保存并释放 blob", async () => {
		const { dataRequestsApi } = await import("./data-requests");
		fetchMock.mockResolvedValue(okResponse());

		await dataRequestsApi.download("req123abc");

		expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
		expect(clickSpy).toHaveBeenCalledTimes(1);
		const anchor = clickSpy.mock.contexts[0] as HTMLAnchorElement;
		expect(anchor.download).toBe("export.zip");
		expect(anchor.href).toBe("blob:download");
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:download");
		// 触发后即从文档移除，不留悬空节点
		expect(document.querySelector("a[download]")).toBeNull();
	});
});
