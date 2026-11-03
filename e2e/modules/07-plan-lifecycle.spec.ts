import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import {
	completePlanViaApi,
	injectLoginCookie,
	seedFullyAllocatedPlan,
	seedOnboarding,
	seedPlanWithAllocation,
	seedRegisterAndLogin,
	seedTransaction,
	seedUsage,
} from "../helpers/api-seeder";

/**
 * 换汇计划生命周期 E2E（阶段5-收尾项方案 §5：M5 全生命周期闭环）
 *
 * 覆盖流程：
 * - T-PLAN-LC-001: 首页「新建计划」直达入口（§1）→ 创建 → 详情字段齐全
 * - T-PLAN-LC-002: 详情 → 修改（调整目标 10000→8000）：影响预览 → 确认 → 目标更新 + 修改记录
 * - T-PLAN-LC-003: 详情 → 修改（分配总额超额）：上限拦截内联提示，数据不变
 * - T-PLAN-LC-004: 取消计划：状态徽标已取消、分配释放（§2 账户视图剩余归 0、
 *   未分配余额恢复）、修改记录保留
 * - T-PLAN-LC-005: 已完成计划 → 重新开启并提高目标：重开预览确认 → 缺口重算、
 *   原完成记录与日志保留
 *
 * 造数走 e2e/helpers/api-seeder.ts（真实后端 API）；登录态经 accessToken cookie 注入。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";

/** 打开「修改/重新开启」两段式对话框（详情页头按钮，按 exact 避免匹配到其他入口） */
async function openAdjustDialog(
	page: import("@playwright/test").Page,
	buttonName: "修改" | "重新开启",
) {
	await page.getByRole("button", { name: buttonName, exact: true }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("【换汇计划生命周期】新建 / 调目标 / 调分配 / 取消 / 重开", () => {
	const logger = new TestLogger("plan-lifecycle");

	test("T-PLAN-LC-001: 首页「新建计划」直达入口 → 创建 → 详情", async ({ page }) => {
		logger.log("action", "info", "开始：首页新建计划入口");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin("plan-lc-create");
		await seedOnboarding(user.accessToken, "CNY");
		// 先持有一笔 CAD 买入（6,000）：首页进入正常态（有账户）且「计入已有外币」可分配
		await seedTransaction(user.accessToken, "CAD", "6000");

		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/home`);
		await page.waitForLoadState("networkidle");

		// §1 新入口断言：正常态首页顶栏「新建计划」→ /plans/new（与录入买入并排）
		const newPlanEntry = page.locator('a[href="/plans/new"]', {
			hasText: "新建计划",
		});
		await expect(newPlanEntry).toBeVisible();
		await expect(page.locator('a[href="/transactions/new"]')).toBeVisible();
		await newPlanEntry.click();
		await page.waitForURL(`${BASE_URL}/plans/new`);
		await saveScreenshot(page, "07-plan-lifecycle", "T-PLAN-LC-001-01-entry");

		// 填表创建（对齐 03-plan T-PLAN-001 填法，含 Select 焦点偶发吞点击重试）
		await page.fill("#plan-name", "生命周期计划");
		const currencyTrigger = page.locator('[aria-label="目标币种"]');
		const listbox = page.locator('[role="listbox"]');
		for (let i = 0; i < 3; i += 1) {
			await currencyTrigger.click();
			if (await listbox.isVisible().catch(() => false)) break;
			await currencyTrigger.press("Enter");
			if (await listbox.isVisible().catch(() => false)) break;
			await page.waitForTimeout(500);
		}
		await expect(listbox).toBeVisible();
		await page.keyboard.type("CAD", { delay: 60 });
		await page.keyboard.press("Enter");
		await page.fill("#plan-target-amount", "10000");
		await page.fill("#plan-expect-use-date", "2030-02-15");
		await page.fill("#plan-prep-lead-days", "3");
		await page.fill("#plan-allocated-amount", "5000");
		await page.click('button:has-text("创建计划")');
		await page.waitForURL(`${BASE_URL}/home`, { timeout: 15000 });

		// 列表卡：进度条可见（§3）且整卡进详情
		await page.goto(`${BASE_URL}/plans`);
		await page.waitForLoadState("networkidle");
		const card = page
			.locator('a[href^="/plans/"]:not([href="/plans/new"])')
			.first();
		await expect(card).toBeVisible();
		await expect(card.getByText("准备进度")).toBeVisible();
		// 准备进度 50%：目标 10000 − 缺口 5000 = 已备 5000（Decimal 口径 (10000-5000)/10000）
		await expect(card.getByText("50%", { exact: true })).toBeVisible();
		await card.click();
		await page.waitForURL(/\/plans\/[^/]+$/, { timeout: 10000 });
		await page.waitForLoadState("networkidle");

		// 详情卡字段齐全（目标币种 + 官方术语金额项 + 缺口提示 + 准备进度）
		await expect(page.getByText("目标币种 CAD")).toBeVisible();
		for (const label of ["目标金额", "累计已使用", "分配总额"]) {
			await expect(
				page
					.getByText(label, { exact: true })
					.first(),
			).toBeVisible();
		}
		await expect(page.getByText(/资金缺口 5000/)).toBeVisible();
		await expect(page.getByText(/准备进度：已备齐 5000/)).toBeVisible();
		await saveScreenshot(page, "07-plan-lifecycle", "T-PLAN-LC-001-02-detail");
		await logger.saveToFile();
	});

	test("T-PLAN-LC-002: 调整目标金额（预览 → 确认 → 目标更新 + 修改记录）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：调整目标金额");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin("plan-lc-target");
		await seedOnboarding(user.accessToken, "CNY");
		await seedTransaction(user.accessToken, "CAD", "6000");
		const planId = await seedPlanWithAllocation(
			user.accessToken,
			"CAD",
			"6000",
		);

		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/plans/${planId}`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByText("目标币种 CAD")).toBeVisible();

		// 修改：目标 10000 → 8000（分配保持 6000 不动）
		await openAdjustDialog(page, "修改");
		await page.fill("#plan-adjust-target", "8000");
		await page.getByRole("button", { name: "生成预览", exact: true }).click();

		// 影响预览：修改前/修改后对比 + 新资金缺口 2000（8000 − 0 − 6000）
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByText("修改后")).toBeVisible();
		await expect(dialog.getByText("新资金缺口")).toBeVisible();
		await expect(dialog.getByText(/2000/).first()).toBeVisible();
		await saveScreenshot(page, "07-plan-lifecycle", "T-PLAN-LC-002-01-preview");

		await page.getByRole("button", { name: "确认修改", exact: true }).click();
		await expect(page.getByText("计划修改已保存")).toBeVisible({
			timeout: 10_000,
		});

		// 详情回显：目标 8000、缺口 2000；修改记录新增「目标金额调整」
		await expect(page.getByText("目标币种 CAD")).toBeVisible();
		await expect(page.getByText(/准备进度：已备齐 6000 \/ 目标 8000/)).toBeVisible();
		await expect(page.getByText("目标金额调整").first()).toBeVisible();
		await saveScreenshot(page, "07-plan-lifecycle", "T-PLAN-LC-002-02-updated");
		await logger.saveToFile();
	});

	test("T-PLAN-LC-003: 调整分配超额被拦截（上限 caps 内联提示，数据不变）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：分配超额拦截");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin("plan-lc-over");
		await seedOnboarding(user.accessToken, "CNY");
		// 买入 6000，计划仅分配 2000：修改总额上限 = min(还需使用 10000, 未分配 4000 + 原剩余 2000) = 6000（例 09 修改口径）
		await seedTransaction(user.accessToken, "CAD", "6000");
		const planId = await seedPlanWithAllocation(
			user.accessToken,
			"CAD",
			"2000",
		);

		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/plans/${planId}`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByText("目标币种 CAD")).toBeVisible();

		await openAdjustDialog(page, "修改");
		await page.fill("#plan-adjust-allocation", "99999");
		await page.getByRole("button", { name: "生成预览", exact: true }).click();

		// 内联提示：caps 三值（未分配 4000 / 修改上限 6000 / 还需使用 10000），预填上限引导
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByText(/最多可分配 6000/)).toBeVisible({
			timeout: 10_000,
		});
		await saveScreenshot(page, "07-plan-lifecycle", "T-PLAN-LC-003-01-over-limit");

		// 关闭对话框取消：分配总额仍 2000（超额未保存）
		await page.getByRole("button", { name: "取消", exact: true }).click();
		await expect(
			page.getByText(/分配总额/, { exact: false }).first(),
		).toBeVisible();
		await expect(page.getByText(/准备进度：已备齐 2000 \/ 目标 10000/)).toBeVisible();
		await logger.saveToFile();
	});

	test("T-PLAN-LC-004: 取消计划 → 分配释放（账户视图剩余 0、未分配余额恢复）、记录保留", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：取消计划");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin("plan-lc-cancel");
		await seedOnboarding(user.accessToken, "CNY");
		await seedTransaction(user.accessToken, "USD", "10000");
		const planId = await seedPlanWithAllocation(
			user.accessToken,
			"USD",
			"6000",
		);

		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/plans/${planId}`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByText("目标币种 USD")).toBeVisible();

		// 取消 → 二次确认
		await page.getByRole("button", { name: "取消计划", exact: true }).click();
		await expect(page.getByText("确认取消这个换汇计划？")).toBeVisible();
		await page
			.getByRole("alertdialog")
			.getByRole("button", { name: "确认取消计划", exact: true })
			.click();
		await expect(page.getByText("计划已取消，剩余分配已释放")).toBeVisible({
			timeout: 10_000,
		});
		// 详情态：取消提示 + 修改记录保留「取消计划」
		await expect(page.getByText(/计划已取消/).first()).toBeVisible();
		await expect(page.getByText("取消计划", { exact: true }).first()).toBeVisible();
		await saveScreenshot(page, "07-plan-lifecycle", "T-PLAN-LC-004-01-cancelled");

		// 列表徽标：已取消
		await page.goto(`${BASE_URL}/plans`);
		await page.waitForLoadState("networkidle");
		await expect(
			page
				.locator('a[href^="/plans/"]:not([href="/plans/new"])')
				.first()
				.getByText("已取消", { exact: true }),
		).toBeVisible();

		// §2 账户分配视图：该计划行剩余 0、状态已取消；未分配余额恢复 10000（无使用 → amount 归 0 不出行）
		await page.goto(`${BASE_URL}/accounts/USD`);
		await page.waitForLoadState("networkidle");
		const allocationSection = page.locator('section[aria-label="按计划分配"]');
		await expect(allocationSection).toBeVisible();
		// 取消且无使用：amount = used = 0 → 不产生明细行（全 0 行过滤）→ 空态文案
		await expect(allocationSection.getByText("暂无计划分配该币种")).toBeVisible();
		// 未分配余额恢复全额：锚定摘要区「未分配余额」卡（余额卡同为 10000.0000，勿混），
		// 且已分配归零——两者共同证明释放（对抗审 m1）
		const summaryCards = page.getByLabel("账户金额概览");
		const unallocatedCard = summaryCards
			.locator('[data-slot="card"]')
			.filter({ hasText: "未分配余额" });
		await expect(unallocatedCard.getByText("10000.0000")).toBeVisible();
		const allocatedCard = summaryCards
			.locator('[data-slot="card"]')
			.filter({ hasText: "已分配" });
		await expect(allocatedCard.getByText("0.0000")).toBeVisible();
		await saveScreenshot(page, "07-plan-lifecycle", "T-PLAN-LC-004-02-account");
		await logger.saveToFile();
	});

	test("T-PLAN-LC-005: 已完成计划 → 重新开启并提高目标（缺口重算、记录保留）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：重开已完成计划");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin("plan-lc-reopen");
		await seedOnboarding(user.accessToken, "CNY");
		await seedTransaction(user.accessToken, "USD", "10000");
		// 全额分配 → 用满 → API 完成确认（完成 UI 链路由 11-plan-usage 覆盖）
		const planId = await seedFullyAllocatedPlan(
			user.accessToken,
			"USD",
			"10000",
		);
		await seedUsage(user.accessToken, planId, "10000");
		await completePlanViaApi(user.accessToken, planId);

		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/plans/${planId}`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByText("目标币种 USD")).toBeVisible();

		// 重新开启：仅可改目标金额（分配/节奏/缓冲字段不出现）
		await openAdjustDialog(page, "重新开启");
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByText("重新开启计划")).toBeVisible();
		await expect(dialog.locator("#plan-adjust-allocation")).toHaveCount(0);
		await dialog.locator("#plan-adjust-target").fill("12000");
		await page.getByRole("button", { name: "生成预览", exact: true }).click();

		// 重开预览：提示语 + 修改后目标 12000、新资金缺口 2000
		await expect(
			dialog.getByText("本次调整将重新开启已完成计划"),
		).toBeVisible();
		await expect(dialog.getByText("修改后")).toBeVisible();
		await saveScreenshot(page, "07-plan-lifecycle", "T-PLAN-LC-005-01-reopen-preview");

		await page
			.getByRole("button", { name: "确认重新开启", exact: true })
			.click();
		await expect(page.getByText("计划已重新开启")).toBeVisible({
			timeout: 10_000,
		});

		// 回到进行中：目标 12000、缺口 2000（已用 10000 全额分配不再变化）；
		// 原完成记录（完成确认）与重开记录（重新开启）并存
		await expect(
			page.getByText(/准备进度：已备齐 10000 \/ 目标 12000/),
		).toBeVisible();
		await expect(page.getByText("完成确认", { exact: true }).first()).toBeVisible();
		await expect(page.getByText("重新开启", { exact: true }).first()).toBeVisible();
		await saveScreenshot(page, "07-plan-lifecycle", "T-PLAN-LC-005-02-reopened");
		await logger.saveToFile();
	});
});
