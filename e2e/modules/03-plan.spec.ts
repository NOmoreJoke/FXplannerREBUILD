import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { selectCadPlanCurrency } from "../helpers/plan-form";
import { saveScreenshot } from "../helpers/save-screenshot";
import {
	injectLoginCookie,
	seedOnboarding,
	seedPlanWithAllocation,
	seedRegisterAndLogin,
	seedTransaction,
} from "../helpers/api-seeder";

/**
 * 换汇计划模块 E2E（changes/ux-improvements：补全端到端流程）
 *
 * 覆盖流程：
 * - T-PLAN-001: UI 创建计划（表单填写 → 提交 → 首页 → 列表可见）
 * - T-PLAN-002: 计划列表 → 详情（卡片跳转、详情卡、面包屑/录入买入入口）
 * - T-PLAN-003: 列表状态筛选（全部/进行中/已完成）
 *
 * 造数走 e2e/helpers/api-seeder.ts（真实后端 API）；登录态经 accessToken cookie 注入。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";

test.describe("【换汇计划模块】创建 / 列表 / 详情 / 筛选", () => {
	const logger = new TestLogger("plan-module");

	test("T-PLAN-001: UI 创建计划 → 列表可见", async ({ page }) => {
		logger.log("action", "info", "开始：UI 创建计划");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin("plan-create");
		await seedOnboarding(user.accessToken, "CNY");
		// 先持有一笔 CAD 买入（6,000），保证「计入已有外币」可分配
		await seedTransaction(user.accessToken, "CAD", "6000");

		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/plans/new`);
		await page.waitForLoadState("networkidle");
		await saveScreenshot(page, "03-plan", "T-PLAN-001-01-new-page");

		await selectCadPlanCurrency(page);
		await page.fill("#plan-name", "E2E 换汇计划");

		// 净到账金额 / 用途日期 / 提前天数 / 计入已有外币
		await page.fill("#plan-target-amount", "10000");
		await page.fill("#plan-expect-use-date", "2030-02-15");
		await page.fill("#plan-prep-lead-days", "3");
		await page.fill("#plan-allocated-amount", "5000");
		logger.log("action", "info", "✓ 计划表单已填充（CAD/10000/分配5000）");
		await saveScreenshot(page, "03-plan", "T-PLAN-001-02-form-filled");

		await page.click('button:has-text("创建计划")');
		await page.waitForURL(`${BASE_URL}/home`, { timeout: 15000 });
		logger.log("action", "info", "✓ 计划创建成功，跳转 /home");
		await saveScreenshot(page, "03-plan", "T-PLAN-001-03-home-after-create");

		// 列表出现刚创建的计划（目标币种 CAD）
		await page.goto(`${BASE_URL}/plans`);
		await page.waitForLoadState("networkidle");
		await expect(page.locator('a[href^="/plans/"]').first()).toBeVisible();
		await expect(page.getByText("CAD").first()).toBeVisible();
		await saveScreenshot(page, "03-plan", "T-PLAN-001-04-plan-list");

		await logger.saveToFile();
	});

	test("T-PLAN-002: 列表 → 详情（卡片跳转 + 详情卡渲染）", async ({ page }) => {
		logger.log("action", "info", "开始：计划列表到详情");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin("plan-detail");
		await seedOnboarding(user.accessToken, "CNY");
		await seedTransaction(user.accessToken, "CAD", "6000");
		// 列表页依赖计划数据：API 直接创建（分配 6000 ≤ 可分配 6000）
		await seedPlanWithAllocation(user.accessToken, "CAD", "6000");

		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/plans`);
		await page.waitForLoadState("networkidle");

		// 点击第一张计划卡片进入详情
		await page.click('a[href^="/plans/"]:not([href="/plans/new"])');
		await page.waitForURL(/\/plans\/[^/]+$/, { timeout: 10000 });
		await page.waitForLoadState("networkidle");
		logger.log("action", "info", `✓ 进入详情 ${page.url()}`);

		// 详情卡：目标币种 CAD + 「录入买入」入口 + 面包屑「计划详情」
		await expect(page.getByText("目标币种 CAD")).toBeVisible();
		await expect(page.locator('a:has-text("录入买入")')).toBeVisible();
		await expect(
			page.locator('nav[aria-label="面包屑"]').getByText("计划详情"),
		).toBeVisible();
		await saveScreenshot(page, "03-plan", "T-PLAN-002-01-detail");

		await logger.saveToFile();
	});

	test("T-PLAN-003: 列表状态筛选（全部 / 进行中 / 已完成）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：列表状态筛选");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin("plan-filter");
		await seedOnboarding(user.accessToken, "CNY");
		await seedTransaction(user.accessToken, "CAD", "6000");
		// 「进行中」筛选需要真实计划数据（选择器排除「新建计划」入口避免假通过）
		await seedPlanWithAllocation(user.accessToken, "CAD", "6000");

		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/plans`);
		await page.waitForLoadState("networkidle");

		// 「进行中」：刚创建的计划可见（排除「新建计划」入口链接）
		await page.click('button[aria-pressed]:has-text("进行中")');
		await page.waitForLoadState("networkidle");
		await page.waitForTimeout(500);
		await expect(
			page.locator('a[href^="/plans/"]:not([href="/plans/new"])').first(),
		).toBeVisible();
		await saveScreenshot(page, "03-plan", "T-PLAN-003-01-filter-active");

		// 「已完成」：无已完成计划 → 空态（无卡片链接）
		await page.click('button[aria-pressed]:has-text("已完成")');
		await page.waitForLoadState("networkidle");
		await page.waitForTimeout(500);
		const cardCount = await page
			.locator('a[href^="/plans/"]:not([href="/plans/new"])')
			.count();
		expect(cardCount).toBe(0);
		await saveScreenshot(page, "03-plan", "T-PLAN-003-02-filter-completed");

		await logger.saveToFile();
	});
});
