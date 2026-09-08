import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { createTestApp, type TestContext } from "../helpers/test-app";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RateController } from "../../src/rate/rate.controller";
import { RateService } from "../../src/rate/rate.service";

describe("RateController（接口）", () => {
	let app: INestApplication;
	let realCtx: TestContext;
	let realApp: INestApplication;
	const rateService = {
		getSupported: vi.fn(() => ["USD", "CNY", "EUR"]),
		getLatest: vi.fn(async (base: string) => ({
			base: base.toUpperCase(),
			target: "USD",
			rate: "0.7300",
			source: "frankfurter",
		})),
		getHistory: vi.fn(async (base: string, target: string, period: number) => ({
			base,
			target,
			period,
			data_points: [],
		})),
	};

	beforeAll(async () => {
		const moduleRef = await Test.createTestingModule({
			controllers: [RateController],
			providers: [{ provide: RateService, useValue: rateService }],
		}).compile();

		app = moduleRef.createNestApplication();
		app.setGlobalPrefix("api");
		app.useGlobalPipes(
			new ValidationPipe({ transform: true, whitelist: true }),
		);
		await app.init();
		realCtx = await createTestApp();
		realApp = realCtx.app;
	});

	afterAll(async () => {
		await realCtx.prisma.exchangeRate.deleteMany({
			where: { base: "USD", quote: "USD" },
		});
		await realApp.close();
		await app.close();
	});

	it("真实 AppModule 的 latest/USD 能落库并返回字符串汇率", async () => {
		await realCtx.prisma.exchangeRate.deleteMany({
			where: { base: "USD", quote: "USD" },
		});

		const res = await request(realApp.getHttpServer())
			.get("/api/rates/latest/USD")
			.expect(200);

		expect(res.body).toMatchObject({
			success: true,
			data: {
				base: "USD",
				target: "USD",
				rate: "1",
			},
		});
		const saved = await realCtx.prisma.exchangeRate.findFirst({
			where: { base: "USD", quote: "USD" },
		});
		expect(saved?.rate.toString()).toBe("1");
	});

	it("GET /api/rates/supported 返回固定币种数组", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/rates/supported")
			.expect(200);

		expect(res.body).toMatchObject({
			success: true,
			data: ["USD", "CNY", "EUR"],
		});
	});

	it("GET /api/rates/latest/:base 转发基础币种并统一响应结构", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/rates/latest/cad")
			.expect(200);

		expect(rateService.getLatest).toHaveBeenCalledWith("cad");
		expect(res.body).toMatchObject({
			success: true,
			data: { base: "CAD", rate: "0.7300" },
		});
	});

	it("GET /api/rates/history 转换查询参数并校验周期", async () => {
		await request(app.getHttpServer())
			.get("/api/rates/history?base=usd&target=cny&period=7")
			.expect(200);

		expect(rateService.getHistory).toHaveBeenCalledWith("USD", "CNY", 7);

		await request(app.getHttpServer())
			.get("/api/rates/history?base=USD&target=CNY&period=15")
			.expect(400);
	});
});
