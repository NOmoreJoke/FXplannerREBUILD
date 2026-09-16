import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { createTestApp, type TestContext } from "../helpers/test-app";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ABC_RATE_URL, ERAPI_RATE_URL } from "../../src/rate/rate.constants";
import {
	RATE_PROVIDER_TIMEOUT_TOKEN,
	RateProvider,
} from "../../src/rate/rate.provider";
import { RateController } from "../../src/rate/rate.controller";
import { RateService } from "../../src/rate/rate.service";
import {
	ABC_SAMPLE_FIXTURE,
	createRateSourceFetchStub,
	erApiLatestBody,
	frankfurterLatestBody,
	jsonResponse,
	type RateSourceRoutes,
} from "../helpers/rate-source-fixtures";

// 15 币种全量 + 1 个重复，用于验证 targets 超量 400
const SIXTEEN_TARGETS =
	"HKD,USD,GBP,AUD,CAD,CNY,JPY,EUR,SGD,NZD,TWD,CHF,KRW,THB,MYR,CNY";

describe("RateController（接口）", () => {
	let app: INestApplication;
	let realCtx: TestContext;
	let realApp: INestApplication;
	const rateService = {
		getSupported: vi.fn(() => ["USD", "CNY", "EUR"]),
		getLatest: vi.fn(
			async (base: string, targets?: string[], _refresh?: boolean) => {
				if (targets && targets.length > 1) {
					return {
						base: base.toUpperCase(),
						items: targets.map((target) => ({
							target,
							rate: "0.13910462",
							source: "frankfurter",
							observedAt: "2026-02-13T00:00:00.000Z",
							validUntil: "2026-02-16T08:05:00.000Z",
							fresh: true,
						})),
					};
				}
				return {
					base: base.toUpperCase(),
					target: (targets?.[0] ?? "USD").toUpperCase(),
					rate: "0.73000000",
					source: "frankfurter",
					observedAt: "2026-02-13T00:00:00.000Z",
					validUntil: "2026-02-16T08:05:00.000Z",
					fresh: true,
				};
			},
		),
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

	it("真实 AppModule 的 latest/USD 恒等报价：rate=1、落库、窗口内重复请求不再落库", async () => {
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
				source: "identity",
				fresh: true,
			},
		});
		expect(res.body.data.observedAt).toBeTruthy();
		expect(res.body.data.validUntil).toBeTruthy();

		const saved = await realCtx.prisma.exchangeRate.findFirst({
			where: { base: "USD", quote: "USD" },
		});
		expect(saved?.rate.toString()).toBe("1");
		expect(saved?.source).toBe("identity");

		// 5 分钟窗口内重复请求：命中缓存，不再产生新落库
		const second = await request(realApp.getHttpServer())
			.get("/api/rates/latest/USD")
			.expect(200);
		expect(second.body.data.rate).toBe("1");
		const count = await realCtx.prisma.exchangeRate.count({
			where: { base: "USD", quote: "USD" },
		});
		expect(count).toBe(1);
	});

	it("真实 AppModule 拒绝不支持的基准币种（400）", async () => {
		await request(realApp.getHttpServer())
			.get("/api/rates/latest/XYZ")
			.expect(400);
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

	it("GET /api/rates/latest/:base 缺省单目标：转发 base、平铺结构", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/rates/latest/cad")
			.expect(200);

		expect(rateService.getLatest).toHaveBeenCalledWith("cad", undefined, false);
		expect(res.body).toMatchObject({
			success: true,
			data: {
				base: "CAD",
				target: "USD",
				rate: "0.73000000",
				source: "frankfurter",
				fresh: true,
			},
		});
		// 平铺结构不再携带旧别名
		expect(res.body.data).not.toHaveProperty("rate_to_usd");
		expect(res.body.data).not.toHaveProperty("fetched_at");
		expect(res.body.data).not.toHaveProperty("quote");
	});

	it("GET /api/rates/latest/:base 多目标：targets/refresh 透传，items 结构", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/rates/latest/CNY?targets=USD,JPY&refresh=true")
			.expect(200);

		expect(rateService.getLatest).toHaveBeenCalledWith(
			"CNY",
			["USD", "JPY"],
			true,
		);
		expect(res.body).toMatchObject({
			success: true,
			data: {
				base: "CNY",
				items: [
					{ target: "USD", rate: "0.13910462", fresh: true },
					{ target: "JPY", rate: "0.13910462", fresh: true },
				],
			},
		});
	});

	it("targets 含不支持币种或超量：400", async () => {
		await request(app.getHttpServer())
			.get("/api/rates/latest/USD?targets=CNY,BAD")
			.expect(400);
		await request(app.getHttpServer())
			.get(`/api/rates/latest/USD?targets=${SIXTEEN_TARGETS}`)
			.expect(400);
		await request(app.getHttpServer())
			.get("/api/rates/latest/USD?refresh=yes")
			.expect(400);
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

	// ── realtime-rate 多源升级追加用例（方案 §8.2）：仅追加，既有用例断言不动 ──
	// 装配：真实 AppModule + overrideProvider(RateProvider) 注入 fetch stub（按 URL 路由三源，不发真实请求）。
	describe("三源路由契约（真实 AppModule + fetch stub）", () => {
		// 可热切换的三源路由行为（健康/失败场景按用例覆写）
		const multiRoutes: RateSourceRoutes = {};
		const multiStub = createRateSourceFetchStub(multiRoutes);
		const countSourceCalls = (stub: ReturnType<typeof vi.fn>, prefix: string) =>
			stub.mock.calls.filter(([url]) => String(url).startsWith(prefix)).length;

		let multiApp: INestApplication;
		// 失败场景专用实例：AbcSource 首呼即失败，避开最小间隔内的成功全表复用
		let failureRoutes: RateSourceRoutes;
		let failureApp: INestApplication;
		let degradedApp: INestApplication;

		const buildRateApp = async (
			rateSourceEnv: string,
			stub: ReturnType<typeof vi.fn>,
		): Promise<TestContext> => {
			const previous = process.env.RATE_SOURCE;
			process.env.RATE_SOURCE = rateSourceEnv;
			try {
				return await createTestApp((builder) =>
					builder.overrideProvider(RateProvider).useFactory({
						factory: (timeoutMs: number) =>
							new RateProvider(timeoutMs, stub as unknown as typeof fetch),
						inject: [RATE_PROVIDER_TIMEOUT_TOKEN],
					}),
				);
			} finally {
				if (previous === undefined) delete process.env.RATE_SOURCE;
				else process.env.RATE_SOURCE = previous;
			}
		};

		const defaultMultiRoutes = () => {
			multiRoutes.abc = async () => jsonResponse(ABC_SAMPLE_FIXTURE);
			multiRoutes.erApi = async () =>
				jsonResponse(erApiLatestBody({ TWD: "4.5023" }));
			multiRoutes.frankfurter = async () =>
				jsonResponse(frankfurterLatestBody("2026-09-15", { MYR: "0.6102" }));
		};

		beforeAll(async () => {
			// 清理本组用例的落库残留（含上次运行可能留下的行），避免唯一约束/窗口污染
			await realCtx.prisma.exchangeRate.deleteMany({
				where: { base: "CNY", quote: { in: ["USD", "TWD", "MYR"] } },
			});

			defaultMultiRoutes();
			multiApp = (await buildRateApp("multi", multiStub)).app;

			failureRoutes = {
				abc: async () => jsonResponse({ message: "abc down" }, 500),
			};
			failureApp = (
				await buildRateApp("multi", createRateSourceFetchStub(failureRoutes))
			).app;
			// er-api 缺省应答（失败场景按需热切换）
			failureRoutes.erApi = async () =>
				jsonResponse(erApiLatestBody({ TWD: "4.5023" }));
		});

		afterAll(async () => {
			await realCtx.prisma.exchangeRate.deleteMany({
				where: { base: "CNY", quote: { in: ["USD", "TWD", "MYR"] } },
			});
			await multiApp?.close();
			await failureApp?.close();
			await degradedApp?.close();
		});

		it("多源缺省 targets=USD 走 abc：rate=基准价、sellRate 返回、source=abc（§8.2 行1）", async () => {
			const res = await request(multiApp.getHttpServer())
				.get("/api/rates/latest/CNY?refresh=true")
				.expect(200);

			expect(res.body).toMatchObject({
				success: true,
				data: {
					base: "CNY",
					target: "USD",
					rate: "6.71055",
					sellRate: "6.72531",
					source: "abc",
					observedAt: "2026-09-15T02:26:54.000Z",
					fresh: true,
				},
			});
		});

		it("混合组：USD/TWD/MYR 分别 source=abc/er-api/frankfurter，仅 abc 项含 sellRate，observedAt 精度各异（§8.2 行2）", async () => {
			const res = await request(multiApp.getHttpServer())
				.get("/api/rates/latest/CNY?targets=USD,TWD,MYR&refresh=true")
				.expect(200);

			const items = res.body.data.items;
			expect(items.map((item: { target: string }) => item.target)).toEqual([
				"USD",
				"TWD",
				"MYR",
			]);
			// abc 项：秒级发布时间 + sellRate（8 位）
			expect(items[0]).toMatchObject({
				source: "abc",
				rate: "6.71055",
				sellRate: "6.72531",
				observedAt: "2026-09-15T02:26:54.000Z",
			});
			// er-api 项：日精度发布时间，响应不含 sellRate 键（非 null）
			expect(items[1]).toMatchObject({
				source: "er-api",
				rate: "4.5023",
				observedAt: "2026-09-15T00:00:00.000Z",
			});
			expect(items[1]).not.toHaveProperty("sellRate");
			// frankfurter 项：日精度发布时间，无 sellRate
			expect(items[2]).toMatchObject({
				source: "frankfurter",
				rate: "0.6102",
				observedAt: "2026-09-15T00:00:00.000Z",
			});
			expect(items[2]).not.toHaveProperty("sellRate");
			// source 值域（§4.1）
			for (const item of items) {
				expect(["abc", "er-api", "frankfurter", "identity"]).toContain(
					item.source,
				);
			}
		});

		it("ABC 最小外呼间隔：10s 内重复 refresh=true 第二次无真实外呼（§8.2 行5）", async () => {
			await request(multiApp.getHttpServer())
				.get("/api/rates/latest/CNY?refresh=true")
				.expect(200);
			const abcCallsAfterFirst = countSourceCalls(multiStub, ABC_RATE_URL);

			await request(multiApp.getHttpServer())
				.get("/api/rates/latest/CNY?refresh=true")
				.expect(200);

			// 第二次复用最近一次成功全表：外呼计数零增量
			expect(countSourceCalls(multiStub, ABC_RATE_URL)).toBe(
				abcCallsAfterFirst,
			);
		});

		it("er-api 失败单目标：502 上抛含 lastObservedAt（§8.2 行3）", async () => {
			// 热切换 er-api 为失败应答，结束后恢复
			const healthyErApi = failureRoutes.erApi;
			failureRoutes.erApi = async () => jsonResponse({ result: "error" }, 200);
			try {
				// 播种 TWD 历史行：502 响应体应透出库中最后报价时间
				await realCtx.prisma.exchangeRate.deleteMany({
					where: { base: "CNY", quote: "TWD" },
				});
				await realCtx.prisma.exchangeRate.create({
					data: {
						base: "CNY",
						quote: "TWD",
						rate: "4.4823000000",
						source: "er-api",
						observedAt: new Date("2026-02-13T00:00:00.000Z"),
					},
				});

				const res = await request(failureApp.getHttpServer())
					.get("/api/rates/latest/CNY?targets=TWD&refresh=true")
					.expect(502);

				expect(res.body).toMatchObject({
					code: "RATE_SOURCE_UNAVAILABLE",
					lastObservedAt: "2026-02-13T00:00:00.000Z",
				});
			} finally {
				failureRoutes.erApi = healthyErApi;
			}
		});

		it("ABC 失败多目标：USD 项 502 下沉、TWD 照常返回（部分降级，§8.2 行4）", async () => {
			const res = await request(failureApp.getHttpServer())
				.get("/api/rates/latest/CNY?targets=USD,TWD&refresh=true")
				.expect(200);

			const items = res.body.data.items;
			expect(items[0]).toMatchObject({
				target: "USD",
				error: { code: "RATE_SOURCE_UNAVAILABLE" },
			});
			expect(items[1]).toMatchObject({
				target: "TWD",
				rate: "4.5023",
				source: "er-api",
			});
		});

		describe("RATE_SOURCE=frankfurter 整组单源降级（§8.2 行8）", () => {
			let degradedStub: ReturnType<typeof vi.fn>;

			beforeAll(async () => {
				const degradedRoutes: RateSourceRoutes = {
					abc: async () => {
						throw new Error("降级模式不应外呼 ABC");
					},
					erApi: async () => {
						throw new Error("降级模式不应外呼 er-api");
					},
					frankfurter: async () =>
						jsonResponse(
							frankfurterLatestBody("2026-09-15", { USD: "0.1391" }),
						),
				};
				degradedStub = createRateSourceFetchStub(degradedRoutes);
				degradedApp = (await buildRateApp("frankfurter", degradedStub)).app;
			});

			it("整组单源：USD 也走 frankfurter，TWD 缺币种下沉 422 语义、ABC/er-api 零外呼", async () => {
				const res = await request(degradedApp.getHttpServer())
					.get("/api/rates/latest/CNY?targets=USD,TWD&refresh=true")
					.expect(200);

				const items = res.body.data.items;
				expect(items[0]).toMatchObject({
					target: "USD",
					rate: "0.1391",
					source: "frankfurter",
				});
				expect(items[0]).not.toHaveProperty("sellRate");
				expect(items[1]).toMatchObject({
					target: "TWD",
					error: { code: "RATE_PAIR_UNSUPPORTED" },
				});
				expect(countSourceCalls(degradedStub, ABC_RATE_URL)).toBe(0);
				expect(countSourceCalls(degradedStub, ERAPI_RATE_URL)).toBe(0);
			});

			it("单目标 TWD 回归：HTTP 422（M1.2 行为不变）", async () => {
				const res = await request(degradedApp.getHttpServer())
					.get("/api/rates/latest/CNY?targets=TWD&refresh=true")
					.expect(422);

				expect(res.body).toMatchObject({
					code: "RATE_PAIR_UNSUPPORTED",
				});
			});
		});
	});
});
