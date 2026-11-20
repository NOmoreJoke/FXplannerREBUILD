import type { Page, Route } from "@playwright/test";
import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import { injectLoginCookie, seedAccountScenario } from "../helpers/api-seeder";

/**
 * 汇率行情 E2E（changes/rate-chart/技术方案.md §3.3 / §5.3）
 *
 * 覆盖断言点（方案 §3.3）：
 * - T-MKT-001: 菜单可达——侧边栏「汇率行情」（NAV_ITEMS，我的报告后）→ /market 渲染
 * - T-MKT-002: 四档切换——7/30/90/365，第四档 label「1年」，默认 30 天，切档发新请求不白屏
 * - T-MKT-003: 多币种叠加——对比币种 1~5 上限，满员隐藏添加器，5 条折线渲染
 * - T-MKT-004: 缺口不补 0——序列含缺口（null），Y 轴不出现 0 刻度（补 0 则 Y 轴必含 0）
 * - T-MKT-005: 失败隔离 + 部分序列——单币种 422 置灰「暂无数据」不拖垮整页；
 *              部分序列 → 图表下方标注「数据自 YYYY-MM-DD 起」
 * - T-MKT-006: 空态——全部无数据 → 空态 + 失败摘要 + 重试按钮，重试再次发请求
 * - T-MKT-007: 重查失败——保留已绘制的参考曲线和来源说明，同时显示失败提示
 *
 * 数据源 stub：后端 FRANKFURTER_RATE_URL 为硬编码常量（无 URL 注入点），按任务书
 * 「E2E 数据源注入 frankfurter stub」语义在 Playwright 网络层拦截 /rates/history，
 * 按 query（target/period）路由到受控工作日序列（latest/timeseries 应答结构参照
 * services/chat/test/helpers/rate-source-fixtures.ts 的 frankfurter fixture 形态）。
 * 运行脚本仍注入 RATE_SOURCE=frankfurter（§5.3 降级开关）：未被拦截的汇率外呼
 * 一律单源走 frankfurter，避免 E2E 真实外呼农行 ABC 源。
 *
 * 前置：seedAccountScenario（本位币 CNY → 默认对比币种 USD），登录态 cookie 注入。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";

// ── 受控序列 stub ──────────────────────────────────────────────────────────

type StubKind =
	| "normal"
	| "gapped"
	| "partial"
	| "mixed-reference"
	| "empty"
	| "unsupported";

interface StubTarget {
	kind: StubKind;
	/** 基准汇率（>0，远离 0 以便「补 0」可被 Y 轴刻度区分） */
	base?: number;
	/** partial：首日距今天的自然日偏移（12 天 → 30 档下必判部分序列，余量 20+ 天免时区边界） */
	firstDateOffsetDays?: number;
}

interface StubOptions {
	/** 按币种覆写形态；未列出的币种默认 normal（USD 缺省 gapped，供缺口用例） */
	targets?: Record<string, StubTarget>;
}

interface HistoryCall {
	target: string;
	period: number;
}

interface MarketStub {
	/** 已发生的 history 请求（按序） */
	calls: HistoryCall[];
	/** partial 币种的实际首日（YYYY-MM-DD，供「数据自 … 起」断言） */
	partialFirstDates: Record<string, string>;
}

const isoDate = (value: Date): string => value.toISOString().slice(0, 10);

const shiftDays = (iso: string, days: number): string => {
	const date = new Date(`${iso}T00:00:00.000Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return isoDate(date);
};

/** [startIso, endIso] 闭区间内的工作日序列（ECB 语义：周末无报价） */
const businessDays = (startIso: string, endIso: string): string[] => {
	const days: string[] = [];
	const cursor = new Date(`${startIso}T00:00:00.000Z`);
	const last = new Date(`${endIso}T00:00:00.000Z`);
	while (cursor <= last) {
		const weekday = cursor.getUTCDay();
		if (weekday !== 0 && weekday !== 6) days.push(isoDate(cursor));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return days;
};

/** 构造单币种 data_points（汇率随序号微波动，字符串透传数据源精度语义） */
function buildPoints(
	period: number,
	spec: StubTarget,
): Array<{ date: string; rate: string; source?: string }> {
	if (spec.kind === "empty") return [];
	const todayIso = isoDate(new Date());
	const span =
		spec.kind === "partial" ? (spec.firstDateOffsetDays ?? 12) : period + 15;
	let dates = businessDays(shiftDays(todayIso, -span), todayIso);
	if (spec.kind === "gapped" && dates.length > 8) {
		const mid = Math.floor(dates.length / 2);
		dates = dates.filter((_, index) => index !== mid && index !== mid + 1);
	}
	const base = spec.base ?? 0.721;
	return dates.map((date, index) => ({
		date,
		rate: (base + (index % 5) * 0.0002).toFixed(4),
		...(spec.kind === "mixed-reference" && {
			source: index === 0 ? "frankfurter-v2-reference" : "er-api",
		}),
	}));
}

/**
 * 挂载 /rates/history 网络层 stub（每用例独立 page，无需清理）。
 * 响应体形态对齐后端 §4 契约：成功 { success, data: {...} }；422 { code, message }。
 */
async function installMarketStub(
	page: Page,
	options: StubOptions = {},
): Promise<MarketStub> {
	const calls: HistoryCall[] = [];
	const partialFirstDates: Record<string, string> = {};
	const handle = async (route: Route): Promise<void> => {
		const url = new URL(route.request().url());
		const base = url.searchParams.get("base") ?? "CNY";
		const target = url.searchParams.get("target") ?? "USD";
		const period = Number(url.searchParams.get("period") ?? 30);
		calls.push({ target, period });

		const spec: StubTarget =
			options.targets?.[target] ??
			(target === "USD" ? { kind: "gapped" } : { kind: "normal" });
		if (spec.kind === "unsupported") {
			await route.fulfill({
				status: 422,
				contentType: "application/json",
				body: JSON.stringify({
					code: "RATE_PAIR_UNSUPPORTED",
					message: `汇率数据源不支持 ${base} → ${target} 报价，无法提供该币种有效报价`,
				}),
			});
			return;
		}
		const points = buildPoints(period, spec);
		if (spec.kind === "partial") partialFirstDates[target] = points[0].date;
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				success: true,
				data: {
					base,
					target,
					period,
					data_points: points,
					current_rate: points.at(-1)?.rate ?? null,
				},
			}),
		});
	};
	await page.route("**/rates/history*", handle);
	return { calls, partialFirstDates };
}

/** 币种 → 下拉选项 accessible name 前缀（SelectItem 文本「CODE · 中文名」） */
const OPTION_NAME: Record<string, RegExp> = {
	EUR: /^EUR /,
	CAD: /^CAD /,
	AUD: /^AUD /,
	NZD: /^NZD /,
	JPY: /^JPY /,
	TWD: /^TWD /,
};

/** 打开币种下拉并选中目标币种 */
async function addCurrency(page: Page, code: string): Promise<void> {
	await page.getByTestId("currency-add").click();
	await page.getByRole("option", { name: OPTION_NAME[code] }).click();
	await expect(page.getByTestId(`currency-tag-${code}`)).toBeVisible();
}

/** 登录态 + 打开 /market 并等待页面就绪（各用例共用入口） */
async function openMarket(page: Page, accessToken: string): Promise<void> {
	await injectLoginCookie(page.context(), accessToken, BASE_URL);
	// dev 模式下部分页面 load 事件不稳定，统一 domcontentloaded + 显式断言驱动等待
	await page.goto(`${BASE_URL}/market`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("market-page")).toBeVisible();
}

// ── 用例 ───────────────────────────────────────────────────────────────────

test.describe("【汇率行情】菜单 / 档位 / 多币种 / 空态", () => {
	const logger = new TestLogger("market");
	let seed: Awaited<ReturnType<typeof seedAccountScenario>>;

	test.beforeAll(async () => {
		seed = await seedAccountScenario("market");
		logger.log("action", "info", `✓ 造数完成 userId=${seed.userId}`);
	});

	test("T-MKT-001: 菜单可达（侧边栏「汇率行情」→ /market 渲染，默认 30 天档）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：菜单可达");
		logger.setupPageListeners(page);
		await installMarketStub(page);

		await injectLoginCookie(page.context(), seed.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/market`, { waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("market-page")).toBeVisible();

		// 侧边栏菜单项存在且当前页高亮（NAV_ITEMS：我的报告之后）
		const menuItem = page.locator('aside a[href="/market"]');
		await expect(menuItem).toBeVisible();
		await expect(menuItem).toHaveText(/汇率行情/);
		await expect(menuItem).toHaveAttribute("aria-current", "page");
		await saveScreenshot(page, "13-market", "T-MKT-001-01-menu-active");

		// 从相邻页（设置）经菜单点击进入行情页，页面渲染（不白屏）
		await page.click('aside a[href="/settings"]');
		await expect
			.poll(() => page.url(), { timeout: 10000 })
			.toContain("/settings");
		await page.click('aside a[href="/market"]');
		await expect
			.poll(() => page.url(), { timeout: 10000 })
			.toContain("/market");
		await expect(page.getByTestId("market-page")).toBeVisible();
		await expect(page.getByRole("heading", { name: "汇率行情" })).toBeVisible();
		// 本位币计价注明（本位币 CNY，§3.3）
		await expect(page.getByText(/以本位币 CNY 为基准/)).toBeVisible();
		await saveScreenshot(page, "13-market", "T-MKT-001-02-market-page");

		await logger.saveToFile();
	});

	test("T-MKT-002: 四档切换 7/30/90/365（第四档「1年」，默认 30，切档发新请求）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：四档切换");
		logger.setupPageListeners(page);
		const stub = await installMarketStub(page);

		await openMarket(page, seed.accessToken);

		// 默认 30 天（§3.3 规格），首个 history 请求 period=30
		expect(stub.calls.length).toBeGreaterThanOrEqual(1);
		expect(stub.calls[0]).toEqual({ target: "USD", period: 30 });

		// 四档可见，第四档 label「1年」（E2E/规格口径）
		const periods = [
			{ id: "period-7", label: "7天", value: 7 },
			{ id: "period-30", label: "30天", value: 30 },
			{ id: "period-90", label: "90天", value: 90 },
			{ id: "period-365", label: "1年", value: 365 },
		];
		for (const item of periods) {
			await expect(page.getByTestId(item.id)).toBeVisible();
			await expect(page.getByTestId(item.id)).toHaveText(item.label);
		}

		// 逐档切换：发新请求 + 图表不白屏
		for (const item of [periods[0], periods[2], periods[3]]) {
			await page.getByTestId(item.id).click();
			await expect
				.poll(() => stub.calls.some((call) => call.period === item.value), {
					timeout: 10000,
				})
				.toBe(true);
			await expect(page.getByTestId("market-chart-panel")).toBeVisible();
			await saveScreenshot(page, "13-market", `T-MKT-002-period-${item.value}`);
		}
		await logger.saveToFile();
	});

	test("T-MKT-003: 多币种叠加 1~5（逐个追加，满 5 隐藏添加器，5 条折线）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：多币种叠加");
		logger.setupPageListeners(page);
		const stub = await installMarketStub(page);

		await openMarket(page, seed.accessToken);
		await expect(page.getByTestId("currency-tag-USD")).toBeVisible();

		// 逐个追加到 5 个对比币种（上限 5，§3.3）
		const additions = ["EUR", "CAD", "AUD", "NZD"];
		for (const code of additions) {
			await addCurrency(page, code);
		}
		// 新币种请求已发出
		for (const code of additions) {
			expect(stub.calls.some((call) => call.target === code)).toBe(true);
		}

		// 满员：添加器隐藏 + 「最多 5 个」提示
		await expect(page.getByTestId("currency-add")).toHaveCount(0);
		await expect(page.getByText("最多 5 个")).toBeVisible();

		// 5 条折线全部渲染（recharts Line）
		await expect(
			page.getByTestId("market-chart").locator(".recharts-line"),
		).toHaveCount(5);
		await saveScreenshot(page, "13-market", "T-MKT-003-five-lines");

		await logger.saveToFile();
	});

	test("T-MKT-004: 缺口 null 不补 0（序列含缺口，Y 轴无 0 刻度）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：缺口不补 0");
		logger.setupPageListeners(page);
		await installMarketStub(page); // USD 缺省 gapped：中段挖掉 2 个工作日

		await openMarket(page, seed.accessToken);
		await expect(page.getByTestId("market-chart-panel")).toBeVisible();

		// 折线渲染存在
		await expect(
			page.getByTestId("market-chart").locator(".recharts-line-curve").first(),
		).toBeVisible();

		// 若缺口被补 0，Y 轴 domain 必含 0 → 出现 0 刻度；
		// 断言全部 Y 轴刻度 > 0（数据值域 0.72x，补 0 与否在 Y 轴可行为级区分）。
		// recharts 3.x 刻度文本经 ZIndexLayer portal 渲染在 yAxis-tick-labels 层（非 yAxis 后代）
		await expect
			.poll(async () => {
				const ticks = await page
					.locator(
						".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value",
					)
					.allTextContents();
				if (ticks.length === 0) return -1; // 尚未渲染
				const values = ticks.map((text) => Number.parseFloat(text));
				return Math.min(...values);
			})
			.toBeGreaterThan(0);
		await saveScreenshot(page, "13-market", "T-MKT-004-gap-no-zero");

		await logger.saveToFile();
	});

	test("T-MKT-005: 失败隔离 + 部分序列（422 置灰「暂无数据」，起始日标注）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：失败隔离 + 部分序列");
		logger.setupPageListeners(page);
		const stub = await installMarketStub(page, {
			targets: {
				// 现实形态（13/15 币对无积累）：可用币种均为部分序列；合并轴首日取更早的 USD 首日
				USD: { kind: "partial", base: 0.721, firstDateOffsetDays: 12 },
				JPY: { kind: "partial", base: 0.048, firstDateOffsetDays: 10 },
				TWD: { kind: "unsupported" },
			},
		});

		await openMarket(page, seed.accessToken);
		await expect(page.getByTestId("currency-tag-USD")).toBeVisible();

		// 追加 JPY（部分序列）与 TWD（422 不支持）
		await addCurrency(page, "JPY");
		await addCurrency(page, "TWD");

		// TWD 422：标签置灰标注「暂无数据」，不拖垮整页（§3.3）
		const tgdTag = page.getByTestId("currency-tag-TWD");
		await expect(tgdTag).toHaveAttribute("data-unavailable", "true");
		await expect(tgdTag).toContainText("暂无数据");
		await expect(page.getByTestId("market-chart-panel")).toBeVisible();

		// 部分序列：正常渲染 + 「数据自 YYYY-MM-DD 起」标注（取合并行首日 = 更早的 USD 首日）
		const usdFirstDate = stub.partialFirstDates.USD;
		expect(usdFirstDate).toBeDefined();
		const partialNote = page.getByTestId("market-chart-partial");
		await expect(partialNote).toBeVisible();
		await expect(partialNote).toContainText(`数据自 ${usdFirstDate} 起`);

		// 面板内单币种失败提示行
		await expect(
			page.getByTestId("market-chart-panel").getByText("TWD 暂无数据"),
		).toBeVisible();
		await saveScreenshot(page, "13-market", "T-MKT-005-isolation-partial");

		await logger.saveToFile();
	});

	test("T-MKT-006: 空态（失败摘要 + 重试按钮，重试再次发请求）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：空态与重试");
		logger.setupPageListeners(page);
		const stub = await installMarketStub(page, {
			targets: { USD: { kind: "empty" } },
		});

		await openMarket(page, seed.accessToken);
		await expect(page.getByTestId("currency-tag-USD")).toBeVisible();

		// 整幅空态 + 失败摘要（empty → 「暂无积累序列」）+ 重试
		await expect(page.getByTestId("market-chart-empty")).toBeVisible();
		await expect(page.getByTestId("market-chart-empty")).toContainText(
			"USD：暂无积累序列",
		);
		const retry = page.getByTestId("market-chart-retry");
		await expect(retry).toBeVisible();
		await saveScreenshot(page, "13-market", "T-MKT-006-empty-state");

		// 重试 → 再次发出 history 请求（empty 成功响应不触发自动重试，计数确定）
		const before = stub.calls.length;
		await retry.click();
		await expect
			.poll(() => stub.calls.length, { timeout: 10000 })
			.toBeGreaterThan(before);

		// stub 数据不变：仍空态，页面不崩（任何情况下不白屏，§3.3）
		await expect(page.getByTestId("market-chart-empty")).toBeVisible();

		await logger.saveToFile();
	});

	test("T-MKT-007: 重查失败时保留已绘制的参考曲线与来源说明", async ({
		page,
	}) => {
		const targets: Record<string, StubTarget> = {
			TWD: { kind: "mixed-reference", base: 4.2 },
		};
		const stub = await installMarketStub(page, { targets });
		await openMarket(page, seed.accessToken);
		await page.getByTestId("period-365").click();
		await addCurrency(page, "TWD");

		const panel = page.getByTestId("market-chart-panel");
		const note = panel.getByTestId("market-chart-reference-note");
		const curves = panel.locator(".recharts-line-curve");
		await expect(note).toBeVisible();
		await expect(note).toContainText(/TWD.*frankfurter v2/);
		await expect(curves).toHaveCount(2);

		// 另一档只返回原来源报价，不应沿用上一档的参考价说明。
		targets.TWD = { kind: "normal", base: 4.2 };
		await page.getByTestId("period-7").click();
		await expect
			.poll(() =>
				stub.calls.some(({ target, period }) => target === "TWD" && period === 7),
			)
			.toBe(true);
		await expect(curves).toHaveCount(2);
		await expect(note).toHaveCount(0);

		// 调整浏览器时间使一年档数据过期，同时保留缓存回收计时器。
		await page.clock.setFixedTime(new Date(Date.now() + 11 * 60_000));
		targets.TWD = { kind: "unsupported" };
		await page.getByTestId("period-365").click();
		await expect(panel.getByText("TWD 暂无数据")).toBeVisible();
		await expect(curves).toHaveCount(2);
		await expect(note).toBeVisible();
		await expect(note).toContainText(/TWD.*frankfurter v2/);

		await page.getByRole("button", { name: "移除 TWD" }).click();
		await expect(curves).toHaveCount(1);
		await expect(note).toHaveCount(0);
	});
});
