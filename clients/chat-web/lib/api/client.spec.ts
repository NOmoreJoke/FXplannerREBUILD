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

	it("409 ONBOARDING_NOT_COMPLETED 与 403 DATA_REQUEST_LOCKED / ACCOUNT_PENDING_DELETION 不触发 dev-log captureApiError", async () => {
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
