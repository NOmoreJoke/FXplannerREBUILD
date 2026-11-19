/**
 * FrankfurterV2Source 单测（MVP-F0-2 C2·TWD 图表参考序列）。
 *
 * 覆盖：URL 形状、上游「1 base = X target」取倒数一次（FX-01 固定夹具
 * 4.7567 → 0.2102297812）、实测逐条 date/base/quote/rate 契约 + v1 map 兼容、
 * 日期升序、供应商返回的周末日期原样保留、区间外日期过滤、缺目标币种条目
 * 跳过但日期校验不绕过、非字符串/非法/不存在/未来日期拒绝、非 2xx 与
 * 非 JSON → 502。参考序列仅供图表合并层，不落库（无 DB 交互面）。
 */
import { BadGatewayException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../../test/helpers/rate-source-fixtures";
import { FRANKFURTER_V2_RATE_URL } from "./rate.constants";
import { FrankfurterV2Source } from "./rate-source.frankfurter-v2";

/** 固定时钟：未来日期判定基于 Date.now（fake timers 固定，真实定时器保留） */
const NOW = new Date("2026-11-19T02:00:00.000Z");

const okFetch = (body: unknown, status = 200) =>
	vi.fn(async () => jsonResponse(body, status)) as unknown as typeof fetch;

describe("FrankfurterV2Source（TWD 图表参考序列）", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: NOW });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("URL 形状 /v2/rates?base&quotes&from&to；实测逐条记录契约 + 取倒数一次（4.7567 → 0.2102297812）", async () => {
		const fetchImpl = okFetch({
			base: "CNY",
			quote: "TWD",
			rates: [
				{ date: "2026-10-08", base: "CNY", quote: "TWD", rate: "4.7567" },
				{ date: "2026-10-09", base: "CNY", quote: "TWD", rate: "4.7569" },
			],
		});
		const points = await new FrankfurterV2Source({ fetchImpl }).fetchReferenceSeries(
			"CNY",
			"TWD",
			"2026-10-01",
			"2026-10-14",
		);

		expect(fetchImpl).toHaveBeenCalledWith(
			`${FRANKFURTER_V2_RATE_URL}/rates?base=CNY&quotes=TWD&from=2026-10-01&to=2026-10-14`,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(points).toHaveLength(2);
		expect(points[0].rate).toBe("0.2102297812");
		expect(points[0].observedAt.toISOString()).toBe("2026-10-08T00:00:00.000Z");
		expect(points[1].rate).toBe("0.2102209422");
	});

	it("兼容 v1 风格嵌套 map（rates[date][target]）；按日期升序；周末日期原样保留", async () => {
		const fetchImpl = okFetch({
			rates: {
				"2026-10-12": { TWD: "4.7561" }, // 周日（供应商提供）
				"2026-10-10": { TWD: "4.7560" }, // 周五
				"2026-10-11": { TWD: "4.7562" }, // 周六（供应商提供）
			},
		});
		const points = await new FrankfurterV2Source({ fetchImpl }).fetchReferenceSeries(
			"CNY",
			"TWD",
			"2026-10-10",
			"2026-10-12",
		);

		expect(points.map((point) => point.observedAt.toISOString().slice(0, 10))).toEqual([
			"2026-10-10",
			"2026-10-11",
			"2026-10-12",
		]);
	});

	it("区间外日期过滤（上游越界不外溢）；非目标币对条目跳过但日期校验不绕过（含缺 quote 条目）", async () => {
		// 非目标 quote 条目与缺 quote 条目携带非法日期：一律先过校验 → 整批拒绝（不借过滤绕过）
		const invalidViaNonTarget = okFetch({
			rates: [
				{ date: "2026-10-08", base: "CNY", quote: "TWD", rate: "4.7567" },
				{ date: "not-a-date", base: "CNY", quote: "HKD", rate: "4.75" },
			],
		});
		await expect(
			new FrankfurterV2Source({ fetchImpl: invalidViaNonTarget }).fetchReferenceSeries(
				"CNY",
				"TWD",
				"2026-10-01",
				"2026-10-14",
			),
		).rejects.toThrow("无效日期");
		const invalidViaMissingQuote = okFetch({
			rates: [
				{ date: "not-a-date", rate: "4.7567" }, // 缺 quote：不得误作目标币种
			],
		});
		await expect(
			new FrankfurterV2Source({ fetchImpl: invalidViaMissingQuote }).fetchReferenceSeries(
				"CNY",
				"TWD",
				"2026-10-01",
				"2026-10-14",
			),
		).rejects.toThrow("无效日期");

		// 无非法日期时：区间外与非目标（含缺 quote 的悬空条目）被过滤，其余正常返回
		const fetchImpl2 = okFetch({
			rates: [
				{ date: "2026-09-30", base: "CNY", quote: "TWD", rate: "4.75" }, // 区间外
				{ date: "2026-10-08", base: "CNY", quote: "HKD", rate: "4.75" }, // 非目标币对
				{ date: "2026-10-09", base: "CNY", rate: "4.75" }, // 缺 quote（悬空条目）→ 不误作目标
				{ date: "2026-10-08", base: "CNY", quote: "TWD", rate: "4.7567" },
			],
		});
		const points = await new FrankfurterV2Source({ fetchImpl: fetchImpl2 }).fetchReferenceSeries(
			"CNY",
			"TWD",
			"2026-10-01",
			"2026-10-14",
		);
		expect(points).toHaveLength(1);
		expect(points[0].rate).toBe("0.2102297812");
	});

	it("无效牌价（0/负/非法）→ 502（与既有源同语义）", async () => {
		const fetchImpl = okFetch({
			rates: [{ date: "2026-10-08", base: "CNY", quote: "TWD", rate: "0" }],
		});
		await expect(
			new FrankfurterV2Source({ fetchImpl }).fetchReferenceSeries(
				"CNY",
				"TWD",
				"2026-10-01",
				"2026-10-14",
			),
		).rejects.toThrowError(BadGatewayException);
	});

	it("date 非法/不存在/未来 → 502（FX-01：不得回落系统时间，参考点越界拒绝）", async () => {
		for (const badDate of ["2026-02-29", "not-a-date"]) {
			const fetchImpl = okFetch({
				rates: [{ date: badDate, base: "CNY", quote: "TWD", rate: "4.7567" }],
			});
			await expect(
				new FrankfurterV2Source({ fetchImpl }).fetchReferenceSeries(
					"CNY",
					"TWD",
					"2026-10-01",
					"2026-10-14",
				),
			).rejects.toThrow("无效日期");
		}
		const future = okFetch({
			rates: [{ date: "2026-12-01", base: "CNY", quote: "TWD", rate: "4.7567" }],
		});
		await expect(
			new FrankfurterV2Source({ fetchImpl: future }).fetchReferenceSeries(
				"CNY",
				"TWD",
				"2026-12-01",
				"2026-12-14",
			),
		).rejects.toThrow("未来日期");
	});

	it("非 2xx → 502；响应体非 JSON → 502（暂时不可用）", async () => {
		await expect(
			new FrankfurterV2Source({
				fetchImpl: okFetch({ message: "broken" }, 503),
			}).fetchReferenceSeries("CNY", "TWD", "2026-10-01", "2026-10-14"),
		).rejects.toThrow("响应状态 503");
		await expect(
			new FrankfurterV2Source({
				fetchImpl: vi.fn(
					async () => new Response("<html>err</html>", { status: 200 }),
				) as unknown as typeof fetch,
			}).fetchReferenceSeries("CNY", "TWD", "2026-10-01", "2026-10-14"),
		).rejects.toThrow("参考序列暂时不可用");
	});
});
