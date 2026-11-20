import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
	RatePairUnsupportedException,
	RateSourceUnavailableException,
} from "../../rate/rate.errors";
import type { RateService } from "../../rate/rate.service";
import { createRateTool, RATE_TOOL_NAME } from "./rate-tool";

/**
 * 汇率工具单测（ai-assistant 技术方案 §8.1）：
 * mode 分支映射、入参校验（非法币种/缺 target/period 越界）、
 * 400/422/502 与空历史序列 → 错误/说明文本回喂而非抛出。
 */

const buildRateService = (
	overrides: Partial<Record<"getLatest" | "getHistory", unknown>> = {},
) => {
	const getLatest = vi.fn(async () => ({
		base: "CNY",
		target: "USD",
		rate: "7.12000000",
		source: "er-api",
		observedAt: "2026-02-13T00:00:00.000Z",
		validUntil: "2026-02-13T00:05:00.000Z",
		fresh: true,
	}));
	const getHistory = vi.fn(async () => ({
		base: "CNY",
		target: "USD",
		period: 30,
		data_points: [
			{ date: "2026-01-15", rate: "7.15", source: "abc" },
			{ date: "2026-02-13", rate: "7.12", source: "abc" },
		],
		current_rate: "7.12",
	}));
	return {
		getLatest: overrides.getLatest ?? getLatest,
		getHistory: overrides.getHistory ?? getHistory,
	} as unknown as RateService;
};

describe("query_exchange_rate 工具", () => {
	it("工具名与元数据固定为 query_exchange_rate", () => {
		const tool = createRateTool(buildRateService());
		expect(tool.name).toBe(RATE_TOOL_NAME);
	});

	it("mode=latest 单目标：映射 RateService.getLatest，文本含数值与数据时间", async () => {
		const rateService = buildRateService();
		const tool = createRateTool(rateService);

		const result = await tool.invoke({
			mode: "latest",
			base: "CNY",
			targets: ["USD"],
		});

		expect(rateService.getLatest).toHaveBeenCalledWith("CNY", ["USD"]);
		expect(result).toContain("7.12");
		expect(result).toContain("2026-02-13");
	});

	it("mode=latest 多目标：targets 原样透传", async () => {
		const rateService = buildRateService({
			getLatest: vi.fn(async () => ({
				base: "CNY",
				items: [
					{
						target: "USD",
						rate: "7.12",
						source: "er-api",
						observedAt: "2026-02-13T00:00:00.000Z",
						validUntil: "x",
						fresh: true,
					},
					{
						target: "JPY",
						rate: "0.047",
						source: "abc",
						observedAt: "2026-02-13T00:00:00.000Z",
						validUntil: "x",
						fresh: true,
					},
				],
			})),
		});
		const tool = createRateTool(rateService);

		const result = await tool.invoke({
			mode: "latest",
			base: "CNY",
			targets: ["USD", "JPY"],
		});

		expect(rateService.getLatest).toHaveBeenCalledWith("CNY", ["USD", "JPY"]);
		expect(result).toContain("USD = 7.12");
		expect(result).toContain("JPY = 0.047");
	});

	it("mode=history：映射 getHistory，文本含起止值与区间", async () => {
		const rateService = buildRateService();
		const tool = createRateTool(rateService);

		const result = await tool.invoke({
			mode: "history",
			base: "CNY",
			target: "USD",
			period: 30,
		});

		expect(rateService.getHistory).toHaveBeenCalledWith("CNY", "USD", 30);
		expect(result).toContain("近 30 天");
		expect(result).toContain("7.15");
		expect(result).toContain("7.12");
	});

	it("非法基准币种：错误文本回喂（含可查询范围），不抛出", async () => {
		const rateService = buildRateService();
		const tool = createRateTool(rateService);

		const result = await tool.invoke({
			mode: "latest",
			base: "BTC",
			targets: ["USD"],
		});

		expect(rateService.getLatest).not.toHaveBeenCalled();
		expect(result).toContain("RATE_PAIR_UNSUPPORTED");
		expect(result).toContain("BTC");
	});

	it("latest 缺 targets：INVALID_PARAMS 错误文本，不调 RateService", async () => {
		const rateService = buildRateService();
		const tool = createRateTool(rateService);

		const result = await tool.invoke({
			mode: "latest",
			base: "USD",
			targets: [],
		});

		expect(rateService.getLatest).not.toHaveBeenCalled();
		expect(result).toContain("INVALID_PARAMS");
		expect(result).toContain("1~5");
	});

	it("history 缺 target / period 越界：INVALID_PARAMS 错误文本", async () => {
		const rateService = buildRateService();
		const tool = createRateTool(rateService);

		const missingTarget = await tool.invoke({ mode: "history", base: "USD" });
		expect(rateService.getHistory).not.toHaveBeenCalled();
		expect(missingTarget).toContain("INVALID_PARAMS");

		const badPeriod = await tool.invoke({
			mode: "history",
			base: "USD",
			target: "CNY",
			period: 15,
		});
		expect(badPeriod).toContain("INVALID_PARAMS");
		expect(badPeriod).toContain("7、30、90");
	});

	it("空历史序列：返回「暂无历史数据」说明文本而非抛出（13/15 币对无历史回源，§3.1）", async () => {
		const rateService = buildRateService({
			getHistory: vi.fn(async () => ({
				base: "CNY",
				target: "USD",
				period: 7,
				data_points: [],
				current_rate: null,
			})),
		});
		const tool = createRateTool(rateService);

		const result = await tool.invoke({
			mode: "history",
			base: "CNY",
			target: "USD",
			period: 7,
		});

		expect(result).toContain("暂无历史数据");
	});

	it("history 固定日期和汇率，仅交换两个点的来源，起止与极值归属随之交换", async () => {
		const dataPoints = [
			{ date: "2026-02-12", rate: "0.2102297812", source: "frankfurter-v2-reference" },
			{ date: "2026-02-13", rate: "0.2103", source: "er-api" },
		];
		const swappedPoints = [
			{ ...dataPoints[0], source: dataPoints[1].source },
			{ ...dataPoints[1], source: dataPoints[0].source },
		];
		const getHistory = vi.fn();
		const rateService = buildRateService({
			getHistory: getHistory
				.mockResolvedValueOnce({ data_points: dataPoints })
				.mockResolvedValueOnce({ data_points: swappedPoints }),
		});
		const tool = createRateTool(rateService);
		const input = {
			mode: "history" as const,
			base: "CNY",
			target: "TWD",
			period: 7,
		};
		const original = await tool.invoke(input);
		const swapped = await tool.invoke(input);

		expect(original).toContain("1 个数据点为参考价");
		expect(swapped).toContain("1 个数据点为参考价");
		for (const label of ["起点", "区间最低"]) {
			expect(original).toContain(`${label} 2026-02-12 = 0.2102297812（参考价：frankfurter v2 参考序列）`);
			expect(swapped).toContain(`${label} 2026-02-12 = 0.2102297812（原来源报价：er-api）`);
		}
		for (const label of ["终点", "区间最高"]) {
			expect(original).toContain(`${label} 2026-02-13 = 0.2103（原来源报价：er-api）`);
			expect(swapped).toContain(`${label} 2026-02-13 = 0.2103（参考价：frankfurter v2 参考序列）`);
		}
	});

	it("history 按十进制精确取极值，并保留原始精度和来源", async () => {
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 100_000_000, max: 999_999_999 }), async (whole) => {
				// 同一整数部分的相邻十位小数在 Number 下不可区分。
				const low = `${whole}.0000000001`;
				const high = `${whole}.0000000002`;
				const tool = createRateTool(buildRateService({
					getHistory: vi.fn(async () => ({
						data_points: [
							{ date: "2026-02-12", rate: low, source: "er-api" },
							{ date: "2026-02-13", rate: high, source: "frankfurter-v2-reference" },
						],
					})),
				}));
				const result = await tool.invoke({ mode: "history", base: "USD", target: "TWD" });
				expect(result).toContain(`区间最高 2026-02-13 = ${high}（参考价：frankfurter v2 参考序列）`);
				expect(result).toContain(`区间最低 2026-02-12 = ${low}（原来源报价：er-api）`);
			}),
		);
	});

	it("history 同值极值取最早观测点，缺少来源时明确标注", async () => {
		const tool = createRateTool(buildRateService({
			getHistory: vi.fn(async () => ({
				data_points: [
					{ date: "2026-02-12", rate: "1.00" },
					{ date: "2026-02-13", rate: "1", source: "er-api" },
				],
			})),
		}));
		const result = await tool.invoke({ mode: "history", base: "USD", target: "TWD" });
		expect(result).toContain("起点 2026-02-12 = 1.00（来源未标注）");
		expect(result).toContain("终点 2026-02-13 = 1（原来源报价：er-api）");
		expect(result).toContain("区间最高 2026-02-12 = 1.00（来源未标注）");
		expect(result).toContain("区间最低 2026-02-12 = 1.00（来源未标注）");
	});

	it("history 全部为原来源报价：不含参考价标注", async () => {
		const tool = createRateTool(buildRateService());

		const result = await tool.invoke({
			mode: "history",
			base: "CNY",
			target: "USD",
			period: 30,
		});

		expect(result).not.toContain("参考价");
		expect(result).toContain("起点 2026-01-15 = 7.15（原来源报价：abc）");
		expect(result).toContain("终点 2026-02-13 = 7.12（原来源报价：abc）");
	});

	it("数据源不可用（502）：错误文本回喂而非抛出", async () => {
		const rateService = buildRateService({
			getLatest: vi.fn(() => {
				throw new RateSourceUnavailableException("2026-02-13T00:00:00.000Z");
			}),
		});
		const tool = createRateTool(rateService);

		const result = await tool.invoke({
			mode: "latest",
			base: "CNY",
			targets: ["USD"],
		});

		expect(result).toContain("RATE_SOURCE_UNAVAILABLE");
	});

	it("币对不支持（422）：错误文本回喂而非抛出", async () => {
		const rateService = buildRateService({
			getHistory: vi.fn(() => {
				throw new RatePairUnsupportedException("CNY", "TWD");
			}),
		});
		const tool = createRateTool(rateService);

		const result = await tool.invoke({
			mode: "history",
			base: "CNY",
			target: "TWD",
			period: 30,
		});

		expect(result).toContain("RATE_PAIR_UNSUPPORTED");
	});
});
