import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	buildLatestRatesQueryKey,
	LATEST_RATES_QUERY_STEM,
	normalizeLatestRates,
	resolveEntryRate,
	useLatestRates,
} from "./use-latest-rates";
import { ratesApi } from "@/lib/api/rates";
import { ApiError } from "@/lib/api/client";
import type {
	LatestRateGroupResponse,
	LatestRateResponse,
} from "@/lib/api/rates";
import type React from "react";

// 真实 client.ts 顶层校验 NEXT_PUBLIC_API_BASE_URL（测试环境不存在），mock 掉；
// 类定义须置于工厂内（vi.mock 被提升），hook 内 instanceof 与本文件拿到的
// ApiError 即同一 mock 类。构造签名与真实类一致（含 body 增量字段）。
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

// Mock ratesApi（传输层由 client.ts mock 承接，此处直接断言 API 封装的入参）
vi.mock("@/lib/api/rates", () => ({
	ratesApi: { latest: vi.fn() },
}));

/** 有效期终点：以假定时器的当前时间为基准偏移（hook 内 Date.now() 同为假时钟） */
const validUntilIn = (ms: number): string =>
	new Date(Date.now() + ms).toISOString();

/** 单目标平铺响应（后端缺省 targets=USD 的形状） */
const flatQuote = (validUntil: string): LatestRateResponse => ({
	base: "CNY",
	target: "USD",
	rate: "0.13910462",
	sellRate: "0.67401235",
	source: "abc",
	observedAt: "2026-02-13T08:00:00.000Z",
	validUntil,
	fresh: true,
});

/** 多目标组响应（两项，validUntil 可分别控制，用于「最早 validUntil」判定） */
const groupQuote = (
	validUntils: [string, string],
): LatestRateGroupResponse => ({
	base: "CNY",
	items: [
		{
			target: "USD",
			rate: "0.13910462",
			sellRate: "0.67401235",
			source: "abc",
			observedAt: "2026-02-13T08:00:00.000Z",
			validUntil: validUntils[0],
			fresh: true,
		},
		{
			target: "JPY",
			rate: "20.51234567",
			source: "abc",
			observedAt: "2026-02-13T08:00:00.000Z",
			validUntil: validUntils[1],
			fresh: true,
		},
	],
});

const createWrapper = () => {
	// gcTime: 0——卸载后缓存 gc 计时器即刻到期，供「卸载无泄漏」断言 getTimerCount 归零
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	});
	return ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
};

async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

/** jsdom 的 document.visibilityState 不可写，测试中用 defineProperty 覆写 */
function setVisibility(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: state,
	});
}

/** 本仓依赖的 react-query 版本在 window 上监听 visibilitychange（focusManager） */
function fireVisibilityChange() {
	window.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	setVisibility("visible");
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useLatestRates", () => {
	it("初次挂载触发 refreshLatest：请求带 refresh=true（强制回源），单目标响应归一化为单元素数组", async () => {
		vi.mocked(ratesApi.latest).mockResolvedValue(
			flatQuote(validUntilIn(300_000)),
		);

		const { result } = renderHook(
			() => useLatestRates({ base: "CNY", targets: ["USD"] }),
			{ wrapper: createWrapper() },
		);
		await advance(0);

		expect(ratesApi.latest).toHaveBeenCalledOnce();
		expect(ratesApi.latest).toHaveBeenCalledWith("CNY", ["USD"], true);
		expect(result.current.isLoading).toBe(false);
		expect(result.current.error).toBeNull();
		expect(result.current.rates).toEqual([
			{
				target: "USD",
				rate: "0.13910462",
				sellRate: "0.67401235",
				source: "abc",
				observedAt: "2026-02-13T08:00:00.000Z",
				validUntil: expect.any(String),
				fresh: true,
			},
		]);
		expect(result.current.isExpired).toBe(false);
	});

	it("60s 轮询触发 refetch：后续请求不带 refresh（走后端 5 分钟窗口缓存）", async () => {
		vi.mocked(ratesApi.latest).mockResolvedValue(
			flatQuote(validUntilIn(300_000)),
		);

		renderHook(() => useLatestRates({ base: "CNY", targets: ["USD"] }), {
			wrapper: createWrapper(),
		});
		await advance(0);
		expect(ratesApi.latest).toHaveBeenCalledTimes(1);

		await advance(60_000);
		expect(ratesApi.latest).toHaveBeenCalledTimes(2);
		expect(ratesApi.latest).toHaveBeenLastCalledWith("CNY", ["USD"], false);

		await advance(60_000);
		expect(ratesApi.latest).toHaveBeenCalledTimes(3);
		expect(ratesApi.latest).toHaveBeenLastCalledWith("CNY", ["USD"], false);
	});

	it("切后台暂停轮询（refetchIntervalInBackground=false），回前台立即重查", async () => {
		vi.mocked(ratesApi.latest).mockResolvedValue(
			flatQuote(validUntilIn(300_000)),
		);

		renderHook(() => useLatestRates({ base: "CNY", targets: ["USD"] }), {
			wrapper: createWrapper(),
		});
		await advance(0);
		expect(ratesApi.latest).toHaveBeenCalledTimes(1);

		setVisibility("hidden");
		fireVisibilityChange();
		await advance(120_000);
		// 后台期间轮询心跳照常触发，但被暂停语义拦截，不发生新请求
		expect(ratesApi.latest).toHaveBeenCalledTimes(1);

		setVisibility("visible");
		fireVisibilityChange();
		await advance(0);
		// 回前台：聚焦重取（refresh=false，走窗口缓存）
		expect(ratesApi.latest).toHaveBeenCalledTimes(2);
		expect(ratesApi.latest).toHaveBeenLastCalledWith("CNY", ["USD"], false);
	});

	it("locked=true 停轮询且关闭焦点重取（核对页回前台不自动换数）", async () => {
		vi.mocked(ratesApi.latest).mockResolvedValue(
			flatQuote(validUntilIn(300_000)),
		);

		const { rerender } = renderHook(
			({ locked }) => useLatestRates({ base: "CNY", targets: ["USD"], locked }),
			{ initialProps: { locked: false }, wrapper: createWrapper() },
		);
		await advance(0);
		expect(ratesApi.latest).toHaveBeenCalledTimes(1);

		rerender({ locked: true });
		setVisibility("hidden");
		fireVisibilityChange();
		await advance(180_000);
		setVisibility("visible");
		fireVisibilityChange();
		await advance(0);

		expect(ratesApi.latest).toHaveBeenCalledTimes(1);
	});

	it("locked→live 切换：queryKey 变化后旧数据不复用，重新请求且强制回源", async () => {
		const lockedQuote = flatQuote(validUntilIn(300_000));
		const liveQuote: LatestRateResponse = {
			...lockedQuote,
			rate: "0.13999999",
		};
		vi.mocked(ratesApi.latest)
			.mockResolvedValueOnce(lockedQuote)
			.mockResolvedValueOnce(liveQuote);

		const { result, rerender } = renderHook(
			({ locked }) => useLatestRates({ base: "CNY", targets: ["USD"], locked }),
			{ initialProps: { locked: true }, wrapper: createWrapper() },
		);

		// locked 下无自动拉取，由消费方触发 refreshLatest（确认页「先取数后锁数」）；
		// advance(0) 冲刷 react-query notifyManager 的 setTimeout(0) 通知（假定时器下不会自动跑）
		await act(async () => {
			await result.current.refreshLatest();
		});
		await advance(0);
		expect(ratesApi.latest).toHaveBeenCalledOnce();
		expect(ratesApi.latest).toHaveBeenCalledWith("CNY", ["USD"], true);
		expect(result.current.rates?.[0]?.rate).toBe("0.13910462");

		// 改回可编辑页：Key 从 locked 切回 live，旧锁定数据不复用
		rerender({ locked: false });
		await advance(0);

		expect(ratesApi.latest).toHaveBeenCalledTimes(2);
		expect(ratesApi.latest).toHaveBeenLastCalledWith("CNY", ["USD"], true);
		expect(result.current.rates?.[0]?.rate).toBe("0.13999999");
	});

	it("isExpired 按组内最早 validUntil 计算，恰好满期视为过期，locked 下随时间翻转", async () => {
		vi.mocked(ratesApi.latest).mockResolvedValue(
			groupQuote([validUntilIn(3_000), validUntilIn(5_000)]),
		);

		const { result } = renderHook(
			() =>
				useLatestRates({ base: "CNY", targets: ["USD", "JPY"], locked: true }),
			{ wrapper: createWrapper() },
		);
		await act(async () => {
			await result.current.refreshLatest();
		});
		await advance(0); // 冲刷 notifyManager 通知，让报价落入组件态
		expect(result.current.isExpired).toBe(false);

		// 推进到 2999ms：尚未满 3s，不过期（1s 心跳最后一次落在 2000ms）
		await advance(2_999);
		expect(result.current.isExpired).toBe(false);

		// 再推进 1ms（恰好 earliest validUntil 时点）→ 过期翻转
		await advance(1);
		expect(result.current.isExpired).toBe(true);
	});

	it("数据带已过期的 validUntil 时挂载后立即判定过期（live 模式）", async () => {
		vi.mocked(ratesApi.latest).mockResolvedValue(
			flatQuote(validUntilIn(-1_000)),
		);

		const { result } = renderHook(
			() => useLatestRates({ base: "CNY", targets: ["USD"] }),
			{ wrapper: createWrapper() },
		);
		await advance(0);

		expect(result.current.rates).not.toBeNull();
		expect(result.current.isExpired).toBe(true);
	});

	it("502 错误：error 归一为 { code, message, lastObservedAt }，lastObservedAt 从响应体透传", async () => {
		vi.mocked(ratesApi.latest).mockRejectedValue(
			new ApiError("汇率数据源暂时不可用", 502, "RATE_SOURCE_UNAVAILABLE", {
				code: "RATE_SOURCE_UNAVAILABLE",
				message: "汇率数据源暂时不可用",
				lastObservedAt: "2026-02-13T08:00:00.000Z",
			}),
		);

		const { result } = renderHook(
			() => useLatestRates({ base: "CNY", targets: ["USD"] }),
			{ wrapper: createWrapper() },
		);
		await advance(0);

		expect(result.current.isLoading).toBe(false);
		expect(result.current.rates).toBeNull();
		expect(result.current.error).toEqual({
			code: "RATE_SOURCE_UNAVAILABLE",
			message: "汇率数据源暂时不可用",
			lastObservedAt: "2026-02-13T08:00:00.000Z",
		});
	});

	it("非 ApiError 的未知错误归一为兜底 code，lastObservedAt 为 null", async () => {
		vi.mocked(ratesApi.latest).mockRejectedValue(new Error("网络失败"));

		const { result } = renderHook(
			() => useLatestRates({ base: "CNY", targets: ["USD"] }),
			{ wrapper: createWrapper() },
		);
		await advance(0);

		expect(result.current.error).toEqual({
			code: "UNKNOWN",
			message: "网络失败",
			lastObservedAt: null,
		});
	});

	it("卸载无泄漏：live 轮询与 locked 心跳计时器均随卸载清理，不再发请求", async () => {
		// live：60s 轮询 interval
		vi.mocked(ratesApi.latest).mockResolvedValue(
			flatQuote(validUntilIn(300_000)),
		);
		const live = renderHook(
			() => useLatestRates({ base: "CNY", targets: ["USD"] }),
			{ wrapper: createWrapper() },
		);
		await advance(0);
		live.unmount();
		await advance(180_000);
		expect(ratesApi.latest).toHaveBeenCalledTimes(1);

		// locked：refreshLatest 后存在 1s 过期心跳 interval
		vi.mocked(ratesApi.latest).mockClear();
		vi.mocked(ratesApi.latest).mockResolvedValue(
			groupQuote([validUntilIn(60_000), validUntilIn(60_000)]),
		);
		const locked = renderHook(
			() =>
				useLatestRates({ base: "CNY", targets: ["USD", "JPY"], locked: true }),
			{ wrapper: createWrapper() },
		);
		await act(async () => {
			await locked.result.current.refreshLatest();
		});
		await advance(0); // 冲刷通知让数据落地，过期心跳 interval 随之启动
		expect(ratesApi.latest).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBeGreaterThan(0); // 心跳在跑
		vi.mocked(ratesApi.latest).mockClear();
		locked.unmount();

		await advance(0); // gcTime:0 的缓存 gc 计时器到期
		expect(vi.getTimerCount()).toBe(0);
		await advance(120_000);
		expect(ratesApi.latest).not.toHaveBeenCalled();
	});

	it("resolveEntryRate：录入价取 sellRate ?? rate（银行卖出价优先，非银行源回退基准价）", () => {
		expect(
			resolveEntryRate({
				target: "USD",
				rate: "0.13910462",
				sellRate: "0.67401235",
			}),
		).toBe("0.67401235");
		expect(resolveEntryRate({ target: "USD", rate: "0.13910462" })).toBe(
			"0.13910462",
		);
		// 项级错误（rate/sellRate 均缺省）返回 undefined，由消费方按 error 呈现
		expect(
			resolveEntryRate({
				target: "TWD",
				error: {
					code: "RATE_PAIR_UNSUPPORTED",
					message: "不支持",
					lastObservedAt: null,
				},
			}),
		).toBeUndefined();
	});

	it("normalizeLatestRates：单目标平铺 → 单元素数组；多目标原样返回 items", () => {
		const flat = flatQuote("2026-02-13T08:05:00.000Z");
		expect(normalizeLatestRates(flat)).toEqual([
			{
				target: "USD",
				rate: "0.13910462",
				sellRate: "0.67401235",
				source: "abc",
				observedAt: "2026-02-13T08:00:00.000Z",
				validUntil: "2026-02-13T08:05:00.000Z",
				fresh: true,
			},
		]);

		const group = groupQuote([
			"2026-02-13T08:05:00.000Z",
			"2026-02-13T08:07:00.000Z",
		]);
		expect(normalizeLatestRates(group)).toBe(group.items);
	});

	it("查询 Key 符合 §4.2 约定：[rates, latest, base, targets, locked|live]", () => {
		expect(LATEST_RATES_QUERY_STEM).toEqual(["rates", "latest"]);
		expect(buildLatestRatesQueryKey("CNY", "USD,JPY", true)).toEqual([
			"rates",
			"latest",
			"CNY",
			"USD,JPY",
			"locked",
		]);
		expect(buildLatestRatesQueryKey("CNY", "USD", false)).toEqual([
			"rates",
			"latest",
			"CNY",
			"USD",
			"live",
		]);
	});
});
