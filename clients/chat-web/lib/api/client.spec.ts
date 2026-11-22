import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
});
