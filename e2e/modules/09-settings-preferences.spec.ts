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
 * 设置页偏好修改 E2E（changes/onboarding-rework/技术方案.md §8.3 场景 4）
 *
 * 覆盖需求文档场景 12/13/14：
 * - 设置页改准备偏好「安心」+ 关闭提醒 + 改语言英文 → 保存 → 刷新后仍生效
 * - 外汇账户/计划页无任何数据变化（偏好修改不产生记账数据）
 * - 本位币只读展示（需求场景 7 的设置页断言）
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";

test.describe("【设置页】偏好随时改", () => {
	const logger = new TestLogger("settings-preferences");
	let seed: Awaited<ReturnType<typeof seedRegisterAndLogin>>;

	test.beforeAll(async () => {
		seed = await seedRegisterAndLogin("settings-pref");
		await seedOnboarding(seed.accessToken, "CNY");
		logger.log("action", "info", `✓ 造数完成（已建账 CNY）${seed.email}`);
	});

	test("T-SET-001: 偏好修改 → 保存 → 刷新持久，业务页无变化", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：设置页偏好修改");
		logger.setupPageListeners(page);

		await injectLoginCookie(page.context(), seed.accessToken, BASE_URL);

		// 浏览器端错误透传到测试日志（radix 交互排障用）
		page.on("pageerror", (err) =>
			logger.log("action", "error", `PAGEERROR: ${err.message}`),
		);
		page.on("console", (msg) => {
			if (msg.type() === "error")
				logger.log("action", "error", `CONSOLE: ${msg.text()}`);
		});

		// 修改前：外汇账户/计划页正常渲染（基线，用于「无数据变化」对照——
		// 偏好修改无记账后果由接口测试覆盖，E2E 仅断言业务页稳定可用）
		await page.goto(`${BASE_URL}/accounts`);
		await page.waitForLoadState("networkidle");
		await expect(
			page.getByRole("heading", { name: "外汇账户" }).first(),
		).toBeVisible();
		logger.log("action", "info", "✓ 修改前账户页正常");

		// 设置页：本位币只读 + 旁注（需求场景 7；readonly input，value 含币种名）
		await page.goto(`${BASE_URL}/settings`);
		await page.waitForLoadState("networkidle");
		await expect(
			page.locator('[data-testid="settings-base-currency"]'),
		).toHaveValue(/CNY/);
		await expect(
			page.locator('[data-testid="base-currency-readonly-note"]'),
		).toContainText("不可更换");
		await expect(
			page.locator(
				'[data-testid="settings-page"] [data-testid="base-currency-select"]',
			),
		).toHaveCount(0);
		await saveScreenshot(page, "09-settings", "T-SET-001-01-settings-loaded");

		// 改准备偏好「安心」+ 关闭提醒 + 语言英文（radix Select 稳健展开，见 test-utils）
		await selectRadixOption(
			page,
			page.locator('[data-testid="prep-preference-select"]'),
			"安心",
		);
		await page.uncheck('[data-testid="reminder-toggle"]');
		await selectRadixOption(
			page,
			page.locator('[data-testid="locale-select"]'),
			"英文",
		);
		await page.click('[data-testid="settings-save"]');
		// 保存成功 toast（sonner）
		await expect(page.getByText("设置已保存")).toBeVisible({
			timeout: 10000,
		});
		await saveScreenshot(page, "09-settings", "T-SET-001-02-saved");
		logger.log("action", "info", "✓ 偏好已保存（cautious / 提醒关 / en）");

		// 刷新后仍生效（持久化；radix Select trigger 显示 label 文本）
		await page.reload();
		await page.waitForLoadState("networkidle");
		await expect(
			page.locator('[data-testid="prep-preference-select"]'),
		).toContainText("安心");
		await expect(page.locator('[data-testid="locale-select"]')).toContainText(
			"英文",
		);
		await expect(
			page.locator('[data-testid="reminder-toggle"]'),
		).not.toBeChecked();
		await saveScreenshot(page, "09-settings", "T-SET-001-03-after-reload");
		logger.log("action", "info", "✓ 刷新后偏好仍生效");

		// 外汇账户/计划页无任何数据变化（仍正常渲染，无错误态）
		await page.goto(`${BASE_URL}/accounts`);
		await page.waitForLoadState("networkidle");
		await expect(
			page.getByRole("heading", { name: "外汇账户" }).first(),
		).toBeVisible();
		await page.goto(`${BASE_URL}/plans`);
		await page.waitForLoadState("networkidle");
		await expect(
			page.locator('[aria-label="按状态筛选换汇计划"]'),
		).toBeVisible();
		await saveScreenshot(
			page,
			"09-settings",
			"T-SET-001-04-business-unchanged",
		);
		logger.log("action", "info", "✓ 账户/计划页无数据变化");

		await logger.saveToFile();
	});
});
