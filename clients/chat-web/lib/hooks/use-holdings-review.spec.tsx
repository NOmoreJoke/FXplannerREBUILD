import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useHoldingsReview, type ReviewInputRow } from "./use-holdings-review";
import { ratesApi } from "@/lib/api/rates";
import type {
	LatestRateGroupResponse,
	LatestRateResponse,
} from "@/lib/api/rates";

// 真实 client.ts 顶层校验 NEXT_PUBLIC_API_BASE_URL（测试环境不存在），mock 掉
vi.mock("@/lib/api/client", () => ({
	ApiError: class MockApiError extends Error {},
}));

// Mock ratesApi（断言取价入参：base / codes / refresh 决策）
vi.mock("@/lib/api/rates", () => ({
	ratesApi: { latest: vi.fn() },
}));

// getCurrency 来自真实 @fxplanner-new/money（纯函数，无需 mock）：
// JPY/KRW decimalPlaces=0，CNY/USD=2

const OBSERVED_AT = "2026-09-18T08:00:00.000Z";
const VALID_UNTIL = "2026-09-18T08:05:00.000Z";

const groupOf = (
	items: Array<{
		target: string;
		rate: string;
		sellRate?: string;
		error?: {
			code: "RATE_PAIR_UNSUPPORTED" | "RATE_SOURCE_UNAVAILABLE";
			message: string;
			lastObservedAt: string | null;
		};
	}>,
): LatestRateGroupResponse => ({
	base: "CNY",
	items: items.map((item) => ({
		target: item.target,
		rate: item.rate,
		...(item.sellRate !== undefined ? { sellRate: item.sellRate } : {}),
		...(item.error !== undefined ? { error: item.error } : {}),
		source: "abc",
		observedAt: OBSERVED_AT,
		validUntil: VALID_UNTIL,
		fresh: true,
	})),
});

const flatOf = (rate: string): LatestRateResponse => ({
	base: "JPY",
	target: "USD",
	rate,
	source: "abc",
	observedAt: OBSERVED_AT,
	validUntil: VALID_UNTIL,
	fresh: true,
});

const rows = (...pairs: Array<[string, string]>): ReviewInputRow[] =>
	pairs.map(([currencyCode, amount]) => ({ currencyCode, amount }));

async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

/** 手动控制 resolve 的假响应（竞态测试用） */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

function renderReview(initialBase: string, initialRows: ReviewInputRow[]) {
	return renderHook(
		(props: { base: string; rows: ReviewInputRow[] }) =>
			useHoldingsReview(props.base, props.rows),
		{ initialProps: { base: initialBase, rows: initialRows } },
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(ratesApi.latest).mockReset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useHoldingsReview", () => {
	it("空有效行不取价，保持 idle", async () => {
		const { result } = renderReview("CNY", rows(["", "10000"]));
		await advance(1000);
		expect(ratesApi.latest).not.toHaveBeenCalled();
		expect(result.current.status).toBe("idle");
	});

	it("防抖：停止输入 600ms 后才取价；首次取价 refresh=true（N2）", async () => {
		vi.mocked(ratesApi.latest).mockResolvedValue(
			groupOf([{ target: "USD", rate: "6.71289000", sellRate: "6.71289000" }]),
		);
		const { result } = renderReview("CNY", rows(["USD", "10000"]));

		await advance(599);
		expect(ratesApi.latest).not.toHaveBeenCalled();
		expect(result.current.status).toBe("loading");

		await advance(1);
		expect(ratesApi.latest).toHaveBeenCalledTimes(1);
		expect(ratesApi.latest).toHaveBeenCalledWith("CNY", ["USD"], true);

		await advance(0);
		expect(result.current.status).toBe("success");
	});

	it("N1：成本按本位币精度舍入——JPY 本位币（0 位）持仓 USD 取整", async () => {
		vi.mocked(ratesApi.latest).mockResolvedValue(flatOf("150.12345678"));
		const { result } = renderReview("JPY", rows(["USD", "100"]));

		await advance(600);
		await advance(0);

		expect(result.current.status).toBe("success");
		if (result.current.status !== "success") return;
		// 100 × 150.12345678 = 15012.345678 → JPY 本位币 HALF_UP 取整 = 15012
		// （旧实现按持仓币种 USD 2 位会得 15012.35，与后端入账不一致）
		expect(result.current.rows[0].costDisplay).toBe("15012");
	});

	it("N1：成本按本位币精度舍入——CNY 本位币（2 位）持仓 JPY 两位", async () => {
		vi.mocked(ratesApi.latest).mockResolvedValue(
			groupOf([{ target: "JPY", rate: "0.04712345", sellRate: "0.04712345" }]),
		);
		const { result } = renderReview("CNY", rows(["JPY", "10000"]));

		await advance(600);
		await advance(0);

		expect(result.current.status).toBe("success");
		if (result.current.status !== "success") return;
		// 10000 × 0.04712345 = 471.2345 → CNY 本位币 HALF_UP 2 位 = 471.23
		// （旧实现按持仓币种 JPY 0 位会得 471，与后端入账不一致）
		expect(result.current.rows[0].costDisplay).toBe("471.23");
	});

	it("N2：仅金额变化时复用缓存报价（refresh=false），币种集合变化才 refresh=true", async () => {
		vi.mocked(ratesApi.latest).mockResolvedValue(
			groupOf([
				{ target: "USD", rate: "6.71289000", sellRate: "6.71289000" },
				{ target: "JPY", rate: "0.04712345", sellRate: "0.04712345" },
			]),
		);
		const { rerender, result } = renderReview(
			"CNY",
			rows(["USD", "10000"], ["JPY", "50000"]),
		);

		// 首次：refresh=true
		await advance(600);
		expect(vi.mocked(ratesApi.latest).mock.calls[0][2]).toBe(true);

		// 仅金额变化：refresh=false（金额不影响汇率，复用窗口缓存本地重算）
		rerender({ base: "CNY", rows: rows(["USD", "20000"], ["JPY", "50000"]) });
		await advance(600);
		expect(vi.mocked(ratesApi.latest).mock.calls[1][2]).toBe(false);
		await advance(0);
		expect(result.current.status).toBe("success");

		// 币种集合变化（移除 JPY）：refresh=true
		rerender({ base: "CNY", rows: rows(["USD", "20000"]) });
		await advance(600);
		expect(vi.mocked(ratesApi.latest).mock.calls[2][2]).toBe(true);

		// 改本位币且持仓行 = 新本位币：行被过滤 → codes 空 → 不取价（防御 UI-P1 矛盾态）
		rerender({ base: "USD", rows: rows(["USD", "20000"]) });
		await advance(600);
		expect(ratesApi.latest).toHaveBeenCalledTimes(3);
	});

	it("竞态：过期响应不覆盖最新输入的结果", async () => {
		const first = deferred<LatestRateGroupResponse>();
		const second = deferred<LatestRateGroupResponse>();
		vi.mocked(ratesApi.latest)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);

		const { rerender, result } = renderReview("CNY", rows(["USD", "1"]));
		await advance(600); // 第 1 次请求 pending
		rerender({ base: "CNY", rows: rows(["USD", "2"]) });
		await advance(600); // 第 2 次请求 pending
		expect(ratesApi.latest).toHaveBeenCalledTimes(2);

		// 旧响应先到：必须被丢弃（仍在 loading，等待最新请求）
		await act(async () => {
			first.resolve(groupOf([{ target: "USD", rate: "1.00000000" }]));
		});
		await advance(0);
		expect(result.current.status).toBe("loading");

		// 最新响应到达：落地
		await act(async () => {
			second.resolve(groupOf([{ target: "USD", rate: "6.71289000" }]));
		});
		await advance(0);
		expect(result.current.status).toBe("success");
		if (result.current.status !== "success") return;
		expect(result.current.rows[0].rateDisplay).toBe("6.71289000");
		expect(result.current.rows[0].amount).toBe("2");
	});

	it("项级 error 或取价失败 → status=error，绝不用 0 或手填价顶替", async () => {
		vi.mocked(ratesApi.latest)
			.mockResolvedValueOnce(
				groupOf([
					{
						target: "USD",
						rate: "0",
						error: {
							code: "RATE_SOURCE_UNAVAILABLE",
							message: "源不可用",
							lastObservedAt: null,
						},
					},
				]),
			)
			.mockRejectedValueOnce(new Error("network down"));

		const { rerender, result } = renderReview("CNY", rows(["USD", "10000"]));
		await advance(600);
		await advance(0);
		expect(result.current.status).toBe("error");

		// 请求级失败同样 error
		rerender({ base: "CNY", rows: rows(["USD", "20000"]) });
		await advance(600);
		await advance(0);
		expect(result.current.status).toBe("error");
	});
});
