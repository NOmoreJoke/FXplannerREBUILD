import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import {
	injectLoginCookie,
	isBizTodayWorkday,
	seedOnboarding,
	seedPlanDueToday,
	seedRegisterAndLogin,
} from "../helpers/api-seeder";

/**
 * 提醒与到期处理 E2E（changes/reminders/技术方案.md §10.5 三条用户路径）
 *
 * 前置：建计划（startDate = 业务今天 → 首批准备节点命中今天，gap>0）→
 * 打开首页即触发 GET /reminders 读时懒生成（同计划同日合并，PREP_DUE）。
 *
 * 路径 1（T-REM-001）准备提醒出现与防重复打扰：今日提醒区可见、铃铛角标为 2（两个计划）；
 *          再次进入首页角标不增长（同日已有行不重发）。
 * 路径 2（T-REM-002）已读流转：点击条目 → 跳转 /plans/:id → 返回提醒中心该条已读；
 *          「全部标为已读」后未读清零、角标消失。
 * 路径 3（T-REM-003）开关闭环：设置页关提醒 → 首页无角标 + 关闭提示、焦点横幅仍在；
 *          重新开启 → 无重复提醒（角标不回增）。
 *
 * 业务今天为周末（UTC+8 口径）时跳过：R1/R3 均无法命中当天（规格「错过不补发」，
 * 排期最早从下个工作日起），属日历依赖用例的既定边界。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";

test.describe("【提醒中心】提醒与到期处理", () => {
	const logger = new TestLogger("reminders");
	let seed: Awaited<ReturnType<typeof seedRegisterAndLogin>>;

	// 业务今天为周末（UTC+8 口径）时跳过：R1/R3 均无法命中当天（规格「错过不补发」，
	// 排期最早从下个工作日起），属日历依赖用例的既定边界
	test.skip(
		!isBizTodayWorkday(),
		"业务今天（UTC+8）为周末：准备节点无法命中今天，用例按日历边界跳过",
	);

	test.beforeAll(async () => {
		seed = await seedRegisterAndLogin("reminder");
		await seedOnboarding(seed.accessToken, "CNY");
		// 两个计划（USD/JPY），首批节点均命中业务今天 → 今日提醒 2 条未读
		await seedPlanDueToday(seed.accessToken, "USD", "10000");
		await seedPlanDueToday(seed.accessToken, "JPY", "100000");
		logger.log(
			"action",
			"info",
			`✓ 造数完成（已建账 CNY + 2 个今日节点计划）${seed.email}`,
		);
	});

	test("T-REM-001: 准备提醒出现与合并，二次进入不重复打扰", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：T-REM-001 准备提醒出现");
		logger.setupPageListeners(page);

		await injectLoginCookie(page.context(), seed.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/home`);
		await page.waitForLoadState("networkidle");

		// 今日提醒区可见（两个计划各 1 条，未读）
		const section = page.locator('[data-testid="reminder-section"]');
		await expect(section).toBeVisible();
		const cards = section.locator('[data-testid="reminder-card"]');
		await expect(cards).toHaveCount(2);
		await expect(cards.first()).toContainText("今天到了本次准备日期");
		logger.log("action", "info", "✓ 今日提醒区出现 2 条准备提醒");

		// 铃铛角标 = 2（未读数）
		const badge = page.locator('[data-testid="reminder-badge"]');
		await expect(badge).toHaveText("2");
		await saveScreenshot(page, "11-reminders", "T-REM-001-01-home-badges");
		logger.log("action", "info", "✓ 铃铛角标为 2");

		// 二次进入首页：角标不增长（同计划同日已有行 → 不重发）
		await page.goto(`${BASE_URL}/plans`);
		await page.waitForLoadState("networkidle");
		await page.goto(`${BASE_URL}/home`);
		await page.waitForLoadState("networkidle");
		await expect(page.locator('[data-testid="reminder-badge"]')).toHaveText(
			"2",
		);
		await expect(page.locator('[data-testid="reminder-card"]')).toHaveCount(2);
		await saveScreenshot(page, "11-reminders", "T-REM-001-02-reenter");
		logger.log("action", "info", "✓ 二次进入角标仍为 2（不重复打扰）");

		await logger.saveToFile();
	});

	test("T-REM-002: 点击条目已读 + 跳转计划详情 + 全部标为已读", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：T-REM-002 已读流转");
		logger.setupPageListeners(page);

		await injectLoginCookie(page.context(), seed.accessToken, BASE_URL);

		// 首页：点第一条提醒卡（USD 计划）
		await page.goto(`${BASE_URL}/home`);
		await page.waitForLoadState("networkidle");
		const firstCard = page
			.locator('[data-testid="reminder-card"]')
			.filter({ hasText: "USD" })
			.first();
		await expect(firstCard).toBeVisible();
		await firstCard.click();

		// 跳转对应计划详情
		await page.waitForURL(/\/plans\/[^/]+$/);
		await expect(page).toHaveURL(/\/plans\/[^/]+$/);
		await saveScreenshot(page, "11-reminders", "T-REM-002-01-plan-detail");
		logger.log("action", "info", "✓ 点击条目跳转计划详情");

		// 返回提醒中心：该条已读（data-read=true）
		await page.goto(`${BASE_URL}/reminders`);
		await page.waitForLoadState("networkidle");
		const usdCard = page
			.locator('[data-testid="reminder-card"]')
			.filter({ hasText: "USD" })
			.first();
		await expect(usdCard).toBeVisible();
		await expect(usdCard).toHaveAttribute("data-read", "true");
		// JPY 条目仍未读；「全部标为已读」可见
		const jpyCard = page
			.locator('[data-testid="reminder-card"]')
			.filter({ hasText: "JPY" })
			.first();
		await expect(jpyCard).toHaveAttribute("data-read", "false");
		await expect(
			page.locator('[data-testid="reminder-read-all"]'),
		).toBeVisible();
		await saveScreenshot(page, "11-reminders", "T-REM-002-02-one-read");
		logger.log("action", "info", "✓ 点击条目已记为已读");

		// 全部标为已读 → 所有条目已读
		await page.click('[data-testid="reminder-read-all"]');
		await expect(jpyCard).toHaveAttribute("data-read", "true", {
			timeout: 10000,
		});
		await saveScreenshot(page, "11-reminders", "T-REM-002-03-all-read");
		logger.log("action", "info", "✓ 全部标为已读");

		// 首页角标消失（未读归零）
		await page.goto(`${BASE_URL}/home`);
		await page.waitForLoadState("networkidle");
		await expect(page.locator('[data-testid="reminder-badge"]')).toHaveCount(0);
		logger.log("action", "info", "✓ 未读角标消失");

		await logger.saveToFile();
	});

	test("T-REM-003: 关闭提醒 → 状态仍展示；重新开启不重复提醒", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：T-REM-003 开关闭环");
		logger.setupPageListeners(page);

		await injectLoginCookie(page.context(), seed.accessToken, BASE_URL);

		// 设置页关闭提醒开关并保存
		await page.goto(`${BASE_URL}/settings`);
		await page.waitForLoadState("networkidle");
		await page.uncheck('[data-testid="reminder-toggle"]');
		await page.click('[data-testid="settings-save"]');
		await expect(page.getByText("设置已保存")).toBeVisible({
			timeout: 10000,
		});
		logger.log("action", "info", "✓ 提醒开关已关闭并保存");

		// 首页：无角标、今日提醒区变为关闭提示、焦点横幅仍在（状态展示不受开关影响）
		await page.goto(`${BASE_URL}/home`);
		await page.waitForLoadState("networkidle");
		await expect(page.locator('[data-testid="reminder-badge"]')).toHaveCount(0);
		await expect(
			page.locator('[data-testid="reminder-disabled-note"]'),
		).toBeVisible();
		await expect(page.locator('[data-testid="reminder-section"]')).toHaveCount(
			0,
		);
		// 焦点计划横幅仍展示（「最晚备汇日」统计卡随焦点计划存在；exact 避开横幅文案子串）
		await expect(page.getByText("最晚备汇日", { exact: true })).toBeVisible();
		await saveScreenshot(page, "11-reminders", "T-REM-003-01-disabled");
		logger.log("action", "info", "✓ 关闭后无角标、有提示、横幅仍在");

		// 重新开启 → 同一天不把关掉的提醒再发一遍（角标不回增）
		await page.goto(`${BASE_URL}/settings`);
		await page.waitForLoadState("networkidle");
		await page.check('[data-testid="reminder-toggle"]');
		await page.click('[data-testid="settings-save"]');
		await expect(page.getByText("设置已保存")).toBeVisible({
			timeout: 10000,
		});
		await page.goto(`${BASE_URL}/home`);
		await page.waitForLoadState("networkidle");
		await expect(page.locator('[data-testid="reminder-badge"]')).toHaveCount(0);
		// 今日提醒区恢复展示既有条目（已读样式），不出现新的未读打扰
		const section = page.locator('[data-testid="reminder-section"]');
		await expect(section).toBeVisible();
		await expect(
			section.locator('[data-testid="reminder-unread-dot"]'),
		).toHaveCount(0);
		await saveScreenshot(page, "11-reminders", "T-REM-003-02-reenabled");
		logger.log("action", "info", "✓ 重新开启后角标不回增、无未读");

		await logger.saveToFile();
	});
});
