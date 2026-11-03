import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import {
	injectLoginCookie,
	seedAccountScenario,
	seedRegisterAndLogin,
	type AccountSeedResult,
} from "../helpers/api-seeder";

/**
 * 外汇账户模块 E2E（changes/account-module/技术方案.md §8.3，按用户操作路径编号）
 *
 * 场景 1：查看账户列表与金额 —— 列表 CAD 行三值精确断言（接口字符串原样渲染）+ 术语「未分配余额」
 * 场景 2：账户详情与流水 —— 金额卡四值（含 8 位平均单位成本）、流水倒序、动态本位币成本列、
 *         买入行级跳转 /transactions/:id 且详情金额与流水行一致
 * 场景 3：空账户引导 —— 新注册用户空态 + 「录入换汇」入口跳 /transactions/new
 *
 * 造数走 e2e/helpers/api-seeder.ts（真实后端 API），登录态经 accessToken cookie 注入
 * （与 clients/chat-web/lib/auth/token.ts 唯一事实来源一致）。
 * ⚠️ 依赖人工预启动的前后端服务（playwright.config 已移除 webServer，本文件不拉起服务）。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";

test.describe("【外汇账户模块】账户列表 / 详情 / 流水", () => {
	const logger = new TestLogger("account-module");
	let seed: AccountSeedResult;

	test.beforeAll(async () => {
		// 场景 1/2 共用账本：CAD 余额 12,000 / 分配 6,000 / 未分配 6,000 / 平均成本 1.00000000
		seed = await seedAccountScenario("shared");
		logger.log("action", "info", `✓ 造数完成 userId=${seed.userId}`);
	});

	test("T-ACCOUNT-001: 场景 1 —— 查看账户列表与金额（三值精确断言 + 术语）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：查看账户列表与金额");
		logger.setupPageListeners(page);

		await injectLoginCookie(page.context(), seed.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/accounts`);
		await page.waitForLoadState("networkidle");

		// 侧边栏导航进入（回归验证预留入口已不再 404）：直接点击「外汇账户」
		await page.click('aside a[href="/accounts"]');
		await page.waitForLoadState("networkidle");

		// 列表出现 CAD 行
		const cadRow = page.locator("tr", { hasText: "CAD" }).first();
		await expect(cadRow).toBeVisible();

		// 三值精确断言：接口字符串原样渲染（无千分位/精度裁剪），可 toHaveText 精确命中
		await expect(cadRow).toContainText("CAD");
		await expect(cadRow).toContainText("12000.0000"); // 余额 = 6,000 × 2
		await expect(cadRow).toContainText("6000.0000"); // 已分配 = 计划分配
		await expect(cadRow).toContainText("6000.0000"); // 未分配余额 = 12,000 − 6,000

		// 术语裁决：表头为「未分配余额」（§1.1 裁决 1，废弃「可分配」）
		await expect(page.locator("th", { hasText: "未分配余额" })).toBeVisible();
		await saveScreenshot(page, "02-account", "T-ACCOUNT-001-account-list");

		logger.log("action", "info", "✓ 列表三值与术语断言通过");
	});

	test("T-ACCOUNT-002: 场景 2 —— 账户详情与流水（四卡 / 倒序 / 本位币列 / 行级跳转）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：账户详情与流水");
		logger.setupPageListeners(page);

		await injectLoginCookie(page.context(), seed.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/accounts`);
		await page.waitForLoadState("networkidle");

		// 列表行点击「查看账户」进入 /accounts/CAD
		const cadRow = page.locator("tr", { hasText: "CAD" }).first();
		await cadRow.getByRole("link", { name: "查看账户" }).click();
		await expect(page).toHaveURL(`${BASE_URL}/accounts/CAD`);
		await page.waitForLoadState("networkidle");

		// 金额卡四值：原样渲染接口字符串（平均单位成本 8 位），null 显示「—」的降级由详情降级用例覆盖
		// 「未分配余额」限定摘要区：阶段5 §2 后账户详情页新增「计划分配」只读表，
		// 其合计行同样使用官方术语「未分配余额」（全局断言会 strict 冲突）
		const summaryCards = page.getByLabel("账户金额概览");
		await expect(summaryCards.getByText("余额", { exact: true })).toBeVisible();
		await expect(summaryCards.getByText("已分配", { exact: true })).toBeVisible();
		await expect(
			summaryCards.getByText("未分配余额", { exact: true }),
		).toBeVisible();
		await expect(
			summaryCards.getByText("平均单位成本", { exact: true }),
		).toBeVisible();
		await expect(page.getByText("12000.0000").first()).toBeVisible();
		await expect(page.getByText("6000.0000").first()).toBeVisible();
		await expect(page.getByText("1.00000000")).toBeVisible(); // (6000+6000) ÷ 12000，toFixed(8)
		await saveScreenshot(
			page,
			"02-account",
			"T-ACCOUNT-002-account-detail-ledger",
		);

		// 流水表：两行买入记录按日期倒序（同日按录入倒序）；类型标签「买入」
		// 锚定流水表（阶段5 §2 后页面新增「计划分配」只读表，页内不止一个 tbody）
		const ledgerTable = page.locator("section", {
			has: page.getByRole("heading", { name: "账户流水" }),
		});
		const rows = ledgerTable.locator("tbody tr");
		await expect(rows).toHaveCount(2);
		await expect(rows.first()).toContainText("买入");
		await expect(rows.nth(1)).toContainText("买入");

		// 成本列表头动态本位币（baseCurrency=CNY 由接口返回，前端不硬编码）
		await expect(
			ledgerTable.locator("th", { hasText: "成本（CNY）" }),
		).toBeVisible();

		// 买入行级跳转：倒序首行 = 后录入的一笔，取行内 stretched link 的目标作为断言基准（不硬编码 id）
		const rowHref = await rows
			.first()
			.locator('a[href^="/transactions/"]')
			.getAttribute("href");
		expect(rowHref).toBeTruthy();
		await rows.first().click();
		await expect(page).toHaveURL(`${BASE_URL}${rowHref}`);

		// 详情页金额与流水行一致（该笔本金 6,000、汇率 1、成本 6,000）
		await page.waitForLoadState("networkidle");
		await expect(page.getByText("6000.0000").first()).toBeVisible();

		logger.log("action", "info", "✓ 详情四卡 / 流水倒序 / 行级跳转断言通过");
	});

	test("T-ACCOUNT-003: 场景 3 —— 空账户引导（新用户空态 + 录入入口）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：空账户引导");
		logger.setupPageListeners(page);

		// 新注册用户（不完成初始化设置，构造 baseCurrency=null 降级口径）
		const fresh = await seedRegisterAndLogin("empty");
		await injectLoginCookie(page.context(), fresh.accessToken, BASE_URL);

		await page.goto(`${BASE_URL}/accounts`);
		await page.waitForLoadState("networkidle");

		// 空态引导
		await expect(page.getByText("还没有任何外汇账户")).toBeVisible();

		// 「录入换汇」入口跳转 /transactions/new
		await page.getByRole("link", { name: "录入换汇" }).first().click();
		await expect(page).toHaveURL(`${BASE_URL}/transactions/new`);

		logger.log("action", "info", "✓ 空态引导与录入入口跳转断言通过");
	});
});
