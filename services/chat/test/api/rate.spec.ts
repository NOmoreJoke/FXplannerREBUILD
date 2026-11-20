import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import request from "supertest";
import { createTestApp, type TestContext } from "../helpers/test-app";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	ABC_RATE_URL,
	ERAPI_RATE_URL,
	FRANKFURTER_RATE_URL,
	FRANKFURTER_V2_RATE_URL,
} from "../../src/rate/rate.constants";
import {
	RATE_PROVIDER_TIMEOUT_TOKEN,
	RateProvider,
} from "../../src/rate/rate.provider";
import { RateController } from "../../src/rate/rate.controller";
import {
	RateCronService,
	type CronRunSummary,
} from "../../src/rate/rate-cron.service";
import { RateService } from "../../src/rate/rate.service";
import { SUPPORTED_CURRENCIES } from "../../src/rate/rate.constants";
import {
	ABC_SAMPLE_FIXTURE,
	FRANKFURTER_V2_CNY_TWD_SAMPLE,
	createRateSourceFetchStub,
	erApiLatestBody,
	frankfurterBusinessDaySeries,
	frankfurterLatestBody,
	frankfurterRouteWithHistory,
	jsonResponse,
	parseFrankfurterTimeSeriesRange,
	type RateSourceRoutes,
} from "../helpers/rate-source-fixtures";

// 15 币种全量 + 1 个重复，用于验证 targets 超量 400
const SIXTEEN_TARGETS =
	"HKD,USD,GBP,AUD,CAD,CNY,JPY,EUR,SGD,NZD,TWD,CHF,KRW,THB,MYR,CNY";

/**
 * 重置 app 内 AbcSource 的进程内状态（最小外呼间隔/成功全表缓存/并发单飞）。
 *
 * 根因（flaky 治理）：真实 AppModule 的 RateProvider 单例跨用例共享 abcSource，
 * 上一用例残留的 lastFetchAt/lastTable 会让最小间隔（10s）内的后续用例复用旧表
 * 或抛 BadGateway——是否复用取决于用例间的真实时间流逝（单独跑与全量并发节奏
 * 不同），是「三源路由/cron-refresh 偶发失败」的根因。每个用例前重置，保证 stub
 * 路由行为与断言确定性（私有字段重置仅限测试基建使用）。
 */
const resetAbcSourceState = (apps: INestApplication[]) => {
	for (const app of apps) {
		const provider = app.get(RateProvider) as unknown as {
			abcSource: {
				inFlight: Promise<unknown> | null;
				lastTable: unknown | null;
				lastFetchAt: number;
			};
		};
		provider.abcSource.inFlight = null;
		provider.abcSource.lastTable = null;
		provider.abcSource.lastFetchAt = -Infinity;
	}
};

/**
 * 重置 RateService 历史回源防护状态（单飞/负缓存进程内 Map，rate-chart 方案 §6）。
 * 私有字段重置仅限测试基建使用（先例：resetAbcSourceState）；行情用例组共用
 * 真实 AppModule 的 RateService 单例，跨用例残留会让负缓存/单飞判定互相污染。
 */
const resetHistoryGuards = (apps: INestApplication[]) => {
	for (const app of apps) {
		const service = app.get(RateService) as unknown as {
			historyInFlight: Map<string, unknown>;
			historyNegativeCache: Map<string, number>;
		};
		service.historyInFlight.clear();
		service.historyNegativeCache.clear();
	}
};

/** 是否为 frankfurter time-series URL（/{start}..{end}?from=&to=，rate-chart 方案 §8.2） */
const isTimeSeriesUrl = (href: string) =>
	parseFrankfurterTimeSeriesRange(href) !== null;

/** 关闭全局限流守卫：行情用例组单 app 请求数贴近 10/min/IP 缺省配额，避免边界 429 */
const disableThrottler = (builder: TestingModuleBuilder) =>
	builder.overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true });

/** 真实 AppModule + overrideProvider(RateProvider) 注入 fetch stub（按 URL 路由三源，不发真实请求）；
 *  三源路由契约与 cron-refresh 端点两组用例共用（rate-refresh-cron 方案 §6.2） */
const buildRateApp = async (
	rateSourceEnv: string,
	stub: ReturnType<typeof vi.fn>,
	configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<TestContext> => {
	const previous = process.env.RATE_SOURCE;
	process.env.RATE_SOURCE = rateSourceEnv;
	try {
		return await createTestApp((builder) => {
			const wired = builder.overrideProvider(RateProvider).useFactory({
				factory: (timeoutMs: number) =>
					new RateProvider(timeoutMs, stub as unknown as typeof fetch),
				inject: [RATE_PROVIDER_TIMEOUT_TOKEN],
			});
			return configure ? configure(wired) : wired;
		});
	} finally {
		if (previous === undefined) delete process.env.RATE_SOURCE;
		else process.env.RATE_SOURCE = previous;
	}
};

// cron 全量用例专用：abc 牌价表结构同 ABC_SAMPLE_FIXTURE（唯一真实样本仅含 3 币种），
// 按 CurrName 括号代码解析的规则生成 12 币种全量应答（同一 PublishTime，价格合法即可）
const ABC_FULL_CODES = [
	"HKD",
	"USD",
	"GBP",
	"AUD",
	"CAD",
	"JPY",
	"EUR",
	"SGD",
	"NZD",
	"CHF",
	"THB",
	"KRW",
] as const;
const ABC_CN_NAME: Record<(typeof ABC_FULL_CODES)[number], string> = {
	HKD: "港元",
	USD: "美元",
	GBP: "英镑",
	AUD: "澳元",
	CAD: "加拿大元",
	JPY: "日元",
	EUR: "欧元",
	SGD: "新加坡元",
	NZD: "新西兰元",
	CHF: "瑞士法郎",
	THB: "泰铢",
	KRW: "韩国元",
};
const buildFullAbcFixture = () => ({
	ErrorCode: "0",
	ErrorMsg: "",
	Data: {
		Table: ABC_FULL_CODES.map((code, i) => ({
			BenchMarkPrice: `${(i + 1) * 10}.50000000`,
			BuyingPrice: `${(i + 1) * 10}.49000000`,
			CurrName: `${ABC_CN_NAME[code]}(${code})`,
			CurrId: String(i + 1),
			SellPrice: `${(i + 1) * 10}.51000000`,
			PublishTime: "2026-09-15T10:26:54+08:00",
			Id: String(i + 1),
			CashBuyingPrice: `${(i + 1) * 10}.49000000`,
		})),
	},
});

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
	// cron-refresh 端点 mock：runOnce 返回值按用例覆写（fatal 语义用 mockResolvedValueOnce）
	const cronSummary = {
		triggeredAt: "2026-09-17T03:30:00.000Z",
		succeeded: ["USD", "CNY"],
		failed: [{ target: "TWD", code: "RATE_SOURCE_UNAVAILABLE" }],
	};
	const rateCronService = {
		runOnce: vi.fn(async (): Promise<CronRunSummary> => ({ ...cronSummary })),
	};

	beforeAll(async () => {
		const moduleRef = await Test.createTestingModule({
			controllers: [RateController],
			providers: [
				{ provide: RateService, useValue: rateService },
				{ provide: RateCronService, useValue: rateCronService },
			],
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

	it("POST /api/rates/cron-refresh：runOnce 摘要透传（成功轮次，rate-refresh-cron §6.2）", async () => {
		const res = await request(app.getHttpServer())
			.post("/api/rates/cron-refresh")
			.expect(200);

		expect(res.body).toMatchObject({
			success: true,
			data: cronSummary,
			message: "汇率定时刷新（手动触发）完成",
		});
	});

	it("POST /api/rates/cron-refresh：fatal 语义——整轮异常仍 200 且 data.fatal 透出（无 500 路径）", async () => {
		rateCronService.runOnce.mockResolvedValueOnce({
			triggeredAt: "2026-09-17T04:00:00.000Z",
			succeeded: [],
			failed: [],
			fatal: "db connection lost",
		});

		const res = await request(app.getHttpServer())
			.post("/api/rates/cron-refresh")
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.data.succeeded).toEqual([]);
		expect(res.body.data.fatal).toBe("db connection lost");
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

		// flaky 治理：multiApp 单例的 abcSource 状态跨用例残留，每用例前重置
		//（failureApp 首呼即失败无成功表可复用，degradedApp 不走 abc，均无需处理）
		beforeEach(() => resetAbcSourceState([multiApp]));

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
			// er-api 项：日精度发布时间，响应不含 sellRate 键（非 null）；
			// rate 为上游 4.5023 取倒数后的 0.2221087000 入账、toItem 8 位展示
			expect(items[1]).toMatchObject({
				source: "er-api",
				rate: "0.2221087",
				observedAt: "2026-09-15T00:00:00.000Z",
			});
			expect(items[1]).not.toHaveProperty("sellRate");
			// frankfurter 项：0.6102 取倒数 → 1.6388069485 入账、8 位展示
			expect(items[2]).toMatchObject({
				source: "frankfurter",
				rate: "1.63880695",
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
				rate: "0.2221087",
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
					rate: "7.18907261",
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

	// ── rate-refresh-cron 手动触发端点（方案 §6.2）：真实 AppModule + fetch stub ──
	// vitest test.env 已注入 RATE_CRON_ENABLED="false"（vitest.config.ts §6.0），
	// 定时调度在测试环境不真实触发；本组经端点直接驱动 runOnce，
	// 验证与定时任务共用链路的 HTTP 语义与落库行为。
	describe("latest 八位报价门槛（真实 AppModule + PostgreSQL）", () => {
		let ctx: TestContext;
		let routes: RateSourceRoutes;
		let stub: ReturnType<typeof createRateSourceFetchStub>;
		const observedAt = new Date("2026-09-15T00:00:00.000Z");
		const pair = { base: "CNY", quote: "MYR" };
		const affected = { base: pair.base, quote: { in: ["MYR", "TWD", "USD", "HKD"] } };

		beforeAll(async () => {
			routes = {};
			stub = createRateSourceFetchStub(routes);
			ctx = await buildRateApp("multi", stub, disableThrottler);
		});

		beforeEach(async () => {
			await ctx.prisma.exchangeRate.deleteMany({ where: affected });
			resetAbcSourceState([ctx.app]);
			stub.mockClear();
			routes.abc = undefined;
			routes.erApi = undefined;
			routes.frankfurter = undefined;
		});

		afterAll(async () => {
			await ctx.prisma.exchangeRate.deleteMany({ where: affected });
			await ctx.app.close();
		});

		it("Frankfurter 舍入为零：强制刷新返回 502，既有有效报价仍可从缓存读取", async () => {
			const previous = await ctx.prisma.exchangeRate.create({
				data: { ...pair, observedAt, rate: "1.6388069485", source: "frankfurter" },
			});
			routes.frankfurter = () =>
				jsonResponse(frankfurterLatestBody("2026-09-15", { MYR: "500000000" }));

			const server = ctx.app.getHttpServer();
			const failure = await request(server)
				.get("/api/rates/latest/CNY?targets=MYR&refresh=true")
				.expect(502);
			expect(failure.body).toMatchObject({
				code: "RATE_SOURCE_UNAVAILABLE",
				lastObservedAt: observedAt.toISOString(),
			});
			expect(await ctx.prisma.exchangeRate.findMany({ where: pair })).toEqual([previous]);

			const cached = await request(server)
				.get("/api/rates/latest/CNY?targets=MYR")
				.expect(200);
			expect(cached.body.data).toMatchObject({
				rate: "1.63880695",
				fresh: true,
			});
			expect(stub).toHaveBeenCalledTimes(1);
		});

		it("ErApi 倒数和 ABC 卖出价归零时仅标记对应项，Frankfurter 半单位和同源 HKD 仍有效", async () => {
			routes.erApi = () => jsonResponse(erApiLatestBody({ TWD: "205000000" }));
			routes.frankfurter = () =>
				jsonResponse(frankfurterLatestBody("2026-09-15", { MYR: "200000000" }));
			const [usd, ...rest] = ABC_SAMPLE_FIXTURE.Data.Table;
			routes.abc = () =>
				jsonResponse({
					...ABC_SAMPLE_FIXTURE,
					Data: { Table: [{ ...usd, SellPrice: "0.00000049" }, ...rest] },
				});

			const res = await request(ctx.app.getHttpServer())
				.get("/api/rates/latest/CNY?targets=TWD,USD,MYR,HKD&refresh=true")
				.expect(200);
			expect(res.body.data.items).toMatchObject([
				{ target: "TWD", error: { code: "RATE_SOURCE_UNAVAILABLE", lastObservedAt: null } },
				{ target: "USD", error: { code: "RATE_SOURCE_UNAVAILABLE", lastObservedAt: null } },
				{ target: "MYR", source: "frankfurter", rate: "1e-8", fresh: true },
				{ target: "HKD", source: "abc", rate: "0.85534", sellRate: "0.85705", fresh: true },
			]);
			for (const item of res.body.data.items.slice(0, 2)) {
				expect(Object.keys(item).sort()).toEqual(["error", "target"]);
			}
			const stored = await ctx.prisma.exchangeRate.findMany({
				where: affected,
				orderBy: { quote: "asc" },
			});
			expect(stored.map(({ quote, rate }) => [quote, rate.toFixed(10)])).toEqual([
				["HKD", "0.8553400000"],
				["MYR", "0.0000000050"],
			]);
		});

		it.each([0, 6])("缓存确认于 %i 分钟前且报价归零：同步回源，失败时 502，恢复后正常返回", async (minutes) => {
			const previous = await ctx.prisma.exchangeRate.create({
				data: {
					...pair,
					observedAt,
					createdAt: new Date(Date.now() - minutes * 60_000),
					rate: "0.0000000020",
					source: "frankfurter",
				},
			});
			routes.frankfurter = () =>
				jsonResponse(frankfurterLatestBody("2026-09-15", { MYR: "500000000" }));
			const server = ctx.app.getHttpServer();
			const path = "/api/rates/latest/CNY?targets=MYR";
			const failure = await request(server).get(path).expect(502);
			expect(failure.body).toMatchObject({
				code: "RATE_SOURCE_UNAVAILABLE",
				lastObservedAt: null,
			});
			expect(await ctx.prisma.exchangeRate.findMany({ where: pair })).toEqual([previous]);

			routes.frankfurter = () =>
				jsonResponse(frankfurterLatestBody("2026-09-15", { MYR: "0.6102" }));
			const recovered = await request(server).get(path).expect(200);
			expect(recovered.body.data).toMatchObject({ rate: "1.63880695", fresh: true });
			expect(stub).toHaveBeenCalledTimes(2);
			const stored = await ctx.prisma.exchangeRate.findMany({ where: pair });
			expect(stored).toHaveLength(1);
			expect(stored[0].rate.toFixed(10)).toBe("1.6388069485");
		});

		it.each([
			{ sellRate: "0.0000000049", status: 502 },
			{ sellRate: "7.1250000000", status: 200 },
		])("ABC 省略卖出价时，保留的 $sellRate 决定同一报价更新能否提交", async ({ sellRate, status }) => {
			const [usd, ...rest] = ABC_SAMPLE_FIXTURE.Data.Table;
			const usdPair = { base: "CNY", quote: "USD" };
			const previous = await ctx.prisma.exchangeRate.create({
				data: {
					...usdPair,
					observedAt: new Date(usd.PublishTime),
					createdAt: observedAt,
					rate: "6.7100000000",
					sellRate,
					source: "abc",
				},
			});
			routes.abc = () =>
				jsonResponse({
					...ABC_SAMPLE_FIXTURE,
					Data: { Table: [{ ...usd, SellPrice: undefined }, ...rest] },
				});

			const res = await request(ctx.app.getHttpServer())
				.get("/api/rates/latest/CNY?targets=USD&refresh=true")
				.expect(status);
			const rows = await ctx.prisma.exchangeRate.findMany({ where: usdPair });
			if (status === 502) {
				expect(res.body).toMatchObject({ code: "RATE_SOURCE_UNAVAILABLE", lastObservedAt: null });
				expect(rows).toEqual([previous]);
			} else {
				expect(res.body.data).toMatchObject({ rate: "6.71055", sellRate: "7.125", fresh: true });
				expect(rows).toHaveLength(1);
				expect(rows[0].id).toBe(previous.id);
				expect(rows[0].sellRate?.toFixed(10)).toBe(sellRate);
				expect(rows[0].createdAt.getTime()).toBeGreaterThan(previous.createdAt.getTime());
			}
		});
	});

	describe("cron-refresh 端点（真实 AppModule + fetch stub）", () => {
		const healthyRoutes: RateSourceRoutes = {
			abc: async () => jsonResponse(buildFullAbcFixture()),
			erApi: async () => jsonResponse(erApiLatestBody({ TWD: "4.5023" })),
			frankfurter: async () =>
				jsonResponse(frankfurterLatestBody("2026-09-15", { MYR: "0.6102" })),
		};
		let cronApp: INestApplication;
		let failureCronApp: INestApplication;
		// 去重用例独立实例：与 cronApp 的端点级限流（2/min）计数互不干扰
		let dedupeApp: INestApplication;

		const countCnyRows = () =>
			realCtx.prisma.exchangeRate.count({ where: { base: "CNY" } });

		beforeAll(async () => {
			// 清理 CNY 视角全量残留（含恒等行），避免唯一约束/窗口污染
			await realCtx.prisma.exchangeRate.deleteMany({
				where: { base: "CNY" },
			});

			cronApp = (
				await buildRateApp("multi", createRateSourceFetchStub(healthyRoutes))
			).app;

			const failureRoutes: RateSourceRoutes = {
				...healthyRoutes,
				abc: async () => jsonResponse({ message: "abc down" }, 500),
			};
			failureCronApp = (
				await buildRateApp("multi", createRateSourceFetchStub(failureRoutes))
			).app;

			dedupeApp = (
				await buildRateApp("multi", createRateSourceFetchStub(healthyRoutes))
			).app;
		});

		afterAll(async () => {
			await realCtx.prisma.exchangeRate.deleteMany({
				where: { base: "CNY" },
			});
			await cronApp?.close();
			await failureCronApp?.close();
			await dedupeApp?.close();
		});

		// flaky 治理：三个 app 单例的 abcSource 状态跨用例残留，每用例前重置
		//（failureCronApp 首呼即失败亦需清 lastFetchAt，避免间隔窗口内快速失败被上一用例的时间戳放过/拦截）
		beforeEach(() => resetAbcSourceState([cronApp, failureCronApp, dedupeApp]));

		it("手动触发成功：succeeded 覆盖 15 币种，库内落库 15 行（14 外部 + 恒等）", async () => {
			const res = await request(cronApp.getHttpServer())
				.post("/api/rates/cron-refresh")
				.expect(200);

			expect(res.body.success).toBe(true);
			expect([...res.body.data.succeeded].sort()).toEqual(
				[...SUPPORTED_CURRENCIES].sort(),
			);
			expect(res.body.data.failed).toEqual([]);
			expect(res.body.data.fatal).toBeUndefined();
			expect(await countCnyRows()).toBe(15);
		});

		it("单源失败不影响其他源：abc 500 → 12 币种 failed，TWD/MYR/CNY 照常落库", async () => {
			const res = await request(failureCronApp.getHttpServer())
				.post("/api/rates/cron-refresh")
				.expect(200);

			expect([...res.body.data.succeeded].sort()).toEqual([
				"CNY",
				"MYR",
				"TWD",
			]);
			expect(res.body.data.failed).toHaveLength(12);
			for (const failedItem of res.body.data.failed) {
				expect(failedItem.code).toBe("RATE_SOURCE_UNAVAILABLE");
			}
		});

		it("重复触发去重：同牌价两轮后行数不变（upsert 幂等，规格验收③）", async () => {
			// 独立清理（含上一用例 failureCronApp 落库的恒等行：其 observedAt 键与本组不同）
			await realCtx.prisma.exchangeRate.deleteMany({
				where: { base: "CNY" },
			});

			const first = await request(dedupeApp.getHttpServer())
				.post("/api/rates/cron-refresh")
				.expect(200);
			expect(first.body.data.succeeded).toHaveLength(15);
			const rowsAfterFirst = await countCnyRows();
			expect(rowsAfterFirst).toBe(15);

			// 第二轮：abc 处于 10s 最小外呼间隔内，复用上次成功全表（无新外呼、同 observedAt），
			// er-api/frankfurter/恒等项亦按同 observedAt upsert 同一行 → 零新增
			const second = await request(dedupeApp.getHttpServer())
				.post("/api/rates/cron-refresh")
				.expect(200);
			expect(second.body.data.succeeded).toHaveLength(15);

			expect(await countCnyRows()).toBe(rowsAfterFirst);
		});
	});

	// ── rate-chart 行情档位扩展追加用例（方案 §8.2）：仅追加，既有用例断言不动 ──
	// 装配：真实 AppModule + overrideProvider(RateProvider) 注入 fetch stub（同上组手法）；
	// time-series 回源 URL（/{start}..{end}）按区间动态生成工作日序列，与真实「now」解耦；
	// 回源路由选 MYR（multi 模式下唯一具备历史回源能力的币种，方案 §1.3），
	// 422 用例按用例表用 frankfurter 单源模式 + TWD。
	describe("行情档位扩展（365）与回源防护（真实 AppModule + fetch stub）", () => {
		const historyRoutes: RateSourceRoutes = {};
		const historyStub = createRateSourceFetchStub(historyRoutes);
		/** time-series 外呼计数（frankfurter /{start}..{end} URL，负缓存/单飞行为级断言用） */
		const countHistoryCalls = () =>
			historyStub.mock.calls.filter(
				([url]) =>
					String(url).startsWith(FRANKFURTER_RATE_URL) &&
					isTimeSeriesUrl(String(url)),
			).length;
		const deleteMarketPairs = () =>
			realCtx.prisma.exchangeRate.deleteMany({
				where: {
					OR: [
						{ base: "USD", quote: "MYR" },
						{ base: "JPY", quote: "MYR" },
					],
				},
			});

		let marketApp: INestApplication;
		let singleSourceApp: INestApplication;

		beforeAll(async () => {
			marketApp = (await buildRateApp("multi", historyStub, disableThrottler))
				.app;
			// 清理本组币对落库残留（含上次运行可能留下的行），避免缓存完整/负缓存判定污染
			await deleteMarketPairs();
		});

		afterAll(async () => {
			await realCtx.prisma.exchangeRate.deleteMany({
				where: {
					OR: [
						{ base: "USD", quote: "MYR" },
						{ base: "JPY", quote: "MYR" },
						{ base: "USD", quote: "TWD" },
					],
				},
			});
			await marketApp?.close();
			await singleSourceApp?.close();
		});

		// flaky 治理：单飞/负缓存 Map 为 RateService 单例进程内状态，每用例前重置
		beforeEach(() => resetHistoryGuards([marketApp]));

		it("period=365 表无数据：frankfurter 完整回源落库，data_points 覆盖窗口工作日、current_rate 为末点（§8.2 行1）", async () => {
			historyRoutes.frankfurter = frankfurterRouteWithHistory({
				latestBody: frankfurterLatestBody("2026-09-15", { MYR: "0.6102" }),
				target: "MYR",
				rate: "0.61",
			});
			await realCtx.prisma.exchangeRate.deleteMany({
				where: { base: "USD", quote: "MYR" },
			});

			const res = await request(marketApp.getHttpServer())
				.get("/api/rates/history?base=USD&target=MYR&period=365")
				.expect(200);

			expect(res.body).toMatchObject({
				success: true,
				data: { base: "USD", target: "MYR", period: 365 },
			});
			// 期望序列 = stub 实际收到区间的工作日全序列（与真实 now 解耦的严格比对）
			const historyCall = historyStub.mock.calls
				.map(([url]) => String(url))
				.find(isTimeSeriesUrl);
			expect(historyCall).toBeTruthy();
			const { start, end } = parseFrankfurterTimeSeriesRange(historyCall!)!;
			const expectedDates = Object.keys(
				frankfurterBusinessDaySeries(start, end, "MYR", "0.61"),
			);
			expect(expectedDates.length).toBeGreaterThan(250); // 365 天 ≈ 261 个工作日
			const points = res.body.data.data_points;
			expect(points.map((p: { date: string }) => p.date)).toEqual(
				expectedDates,
			);
			// 历史 rate 为上游 0.61 取倒数后的落库值（10 位定点字符串）
			expect(
				points.every((p: { rate: string }) => p.rate === "1.6393442623"),
			).toBe(true);
			// current_rate 为末点
			expect(res.body.data.current_rate).toBe(points.at(-1).rate);
			// 回源数据落库
			const savedCount = await realCtx.prisma.exchangeRate.count({
				where: { base: "USD", quote: "MYR" },
			});
			expect(savedCount).toBe(expectedDates.length);
		});

		it("period=365 部分序列：首次回源返回部分序列并落库；第二次请求零外呼（负缓存生效，§8.2 行2）", async () => {
			historyRoutes.frankfurter = frankfurterRouteWithHistory({
				latestBody: frankfurterLatestBody("2026-09-15", { MYR: "0.6102" }),
				target: "MYR",
				rate: "0.62",
				skipTailBusinessDays: 5, // 缺尾部 5 个工作日 → 回源后仍不完整
			});
			await realCtx.prisma.exchangeRate.deleteMany({
				where: { base: "USD", quote: "MYR" },
			});

			// 外呼计数为跨用例累积值，断言用增量（本用例首次请求 +1）
			const callsBefore = countHistoryCalls();
			const first = await request(marketApp.getHttpServer())
				.get("/api/rates/history?base=USD&target=MYR&period=365")
				.expect(200);
			const points = first.body.data.data_points;
			expect(points.length).toBeGreaterThan(250);
			expect(first.body.data.current_rate).toBe(points.at(-1).rate);
			const callsAfterFirst = countHistoryCalls();
			expect(callsAfterFirst).toBe(callsBefore + 1);

			// 第二次请求：负缓存窗口内 → 不再外呼，返回同一份积累序列
			const second = await request(marketApp.getHttpServer())
				.get("/api/rates/history?base=USD&target=MYR&period=365")
				.expect(200);
			expect(second.body.data.data_points).toEqual(points);
			expect(countHistoryCalls()).toBe(callsAfterFirst);
		});

		it("period=365 同币对并发 3 请求：回源外呼仅 1 次（in-flight 单飞，§8.2 行3）", async () => {
			historyRoutes.frankfurter = frankfurterRouteWithHistory({
				latestBody: frankfurterLatestBody("2026-09-15", { MYR: "0.6102" }),
				target: "MYR",
				rate: "0.63",
				// stub 放慢：保证 3 个请求都在首次回源 resolve 前进入单飞判定
				//（否则过快应答会在后续请求到达前清除 in-flight，导致重复外呼）
				historyDelayMs: 50,
			});
			await realCtx.prisma.exchangeRate.deleteMany({
				where: { base: "JPY", quote: "MYR" },
			});

			// 外呼计数为跨用例累积值：并发 3 请求仅应比用例前多 1 次（单飞合并）
			const callsBefore = countHistoryCalls();
			const responses = await Promise.all(
				[1, 2, 3].map(() =>
					request(marketApp.getHttpServer()).get(
						"/api/rates/history?base=JPY&target=MYR&period=365",
					),
				),
			);
			for (const res of responses) {
				expect(res.status).toBe(200);
			}
			// 外呼计数为跨用例累积值：并发 3 请求仅应比用例前多 1 次（单飞合并）
			expect(countHistoryCalls()).toBe(callsBefore + 1);
			const [first, second, third] = responses;
			expect(second.body.data.data_points).toEqual(first.body.data.data_points);
			expect(third.body.data.data_points).toEqual(first.body.data.data_points);
		});

		it("period=180 不在枚举：400 校验错误，不触发外呼（422 仅留给不支持币对，§8.2 行4）", async () => {
			const before = countHistoryCalls();
			await request(marketApp.getHttpServer())
				.get("/api/rates/history?base=USD&target=MYR&period=180")
				.expect(400);
			expect(countHistoryCalls()).toBe(before);
		});

		it("frankfurter 单源模式 TWD + period=365：数据源 404 → 422 RATE_PAIR_UNSUPPORTED（§8.2 行5）", async () => {
			const unsupportedRoutes: RateSourceRoutes = {
				abc: async () => {
					throw new Error("降级模式不应外呼 ABC");
				},
				erApi: async () => {
					throw new Error("降级模式不应外呼 er-api");
				},
				frankfurter: (href) => {
					// ECB 无 TWD：time-series 404 → RatePairUnsupportedException（422 语义）
					if (isTimeSeriesUrl(href)) {
						return jsonResponse({ message: "Not Found" }, 404);
					}
					return jsonResponse(
						frankfurterLatestBody("2026-09-15", { TWD: "4.5023" }),
					);
				},
			};
			singleSourceApp = (
				await buildRateApp(
					"frankfurter",
					createRateSourceFetchStub(unsupportedRoutes),
					disableThrottler,
				)
			).app;

			const res = await request(singleSourceApp.getHttpServer())
				.get("/api/rates/history?base=USD&target=TWD&period=365")
				.expect(422);

			expect(res.body).toMatchObject({ code: "RATE_PAIR_UNSUPPORTED" });
		});

		it("CNY/TWD 空库历史：v2 顶层数组逐点标注参考来源，重复请求仍有数据且零落库（W4-01）", async () => {
			const pair = { base: "CNY", quote: "TWD" };
			await realCtx.prisma.exchangeRate.deleteMany({ where: pair });
			const referenceFetch = vi.fn(() =>
				jsonResponse(FRANKFURTER_V2_CNY_TWD_SAMPLE),
			);
			const { app: twdApp } = await buildRateApp(
				"multi",
				createRateSourceFetchStub({ frankfurterV2: referenceFetch }),
				disableThrottler,
			);
			vi.useFakeTimers({
				toFake: ["Date"],
				now: new Date("2026-10-09T12:00:00Z"),
			});
			try {
				const rowCountBefore = await realCtx.prisma.exchangeRate.count();
				expect(await realCtx.prisma.exchangeRate.count({ where: pair })).toBe(0);
				const history = "/api/rates/history?base=CNY&target=TWD&period=7";
				const first = await request(twdApp.getHttpServer())
					.get(history)
					.expect(200);
				expect(first.body.data).toEqual({
					base: "CNY",
					target: "TWD",
					period: 7,
					data_points: [
						{
							date: "2026-10-08",
							rate: "0.2102297812",
							source: "frankfurter-v2-reference",
						},
						{
							date: "2026-10-09",
							rate: "0.2099296736",
							source: "frankfurter-v2-reference",
						},
					],
					current_rate: "0.2099296736",
				});
				const second = await request(twdApp.getHttpServer())
					.get(history)
					.expect(200);
				expect(second.body.data).toEqual(first.body.data);
				expect(referenceFetch).toHaveBeenCalledExactlyOnceWith(
					`${FRANKFURTER_V2_RATE_URL}/rates?base=CNY&quotes=TWD&from=2026-10-02&to=2026-10-09`,
				);
				expect(await realCtx.prisma.exchangeRate.count()).toBe(rowCountBefore);
				expect(await realCtx.prisma.exchangeRate.count({ where: pair })).toBe(0);
			} finally {
				vi.useRealTimers();
				await twdApp.close();
			}
		});

		it("W4-02 TWD 日级图表保留当日 ErApi 快照，每日唯一且排除未来观测", async () => {
			const now = new Date("2026-11-19T02:00:00.000Z");
			const pair = { base: "USD", quote: "TWD" };
			const stub = createRateSourceFetchStub({
				frankfurterV2: () =>
					jsonResponse({
						rates: [
							{ date: "2026-11-13", ...pair, rate: "4.7567" },
							{ date: "2026-11-15", ...pair, rate: "4.7569" },
							{ date: "2026-11-19", ...pair, rate: "4.7571" },
						],
					}),
			});
			const { app: twdApp, prisma } = await buildRateApp(
				"multi",
				stub,
				disableThrottler,
			);
			try {
				await prisma.exchangeRate.deleteMany({ where: pair });
				await prisma.exchangeRate.createMany({
					data: [
						["2026-11-11T23:59:59.999Z", "33"],
						["2026-11-12T00:00:00.000Z", "32.2"],
						["2026-11-13T12:00:00.000Z", "32.1"],
						["2026-11-19T00:01:00.000Z", "32.05"],
						["2026-11-19T00:02:31.000Z", "32"],
						["2026-11-19T02:00:00.001Z", "31.9"],
						["2026-11-20T00:00:00.000Z", "31.8"],
					].map(([time, rate]) => ({
						...pair,
						rate,
						source: "er-api",
						observedAt: new Date(time),
					})),
				});

				// 只冻结 Date，保留 Supertest 和供应商 stub 的真实计时器。
				vi.useFakeTimers({ toFake: ["Date"], now });
				const res = await request(twdApp.getHttpServer())
					.get("/api/rates/history?base=USD&target=TWD&period=7")
					.expect(200);

				expect(res.body.data.data_points).toEqual([
					{ date: "2026-11-12", rate: "32.2", source: "er-api" },
					{ date: "2026-11-13", rate: "32.1", source: "er-api" },
					{
						date: "2026-11-15",
						rate: "0.2102209422",
						source: "frankfurter-v2-reference",
					},
					{ date: "2026-11-19", rate: "32", source: "er-api" },
				]);
				expect(res.body.data.current_rate).toBe("32");
				expect(stub).toHaveBeenCalledOnce();
				const [url] = stub.mock.calls[0];
				const params = new URL(String(url)).searchParams;
				expect([params.get("from"), params.get("to")]).toEqual([
					"2026-11-12",
					"2026-11-19",
				]);
				expect(await prisma.exchangeRate.count({ where: pair })).toBe(7);
			} finally {
				vi.useRealTimers();
				await twdApp.close();
			}
		});

		it("既有档位 7/30/90 回归：仍被接受且防护同样生效，序列随窗口扩大递增（§8.2 行6）", async () => {
			historyRoutes.frankfurter = frankfurterRouteWithHistory({
				latestBody: frankfurterLatestBody("2026-09-15", { MYR: "0.6102" }),
				target: "MYR",
				rate: "0.64",
			});
			await realCtx.prisma.exchangeRate.deleteMany({
				where: { base: "USD", quote: "MYR" },
			});

			let previousLength = 0;
			for (const period of [7, 30, 90]) {
				const res = await request(marketApp.getHttpServer())
					.get(`/api/rates/history?base=USD&target=MYR&period=${period}`)
					.expect(200);
				expect(res.body.data.period).toBe(period);
				const length = res.body.data.data_points.length;
				expect(length).toBeGreaterThan(previousLength);
				previousLength = length;
			}
		});
	});
});
