import { BadGatewayException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ERAPI_SAMPLE_UNIX,
	erApiLatestBody,
	jsonResponse,
} from "../../test/helpers/rate-source-fixtures";
import { ERAPI_RATE_URL } from "./rate.constants";
import { ErApiSource } from "./rate-source.erapi";

/** 固定时钟：parseObservedAt 的未来时间判定基于 Date.now（fake timers 固定，真实定时器保留） */
const NOW = new Date("2026-09-15T02:27:54.000Z");

const okFetch = (body: unknown, status = 200) =>
	vi.fn(async () => jsonResponse(body, status)) as unknown as typeof fetch;

describe("ErApiSource（TWD 补充源）", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: NOW });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("URL 拼接 /latest/{base}；上游「1 base = raw target」取倒数为「1 target = X base」（raw 保留源字符串）", async () => {
		const fetchImpl = okFetch(
			erApiLatestBody({ TWD: "4.5023", HKD: "1.0975" }),
		);
		const batch = await new ErApiSource({ fetchImpl }).fetchLatestBatch("CNY", [
			"TWD",
		]);

		expect(fetchImpl).toHaveBeenCalledWith(
			`${ERAPI_RATE_URL}/latest/CNY`,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(batch.source).toBe("er-api");
		// 1/4.5023 = 0.22210870…（HALF_UP 10 位；方向修复 MVP-F0-1）
		expect(batch.quotes.TWD.rate).toBe("0.2221087000");
		expect(batch.quotes.TWD.raw).toBe("4.5023");
	});

	it("time_last_update_unix → UTC observedAt（日更零点）", async () => {
		const fetchImpl = okFetch(erApiLatestBody({ TWD: "4.5023" }));
		const batch = await new ErApiSource({ fetchImpl }).fetchLatestBatch("CNY", [
			"TWD",
		]);

		expect(batch.quotes.TWD.observedAt.toISOString()).toBe(
			"2026-09-15T00:00:00.000Z",
		);
	});

	it.each([
		["2048.0000000000001", "0.0004882812"],
		["0.0000002", "5000000.0000000000"],
		["2.00E-7", "5000000.0000000000"],
		['"4.502300"', "0.2221087000"],
	])("原始 JSON 报价 %s 精确取倒数并保留审计值", async (literal, expected) => {
		const fetchImpl = async () => new Response(
			`{"result":"success","time_last_update_unix":${ERAPI_SAMPLE_UNIX},"rates":{"TWD":${literal}}}`,
		);
		const batch = await new ErApiSource({ fetchImpl }).fetchLatestBatch("CNY", ["TWD"]);

		expect(batch.quotes.TWD).toEqual({
			rate: expected,
			raw: literal.replaceAll('"', ""),
			observedAt: new Date(ERAPI_SAMPLE_UNIX * 1000),
		});
	});

	it("result 非 success → 502", async () => {
		const fetchImpl = okFetch({
			result: "error",
			time_last_update_unix: 1,
			rates: { TWD: "4.5023" },
		});

		await expect(
			new ErApiSource({ fetchImpl }).fetchLatestBatch("CNY", ["TWD"]),
		).rejects.toThrowError(BadGatewayException);
		await expect(
			new ErApiSource({ fetchImpl }).fetchLatestBatch("CNY", ["TWD"]),
		).rejects.toThrow("返回结果 error");
	});

	it("非 2xx → 502（响应状态透出）", async () => {
		const fetchImpl = okFetch({ message: "upstream broken" }, 503);

		await expect(
			new ErApiSource({ fetchImpl }).fetchLatestBatch("CNY", ["TWD"]),
		).rejects.toThrow("响应状态 503");
	});

	it("缺 time_last_update_unix → 502（缺少报价时间）", async () => {
		const fetchImpl = okFetch({ result: "success", rates: { TWD: "4.5023" } });

		await expect(
			new ErApiSource({ fetchImpl }).fetchLatestBatch("CNY", ["TWD"]),
		).rejects.toThrow("缺少报价时间");
	});

	it("time_last_update_unix 在未来（超 now+60s 容差）→ 502", async () => {
		const futureUnix = Math.floor(NOW.getTime() / 1000) + 61;
		const fetchImpl = okFetch(erApiLatestBody({ TWD: "4.5023" }, futureUnix));

		await expect(
			new ErApiSource({ fetchImpl }).fetchLatestBatch("CNY", ["TWD"]),
		).rejects.toThrow("未来报价时间");
	});

	it("rates 缺目标币种：该目标不在 quotes（币对不支持语义，不抛错）", async () => {
		const fetchImpl = okFetch(erApiLatestBody({ HKD: "1.0975" }));
		const batch = await new ErApiSource({ fetchImpl }).fetchLatestBatch("CNY", [
			"TWD",
		]);

		expect(batch.quotes.TWD).toBeUndefined();
	});

	it("价格 ≤0 / 不可解析 → 502（无效牌价）", async () => {
		for (const bad of ["0", "-3", "abc"]) {
			const fetchImpl = okFetch(erApiLatestBody({ TWD: bad }));

			await expect(
				new ErApiSource({ fetchImpl }).fetchLatestBatch("CNY", ["TWD"]),
			).rejects.toThrow("无效牌价");
		}
	});

	it("响应体非 JSON → 502（暂时不可用）", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("<html>err</html>", { status: 200 }),
		) as unknown as typeof fetch;

		await expect(
			new ErApiSource({ fetchImpl }).fetchLatestBatch("CNY", ["TWD"]),
		).rejects.toThrow("er-api 汇率源暂时不可用");
	});

	it("无历史能力：fetchHistory 返回空数组且不外呼（TWD 历史由本地落库承担）", async () => {
		const fetchImpl = okFetch(erApiLatestBody({ TWD: "4.5023" }));
		const source = new ErApiSource({ fetchImpl });

		await expect(
			source.fetchHistory("CNY", "TWD", "2026-09-01", "2026-09-15"),
		).resolves.toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
