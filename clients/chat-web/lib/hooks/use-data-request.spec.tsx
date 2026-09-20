import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataRequestView, ImpactView } from "@/lib/api/contract";
import { dataRequestsApi } from "@/lib/api/data-requests";
import {
	DATA_REQUEST_QUERY_KEY,
	useCancelDataRequest,
	useCreateDataRequest,
	useCurrentRequest,
	useImpact,
	useVerifyDataRequest,
} from "./use-data-request";

// mock API 层（hook 只测缓存编排与 mutation 失效逻辑）
vi.mock("@/lib/api/data-requests", () => ({
	dataRequestsApi: {
		getCurrent: vi.fn(),
		getImpact: vi.fn(),
		verify: vi.fn(),
		create: vi.fn(),
		cancel: vi.fn(),
		download: vi.fn(),
	},
}));

const pendingClear: DataRequestView = {
	id: "req-1",
	type: "CLEAR",
	status: "PENDING",
	requestedAt: "2026-09-17T00:00:00.000Z",
	dueAt: "2026-09-24T00:00:00.000Z",
	processedAt: null,
	displayStatus: "SUBMITTED",
	canCancel: true,
	withdrawDeadline: null,
	download: null,
};

const impactView: ImpactView = {
	totals: {
		accounts: 1,
		transactions: 2,
		initialHoldings: 1,
		plans: 1,
		usageRecords: 1,
		corrections: 0,
	},
	hasDownloadableExport: false,
};

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

describe("use-data-request（数据权利请求 hooks）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(async () => {
		vi.useRealTimers();
	});

	it("useCurrentRequest 返回当前请求并缓存 30s（staleTime 内不重复请求）", async () => {
		vi.mocked(dataRequestsApi.getCurrent).mockResolvedValue(pendingClear);
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);

		const first = renderHook(() => useCurrentRequest(), { wrapper });
		await waitFor(() => expect(first.result.current.data).toEqual(pendingClear));
		expect(dataRequestsApi.getCurrent).toHaveBeenCalledTimes(1);

		// 同一 queryClient 再次挂载（observer 重挂）：staleTime 30s 内命中缓存不发请求
		const second = renderHook(() => useCurrentRequest(), { wrapper });
		await waitFor(() => expect(second.result.current.data).toEqual(pendingClear));
		expect(dataRequestsApi.getCurrent).toHaveBeenCalledTimes(1);
		expect(
			queryClient.getQueryState(DATA_REQUEST_QUERY_KEY)?.dataUpdateCount,
		).toBe(1);
	});

	it("useCurrentRequest 无请求时返回 null（三按钮恢复可用）", async () => {
		vi.mocked(dataRequestsApi.getCurrent).mockResolvedValue(null);
		const wrapper = createWrapper();

		const { result } = renderHook(() => useCurrentRequest(), { wrapper });
		await waitFor(() => expect(result.current.data).toBeNull());
	});

	it("useImpact 拉取确认页数量", async () => {
		vi.mocked(dataRequestsApi.getImpact).mockResolvedValue(impactView);
		const wrapper = createWrapper();

		const { result } = renderHook(() => useImpact(), { wrapper });
		await waitFor(() => expect(result.current.data).toEqual(impactView));
	});

	it("useCreateDataRequest 成功后失效当前请求与影响缓存（进度页/三按钮回读）", async () => {
		vi.mocked(dataRequestsApi.getCurrent).mockResolvedValue(pendingClear);
		vi.mocked(dataRequestsApi.getImpact).mockResolvedValue(impactView);
		vi.mocked(dataRequestsApi.create).mockResolvedValue({
			...pendingClear,
			id: "req-2",
		});
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);

		// 先挂载 active observer（invalidate 后才会触发 refetch）
		const current = renderHook(() => useCurrentRequest(), { wrapper });
		await waitFor(() => expect(current.result.current.data).toEqual(pendingClear));
		expect(dataRequestsApi.getCurrent).toHaveBeenCalledTimes(1);

		const { result } = renderHook(() => useCreateDataRequest(), { wrapper });
		result.current.mutate({
			type: "CLEAR",
			challengeId: "ch-1",
			confirmedTotals: impactView.totals,
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(dataRequestsApi.create).toHaveBeenCalledWith({
			type: "CLEAR",
			challengeId: "ch-1",
			confirmedTotals: impactView.totals,
		});
		// 失效后 active query 自动回读（进度页展示新请求状态）
		await waitFor(() => {
			expect(
				vi.mocked(dataRequestsApi.getCurrent).mock.calls.length,
			).toBeGreaterThanOrEqual(2);
		});
	});

	it("useVerifyDataRequest 透传验证入参", async () => {
		vi.mocked(dataRequestsApi.verify).mockResolvedValue({
			challengeId: "ch-9",
			purpose: "CLEAR",
			confirmDeadline: "2026-09-17T00:10:00.000Z",
		});
		const wrapper = createWrapper();

		const { result } = renderHook(() => useVerifyDataRequest(), { wrapper });
		result.current.mutate({
			challengeId: "ch-9",
			code: "123456",
			purpose: "CLEAR",
		});
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(dataRequestsApi.verify).toHaveBeenCalledWith({
			challengeId: "ch-9",
			code: "123456",
			purpose: "CLEAR",
		});
	});

	it("useCancelDataRequest 撤回后失效缓存（三按钮恢复）", async () => {
		vi.mocked(dataRequestsApi.cancel).mockResolvedValue({
			...pendingClear,
			status: "CANCELLED",
			displayStatus: "CANCELLED",
			canCancel: false,
		});
		const wrapper = createWrapper();

		const { result } = renderHook(() => useCancelDataRequest(), { wrapper });
		result.current.mutate({ requestId: "req-1" });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(dataRequestsApi.cancel).toHaveBeenCalledWith("req-1", undefined);
	});

	it("useCancelDataRequest 撤回注销时携带 DELETION 验证凭证", async () => {
		vi.mocked(dataRequestsApi.cancel).mockResolvedValue({
			...pendingClear,
			type: "DELETION",
			status: "CANCELLED",
		});
		const wrapper = createWrapper();

		const { result } = renderHook(() => useCancelDataRequest(), { wrapper });
		result.current.mutate({ requestId: "req-2", challengeId: "ch-del" });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(dataRequestsApi.cancel).toHaveBeenCalledWith("req-2", "ch-del");
	});
});
