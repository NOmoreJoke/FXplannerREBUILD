import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import {
	injectLoginCookie,
	seedOnboarding,
	seedRegisterAndLogin,
} from "../helpers/api-seeder";
import {
	seedAdjustTarget,
	seedCancelPlan,
	seedCompletePlan,
	seedInitialHoldings,
	seedPlan,
	seedPurchase,
	seedUsage,
} from "../helpers/reports-seeder";

/**
 * 成本摘要与报告 E2E（changes/reports/技术方案.md §10.4，T-RPT 编号）。
 *
 * 数据前置全部走真实后端 API（M7 使用记录已上线：POST /plans/:id/usages
 * 事务内完成 FIFO 分摊落库，报告读侧直读分摊事实）：
 * - 用户 rpt-main：买入 2 笔（一笔手续费未明确）+ 计划 A（使用后完成）/ B（无使用）/ C（使用后取消）
 * - 用户 rpt-initial：补录初始持仓 → 计划 D 使用全部来自初始持仓（纯初始收益占位）
 * - 用户 rpt-empty：无计划（空状态）
 *
 * 数值复算（计划 A）：买入 1500@fee100（成本 1600）+ 2500@fee未知（unit 1.0）；
 * 分配 2000 → 使用 2000 → 调低目标至 2000（完成校验 used = target）→ 完成；
 * 分摊：批次 1 扣 1500（成本 1,600）+ 批次 2 扣 500（成本 500）= 2,100，
 * 且涉及未知手续费批次 → 固定说明文案可见。
 * （创建时 target = allocated 会因分批金额 0 被 AMOUNT_TOO_SMALL 拒绝，
 * 故走「分配部分目标 → 使用 → 调低目标 → 完成」的真实用户路径。）
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";

/** 主用户造数（返回三个计划 id：A 已完成 / B 无使用 / C 已取消） */
async function seedMainUser() {
	const seed = await seedRegisterAndLogin("rpt-main");
	await seedOnboarding(seed.accessToken, "CNY");
	// 买入 2 笔（FIFO 同日按录入顺序；批次 1 明确手续费、批次 2 未明确）
	await seedPurchase(seed.accessToken, "USD", "1500", "100");
	await seedPurchase(seed.accessToken, "USD", "2500", null); // 手续费未明确
	// 计划 A：USD 目标 3000（分配 2000，分批 1000 非 0）
	const planA = await seedPlan(seed.accessToken, {
		targetCurrency: "USD",
		targetAmount: "3000",
		allocatedAmount: "2000",
	});
	// 计划 B：JPY 目标 10000（分配 0，无使用）
	const planB = await seedPlan(seed.accessToken, {
		targetCurrency: "JPY",
		targetAmount: "10000",
		allocatedAmount: "0",
	});
	// 计划 C：USD 目标 1500（分配 1000，分批 500 非 0）→ 使用 800 → 取消
	const planC = await seedPlan(seed.accessToken, {
		targetCurrency: "USD",
		targetAmount: "1500",
		allocatedAmount: "1000",
	});

	// 使用：A 跨两批（1500@1600 + 500@500 = 2100，涉未知手续费批次）；C 800@批次 2
	await seedUsage(seed.accessToken, planA, "2000");
	await seedUsage(seed.accessToken, planC, "800");
	// A：调低目标至已使用（2000）→ used = target → 完成校验通过
	await seedAdjustTarget(seed.accessToken, planA, "2000");
	await seedCompletePlan(seed.accessToken, planA);
	await seedCancelPlan(seed.accessToken, planC);
	return { ...seed, planA, planB, planC };
}

/** 纯初始持仓用户：初始 USD 1000 → 计划 D 使用 500（全部分摊来自 INITIAL 批次） */
async function seedInitialOnlyUser() {
	const seed = await seedRegisterAndLogin("rpt-initial");
	await seedOnboarding(seed.accessToken, "CNY");
	// 本位币显式传入：外呼取价不可用时，helper 按「base = 本位币、quote = 外币」兜底写测试汇率缓存行
	await seedInitialHoldings(
		seed.accessToken,
		[{ currencyCode: "USD", amount: "1000" }],
		"CNY",
	);
	const planD = await seedPlan(seed.accessToken, {
		targetCurrency: "USD",
		targetAmount: "800",
		allocatedAmount: "500",
	});
	await seedUsage(seed.accessToken, planD, "500");
	return { ...seed, planD };
}

test.describe("【我的报告】成本摘要与报告", () => {
	const logger = new TestLogger("reports");
	let main: Awaited<ReturnType<typeof seedMainUser>>;
	let initialOnly: Awaited<ReturnType<typeof seedInitialOnlyUser>>;

	/** 网络层失败退避重试（dev 后端就绪窗口期偶发 fetch failed；业务错误不重试） */
	async function retrySeed<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
		let lastError: unknown;
		for (let i = 0; i < attempts; i++) {
			try {
				return await fn();
			} catch (error) {
				lastError = error;
				const message = error instanceof Error ? error.message : String(error);
				if (
					!message.includes("fetch failed") &&
					!message.includes("TypeError")
				) {
					throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, 3000));
			}
		}
		throw lastError;
	}

	test.beforeAll(async () => {
		// 仅造共享用户；001 的空状态用户在用例内部自造（失败只影响自身并享有用例级 retry）
		main = await retrySeed(() => seedMainUser());
		initialOnly = await retrySeed(() => seedInitialOnlyUser());
		logger.log(
			"action",
			"info",
			`✓ 造数完成 main=${main.email} initial=${initialOnly.email}`,
		);
	});

	/** 注入登录态 + 拦截 window.print（下载用例断言触发；不弹真实对话框） */
	function stubPrint(context: Parameters<typeof injectLoginCookie>[0]) {
		return injectLoginCookieAndPrintStub(context);
	}

	test("T-RPT-001: 新用户无计划 → 报告中心空状态 + 去创建计划引导", async ({
		browser,
	}) => {
		const empty = await seedRegisterAndLogin("rpt-empty");
		await seedOnboarding(empty.accessToken, "CNY");
		const context = await browser.newContext();
		await stubPrint(context);
		const page = await context.newPage();
		logger.setupPageListeners(page);
		// 登录态注入（缺省被 (protected) 守卫重定向到 /login，摘要页永不渲染）
		await injectLoginCookie(page.context(), empty.accessToken, BASE_URL);

		// Next dev 首次访问 /reports 需按需编译（可能 >10s），goto 放宽超时
		await page.goto(`${BASE_URL}/reports`, {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		});
		await expect(page.getByRole("heading", { name: "我的报告" })).toBeVisible({
			timeout: 30000,
		});
		await expect(page.getByTestId("reports-empty")).toBeVisible();
		await expect(page.getByTestId("reports-empty-create")).toContainText(
			"去创建计划",
		);
		logger.log("action", "info", "✓ 空状态与引导可见");
		await context.close();
	});

	test("T-RPT-002: 列表与状态/币种筛选，金额按各自币种显示且无跨币种合计", async ({
		browser,
	}) => {
		const context = await browser.newContext();
		await stubPrint(context);
		const page = await context.newPage();
		logger.setupPageListeners(page);
		await injectLoginCookie(page.context(), main.accessToken, BASE_URL);

		await page.goto(`${BASE_URL}/reports`, {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		});
		// 全部：3 行（A 已完成 / B 无使用 ACTIVE / C 已取消）；首次编译放宽等待
		await expect(page.getByTestId("report-plan-row")).toHaveCount(3, {
			timeout: 30000,
		});
		// 行字段按各自币种显示（JPY 行目标 10000 JPY；USD 行目标 3000 USD），无合计行
		const jpyRow = page
			.getByTestId("report-plan-row")
			.filter({ hasText: "JPY" });
		await expect(jpyRow).toHaveCount(1);
		await expect(jpyRow).toContainText("10000");
		// C 行目标 1500（A 目标已在完成路径调低为 2000，勿用 3000 断言）
		await expect(
			page.getByTestId("report-plan-row").filter({ hasText: "1500" }),
		).toHaveCount(1);

		// 状态筛选：已完成 → 只剩计划 A（含已使用成本 3100）；已取消 → 只剩计划 C
		await page.getByTestId("report-status-COMPLETED").click();
		await expect(page.getByTestId("report-plan-row")).toHaveCount(1);
		await expect(page.getByTestId("report-plan-row")).toContainText("2100");
		await expect(
			page.getByTestId(`report-download-${main.planA}`),
		).toBeVisible();
		await page.getByTestId("report-status-CANCELLED").click();
		await expect(page.getByTestId("report-plan-row")).toHaveCount(1);
		// C 曾有使用：已取消仍显示下载入口（需求 5.5 条 1）
		await expect(
			page.getByTestId(`report-download-${main.planC}`),
		).toBeVisible();

		// 切回全部恢复
		await page.getByTestId("report-status-all").click();
		await expect(page.getByTestId("report-plan-row")).toHaveCount(3);

		// 币种筛选：JPY → 只剩计划 B（无使用行）
		await page.getByTestId("report-currency-JPY").click();
		await expect(page.getByTestId("report-plan-row")).toHaveCount(1);
		await expect(
			page.getByTestId(`report-no-usage-${main.planB}`),
		).toBeVisible();
		await page.getByTestId("report-currency-all").click();
		await expect(page.getByTestId("report-plan-row")).toHaveCount(3);

		// 不同币种金额绝不加总：页面不出现任何「合计」行
		await expect(page.getByText(/合计/)).toHaveCount(0);
		logger.log("action", "info", "✓ 列表与筛选通过");
		await context.close();
	});

	test("T-RPT-003: 无使用计划 → 详情摘要「尚未使用」且无下载入口", async ({
		browser,
	}) => {
		const context = await browser.newContext();
		await stubPrint(context);
		const page = await context.newPage();
		logger.setupPageListeners(page);
		await injectLoginCookie(page.context(), main.accessToken, BASE_URL);

		await page.goto(`${BASE_URL}/plans/${main.planB}`, {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		});
		await expect(page.getByTestId("plan-cost-summary")).toBeVisible();
		await expect(page.getByTestId("usage-empty")).toContainText("尚未使用");
		// 不显示使用均价（「尚未使用」形态下无均价字段），不出现下载入口
		await expect(page.getByTestId("plan-report-download")).toHaveCount(0);
		logger.log("action", "info", "✓ 无使用计划无下载入口");
		await context.close();
	});

	test("T-RPT-004: 摘要与说明 → FIFO 成本数值 + 未知手续费文案 + 收益占位两种形态", async ({
		browser,
	}) => {
		const context = await browser.newContext();
		await stubPrint(context);
		const page = await context.newPage();
		logger.setupPageListeners(page);
		await injectLoginCookie(page.context(), main.accessToken, BASE_URL);

		// 计划 A（已完成，含买入来源）：成本 3,100 + 未知手续费说明 + 「后续版本提供」
		await page.goto(`${BASE_URL}/plans/${main.planA}`, {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		});
		await expect(page.getByTestId("plan-cost-summary")).toBeVisible();
		await expect(page.getByTestId("plan-cost-summary")).toContainText("2100");
		await expect(page.getByTestId("unknown-fee-note")).toContainText(
			"部分交易费用未明确",
		);
		await expect(page.getByTestId("yield-section")).toContainText(
			"收益比较将在后续版本提供",
		);
		// 来源拆分：初始持仓来源数量 0、买入来源 3,000
		await expect(page.getByTestId("plan-cost-summary")).toContainText(
			"来源拆分",
		);
		logger.log("action", "info", "✓ 计划 A 摘要与说明通过");

		// 计划 D（纯初始持仓）：「不计算收益比较」，绝不显示 0%
		await injectLoginCookie(page.context(), initialOnly.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/plans/${initialOnly.planD}`, {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		});
		await expect(page.getByTestId("plan-cost-summary")).toBeVisible();
		await expect(page.getByTestId("yield-section")).toContainText(
			"不计算收益比较",
		);
		logger.log("action", "info", "✓ 纯初始持仓不比较通过");
		await context.close();
	});

	test("T-RPT-005: 下载 → 打印视图渲染报告版式且 window.print 被触发", async ({
		browser,
	}) => {
		const context = await browser.newContext();
		await injectLoginCookie(context, main.accessToken, BASE_URL);
		await context.addInitScript(() => {
			// @ts-expect-error 测试埋点
			window.__printTriggered = false;
			window.print = () => {
				// @ts-expect-error 测试埋点
				window.__printTriggered = true;
			};
		});
		const page = await context.newPage();
		logger.setupPageListeners(page);

		await page.goto(`${BASE_URL}/plans/${main.planA}`, {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		});
		await page.getByTestId("plan-report-download").click();
		// 打印浮层渲染报告版式（预览标题 + 报告正文），页面控件区隐藏由 print: 媒体控制
		await expect(page.getByText("报告打印预览")).toBeVisible();
		await expect(page.getByRole("heading", { name: /成本报告/ })).toBeVisible();
		await expect(page.getByText("基本信息与进度")).toBeVisible();
		await expect(page.getByText("报告生成时间")).toBeVisible();
		// window.print 被调用（拦截断言）
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as { __printTriggered?: boolean }).__printTriggered,
				),
			)
			.toBe(true);
		logger.log("action", "info", "✓ 打印视图渲染且 print 已触发");

		// 用户取消/关闭打印 → 浮层关闭，页面原样（需求六）
		await page.getByTestId("print-dialog-close").click();
		await expect(page.getByText("报告打印预览")).toHaveCount(0);
		await context.close();
	});

	test("T-RPT-006: 已取消但曾有使用的计划 → 两处均可下载，打印页脚保留免责声明", async ({
		browser,
	}) => {
		const context = await browser.newContext();
		await stubPrint(context);
		const page = await context.newPage();
		logger.setupPageListeners(page);
		await injectLoginCookie(page.context(), main.accessToken, BASE_URL);

		// 报告中心：已取消计划 C 行有下载入口
		await page.goto(`${BASE_URL}/reports`, {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		});
		const rowDownload = page.getByTestId(`report-download-${main.planC}`);
		await expect(rowDownload).toBeVisible();
		const approvedDisclaimer =
			"本工具由非持牌主体提供，非投资顾问服务；汇率与计划均为工具测算，不构成投资建议、不预测涨跌、不经手资金；据此操作的风险与损失由用户自行承担。";
		const disclaimers = page.getByText(approvedDisclaimer, { exact: true });
		await expect(disclaimers).toBeVisible();
		await rowDownload.click();
		const previewHeading = page.getByText("报告打印预览");
		const printReport = page.locator(".print-root");
		const printDisclaimer = printReport
			.locator("footer")
			.getByText(approvedDisclaimer, { exact: true });
		await expect(previewHeading).toBeVisible();
		await expect(
			printReport.getByRole("heading", { name: /成本报告/ }),
		).toBeVisible();

		await page.emulateMedia({ media: "print" });
		await expect(printDisclaimer).toBeVisible();
		await expect(disclaimers.filter({ visible: true })).toHaveCount(1);
		await expect(
			printReport.getByText("1500 USD", { exact: true }),
		).toBeVisible();
		await expect(previewHeading).toBeHidden();
		await expect(rowDownload).toBeHidden();
		await page.emulateMedia({ media: null });
		await page.getByTestId("print-dialog-close").click();

		// 详情页：同样可进入下载流程
		await page.goto(`${BASE_URL}/plans/${main.planC}`, {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		});
		await expect(page.getByTestId("plan-report-download")).toBeVisible();
		await page.getByTestId("plan-report-download").click();
		await expect(page.getByText("报告打印预览")).toBeVisible();
		logger.log("action", "info", "✓ 已取消计划可下载");
		await context.close();
	});
});

/** 给 context 预置 print 拦截（与登录注入配合的快捷封装） */
async function injectLoginCookieAndPrintStub(
	context: Parameters<typeof injectLoginCookie>[0],
): Promise<void> {
	await context.addInitScript(() => {
		// @ts-expect-error 测试埋点
		window.__printTriggered = false;
		window.print = () => {
			// @ts-expect-error 测试埋点
			window.__printTriggered = true;
		};
	});
}
