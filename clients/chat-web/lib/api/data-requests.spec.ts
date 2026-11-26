import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LastOwnerRequiredBody } from "./contract";

// localStorage 回填（Node ≥26 原生 getter 遮蔽 jsdom localStorage，vitest#8757；
// client.spec 先例——请求头注入经 organization-store 读取当前组织）
vi.hoisted(() => {
	const dom = (
		globalThis as { jsdom?: { window: Window & { localStorage?: Storage } } }
	).jsdom;
	const jsdomStorage = dom?.window.localStorage;
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

const API_BASE = "http://127.0.0.1:4001/api";

type DataRequestsModule = typeof import("./data-requests");
type OrganizationStoreModule = typeof import("@/lib/stores/organization-store");
type ClientModule = typeof import("@/lib/api/client");

/** 被测模块在求值期校验 API 地址环境变量：先 stub 再（动态）导入 */
async function loadModules(): Promise<{
	api: DataRequestsModule;
	store: OrganizationStoreModule["useOrganizationStore"];
	client: ClientModule;
}> {
	const [api, storeModule, client] = await Promise.all([
		import("./data-requests"),
		import("@/lib/stores/organization-store"),
		import("@/lib/api/client"),
	]);
	return { api, store: storeModule.useOrganizationStore, client };
}

/** 一次成功响应（每次调用给新 Response：body 单次消费，不能复用同一实例） */
const okJson = (data: unknown) => async () =>
	Response.json({ success: true, data });

/** 取第 n 次 fetch 的 url / method / body / headers */
function requestOf(
	fetchMock: ReturnType<typeof vi.fn>,
	index = 0,
): {
	url: string;
	method: string;
	body: unknown;
	headers: Record<string, string>;
} {
	const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
	const headers = (init.headers ?? {}) as Record<string, string>;
	return {
		url,
		method: init.method ?? "GET",
		body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
		headers,
	};
}

describe("dataRequestsApi（双域端点与请求头）", () => {
	const fetchMock = vi.fn();
	let api: DataRequestsModule;
	let useOrganizationStore: OrganizationStoreModule["useOrganizationStore"];

	beforeEach(async () => {
		vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", API_BASE);
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockReset();
		document.cookie = "accessToken=tok-123; path=/";
		const modules = await loadModules();
		api = modules.api;
		useOrganizationStore = modules.store;
		useOrganizationStore.setState({
			activeOrganizationId: null,
			rejectedOrganizationIds: [],
		});
	});

	afterEach(() => {
		document.cookie = "accessToken=; path=/; max-age=0";
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("个人域端点：即使已选中组织也不带 X-Organization-Id（个人数据权利不依赖组织）", async () => {
		useOrganizationStore.setState({ activeOrganizationId: "org-b" });
		fetchMock.mockImplementation(okJson({ ok: true }));

		await api.dataRequestsApi.getPersonalCurrent();
		await api.dataRequestsApi.verifyPersonal({
			challengeId: "ch-1",
			code: "123456",
			purpose: "EXPORT",
		});
		await api.dataRequestsApi.createPersonal({
			type: "DELETION",
			scope: "PERSONAL",
			challengeId: "ch-2",
		});
		await api.dataRequestsApi.cancelPersonal("req1abc", { challengeId: "ch-3" });

		const requests = fetchMock.mock.calls.map((_, index) => requestOf(fetchMock, index));
		expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
			`GET ${API_BASE}/data-requests/current`,
			`POST ${API_BASE}/data-requests/verify`,
			`POST ${API_BASE}/data-requests`,
			`POST ${API_BASE}/data-requests/req1abc/cancel`,
		]);
		for (const request of requests) {
			expect(request.headers["Authorization"]).toBe("Bearer tok-123");
			expect(request.headers["X-Organization-Id"]).toBeUndefined();
		}
		expect(requests[1].body).toEqual({
			challengeId: "ch-1",
			code: "123456",
			purpose: "EXPORT",
		});
		// scope 显式固定为 PERSONAL：与个人端点的数据域一致
		expect(requests[2].body).toEqual({
			type: "DELETION",
			scope: "PERSONAL",
			challengeId: "ch-2",
		});
		expect(requests[3].body).toEqual({ challengeId: "ch-3" });
	});

	it("组织域端点：全部走 /organizations/current/data-requests 前缀并携带当前组织的 X-Organization-Id", async () => {
		useOrganizationStore.setState({ activeOrganizationId: "org-b" });
		fetchMock.mockImplementation(okJson({ ok: true }));

		await api.dataRequestsApi.getOrganizationCurrent();
		await api.dataRequestsApi.getOrganizationImpact();
		await api.dataRequestsApi.verifyOrganization({
			challengeId: "ch-1",
			code: "123456",
			purpose: "CLEAR",
		});
		await api.dataRequestsApi.createOrganizationRequest({
			type: "CLEAR",
			scope: "ORGANIZATION",
			challengeId: "ch-1",
			confirmedTotals: {
				accounts: 1,
				transactions: 2,
				initialHoldings: 0,
				plans: 1,
				usageRecords: 0,
				corrections: 0,
			},
		});
		await api.dataRequestsApi.cancelOrganizationRequest("req1abc");
		await api.dataRequestsApi.deleteOrganization({ challengeId: "ch-9" });

		const requests = fetchMock.mock.calls.map((_, index) => requestOf(fetchMock, index));
		expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
			`GET ${API_BASE}/organizations/current/data-requests/current`,
			`GET ${API_BASE}/organizations/current/data-requests/impact`,
			`POST ${API_BASE}/organizations/current/data-requests/verify`,
			`POST ${API_BASE}/organizations/current/data-requests`,
			`POST ${API_BASE}/organizations/current/data-requests/req1abc/cancel`,
			`DELETE ${API_BASE}/organizations/current`,
		]);
		for (const request of requests) {
			expect(request.headers["X-Organization-Id"]).toBe("org-b");
		}
		expect(requests[3].body).toEqual({
			type: "CLEAR",
			scope: "ORGANIZATION",
			challengeId: "ch-1",
			confirmedTotals: {
				accounts: 1,
				transactions: 2,
				initialHoldings: 0,
				plans: 1,
				usageRecords: 0,
				corrections: 0,
			},
		});
		expect(requests[4].body).toEqual({});
		expect(requests[5].body).toEqual({ challengeId: "ch-9" });
	});

	it("组织域端点未选组织时不注入组织头（是否回落默认组织由后端判定）", async () => {
		fetchMock.mockImplementation(okJson(null));
		await api.dataRequestsApi.getOrganizationCurrent();
		const request = requestOf(fetchMock);
		expect(request.headers["X-Organization-Id"]).toBeUndefined();
		expect(request.headers["Authorization"]).toBe("Bearer tok-123");
	});
});

describe("dataRequestsApi.download / cancel（路径段 id 白名单）", () => {
	const fetchMock = vi.fn();
	let api: DataRequestsModule;
	let useOrganizationStore: OrganizationStoreModule["useOrganizationStore"];

	beforeEach(async () => {
		vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", API_BASE);
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockReset();
		document.cookie = "accessToken=tok-123; path=/";
		const modules = await loadModules();
		api = modules.api;
		useOrganizationStore = modules.store;
		useOrganizationStore.setState({
			activeOrganizationId: null,
			rejectedOrganizationIds: [],
		});
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

	it("非法 requestId：两域的下载与撤回都在发请求前拒绝（不把任意输入拼进 URL）", async () => {
		for (const bad of ["../admin", "req/1", "a?x=1", "a#b", ""]) {
			await expect(api.dataRequestsApi.downloadPersonal(bad)).rejects.toMatchObject({
				name: "ApiError",
				status: 400,
				code: "INVALID_REQUEST_ID",
			});
			await expect(api.dataRequestsApi.downloadOrganization(bad)).rejects.toMatchObject({
				name: "ApiError",
				status: 400,
				code: "INVALID_REQUEST_ID",
			});
			await expect(api.dataRequestsApi.cancelPersonal(bad)).rejects.toMatchObject({
				name: "ApiError",
				status: 400,
				code: "INVALID_REQUEST_ID",
			});
			await expect(
				api.dataRequestsApi.cancelOrganizationRequest(bad),
			).rejects.toMatchObject({
				name: "ApiError",
				status: 400,
				code: "INVALID_REQUEST_ID",
			});
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("个人下载：走个人端点，已选组织也不带组织头（0 组织 / 多组织未选同样可达）", async () => {
		useOrganizationStore.setState({ activeOrganizationId: "org-b" });
		fetchMock.mockResolvedValue(okResponse());

		await api.dataRequestsApi.downloadPersonal("req123abc");

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			`${API_BASE}/data-requests/req123abc/download`,
		);
		expect(requestOf(fetchMock).headers).toEqual({
			Authorization: "Bearer tok-123",
		});
	});

	it("组织下载：走组织端点并携带当前组织的 X-Organization-Id（导出按当前组织绑定校验）", async () => {
		useOrganizationStore.setState({ activeOrganizationId: "org-b" });
		fetchMock.mockResolvedValue(okResponse());

		await api.dataRequestsApi.downloadOrganization("req123abc");

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			`${API_BASE}/organizations/current/data-requests/req123abc/download`,
		);
		expect(requestOf(fetchMock).headers).toEqual({
			Authorization: "Bearer tok-123",
			"X-Organization-Id": "org-b",
		});
	});

	it("组织下载 404 ORGANIZATION_NOT_FOUND：按发请求时携带的组织走统一处理并抛 ApiError", async () => {
		useOrganizationStore.setState({ activeOrganizationId: "org-gone" });
		fetchMock.mockResolvedValue(
			Response.json(
				{ success: false, code: "ORGANIZATION_NOT_FOUND", message: "gone" },
				{ status: 404 },
			),
		);

		await expect(
			api.dataRequestsApi.downloadOrganization("req123abc"),
		).rejects.toMatchObject({
			name: "ApiError",
			status: 404,
			code: "ORGANIZATION_NOT_FOUND",
		});
		const state = useOrganizationStore.getState();
		expect(state.activeOrganizationId).toBeNull();
		expect(state.rejectedOrganizationIds).toEqual(["org-gone"]);
	});

	it("个人下载 404：与组织上下文无关——只抛 ApiError，不动组织选择与拒绝集合", async () => {
		useOrganizationStore.setState({ activeOrganizationId: "org-b" });
		fetchMock.mockResolvedValue(
			Response.json(
				{ success: false, code: "DATA_REQUEST_NOT_FOUND", message: "not found" },
				{ status: 404 },
			),
		);

		await expect(api.dataRequestsApi.downloadPersonal("req123abc")).rejects.toMatchObject(
			{
				name: "ApiError",
				status: 404,
				code: "DATA_REQUEST_NOT_FOUND",
			},
		);
		const state = useOrganizationStore.getState();
		expect(state.activeOrganizationId).toBe("org-b");
		expect(state.rejectedOrganizationIds).toEqual([]);
	});

	it("个人下载 410 DOWNLOAD_EXPIRED：错误码与响应体透出给调用方", async () => {
		fetchMock.mockResolvedValue(
			Response.json(
				{ success: false, code: "DOWNLOAD_EXPIRED", message: "链接已失效" },
				{ status: 410 },
			),
		);

		await expect(api.dataRequestsApi.downloadPersonal("req123abc")).rejects.toMatchObject({
			status: 410,
			code: "DOWNLOAD_EXPIRED",
			message: "链接已失效",
		});
	});

	it("401：清除凭证与组织选择", async () => {
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		fetchMock.mockResolvedValue(Response.json({}, { status: 401 }));

		await expect(api.dataRequestsApi.downloadPersonal("req123abc")).rejects.toMatchObject({
			status: 401,
		});
		expect(readTokenCookie()).toBeNull();
		expect(useOrganizationStore.getState().activeOrganizationId).toBeNull();
	});

	it("成功：以 Content-Disposition 的文件名触发浏览器保存并释放 blob", async () => {
		const clickSpy = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});
		fetchMock.mockResolvedValue(okResponse());

		await api.dataRequestsApi.downloadPersonal("req123abc");

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

/**
 * 后端 DataRequestLastOwnerRequiredException 的运行时包体：阻塞组织列表在 data 下
 * （services/chat/test/api/data-request.spec 的接口断言为运行时依据）。
 * 包体以 OpenAPI 契约类型（schema.gen 的 LastOwnerRequiredBodyDto，由后端 DTO 生成）约束——
 * 契约若再与运行时包体错位，这里先在类型检查暴露，而不是等 UI 渲染出空列表。
 */
function lastOwnerRequiredBody(
	blockingOrganizations: LastOwnerRequiredBody["data"]["blockingOrganizations"],
): LastOwnerRequiredBody {
	return {
		success: false,
		code: "LAST_OWNER_REQUIRED",
		message: "你仍是以下组织的唯一所有者，须先转移所有权或删除组织后才能注销账号",
		data: { blockingOrganizations },
	};
}

describe("getBlockingOrganizations（409 LAST_OWNER_REQUIRED 的阻塞组织列表）", () => {
	const fetchMock = vi.fn();
	let api: DataRequestsModule;
	let ApiError: ClientModule["ApiError"];

	beforeEach(async () => {
		vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", API_BASE);
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockReset();
		const modules = await loadModules();
		api = modules.api;
		ApiError = modules.client.ApiError;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("真实链路：409 响应的后端包体 → apiClient 构造的 ApiError → 取出 data 下的阻塞组织", async () => {
		const blockingOrganizations = [
			{ organizationId: "org-a", organizationName: "组织 A", role: "OWNER" },
		];
		// 每次调用给新 Response：body 单次消费（apiClient 之后若再发请求不能复用同一实例）
		fetchMock.mockImplementation(
			async () =>
				Response.json(lastOwnerRequiredBody(blockingOrganizations), {
					status: 409,
				}),
		);

		const error: unknown = await api.dataRequestsApi
			.createPersonal({
				type: "DELETION",
				scope: "PERSONAL",
				challengeId: "ch-1",
			})
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ApiError);
		expect(api.getBlockingOrganizations(error)).toEqual(blockingOrganizations);
	});

	it("命中 409 LAST_OWNER_REQUIRED：返回服务端列出的阻塞组织", () => {
		const blockingOrganizations = [
			{ organizationId: "org-a", organizationName: "组织 A", role: "OWNER" },
			{ organizationId: "org-c", organizationName: "组织 C", role: "NONE" },
		];
		const body = lastOwnerRequiredBody(blockingOrganizations);
		const error = new ApiError(body.message, 409, "LAST_OWNER_REQUIRED", body);
		expect(api.getBlockingOrganizations(error)).toEqual(blockingOrganizations);
	});

	it.each([
		["状态码不是 409", 403, "LAST_OWNER_REQUIRED"],
		["错误码不是 LAST_OWNER_REQUIRED（如互斥冲突）", 409, "DATA_REQUEST_CONFLICT"],
		["账号锁", 403, "ACCOUNT_PENDING_DELETION"],
	])("非该错误（%s）返回 null", (_label, status, code) => {
		expect(
			api.getBlockingOrganizations(new ApiError("x", status, code, {})),
		).toBeNull();
	});

	it("非 ApiError（网络异常等）返回 null", () => {
		expect(api.getBlockingOrganizations(new Error("network"))).toBeNull();
		expect(api.getBlockingOrganizations(undefined)).toBeNull();
	});

	it("列表不在 data 下或不是数组：返回空数组（UI 显示「未返回具体组织」而不是崩溃）", () => {
		const withoutBody = new ApiError("x", 409, "LAST_OWNER_REQUIRED");
		const withoutData = new ApiError("x", 409, "LAST_OWNER_REQUIRED", {
			success: false,
			code: "LAST_OWNER_REQUIRED",
			message: "x",
		});
		const dataNotObject = new ApiError("x", 409, "LAST_OWNER_REQUIRED", {
			success: false,
			code: "LAST_OWNER_REQUIRED",
			message: "x",
			data: null,
		});
		const listNotArray = new ApiError("x", 409, "LAST_OWNER_REQUIRED", {
			success: false,
			code: "LAST_OWNER_REQUIRED",
			message: "x",
			data: { blockingOrganizations: { organizationId: "org-a" } },
		});
		// 回归要点：旧 Swagger 契约把列表误标在顶层，而后端从未这样返回过——
		// 顶层有列表不算数，不能再按顶层读取
		const topLevelOnly = new ApiError("x", 409, "LAST_OWNER_REQUIRED", {
			success: false,
			code: "LAST_OWNER_REQUIRED",
			message: "x",
			blockingOrganizations: [
				{ organizationId: "org-a", organizationName: "组织 A", role: "OWNER" },
			],
		});
		for (const error of [
			withoutBody,
			withoutData,
			dataNotObject,
			listNotArray,
			topLevelOnly,
		]) {
			expect(
				api.getBlockingOrganizations(error),
				JSON.stringify(error.body),
			).toEqual([]);
		}
	});

	it("列表逐项校验：缺字段或类型不符的项被丢弃，不把未校验的数据渲染成链接", () => {
		const valid = {
			organizationId: "org-a",
			organizationName: "组织 A",
			role: "OWNER",
		};
		const error = new ApiError("x", 409, "LAST_OWNER_REQUIRED", {
			success: false,
			code: "LAST_OWNER_REQUIRED",
			message: "x",
			data: {
				blockingOrganizations: [
					valid,
					{ organizationId: 42, organizationName: "坏数据", role: "OWNER" },
					{ organizationId: "org-b" },
					null,
					"organization-c",
				],
			},
		});
		expect(api.getBlockingOrganizations(error)).toEqual([valid]);
	});
});
