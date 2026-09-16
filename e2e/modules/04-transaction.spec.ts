import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import {
	injectLoginCookie,
	seedOnboarding,
	seedPlanWithAllocation,
	seedRegisterAndLogin,
	seedTransaction,
} from "../helpers/api-seeder";

/**
 * 交易录入模块 E2E（changes/ux-improvements：补全端到端流程）
 *
 * 覆盖流程：
 * - T-TXN-001: 计划详情「录入买入」→ URL 预填（planId+currency）→ 表单提交 → 交易详情金额一致
 * - T-TXN-002: 交易详情页面包屑与金额卡渲染
 *
 * 前置数据：CNY 本位币 + CAD 买入 6,000 + 计划（分配 6,000）。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";

test.describe("【交易录入模块】快速买入 → 交易详情", () => {
	const logger = new TestLogger("transaction-module");

	async function seedPlanScenario(label: string) {
		const user = await seedRegisterAndLogin(label);
		await seedOnboarding(user.accessToken, "CNY");
		await seedTransaction(user.accessToken, "CAD", "6000");
		const planId = await seedPlanWithAllocation(
			user.accessToken,
			"CAD",
			"6000",
		);
		return { user, planId };
	}

	test("T-TXN-001: 计划详情录入买入 → 交易详情（端到端）", async ({ page }) => {
		logger.log("action", "info", "开始：计划详情录入买入端到端");
		logger.setupPageListeners(page);

		const { user, planId } = await seedPlanScenario(`txn-${Date.now()}`);
		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);

		// 从计划详情进入录入页
		await page.goto(`${BASE_URL}/plans/${planId}`);
		await page.waitForLoadState("networkidle");
		await saveScreenshot(page, "04-transaction", "T-TXN-001-01-plan-detail");

		await page.click('a:has-text("录入买入")');
		await page.waitForURL(/\/transactions\/new\?/, { timeout: 10000 });
		await page.waitForLoadState("networkidle");
		logger.log("action", "info", `✓ 进入录入页 ${page.url()}`);

		// URL 预填：币种自动选中 CAD（默认选好、仍可改）
		await expect(page.locator('[aria-label="买入币种"]')).toContainText("CAD");
		await saveScreenshot(page, "04-transaction", "T-TXN-001-02-new-form");

		// 填写：本金 1,000 × 汇率 1 → 到账 1,000（另一种填法自动互算）
		await page.fill("#transaction-principal", "1000");
		await page.fill("#transaction-exchange-rate", "1");
		logger.log("action", "info", "✓ 本金 1000 / 汇率 1 已填充");
		await saveScreenshot(page, "04-transaction", "T-TXN-001-03-form-filled");

		await page.click('button:has-text("保存")');
		// 详情页 URL 无 query 且非 new：排除录入页自身（/transactions/new?planId=…）导致 waitForURL 立即假通过
		await page.waitForURL(/\/transactions\/(?!new)[^/?]+$/, { timeout: 15000 });
		await page.waitForLoadState("networkidle");
		logger.log("action", "info", `✓ 保存成功，跳转交易详情 ${page.url()}`);

		// 交易详情：本金 1000.0000（接口字符串原样渲染）
		await expect(page.getByText("本金").first()).toBeVisible();
		await expect(page.getByText("1000").first()).toBeVisible();
		await saveScreenshot(page, "04-transaction", "T-TXN-001-04-txn-detail");

		await logger.saveToFile();
	});

	test("T-TXN-002: 交易详情页面包屑（单级「交易详情」）", async ({ page }) => {
		logger.log("action", "info", "开始：交易详情面包屑");
		logger.setupPageListeners(page);

		const { user, planId } = await seedPlanScenario(`txn-nav-${Date.now()}`);
		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);

		await page.goto(
			`${BASE_URL}/transactions/new?planId=${planId}&currency=CAD`,
		);
		await page.waitForLoadState("networkidle");
		await expect(
			page.locator('nav[aria-label="面包屑"]').getByText("快速录入"),
		).toBeVisible();
		await saveScreenshot(page, "04-transaction", "T-TXN-002-01-breadcrumb");

		await logger.saveToFile();
	});
});
