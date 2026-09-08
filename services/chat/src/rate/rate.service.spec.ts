import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { RateService } from "./rate.service";

const decimal = (value: string) => ({ toString: () => value });

describe("RateService", () => {
	let service: RateService;
	let prisma: {
		exchangeRate: {
			findFirst: ReturnType<typeof vi.fn>;
			findMany: ReturnType<typeof vi.fn>;
			upsert: ReturnType<typeof vi.fn>;
			createMany: ReturnType<typeof vi.fn>;
		};
	};
	let provider: {
		fetchLatest: ReturnType<typeof vi.fn>;
		fetchHistory: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		prisma = {
			exchangeRate: {
				findFirst: vi.fn(),
				findMany: vi.fn(),
				upsert: vi.fn(),
				createMany: vi.fn(),
			},
		};
		provider = {
			fetchLatest: vi.fn(),
			fetchHistory: vi.fn(),
		};
		service = new RateService(
			prisma as unknown as PrismaService,
			provider as never,
		);
	});

	it("返回固定支持币种且不暴露内部 Set", () => {
		const supported = service.getSupported();

		// 15 币种，顺序来自 @fxplanner-new/money 的 CURRENCIES（sortOrder 1-15）
		expect(supported).toEqual([
			"HKD",
			"USD",
			"GBP",
			"AUD",
			"CAD",
			"CNY",
			"JPY",
			"EUR",
			"SGD",
			"NZD",
			"TWD",
			"CHF",
			"KRW",
			"THB",
			"MYR",
		]);
		supported.push("TEST");
		expect(service.getSupported()).not.toContain("TEST");
	});

	it("优先返回 24 小时内的数据库报价", async () => {
		const observedAt = new Date(Date.now() - 1_000);
		prisma.exchangeRate.findFirst.mockResolvedValue({
			base: "CAD",
			quote: "USD",
			rate: decimal("0.7300000000"),
			source: "frankfurter",
			observedAt,
		});

		const result = await service.getLatest("cad");

		expect(provider.fetchLatest).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			base: "CAD",
			target: "USD",
			rate: "0.7300000000",
			rate_to_usd: "0.7300000000",
		});
	});

	it("数据库没有新报价时调用 Provider 并以字符串写入 Decimal", async () => {
		const observedAt = new Date();
		prisma.exchangeRate.findFirst.mockResolvedValue(null);
		provider.fetchLatest.mockResolvedValue({
			base: "EUR",
			quote: "USD",
			rate: "1.0850000000",
			source: "frankfurter",
			observedAt,
		});
		prisma.exchangeRate.upsert.mockResolvedValue({
			base: "EUR",
			quote: "USD",
			rate: decimal("1.0850000000"),
			source: "frankfurter",
			observedAt,
		});

		const result = await service.getLatest("EUR");

		expect(provider.fetchLatest).toHaveBeenCalledWith("EUR", "USD");
		expect(prisma.exchangeRate.upsert).toHaveBeenCalledWith({
			where: {
				base_quote_observedAt: {
					base: "EUR",
					quote: "USD",
					observedAt,
				},
			},
			create: {
				base: "EUR",
				quote: "USD",
				rate: "1.0850000000",
				source: "frankfurter",
				observedAt,
			},
			update: {
				rate: "1.0850000000",
				source: "frankfurter",
			},
		});
		expect(result.rate).toBe("1.0850000000");
	});

	it("缓存过期但报价日相同，使用 upsert 更新原记录", async () => {
		const observedAt = new Date(Date.now() - 2 * 86_400_000);
		prisma.exchangeRate.findFirst.mockResolvedValue({
			base: "CAD",
			quote: "USD",
			rate: decimal("0.7200000000"),
			source: "frankfurter",
			observedAt,
		});
		provider.fetchLatest.mockResolvedValue({
			base: "CAD",
			quote: "USD",
			rate: "0.7300000000",
			source: "frankfurter",
			observedAt,
		});
		prisma.exchangeRate.upsert.mockResolvedValue({
			base: "CAD",
			quote: "USD",
			rate: decimal("0.7300000000"),
			source: "frankfurter",
			observedAt,
		});

		const result = await service.getLatest("CAD");

		expect(prisma.exchangeRate.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					base_quote_observedAt: {
						base: "CAD",
						quote: "USD",
						observedAt,
					},
				},
			}),
		);
		expect(result.rate).toBe("0.7300000000");
	});

	it("查询历史时缓存未命中则获取并保存时间序列", async () => {
		const firstObservedAt = new Date(Date.now() - 86_400_000);
		const secondObservedAt = new Date(Date.now() - 43_200_000);
		prisma.exchangeRate.findMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{
					rate: decimal("7.2000000000"),
					observedAt: firstObservedAt,
				},
				{
					rate: decimal("7.2500000000"),
					observedAt: secondObservedAt,
				},
			]);
		provider.fetchHistory.mockResolvedValue([
			{ rate: "7.2000000000", observedAt: firstObservedAt },
			{ rate: "7.2500000000", observedAt: secondObservedAt },
		]);
		prisma.exchangeRate.createMany.mockResolvedValue({ count: 2 });

		const result = await service.getHistory("usd", "cny", 7);

		expect(provider.fetchHistory).toHaveBeenCalledWith(
			"USD",
			"CNY",
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
		);
		expect(prisma.exchangeRate.createMany).toHaveBeenCalledWith({
			data: [
				{
					base: "USD",
					quote: "CNY",
					rate: "7.2000000000",
					source: "frankfurter",
					observedAt: firstObservedAt,
				},
				{
					base: "USD",
					quote: "CNY",
					rate: "7.2500000000",
					source: "frankfurter",
					observedAt: secondObservedAt,
				},
			],
			skipDuplicates: true,
		});
		expect(result).toMatchObject({
			base: "USD",
			target: "CNY",
			period: 7,
			current_rate: "7.2500000000",
		});
		expect(result.data_points).toHaveLength(2);
	});

	it("部分历史缓存不会直接返回，而是继续从 Provider 补齐", async () => {
		const partialObservedAt = new Date(Date.now() - 3 * 86_400_000);
		prisma.exchangeRate.findMany
			.mockResolvedValueOnce([
				{ rate: decimal("7.2000000000"), observedAt: partialObservedAt },
			])
			.mockResolvedValueOnce([
				{ rate: decimal("7.2000000000"), observedAt: partialObservedAt },
			]);
		provider.fetchHistory.mockResolvedValue([]);

		await service.getHistory("USD", "CNY", 7);

		expect(provider.fetchHistory).toHaveBeenCalledWith(
			"USD",
			"CNY",
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
		);
	});

	it("拒绝不支持的币种和周期", async () => {
		await expect(service.getLatest("XYZ")).rejects.toBeInstanceOf(
			BadRequestException,
		);
		await expect(service.getHistory("USD", "CNY", 15)).rejects.toBeInstanceOf(
			BadRequestException,
		);
		expect(provider.fetchLatest).not.toHaveBeenCalled();
	});
});
