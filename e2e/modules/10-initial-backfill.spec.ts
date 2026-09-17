import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import { selectRadixOption } from "../helpers/test-utils";
import {
	injectLoginCookie,
	seedOnboarding,
	seedRegisterAndLogin,
} from "../helpers/api-seeder";

/**
 * 初始持仓补录 E2E（changes/onboarding-rework/技术方案.md §8.3 场景 → 需求文档场景 9/11）
 *
 * 覆盖流程（技术方案 §8.3 编号 10）：
 * - 空账本（已建账、无任何初始记录）→ 首页补录引导卡可见
 * - 点卡进 /onboarding?backfill=1（补录模式）→ 填 USD 1,000 → 核对 → 确认入账
 * - 回首页：引导卡消失、USD 账户卡出现（此后无补录入口，漏填走更正）
 *
 * 补录入账依赖真实外部汇率数据源（后端按补录时刻取有效报价）；
 * 数据源不可用环境（离线 CI）按注释条件跳过核对后提交，不误报。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";

test.describe("【初始持仓补录】空账本 → 补录 → 引导卡消失", () => {
	const logger = new TestLogger("initial-backfill");
	let seed: Awaited<ReturnType<typeof seedRegisterAndLogin>>;

	test.beforeAll(async () => {
		seed = await seedRegisterAndLogin("initial-backfill");
		// 只建账（CNY），不录任何初始持仓 → 空账本状态
		await seedOnboarding(seed.accessToken, "CNY");
		logger.log("action", "info", `✓ 造数完成（已建账未录持仓）${seed.email}`);
	});

	test("T-IBF-001: 首页引导卡 → 补录 → 入账 → 引导卡消失", async ({ page }) => {
		logger.log("action", "info", "开始：初始持仓补录全流程");
		logger.setupPageListeners(page);

		await injectLoginCookie(page.context(), seed.accessToken, BASE_URL);

		// 空账本首页：补录引导卡可见（需求场景 9 前置）
		await page.goto(`${BASE_URL}/home`);
		await page.waitForLoadState("networkidle");
		await expect(
			page.locator('[data-testid="initial-backfill-card"]'),
		).toBeVisible({ timeout: 15000 });
		await saveScreenshot(page, "10-backfill", "T-IBF-001-01-home-card");
		logger.log("action", "info", "✓ 补录引导卡已出现");

		// 点卡进补录模式（复用第二步填写组件，标题「补录初始持仓」，默认直接进入填写态）
		await page.click('[data-testid="initial-backfill-cta"]');
		await page.waitForURL(/\/onboarding\?backfill=1/, { timeout: 15000 });
		await expect(page.locator('[data-testid="backfill-title"]')).toContainText(
			"补录初始持仓",
		);
		await expect(
			page.locator('[data-testid="holding-currency-0"]'),
		).toBeVisible();
		await saveScreenshot(page, "10-backfill", "T-IBF-001-02-backfill-mode");
		logger.log("action", "info", "✓ 已进入补录模式");

		// 填 USD 1,000 → 等待核对区取价（真实数据源；radix Select 稳健展开，见 test-utils）
		await selectRadixOption(
			page,
			page.locator('[data-testid="holding-currency-0"]'),
			"USD · 美元",
		);
		await page.fill('[data-testid="holding-amount-0"]', "1000");
		const reviewRow = page.locator('[data-testid="review-row-USD"]');
		const rateFailed = page
			.locator('[data-testid="holding-review"] [role="alert"]')
			.or(page.getByText("汇率获取失败"));
		await expect(reviewRow.or(rateFailed).first()).toBeVisible({
			timeout: 30000,
		});
		if (await rateFailed.isVisible().catch(() => false)) {
			await saveScreenshot(page, "10-backfill", "T-IBF-001-skip-rate-source");
			test.skip(true, "外部汇率数据源不可用，补录核对无法加载");
		}
		await saveScreenshot(page, "10-backfill", "T-IBF-001-03-review");
		logger.log("action", "info", "✓ 核对区已展示按补录时刻报价的初始成本");

		// 确认入账 → 回首页：引导卡消失 + USD 账户卡（需求场景 9/11）
		// 先注册 state 响应等待：补录后首页 refetch 返回新数据再断言（消除导航时序竞态）
		const homeStateLoaded = page.waitForResponse(
			(res) =>
				res.url().includes("/api/home/state") &&
				res.request().method() === "GET" &&
				res.status() === 200,
		);
		await page.click('[data-testid="holdings-submit"]');
		await page.waitForURL(`${BASE_URL}/home`, { timeout: 15000 });
		await homeStateLoaded;
		await expect(
			page.locator('[data-testid="initial-backfill-card"]'),
		).toHaveCount(0);
		await expect(page.getByText("USD").first()).toBeVisible();
		await saveScreenshot(
			page,
			"10-backfill",
			"T-IBF-001-04-home-after-backfill",
		);
		logger.log("action", "info", "✓ 补录完成：引导卡消失，USD 账户卡出现");

		await logger.saveToFile();
	});
});
