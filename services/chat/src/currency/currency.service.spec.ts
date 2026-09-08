import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { CurrencyService } from "./currency.service";

const CURRENCY_ROWS = [
	{
		code: "HKD",
		nameZh: "港币",
		nameEn: "Hong Kong Dollar",
		decimalPlaces: 2,
		sortOrder: 1,
		isActive: true,
	},
	{
		code: "JPY",
		nameZh: "日元",
		nameEn: "Japanese Yen",
		decimalPlaces: 0,
		sortOrder: 7,
		isActive: true,
	},
	{
		code: "MYR",
		nameZh: "马来西亚林吉特",
		nameEn: "Malaysian Ringgit",
		decimalPlaces: 2,
		sortOrder: 15,
		isActive: true,
	},
];

describe("CurrencyService", () => {
	let service: CurrencyService;
	let findMany: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		findMany = vi.fn().mockResolvedValue(CURRENCY_ROWS);
		service = new CurrencyService({
			currency: { findMany },
		} as unknown as PrismaService);
	});

	it("仅查询 isActive=true 且按 sortOrder 升序", async () => {
		const items = await service.listActiveCurrencies();

		expect(findMany).toHaveBeenCalledTimes(1);
		expect(findMany).toHaveBeenCalledWith({
			where: { isActive: true },
			orderBy: { sortOrder: "asc" },
		});
		expect(items.map((item) => item.code)).toEqual(["HKD", "JPY", "MYR"]);
	});

	it("映射出全部 5 个契约字段且不泄露 isActive 等内部列", async () => {
		const items = await service.listActiveCurrencies();

		expect(items[0]).toEqual({
			code: "HKD",
			nameZh: "港币",
			nameEn: "Hong Kong Dollar",
			decimalPlaces: 2,
			sortOrder: 1,
		});
		expect(Object.keys(items[0]).sort()).toEqual([
			"code",
			"decimalPlaces",
			"nameEn",
			"nameZh",
			"sortOrder",
		]);
	});

	it("进程内缓存命中：第二次调用不再查库，且结果一致", async () => {
		const first = await service.listActiveCurrencies();
		const second = await service.listActiveCurrencies();

		expect(findMany).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
	});
});
