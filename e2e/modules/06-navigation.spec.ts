import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import { injectLoginCookie, seedAccountScenario } from "../helpers/api-seeder";

/**
 * 导航交互 E2E（changes/ux-improvements R3/R4/R5：面包屑 / 菜单高亮 / Logo）
 *
 * 覆盖流程：
 * - T-NAV-001: 侧边栏菜单高亮（首页精确匹配；计划子页面跟随父级高亮）
 * - T-NAV-002: 统一面包屑（一级页 / 多级页 / 动态段 / 单级兜底）
 * - T-NAV-003: Logo 可点击回首页
 *
 * 前置：seedAccountScenario（CAD 账户 + 计划），登录态 cookie 注入。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";

test.describe("【导航交互】面包屑 / 菜单高亮 / Logo", () => {
	const logger = new TestLogger("navigation");
	let seed: Awaited<ReturnType<typeof seedAccountScenario>>;

	test.beforeAll(async () => {
		seed = await seedAccountScenario("nav");
		logger.log("action", "info", `✓ 造数完成 userId=${seed.userId}`);
	});

	test("T-NAV-001: 侧边栏菜单高亮（含子页面跟随）", async ({ page }) => {
		logger.log("action", "info", "开始：菜单高亮");
		logger.setupPageListeners(page);

		await injectLoginCookie(page.context(), seed.accessToken, BASE_URL);

		// /home：首页菜单高亮（aria-current="page"）
		await page.goto(`${BASE_URL}/home`);
		await page.waitForLoadState("networkidle");
		await expect(
			page.locator('aside a[href="/home"][aria-current="page"]'),
		).toBeVisible();
		await saveScreenshot(page, "06-navigation", "T-NAV-001-01-home-active");

		// /plans：换汇计划菜单高亮，首页取消高亮
		await page.goto(`${BASE_URL}/plans`);
		await page.waitForLoadState("networkidle");
		await expect(
			page.locator('aside a[href="/plans"][aria-current="page"]'),
		).toBeVisible();
		await expect(
			page.locator('aside a[href="/home"][aria-current="page"]'),
		).toHaveCount(0);
		await saveScreenshot(page, "06-navigation", "T-NAV-001-02-plans-active");

		// 子页面 /plans/[id]：仍跟随「换汇计划」高亮（本次修复的核心场景）
		await page.click('a[href^="/plans/"]:not([href="/plans/new"])');
		await page.waitForURL(/\/plans\/[^/]+$/, { timeout: 10000 });
		await page.waitForLoadState("networkidle");
		await expect(
			page.locator('aside a[href="/plans"][aria-current="page"]'),
		).toBeVisible();
		await saveScreenshot(
			page,
			"06-navigation",
			"T-NAV-001-03-plan-detail-active",
		);

		await logger.saveToFile();
	});

	test("T-NAV-002: 统一面包屑（一级 / 多级 / 动态段）", async ({ page }) => {
		logger.log("action", "info", "开始：统一面包屑");
		logger.setupPageListeners(page);

		await injectLoginCookie(page.context(), seed.accessToken, BASE_URL);

		// 一级页：/home → 「首页」
		await page.goto(`${BASE_URL}/home`);
		await page.waitForLoadState("networkidle");
		const breadcrumb = page.locator('nav[aria-label="面包屑"]');
		await expect(breadcrumb).toBeVisible();
		await expect(breadcrumb.getByText("首页")).toBeVisible();
		await saveScreenshot(page, "06-navigation", "T-NAV-002-01-home-crumb");

		// 多级页：/plans/[id] → 「换汇计划 / 计划详情」，父级可点击
		await page.goto(`${BASE_URL}/plans`);
		await page.waitForLoadState("networkidle");
		await page.click('a[href^="/plans/"]:not([href="/plans/new"])');
		await page.waitForURL(/\/plans\/[^/]+$/, { timeout: 10000 });
		await page.waitForLoadState("networkidle");
		await expect(breadcrumb.getByText("换汇计划")).toBeVisible();
		await expect(breadcrumb.getByText("计划详情")).toBeVisible();
		// 父级是链接：点击可回列表
		await breadcrumb.locator('a:has-text("换汇计划")').click();
		await page.waitForURL(`${BASE_URL}/plans`, { timeout: 10000 });
		logger.log("action", "info", "✓ 面包屑父级可点击回列表");
		await saveScreenshot(page, "06-navigation", "T-NAV-002-02-plan-crumb");

		// 动态段：/accounts/CAD → 「外汇账户 / CAD 账户详情」
		await page.goto(`${BASE_URL}/accounts/CAD`);
		await page.waitForLoadState("networkidle");
		await expect(breadcrumb.getByText("外汇账户")).toBeVisible();
		await expect(breadcrumb.getByText("CAD 账户详情")).toBeVisible();
		await saveScreenshot(page, "06-navigation", "T-NAV-002-03-account-crumb");

		await logger.saveToFile();
	});

	test("T-NAV-003: Logo 点击回首页", async ({ page }) => {
		logger.log("action", "info", "开始：Logo 回首页");
		logger.setupPageListeners(page);

		await injectLoginCookie(page.context(), seed.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/plans`);
		await page.waitForLoadState("networkidle");

		await page.click('aside a[aria-label="回到首页"]');
		await page.waitForURL(`${BASE_URL}/home`, { timeout: 10000 });
		logger.log("action", "info", "✓ Logo 点击已回 /home");
		await saveScreenshot(page, "06-navigation", "T-NAV-003-01-logo-home");

		await logger.saveToFile();
	});
});
