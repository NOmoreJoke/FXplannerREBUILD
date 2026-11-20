import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	buildRateHistoryQueryKey,
	RATE_HISTORY_QUERY_STEM,
	useRateHistory,
	type MarketPeriod,
} from "./use-rate-history";
import { ratesApi, REFERENCE_RATE_SOURCE } from "@/lib/api/rates";
import { ApiError } from "@/lib/api/client";
import type { RateHistoryData } from "@/lib/api/rates";
import type React from "react";

// 真实 client.ts 顶层校验 NEXT_PUBLIC_API_BASE_URL（测试环境不存在），mock 掉；
// 类定义须置于工厂内（vi.mock 被提升），hook 内 instanceof 与本文件拿到的
// ApiError 即同一 mock 类。构造签名与真实类一致。
vi.mock("@/lib/api/client", () => {
	class MockApiError extends Error {
		constructor(
			message: string,
			readonly status: number,
			readonly code?: string,
			readonly body?: Record<string, unknown>,
		) {
			super(message);
			this.name = "ApiError";
		}
	}
	return { ApiError: MockApiError };
});

// Mock ratesApi（传输层由 client.ts mock 承接，此处直接断言 API 封装的入参）；
// REFERENCE_RATE_SOURCE 随模块 mock 提供（use-rate-history 的 series 依赖其常量）
vi.mock("@/lib/api/rates", () => ({
	ratesApi: { history: vi.fn() },
	REFERENCE_RATE_SOURCE: "frankfurter-v2-reference",
}));

/** 构造单币种 history 响应 data */
const historyData = (
	target: string,
	points: [string, string][],
): RateHistoryData => ({
	base: "CNY",
	target,
	period: 30,
	data_points: points.map(([date, rate]) => ({ date, rate })),
	current_rate: points.at(-1)?.[1] ?? null,
});

const createWrapper = (
	queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	}),
) =>
	({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);

async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useRateHistory", () => {
	it("多币种并行请求参数组装：每币种一次 history(base, target, period)，行数据按 date 对齐合并", async () => {
		vi.mocked(ratesApi.history).mockImplementation((base, target) => {
			expect(base).toBe("CNY");
			if (target === "USD") {
				return Promise.resolve(
					historyData("USD", [
						["2026-02-10", "0.13910462"],
						["2026-02-11", "0.13950000"],
					]),
				);
			}
			return Promise.resolve(
				historyData("EUR", [
					["2026-02-10", "0.92100000"],
					// EUR 缺 02-11（缺口 → null 断点）
				]),
			);
		});

		const { result } = renderHook(
			() =>
				useRateHistory({ base: "CNY", targets: ["USD", "EUR"], period: 30 }),
			{ wrapper: createWrapper() },
		);
		await advance(0);

		expect(ratesApi.history).toHaveBeenCalledTimes(2);
		expect(ratesApi.history).toHaveBeenCalledWith("CNY", "USD", 30);
		expect(ratesApi.history).toHaveBeenCalledWith("CNY", "EUR", 30);

		expect(result.current.rows).toEqual([
			{ date: "2026-02-10", USD: 0.13910462, EUR: 0.921 },
			{ date: "2026-02-11", USD: 0.1395, EUR: null },
		]);
		expect(result.current.series).toEqual([
			{
				currency: "USD",
				status: "success",
				startDate: "2026-02-10",
				errorMessage: null,
				referenceCount: 0,
			},
			{
				currency: "EUR",
				status: "success",
				startDate: "2026-02-10",
				errorMessage: null,
				referenceCount: 0,
			},
		]);
		expect(result.current.isLoading).toBe(false);
		expect(result.current.isAllUnavailable).toBe(false);
	});

	it("重查失败时保留图表的参考价计数，换为纯本地或清空序列后归零", async () => {
		const localPoint = { date: "2026-02-11", rate: "0.2103", source: "er-api" };
		const localHistory: RateHistoryData = {
			base: "CNY",
			target: "TWD",
			period: 365,
			data_points: [localPoint],
			current_rate: localPoint.rate,
		};
		vi.mocked(ratesApi.history)
			.mockResolvedValueOnce({
				...localHistory,
				data_points: [
					{
						date: "2026-02-10",
						rate: "0.2102297812",
						source: REFERENCE_RATE_SOURCE,
					},
					localPoint,
				],
			})
			.mockRejectedValueOnce(new ApiError("数据源不可用", 502))
			.mockResolvedValueOnce(localHistory)
			.mockResolvedValue({
				...localHistory,
				data_points: [],
				current_rate: null,
			});

		const queryClient = new QueryClient();
		const { result } = renderHook(
			() => useRateHistory({ base: "CNY", targets: ["TWD"], period: 365 }),
			{ wrapper: createWrapper(queryClient) },
		);
		const refetchHistory = async () => {
			await act(async () => {
				await queryClient.invalidateQueries({
					queryKey: buildRateHistoryQueryKey("CNY", "TWD", 365),
					exact: true,
				});
			});
			await advance(0);
		};
		await advance(0);

		const mixedRows = [
			{ date: "2026-02-10", TWD: 0.2102297812 },
			{ date: "2026-02-11", TWD: 0.2103 },
		];
		expect(result.current.rows).toEqual(mixedRows);
		expect(result.current.series[0]).toMatchObject({
			currency: "TWD",
			status: "success",
			referenceCount: 1,
		});

		await refetchHistory();
		expect(result.current.rows).toEqual(mixedRows);
		expect(result.current.series[0]).toMatchObject({
			status: "error",
			errorMessage: "数据源不可用",
			referenceCount: 1,
		});
		expect(result.current.isAllUnavailable).toBe(false);

		await refetchHistory();
		expect(result.current.rows).toEqual([{ date: "2026-02-11", TWD: 0.2103 }]);
		expect(result.current.series[0]).toMatchObject({
			status: "success",
			errorMessage: null,
			referenceCount: 0,
		});

		await refetchHistory();
		expect(result.current.rows).toBeNull();
		expect(result.current.series[0]).toMatchObject({
			status: "empty",
			referenceCount: 0,
		});
		expect(result.current.isAllUnavailable).toBe(true);
		expect(ratesApi.history).toHaveBeenCalledTimes(4);
	});

	it("单币种失败隔离：某币种 422 失败不影响其余币种出图，失败项 status=error", async () => {
		vi.mocked(ratesApi.history).mockImplementation((_base, target) => {
			if (target === "TWD") {
				return Promise.reject(
					new ApiError("不支持该币对", 422, "RATE_PAIR_UNSUPPORTED"),
				);
			}
			return Promise.resolve(
				historyData(target as string, [["2026-02-10", "0.13910462"]]),
			);
		});

		const { result } = renderHook(
			() =>
				useRateHistory({ base: "CNY", targets: ["USD", "TWD"], period: 365 }),
			{ wrapper: createWrapper() },
		);
		await advance(0);

		const twd = result.current.series.find((item) => item.currency === "TWD");
		const usd = result.current.series.find((item) => item.currency === "USD");
		expect(twd).toEqual({
			currency: "TWD",
			status: "error",
			startDate: null,
			errorMessage: "不支持该币对（RATE_PAIR_UNSUPPORTED）",
			referenceCount: 0,
		});
		expect(usd).toMatchObject({ status: "success" });
		// 只有成功币种参与合并（TWD 列不出现）
		expect(result.current.rows).toEqual([
			{ date: "2026-02-10", USD: 0.13910462 },
		]);
		expect(result.current.isAllUnavailable).toBe(false);
	});

	it("staleTime 10min 内重挂载同 Key 命中缓存不发请求；过期后重挂载重新拉取；换档位按新 Key 请求", async () => {
		vi.mocked(ratesApi.history).mockResolvedValue(
			historyData("USD", [["2026-02-10", "0.13910462"]]),
		);

		// 共享 QueryClient（gcTime 15min：先于 gc 验证 staleTime 语义）
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: 15 * 60_000 } },
		});
		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const render = () =>
			renderHook(
				() => useRateHistory({ base: "CNY", targets: ["USD"], period: 30 }),
				{ wrapper },
			);

		const first = render();
		await advance(0);
		expect(ratesApi.history).toHaveBeenCalledTimes(1);
		first.unmount();

		// staleTime 内重挂载：命中缓存，不发请求
		const second = render();
		await advance(0);
		expect(ratesApi.history).toHaveBeenCalledTimes(1);
		second.unmount();

		// 推进 11min（超过 staleTime 10min，未到 gcTime 15min）：重挂载后数据 stale → 重新拉取
		await advance(11 * 60_000);
		const third = render();
		await advance(0);
		expect(ratesApi.history).toHaveBeenCalledTimes(2);
		third.unmount();

		// 换档位：Key 变化（period 位），重新拉取且参数正确
		vi.mocked(ratesApi.history).mockClear();
		renderHook(
			() => useRateHistory({ base: "CNY", targets: ["USD"], period: 365 }),
			{ wrapper },
		);
		await advance(0);
		expect(ratesApi.history).toHaveBeenCalledTimes(1);
		expect(ratesApi.history).toHaveBeenCalledWith("CNY", "USD", 365);
	});

	it("空序列 → status=empty；全部不可用 → isAllUnavailable=true，refetch 只重查未成功项", async () => {
		vi.mocked(ratesApi.history).mockImplementation((_base, target) => {
			if (target === "USD") {
				return Promise.resolve(historyData("USD", []));
			}
			return Promise.reject(new ApiError("数据源不可用", 502));
		});

		// period=365：retry 0（§6），reject 一次即终态，无重试等待
		const { result } = renderHook(
			() =>
				useRateHistory({ base: "CNY", targets: ["USD", "MYR"], period: 365 }),
			{ wrapper: createWrapper() },
		);
		await advance(0);

		expect(result.current.rows).toBeNull();
		expect(result.current.series).toEqual([
			{
				currency: "USD",
				status: "empty",
				startDate: null,
				errorMessage: null,
				referenceCount: 0,
			},
			{
				currency: "MYR",
				status: "error",
				startDate: null,
				errorMessage: "数据源不可用",
				referenceCount: 0,
			},
		]);
		expect(result.current.isAllUnavailable).toBe(true);

		// refetch：USD（empty，非 success）与 MYR（error）都会重查
		vi.mocked(ratesApi.history).mockClear();
		vi.mocked(ratesApi.history).mockResolvedValue(
			historyData("USD", [["2026-02-10", "0.13910462"]]),
		);
		await act(async () => {
			result.current.refetch();
		});
		await advance(0);
		expect(ratesApi.history).toHaveBeenCalledTimes(2);
		expect(result.current.isAllUnavailable).toBe(false);
	});

	it("查询 Key 符合约定：[rates, history, base, target, period]", () => {
		expect(RATE_HISTORY_QUERY_STEM).toEqual(["rates", "history"]);
		expect(buildRateHistoryQueryKey("CNY", "USD", 365)).toEqual([
			"rates",
			"history",
			"CNY",
			"USD",
			365,
		]);
	});

	it("base 未就绪（空串）或 targets 为空：不发请求，不进入加载/不可用态", async () => {
		const { result, rerender } = renderHook(
			({ base, targets }) => useRateHistory({ base, targets, period: 30 }),
			{
				initialProps: { base: "", targets: ["USD"] },
				wrapper: createWrapper(),
			},
		);
		await advance(0);
		expect(ratesApi.history).not.toHaveBeenCalled();
		expect(result.current.isLoading).toBe(false);
		expect(result.current.isAllUnavailable).toBe(false);
		expect(result.current.rows).toBeNull();

		rerender({ base: "CNY", targets: [] });
		await advance(0);
		expect(ratesApi.history).not.toHaveBeenCalled();
	});
});
