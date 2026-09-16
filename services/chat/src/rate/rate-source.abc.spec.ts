import { BadGatewayException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ABC_PUBLISH_TIME,
	ABC_SAMPLE_FIXTURE,
	ABC_SAMPLE_ROWS,
} from "../../test/helpers/rate-source-fixtures";
import { ABC_RATE_TIMEOUT_MS, ABC_RATE_URL } from "./rate.constants";
import { AbcSource, type AbcTransport } from "./rate-source.abc";

/** 固定时钟：实测样本 PublishTime − 60s（有效过去时刻；+60s 容差边界用例在此基础上推） */
const NOW = new Date("2026-09-15T02:27:54.000Z").getTime();

/** 构造一行全表记录（默认价格 100.00000000/101.00000000，可覆写任意字段） */
const sampleRow = (code: string, overrides: Record<string, unknown> = {}) => ({
	CurrName: `测试(${code})`,
	BenchMarkPrice: "100.00000000",
	SellPrice: "101.00000000",
	PublishTime: "2026-09-15T10:26:54+08:00",
	...overrides,
});

const tableBody = (rows: unknown[]) =>
	JSON.stringify({ ErrorCode: "0", ErrorMsg: "", Data: { Table: rows } });

const okTransport = (body: string): AbcTransport => vi.fn(async () => body);

const failTransport = (error: unknown): AbcTransport =>
	vi.fn(async () => {
		throw error;
	});

const mkSource = (transport: AbcTransport, nowMs: number = NOW) =>
	new AbcSource({ transport, now: () => nowMs });

describe("AbcSource（农行牌价主源）", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("全表解析", () => {
		it("CurrName 正则提取括号内币种码；无法识别格式的行被过滤", async () => {
			const table = tableBody([
				sampleRow("USD"),
				{
					CurrName: "离岸人民币",
					BenchMarkPrice: "1.0",
					PublishTime: "2026-09-15T10:26:54+08:00",
				},
				{
					CurrName: "美元(usd)",
					BenchMarkPrice: "671.0",
					PublishTime: "2026-09-15T10:26:54+08:00",
				},
			]);
			const batch = await mkSource(okTransport(table)).fetchLatestBatch("CNY", [
				"USD",
			]);

			expect(Object.keys(batch.quotes)).toEqual(["USD"]);
			expect(batch.source).toBe("abc");
		});

		it("百外币单位 ÷ 100：实测样本归一化，raw 保留百单位原值", async () => {
			const source = mkSource(okTransport(JSON.stringify(ABC_SAMPLE_FIXTURE)));
			const batch = await source.fetchLatestBatch("CNY", ["USD", "HKD", "JPY"]);

			expect(batch.quotes.USD.rate).toBe(ABC_SAMPLE_ROWS.USD.rate);
			expect(batch.quotes.HKD.rate).toBe(ABC_SAMPLE_ROWS.HKD.rate);
			expect(batch.quotes.JPY.rate).toBe(ABC_SAMPLE_ROWS.JPY.rate);
			expect(batch.quotes.USD.raw).toBe("671.05500000");
		});

		it("双价映射：BenchMarkPrice→rate、SellPrice→sellRate", async () => {
			const source = mkSource(okTransport(JSON.stringify(ABC_SAMPLE_FIXTURE)));
			const batch = await source.fetchLatestBatch("CNY", ["USD", "HKD", "JPY"]);

			expect(batch.quotes.USD.sellRate).toBe(ABC_SAMPLE_ROWS.USD.sellRate);
			expect(batch.quotes.HKD.sellRate).toBe(ABC_SAMPLE_ROWS.HKD.sellRate);
			expect(batch.quotes.JPY.sellRate).toBe(ABC_SAMPLE_ROWS.JPY.sellRate);
		});

		it("SellPrice 缺失或空串：该项无 sellRate 键（有值才写）", async () => {
			const table = tableBody([
				sampleRow("USD", { SellPrice: "" }),
				{
					CurrName: "港元(HKD)",
					BenchMarkPrice: "85.53400000",
					PublishTime: "2026-09-15T10:26:54+08:00",
				},
			]);
			const batch = await mkSource(okTransport(table)).fetchLatestBatch("CNY", [
				"USD",
				"HKD",
			]);

			expect("sellRate" in batch.quotes.USD).toBe(false);
			expect("sellRate" in batch.quotes.HKD).toBe(false);
		});

		it("PublishTime 带时区转 UTC observedAt", async () => {
			const source = mkSource(okTransport(JSON.stringify(ABC_SAMPLE_FIXTURE)));
			const batch = await source.fetchLatestBatch("CNY", ["USD"]);

			expect(batch.quotes.USD.observedAt.toISOString()).toBe(
				"2026-09-15T02:26:54.000Z",
			);
			expect(batch.quotes.USD.observedAt.getTime()).toBe(
				ABC_PUBLISH_TIME.getTime(),
			);
		});

		it("任意 base 同表折算：HKD base 的 USD = (USD→CNY)/(HKD→CNY)，同一 PublishTime；卖出价不折算", async () => {
			const source = mkSource(okTransport(JSON.stringify(ABC_SAMPLE_FIXTURE)));
			const batch = await source.fetchLatestBatch("HKD", ["USD", "JPY"]);

			// 671.055 ÷ 85.534 与 4.336 ÷ 85.534（定点运算，10 位）
			expect(batch.quotes.USD.rate).toBe("7.8454766526");
			expect(batch.quotes.JPY.rate).toBe("0.0506932916");
			// 同一次全表响应内折算：时点一致（同一 PublishTime）
			expect(batch.quotes.USD.observedAt.getTime()).toBe(
				ABC_PUBLISH_TIME.getTime(),
			);
			expect(batch.quotes.JPY.observedAt.getTime()).toBe(
				ABC_PUBLISH_TIME.getTime(),
			);
			// 折算价无银行单边卖出价语义：不携带 sellRate
			expect("sellRate" in batch.quotes.USD).toBe(false);
		});

		it("base=CNY 直接价：rate 即对 CNY 牌价换算值", async () => {
			const source = mkSource(okTransport(JSON.stringify(ABC_SAMPLE_FIXTURE)));
			const batch = await source.fetchLatestBatch("CNY", ["USD"]);

			expect(batch.quotes.USD.rate).toBe("6.7105500000");
			expect(batch.quotes.USD.sellRate).toBe("6.7253100000");
		});
	});

	describe("错误与有效性校验（一律 502，不入库不返回）", () => {
		it('ErrorCode != "0" → 502（透出错误码）', async () => {
			const source = mkSource(
				okTransport(
					JSON.stringify({ ErrorCode: "1", ErrorMsg: "system busy", Data: {} }),
				),
			);

			await expect(
				source.fetchLatestBatch("CNY", ["USD"]),
			).rejects.toThrowError(BadGatewayException);
			await expect(
				mkSource(
					okTransport(JSON.stringify({ ErrorCode: "1" })),
				).fetchLatestBatch("CNY", ["USD"]),
			).rejects.toThrow("1");
		});

		it("传输层非 2xx / 网络失败 → 502", async () => {
			await expect(
				mkSource(
					failTransport(new BadGatewayException("ABC 汇率源响应状态 503")),
				).fetchLatestBatch("CNY", ["USD"]),
			).rejects.toThrow("响应状态 503");
			await expect(
				mkSource(failTransport(new Error("socket hang up"))).fetchLatestBatch(
					"CNY",
					["USD"],
				),
			).rejects.toThrow("socket hang up");
		});

		it("响应体非 JSON → 502（无法解析的响应）", async () => {
			await expect(
				mkSource(okTransport("<html>gateway error</html>")).fetchLatestBatch(
					"CNY",
					["USD"],
				),
			).rejects.toThrow("无法解析的响应");
		});

		it("响应缺 Data.Table → 502（缺少牌价表）", async () => {
			await expect(
				mkSource(
					okTransport(JSON.stringify({ ErrorCode: "0", Data: {} })),
				).fetchLatestBatch("CNY", ["USD"]),
			).rejects.toThrow("缺少牌价表");
		});

		it("基准价缺失/≤0/不可解析：涉及行无效 → 502", async () => {
			for (const price of [undefined, "0", "abc"]) {
				const overrides =
					price === undefined
						? { BenchMarkPrice: undefined }
						: { BenchMarkPrice: price };
				const source = mkSource(
					okTransport(tableBody([sampleRow("USD", overrides)])),
				);
				await expect(source.fetchLatestBatch("CNY", ["USD"])).rejects.toThrow(
					"无效牌价",
				);
			}
		});

		it("卖出价不可解析：涉及行无效 → 502", async () => {
			const source = mkSource(
				okTransport(tableBody([sampleRow("USD", { SellPrice: "N/A" })])),
			);

			await expect(source.fetchLatestBatch("CNY", ["USD"])).rejects.toThrow(
				"无效牌价",
			);
		});

		it("PublishTime 缺失：涉及行无效 → 502", async () => {
			const source = mkSource(
				okTransport(tableBody([sampleRow("USD", { PublishTime: undefined })])),
			);

			await expect(source.fetchLatestBatch("CNY", ["USD"])).rejects.toThrow(
				"无效牌价",
			);
		});

		it("无关币种的无效行不拖垮本次请求；涉及行才拒绝", async () => {
			const table = tableBody([
				sampleRow("USD"),
				sampleRow("THB", { BenchMarkPrice: "0" }),
			]);
			const source = mkSource(okTransport(table));

			const batch = await source.fetchLatestBatch("CNY", ["USD"]);
			expect(batch.quotes.USD.rate).toBe("1.0000000000");

			await expect(source.fetchLatestBatch("CNY", ["THB"])).rejects.toThrow(
				"无效牌价",
			);
		});

		it("PublishTime 恰好未来 +60s（时钟漂移容差边界）：放行", async () => {
			const atDeadline = new Date(NOW + 60_000).toISOString();
			const source = mkSource(
				okTransport(tableBody([sampleRow("USD", { PublishTime: atDeadline })])),
			);
			const batch = await source.fetchLatestBatch("CNY", ["USD"]);

			expect(batch.quotes.USD.observedAt.toISOString()).toBe(atDeadline);
		});

		it("PublishTime 超过 +61s（未来报价）：涉及行 → 502", async () => {
			const future = new Date(NOW + 61_000).toISOString();
			const source = mkSource(
				okTransport(tableBody([sampleRow("USD", { PublishTime: future })])),
			);

			await expect(source.fetchLatestBatch("CNY", ["USD"])).rejects.toThrow(
				"无效牌价",
			);
		});
	});

	describe("防滥用：全局并发 1 + 最小外呼间隔 10s", () => {
		it("进行中外呼被并发请求复用：仅 1 次真实外呼", async () => {
			let resolveTable!: (body: string) => void;
			const transport = vi.fn(
				() =>
					new Promise<string>((resolve) => {
						resolveTable = resolve;
					}),
			);
			const source = new AbcSource({ transport, now: () => NOW });

			const first = source.fetchLatestBatch("CNY", ["USD"]);
			const second = source.fetchLatestBatch("CNY", ["USD"]);
			resolveTable(tableBody([sampleRow("USD")]));
			const [batchA, batchB] = await Promise.all([first, second]);

			expect(transport).toHaveBeenCalledTimes(1);
			expect(batchA.quotes.USD.rate).toBe("1.0000000000");
			expect(batchB.quotes.USD.rate).toBe("1.0000000000");
		});

		it("最小间隔 10s 内复用最近一次成功全表（lastTable）；间隔过后才再次外呼", async () => {
			let nowMs = NOW;
			const transport = vi.fn(async () => tableBody([sampleRow("USD")]));
			const source = new AbcSource({ transport, now: () => nowMs });

			await source.fetchLatestBatch("CNY", ["USD"]);
			expect(transport).toHaveBeenCalledTimes(1);

			// +5s（间隔内）：复用最近一次成功全表，不外呼
			nowMs = NOW + 5_000;
			await source.fetchLatestBatch("CNY", ["USD"]);
			expect(transport).toHaveBeenCalledTimes(1);

			// +15s（超过间隔）：发起第二次真实外呼
			nowMs = NOW + 15_001;
			await source.fetchLatestBatch("CNY", ["USD"]);
			expect(transport).toHaveBeenCalledTimes(2);
		});

		it("首呼失败后的间隔窗口内快速失败（不重试）；间隔过后恢复外呼", async () => {
			let nowMs = NOW;
			const transport = vi
				.fn<AbcTransport>()
				.mockRejectedValueOnce(new Error("first blowup"))
				.mockResolvedValue(tableBody([sampleRow("USD")]));
			const source = new AbcSource({ transport, now: () => nowMs });

			await expect(source.fetchLatestBatch("CNY", ["USD"])).rejects.toThrow(
				"first blowup",
			);

			// 间隔内：无成功全表可复用 → 快速失败，不发起第二次外呼
			nowMs = NOW + 1_000;
			await expect(source.fetchLatestBatch("CNY", ["USD"])).rejects.toThrow(
				"最小外呼间隔",
			);
			expect(transport).toHaveBeenCalledTimes(1);

			// 间隔过后：允许重试并成功
			nowMs = NOW + 10_001;
			const batch = await source.fetchLatestBatch("CNY", ["USD"]);
			expect(transport).toHaveBeenCalledTimes(2);
			expect(batch.quotes.USD.rate).toBe("1.0000000000");
		});
	});

	it("超时 6s：ABC_RATE_TIMEOUT_MS 透传给传输函数；可注入覆盖", async () => {
		const transport = vi.fn(async () => tableBody([sampleRow("USD")]));
		await mkSource(transport).fetchLatestBatch("CNY", ["USD"]);

		expect(ABC_RATE_TIMEOUT_MS).toBe(6_000);
		expect(transport).toHaveBeenCalledWith(ABC_RATE_URL, ABC_RATE_TIMEOUT_MS);

		const custom = vi.fn(async () => tableBody([sampleRow("USD")]));
		await new AbcSource({
			transport: custom,
			timeoutMs: 1234,
			now: () => NOW,
		}).fetchLatestBatch("CNY", ["USD"]);
		expect(custom).toHaveBeenCalledWith(ABC_RATE_URL, 1234);
	});

	it("无历史接口：fetchHistory 返回空数组（历史靠本地落库积累）", async () => {
		const source = mkSource(okTransport(tableBody([sampleRow("USD")])));

		await expect(
			source.fetchHistory("CNY", "USD", "2026-09-01", "2026-09-15"),
		).resolves.toEqual([]);
	});
});
