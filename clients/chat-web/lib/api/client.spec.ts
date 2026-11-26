import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage 回填（Node ≥26 原生 getter 遮蔽 jsdom localStorage，vitest#8757；
// use-chat.spec 先例——client.ts 经 organization-store(persist) 触发同问题）
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

const { captureApiErrorMock, getTokenMock, clearTokenMock } = vi.hoisted(() => ({
	captureApiErrorMock: vi.fn(),
	getTokenMock: vi.fn(() => "tok-123"),
	clearTokenMock: vi.fn(),
}));

vi.mock("@/lib/dev-log/monitor", () => ({
	captureApiError: captureApiErrorMock,
}));

vi.mock("@/lib/auth/token", () => ({
	getToken: getTokenMock,
	clearToken: clearTokenMock,
}));

describe("apiClient & isExpectedControlFlowApiError", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://127.0.0.1:4001/api");
		vi.stubGlobal("fetch", fetchMock);
		captureApiErrorMock.mockReset();
		fetchMock.mockReset();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("409 ONBOARDING_NOT_COMPLETED 与 403 双锁错误码不触发 dev-log captureApiError", async () => {
		const { apiClient, isExpectedControlFlowApiError, ApiError } = await import(
			"@/lib/api/client"
		);

		expect(
			isExpectedControlFlowApiError(409, "ONBOARDING_NOT_COMPLETED"),
		).toBe(true);
		expect(isExpectedControlFlowApiError(403, "DATA_REQUEST_LOCKED")).toBe(true);
		expect(
			isExpectedControlFlowApiError(403, "ACCOUNT_PENDING_DELETION"),
		).toBe(true);
		// W27：组织数据锁（当前组织账本清空/删除处理中）
		expect(
			isExpectedControlFlowApiError(403, "ORGANIZATION_DATA_LOCKED"),
		).toBe(true);
		expect(isExpectedControlFlowApiError(409, "IMPACT_CHANGED")).toBe(false);
		expect(isExpectedControlFlowApiError(500, "INTERNAL_ERROR")).toBe(false);

		fetchMock.mockResolvedValueOnce(
			Response.json(
				{ code: "ONBOARDING_NOT_COMPLETED", message: "尚未完成建账" },
				{ status: 409 },
			),
		);
		await expect(apiClient("/settings")).rejects.toBeInstanceOf(ApiError);
		expect(captureApiErrorMock).not.toHaveBeenCalled();

		Object.defineProperty(window, "location", {
			value: { pathname: "/data-requests", href: "" },
			writable: true,
			configurable: true,
		});
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{ code: "DATA_REQUEST_LOCKED", message: "locked" },
				{ status: 403 },
			),
		);
		await expect(
			apiClient("/transactions", { method: "POST", body: "{}" }),
		).rejects.toBeInstanceOf(ApiError);
		expect(captureApiErrorMock).not.toHaveBeenCalled();
	});

	it("非预期 HTTP 4xx/5xx 正常上报 captureApiError", async () => {
		const { apiClient, ApiError } = await import("@/lib/api/client");

		fetchMock.mockResolvedValueOnce(
			Response.json(
				{ code: "INVALID_PLAN_PARAMS", message: "参数非法" },
				{ status: 400 },
			),
		);
		await expect(apiClient("/plans", { method: "POST" })).rejects.toBeInstanceOf(
			ApiError,
		);
		expect(captureApiErrorMock).toHaveBeenCalledWith({
			endpoint: "/plans",
			method: "POST",
			kind: "http",
			status: 400,
			message: "参数非法",
		});
	});

	it("ToB W20：选中组织时注入 X-Organization-Id；未选组织不注入", async () => {
		const { apiClient } = await import("@/lib/api/client");
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);

		// 每次调用返回新 Response（body 单次消费，不能复用同一实例）
		fetchMock.mockImplementation(async () =>
			Response.json({ success: true, data: { ok: true } }),
		);

		useOrganizationStore.setState({ activeOrganizationId: "org-abc" });
		await apiClient("/home/state");
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
			Authorization: "Bearer tok-123",
			"X-Organization-Id": "org-abc",
		});

		useOrganizationStore.setState({ activeOrganizationId: null });
		await apiClient("/home/state");
		const headers2 = fetchMock.mock.calls[1]?.[1]?.headers as Record<
			string,
			string
		>;
		expect(headers2["X-Organization-Id"]).toBeUndefined();
		useOrganizationStore.setState({ activeOrganizationId: null });
	});

	it("ToB W20：400 ORGANIZATION_REQUIRED 清选择并记入拒绝集合；不再硬跳转（路由分流接管）", async () => {
		const { apiClient, ApiError } = await import("@/lib/api/client");
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);
		Object.defineProperty(window, "location", {
			value: { pathname: "/home", href: "" },
			writable: true,
			configurable: true,
		});
		useOrganizationStore.setState({
			activeOrganizationId: "org-gone",
			rejectedOrganizationIds: [],
		});

		fetchMock.mockResolvedValueOnce(
			Response.json(
				{ success: false, code: "ORGANIZATION_REQUIRED", message: "缺组织头" },
				{ status: 400 },
			),
		);
		await expect(apiClient("/plans")).rejects.toMatchObject({
			name: "ApiError",
			status: 400,
			code: "ORGANIZATION_REQUIRED",
		});
		expect(ApiError).toBeDefined();
		const state = useOrganizationStore.getState();
		expect(state.activeOrganizationId).toBeNull();
		// 被拒绝的组织进入会话级拒绝集合：路由分流的自动选中不再选它
		// （否则单组织用户被移出后会「清除 → 自动选回 → 再 400」循环）
		expect(state.rejectedOrganizationIds).toEqual(["org-gone"]);
		// 不做 window.location 硬跳转：选择清空后由 (protected)/layout 的组织路由分流
		// 自动进入选择态（此前硬跳 /organization 会整页重载并丢失当前页面）
		expect(window.location.href).toBe("");
		// 组织上下文语义为预期控制流，不上报 dev-log
		expect(captureApiErrorMock).not.toHaveBeenCalled();
	});

	it("ToB W20：404 ORGANIZATION_NOT_FOUND 同样处理；403 PERMISSION_DENIED 静默", async () => {
		const { apiClient, ApiError } = await import("@/lib/api/client");
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);
		useOrganizationStore.setState({
			activeOrganizationId: "org-removed",
			rejectedOrganizationIds: [],
		});
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{
					success: false,
					code: "ORGANIZATION_NOT_FOUND",
					message: "组织不存在或无权访问",
				},
				{ status: 404 },
			),
		);
		await expect(apiClient("/accounts")).rejects.toBeInstanceOf(ApiError);
		expect(useOrganizationStore.getState().activeOrganizationId).toBeNull();
		expect(useOrganizationStore.getState().rejectedOrganizationIds).toEqual([
			"org-removed",
		]);

		// 403 PERMISSION_DENIED：预期控制流（不触发 dev-log、不清理凭证、不动组织选择）
		useOrganizationStore.setState({ activeOrganizationId: "org-removed-2" });
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{ success: false, code: "PERMISSION_DENIED", message: "无权限" },
				{ status: 403 },
			),
		);
		await expect(
			apiClient("/organizations/current", { method: "PATCH", body: "{}" }),
		).rejects.toBeInstanceOf(ApiError);
		expect(captureApiErrorMock).not.toHaveBeenCalled();
		expect(clearTokenMock).not.toHaveBeenCalled();
		expect(useOrganizationStore.getState().activeOrganizationId).toBe(
			"org-removed-2",
		);
	});

	it("评审 I-18：旧组织的迟到 404 不清除用户刚切换到的新选择", async () => {
		const { apiClient } = await import("@/lib/api/client");
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);
		let resolveFetch: (response: Response) => void = () => {};
		fetchMock.mockImplementationOnce(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		useOrganizationStore.setState({
			activeOrganizationId: "org-a",
			rejectedOrganizationIds: [],
		});

		const pending = apiClient("/accounts");
		// 请求在途时用户切换到组织 B，随后组织 A 的 404 才到达
		useOrganizationStore.setState({ activeOrganizationId: "org-b" });
		resolveFetch(
			Response.json(
				{ success: false, code: "ORGANIZATION_NOT_FOUND", message: "gone" },
				{ status: 404 },
			),
		);

		await expect(pending).rejects.toMatchObject({
			status: 404,
			code: "ORGANIZATION_NOT_FOUND",
		});
		// 新选择保留；被拒绝的是「发请求时携带的」组织 A
		const state = useOrganizationStore.getState();
		expect(state.activeOrganizationId).toBe("org-b");
		expect(state.rejectedOrganizationIds).toEqual(["org-a"]);
	});

	it("401：凭证与组织选择一并清除（换账号登录不得继承上一个账号的组织）", async () => {
		const { apiClient } = await import("@/lib/api/client");
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		fetchMock.mockResolvedValueOnce(Response.json({}, { status: 401 }));

		await expect(apiClient("/home/state")).rejects.toMatchObject({ status: 401 });

		expect(clearTokenMock).toHaveBeenCalledTimes(1);
		expect(useOrganizationStore.getState().activeOrganizationId).toBeNull();
	});

	it("R2-I10：401 走统一会话重置——会话级拒绝集合、聊天运行时态与在途 SSE 一并清空", async () => {
		const { apiClient } = await import("@/lib/api/client");
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);
		const { registerActiveStreamAbort, useChatStore } = await import(
			"@/lib/stores/chat-store"
		);
		// 上一个账号留下的上下文：组织选择、本会话被拒的组织、选中的会话、在途的流
		useOrganizationStore.setState({
			activeOrganizationId: "org-a",
			rejectedOrganizationIds: ["org-rejected"],
		});
		useChatStore.setState({ activeConversationId: "conv-a" });
		const stream = new AbortController();
		registerActiveStreamAbort(stream);
		try {
			fetchMock.mockResolvedValueOnce(Response.json({}, { status: 401 }));

			await expect(apiClient("/home/state")).rejects.toMatchObject({
				status: 401,
			});

			// 此前只清凭证与选择：拒绝集合与会话选择留在内存里，
			// 同一会话内换账号后，新账号的组织可能因旧账号的拒绝记录而无法被自动选中
			expect(useOrganizationStore.getState()).toMatchObject({
				activeOrganizationId: null,
				rejectedOrganizationIds: [],
			});
			expect(useChatStore.getState().activeConversationId).toBeNull();
			expect(stream.signal.aborted).toBe(true);
		} finally {
			registerActiveStreamAbort(null);
		}
	});

	it("buildApiUrl：地址构造的唯一出口——拒绝绝对/协议相对地址，且在发起网络请求前抛出", async () => {
		const { apiClient, buildApiUrl } = await import("@/lib/api/client");

		expect(buildApiUrl("/plans")).toBe("http://127.0.0.1:4001/api/plans");
		expect(() => buildApiUrl("https://evil.example/x")).toThrow(/相对路径/);
		expect(() => buildApiUrl("//evil.example/x")).toThrow(/协议相对/);
		// apiClient：校验失败不触达 fetch，也不记为网络层错误（调用方缺陷）
		await expect(apiClient("//evil.example/x")).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(captureApiErrorMock).not.toHaveBeenCalled();
	});
});

describe("isExpectedControlFlowApiError（六种预期控制流，状态码与错误码须同时匹配）", () => {
	it("完整包含：409 未建账 / 403 双锁 / 403 权限不足 / 400 缺组织 / 404 组织不可达", async () => {
		const { isExpectedControlFlowApiError } = await import("@/lib/api/client");

		expect(isExpectedControlFlowApiError(409, "ONBOARDING_NOT_COMPLETED")).toBe(true);
		expect(isExpectedControlFlowApiError(403, "ORGANIZATION_DATA_LOCKED")).toBe(true);
		expect(isExpectedControlFlowApiError(403, "ACCOUNT_PENDING_DELETION")).toBe(true);
		expect(isExpectedControlFlowApiError(403, "PERMISSION_DENIED")).toBe(true);
		expect(isExpectedControlFlowApiError(400, "ORGANIZATION_REQUIRED")).toBe(true);
		expect(isExpectedControlFlowApiError(404, "ORGANIZATION_NOT_FOUND")).toBe(true);
	});

	it.each([
		[403, "ONBOARDING_NOT_COMPLETED"],
		[500, "PERMISSION_DENIED"],
		[403, "ORGANIZATION_REQUIRED"],
		[400, "ORGANIZATION_NOT_FOUND"],
		[403, undefined],
		[409, "LAST_OWNER_REQUIRED"],
		[409, "DATA_REQUEST_CONFLICT"],
		[409, "IMPACT_CHANGED"],
		[403, "VERIFICATION_PURPOSE_MISMATCH"],
	])(
		"(%s, %s) 不是预期控制流——不静默（不是屏蔽所有 4xx）",
		async (status, code) => {
			const { isExpectedControlFlowApiError } = await import(
				"@/lib/api/client"
			);
			expect(isExpectedControlFlowApiError(status, code)).toBe(false);
		},
	);
});

/** 把 jsdom 的 location 换成可观测对象（读取 pathname、记录赋给 href 的值） */
function stubLocation(pathname: string) {
	Object.defineProperty(window, "location", {
		value: { href: "", pathname },
		writable: true,
		configurable: true,
	});
}

describe("双锁 403 的统一处理（consumeDataRequestLock）", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://127.0.0.1:4001/api");
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockReset();
		// 本 describe 的用例各自断言「是否清凭证 / 是否上报」，不继承前面用例的调用计数
		clearTokenMock.mockClear();
		captureApiErrorMock.mockClear();
		stubLocation("/home");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it.each([
		["ORGANIZATION_DATA_LOCKED", "当前组织账本清空处理中"],
		["ACCOUNT_PENDING_DELETION", "本人账号注销处理中"],
	])(
		"403 %s：整页跳转纯 /data-requests（不拼 ?scope=），并照常抛出带错误码的 ApiError",
		async (code, message) => {
			const { apiClient, ApiError, DATA_REQUESTS_PAGE_PATH } = await import(
				"@/lib/api/client"
			);
			fetchMock.mockResolvedValueOnce(
				Response.json({ success: false, code, message }, { status: 403 }),
			);

			await expect(apiClient("/plans", { method: "POST", body: "{}" })).rejects.toMatchObject(
				{
					name: "ApiError",
					status: 403,
					code,
				},
			);
			// 跳转目标是纯路径：既有 E2E 按 `${BASE_URL}/data-requests` 精确匹配
			expect(window.location.href).toBe("/data-requests");
			expect(window.location.href).not.toContain("?");
			expect(window.location.href).toBe(DATA_REQUESTS_PAGE_PATH);
			expect(ApiError).toBeDefined();
			// 锁是预期控制流，不进本地错误日志
			expect(captureApiErrorMock).not.toHaveBeenCalled();
		},
	);

	it("ORGANIZATION_DATA_LOCKED 不清空组织选择：锁只针对当前组织，侧栏仍可切到未锁定的其他组织", async () => {
		const { apiClient } = await import("@/lib/api/client");
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);
		useOrganizationStore.setState({
			activeOrganizationId: "org-a",
			rejectedOrganizationIds: [],
		});
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{
					success: false,
					code: "ORGANIZATION_DATA_LOCKED",
					message: "locked",
				},
				{ status: 403 },
			),
		);

		await expect(apiClient("/home/state")).rejects.toMatchObject({
			code: "ORGANIZATION_DATA_LOCKED",
		});
		expect(useOrganizationStore.getState()).toMatchObject({
			activeOrganizationId: "org-a",
			rejectedOrganizationIds: [],
		});
		expect(window.location.href).toBe("/data-requests");
	});

	it("ACCOUNT_PENDING_DELETION 同样不动组织选择与凭证（进度页对无组织用户放行，靠的是路由豁免）", async () => {
		const { apiClient } = await import("@/lib/api/client");
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{ success: false, code: "ACCOUNT_PENDING_DELETION", message: "locked" },
				{ status: 403 },
			),
		);

		await expect(apiClient("/home/state")).rejects.toMatchObject({
			code: "ACCOUNT_PENDING_DELETION",
		});
		// 不是 401：凭证保留（进度页的撤回 / 下载仍需要它），组织选择保留
		expect(clearTokenMock).not.toHaveBeenCalled();
		expect(useOrganizationStore.getState().activeOrganizationId).toBe("org-a");
		expect(window.location.href).toBe("/data-requests");
	});

	it("已在进度页时不再重复跳转（防「跳转 → 再 403 → 再跳转」循环）", async () => {
		stubLocation("/data-requests");
		const { apiClient } = await import("@/lib/api/client");
		fetchMock.mockResolvedValue(
			Response.json(
				{ success: false, code: "ACCOUNT_PENDING_DELETION", message: "locked" },
				{ status: 403 },
			),
		);

		await expect(apiClient("/home/state")).rejects.toMatchObject({ status: 403 });
		expect(window.location.href).toBe("");
	});

	it.each([
		["PERMISSION_DENIED", "无权限"],
		["VERIFICATION_PURPOSE_MISMATCH", "用途不匹配"],
	])("403 %s 不是锁：不跳转", async (code, message) => {
		const { apiClient } = await import("@/lib/api/client");
		fetchMock.mockResolvedValueOnce(
			Response.json({ success: false, code, message }, { status: 403 }),
		);

		await expect(apiClient("/plans", { method: "PATCH", body: "{}" })).rejects.toMatchObject(
			{ status: 403, code },
		);
		expect(window.location.href).toBe("");
	});

	it("跳转目的地 /data-requests 在 isOrglessRouteAllowed 中放行：无组织 / 未选组织 / 账号锁定用户进得去进度页", async () => {
		const { DATA_REQUESTS_PAGE_PATH } = await import("@/lib/api/client");
		const { isOrglessRouteAllowed } = await import("@/lib/hooks/use-organizations");

		expect(DATA_REQUESTS_PAGE_PATH).toBe("/data-requests");
		// 两处是同一条约束的两半：锁跳转把人送去 /data-requests，路由分流必须放行它，
		// 否则 0 组织 / 多组织未选用户会被挡在选择页外，落进「403 → 跳进度页 → 进不去」
		expect(isOrglessRouteAllowed(DATA_REQUESTS_PAGE_PATH)).toBe(true);
		expect(isOrglessRouteAllowed("/data-requests/some-sub")).toBe(true);
		// 同前缀的其他路径不误豁免
		expect(isOrglessRouteAllowed("/data-requests-v2")).toBe(false);
	});
});

describe("个人域请求：skipOrganizationScope", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://127.0.0.1:4001/api");
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockReset();
		captureApiErrorMock.mockClear();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("已选组织时，个人域端点不注入 X-Organization-Id；默认请求照常注入", async () => {
		const { apiClient } = await import("@/lib/api/client");
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);
		fetchMock.mockImplementation(async () =>
			Response.json({ success: true, data: { ok: true } }),
		);
		useOrganizationStore.setState({ activeOrganizationId: "org-abc" });

		await apiClient("/data-requests/current", { skipOrganizationScope: true });
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer tok-123",
		});

		await apiClient("/organizations/current/data-requests/current");
		expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
			"X-Organization-Id": "org-abc",
		});
		useOrganizationStore.setState({ activeOrganizationId: null });
	});

	it("个人域请求不参与组织上下文失效处理：404 不会被当成「组织不可达」而清掉组织选择", async () => {
		const { apiClient } = await import("@/lib/api/client");
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);
		stubLocation("/settings");
		useOrganizationStore.setState({
			activeOrganizationId: "org-abc",
			rejectedOrganizationIds: [],
		});
		// 防御性用例：即便个人端点回了一个组织语义的错误码，也不该动当前组织
		// （请求根本没带组织，谈不上「发请求时携带的组织失效」）
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{ success: false, code: "ORGANIZATION_NOT_FOUND", message: "gone" },
				{ status: 404 },
			),
		);

		await expect(
			apiClient("/settings/personal", { skipOrganizationScope: true }),
		).rejects.toMatchObject({ status: 404, code: "ORGANIZATION_NOT_FOUND" });
		const state = useOrganizationStore.getState();
		expect(state.activeOrganizationId).toBe("org-abc");
		expect(state.rejectedOrganizationIds).toEqual([]);
		useOrganizationStore.setState({ activeOrganizationId: null });
	});
});
