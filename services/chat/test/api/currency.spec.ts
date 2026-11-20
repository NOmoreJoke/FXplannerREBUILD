import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURRENCIES } from "@fxplanner-new/money";
import { createTestApp, type TestContext } from "../helpers/test-app";

/**
 * GET /api/currencies 接口测试。
 * 币种为接口的静态数据依赖：beforeAll 按 money 常量 upsert（幂等、不重复手写清单），
 * afterAll 清理本文件写入的行。
 */
describe("CurrencyController（接口）", () => {
	let app: INestApplication;
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await createTestApp();
		app = ctx.app;

		for (const currency of CURRENCIES) {
			await ctx.prisma.currency.upsert({
				where: { code: currency.code },
				create: {
					code: currency.code,
					nameZh: currency.nameZh,
					nameEn: currency.nameEn,
					decimalPlaces: currency.decimalPlaces,
					sortOrder: currency.sortOrder,
				},
				update: {
					nameZh: currency.nameZh,
					nameEn: currency.nameEn,
					decimalPlaces: currency.decimalPlaces,
					sortOrder: currency.sortOrder,
				},
			});
		}
	});

	afterAll(async () => {
		try {
			await ctx.prisma.currency.deleteMany({
				where: { code: { in: CURRENCIES.map((currency) => currency.code) } },
			});
		} finally {
			await app?.close();
		}
	});

	it("无需登录返回 200，items 长度为 15", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/currencies")
			.expect(200);

		expect(Array.isArray(res.body.items)).toBe(true);
		expect(res.body.items).toHaveLength(15);
	});

	it("包含原缺失的 NZD / TWD / CHF", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/currencies")
			.expect(200);

		const codes = res.body.items.map((item: { code: string }) => item.code);
		expect(codes).toContain("NZD");
		expect(codes).toContain("TWD");
		expect(codes).toContain("CHF");
	});

	it("JPY 与 KRW 的 decimalPlaces 为 0，其余为 2", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/currencies")
			.expect(200);

		for (const item of res.body.items as Array<{
			code: string;
			decimalPlaces: number;
		}>) {
			if (item.code === "JPY" || item.code === "KRW") {
				expect(item.decimalPlaces).toBe(0);
			} else {
				expect(item.decimalPlaces).toBe(2);
			}
		}
	});

	it("sortOrder 严格递增且结构含全部 5 个字段", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/currencies")
			.expect(200);

		const items = res.body.items as Array<Record<string, unknown>>;
		let previous = 0;
		for (const item of items) {
			expect(Object.keys(item).sort()).toEqual([
				"code",
				"decimalPlaces",
				"nameEn",
				"nameZh",
				"sortOrder",
			]);
			expect(item.sortOrder).toBeGreaterThan(previous);
			previous = item.sortOrder as number;
		}
	});

	it("响应头带 Cache-Control: public, max-age=3600，重复请求结果一致", async () => {
		const first = await request(app.getHttpServer())
			.get("/api/currencies")
			.expect(200);
		const second = await request(app.getHttpServer())
			.get("/api/currencies")
			.expect(200);

		expect(first.headers["cache-control"]).toBe("public, max-age=3600");
		expect(second.body).toEqual(first.body);
	});
});
