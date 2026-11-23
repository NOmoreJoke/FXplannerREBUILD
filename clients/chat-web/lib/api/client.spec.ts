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

	it("ToB W20：400 ORGANIZATION_REQUIRED 清选择并跳组织选择页", async () => {
		const { apiClient, ApiError } = await import("@/lib/api/client");
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);
		Object.defineProperty(window, "location", {
			value: { pathname: "/home", href: "" },
			writable: true,
			configurable: true,
		});

		useOrganizationStore.setState({ activeOrganizationId: "org-gone" });
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{ success: false, code: "ORGANIZATION_REQUIRED", message: "缺组织头" },
				{ status: 400 },
			),
		);
		await expect(apiClient("/plans")).rejects.toBeInstanceOf(ApiError);
		expect(useOrganizationStore.getState().activeOrganizationId).toBeNull();
		expect(window.location.href).toBe("/organization");
		// 组织上下文语义为预期控制流，不上报 dev-log
		expect(captureApiErrorMock).not.toHaveBeenCalled();
	});

	it("ToB W20：404 ORGANIZATION_NOT_FOUND 同样清选择并跳转；403 PERMISSION_DENIED 静默", async () => {
		const { apiClient, ApiError } = await import("@/lib/api/client");
		const { useOrganizationStore } = await import(
			"@/lib/stores/organization-store"
		);

		useOrganizationStore.setState({ activeOrganizationId: "org-removed" });
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

		// 403 PERMISSION_DENIED：预期控制流（不触发 dev-log、不清理凭证）
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
	});
});
