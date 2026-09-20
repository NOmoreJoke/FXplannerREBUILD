import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import {
	injectLoginCookie,
	seedOnboarding,
	seedPlanWithAllocation,
	seedRegisterAndLogin,
	seedTransaction,
	seedUsage,
} from "../helpers/api-seeder";

/**
 * 资金使用模块 E2E（changes/usage-recording 技术方案 §8.4）
 *
 * 覆盖流程：
 * - T-USAGE-001: 分次使用全程（记录使用 → 双进度/状态徽标/还需使用/使用记录列表
 *   → 用完「资金已使用完成」→ 完成确认 → 计划已完成）
 * - T-USAGE-002: 超额拦截（金额 > 剩余分配 → 内联提示含当前剩余，数据不变）
 * - T-USAGE-003: 日期拦截（晚于今天 → 可区分提示，不记账）
 * - T-USAGE-004: 账户流水成本展示（USAGE 行 totalCost 不再为空）
 *
 * 造数走 e2e/helpers/api-seeder.ts（真实后端 API）；登录态经 accessToken cookie 注入。
 * 成本断言锚定：买入造数本金 = 数量（汇率 1）→ unitCost = 1 → 使用成本 = 使用金额。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";
/** 造数用后端地址（对齐 api-seeder 的 API_URL） */
const API_URL = process.env.API_URL ?? "http://localhost:4001";

/** 造数直连 API（对齐 api-seeder 的 api() 封装，仅本文件 adjust 链路使用） */
async function api<T>(
	path: string,
	init: { method: string; token?: string; body?: unknown },
): Promise<T> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (init.token) headers.Authorization = `Bearer ${init.token}`;
	const res = await fetch(`${API_URL}${path}`, {
		method: init.method,
		headers,
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
	const json = (await res.json()) as {
		success: boolean;
		data: T;
		code?: string;
		message?: string;
	};
	if (!res.ok || !json.success) {
		throw new Error(
			`API 造数失败 ${init.method} ${path} → ${res.status} ${json.code ?? ""} ${json.message ?? ""}`,
		);
	}
	return json.data;
}

/** 今天（UTC+8 口径，与前端 utc8TodayYmd 同源算法）：YYYY-MM-DD */
function utc8TodayYmd(): string {
	return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 明天（UTC+8 口径）：日期拦截用例输入 */
function utc8TomorrowYmd(): string {
	return new Date(Date.now() + 32 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 创建「分配总额 = 目标金额」的计划：
 * 创建路径分配 = 目标时分批总额为 0（400 AMOUNT_TOO_SMALL），故走真实两步链路——
 * 创建（分配 6000，分批总额 > 0）→ PATCH /plans/:id 调高分配至全额（缺口 0 清空排期）。
 */
async function seedFullyAllocatedPlan(
	token: string,
	targetCurrency: string,
	targetAmount: string,
): Promise<string> {
	const planId = await seedPlanWithAllocation(token, targetCurrency, "6000");
	const detail = await api<{ updatedAt: string }>(`/api/plans/${planId}`, {
		method: "GET",
		token,
	});
	await api(`/api/plans/${planId}`, {
		method: "PATCH",
		token,
		body: {
			newAllocAmount: targetAmount,
			expectedUpdatedAt: detail.updatedAt,
		},
	});
	return planId;
}

/** 打开记录使用对话框并填写提交（页面唯一入口：详情页头「记录使用」按钮） */
async function recordUsage(
	page: import("@playwright/test").Page,
	amount: string,
	usedAtYmd?: string,
) {
	await page.getByRole("button", { name: "记录使用", exact: true }).click();
	await page.getByLabel(/使用金额/).fill(amount);
	if (usedAtYmd) {
		await page.fill("#usage-used-at", usedAtYmd);
	}
	await page.getByRole("button", { name: "确认记录", exact: true }).click();
}

test.describe("【资金使用模块】记录使用 / 双进度 / 完成联动 / 流水成本", () => {
	const logger = new TestLogger("plan-usage");

	test("T-USAGE-001: 分次使用全程 → 资金已使用完成 → 完成确认", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：分次使用全程");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin("usage-full");
		await seedOnboarding(user.accessToken, "CNY");
		await seedTransaction(user.accessToken, "USD", "10000");
		const planId = await seedFullyAllocatedPlan(
			user.accessToken,
			"USD",
			"10000",
		);

		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/plans/${planId}`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByText("目标币种 USD")).toBeVisible();
		await saveScreenshot(page, "11-plan-usage", "T-USAGE-001-01-detail-before");

		// 第一笔：使用 4,000 / 今天
		await recordUsage(page, "4000", utc8TodayYmd());
		await expect(page.getByText("使用记录已保存")).toBeVisible({
			timeout: 10_000,
		});

		// 进度区刷新：使用进度 4,000/10,000、双进度条分开、状态徽标「资金已备齐」、还需使用 6,000
		await expect(
			page.getByText("准备进度：已备齐 10000 / 目标 10000 USD"),
		).toBeVisible();
		await expect(
			page.getByText("使用进度：已使用 4000 / 目标 10000 USD"),
		).toBeVisible();
		await expect(page.getByText("资金已备齐", { exact: true })).toBeVisible();
		const stillNeeded = page
			.getByText("还需使用", { exact: true })
			.locator("xpath=following-sibling::dd[1]");
		await expect(stillNeeded).toHaveText(/6000/);
		// 使用记录列表新增一行（金额 4,000 + 本笔成本 4,000，unitCost = 1）
		await expect(
			page.getByText("4000 USD", { exact: true }).first(),
		).toBeVisible();
		await saveScreenshot(
			page,
			"11-plan-usage",
			"T-USAGE-001-02-after-first-usage",
		);

		// 第二笔：使用 6,000 → 用完：状态变「资金已使用完成」、出现「完成确认」按钮
		await recordUsage(page, "6000", utc8TodayYmd());
		await expect(
			page.getByText("使用进度：已使用 10000 / 目标 10000 USD"),
		).toBeVisible();
		await expect(
			page.getByText("资金已使用完成", { exact: true }).first(),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "完成确认", exact: true }),
		).toBeVisible();
		await saveScreenshot(page, "11-plan-usage", "T-USAGE-001-03-used-up");

		// 点完成确认 → 二次确认 → 计划变为已完成（出现「重新开启」，完成按钮消失）
		await page.getByRole("button", { name: "完成确认", exact: true }).click();
		await expect(page.getByText("确认完成这个换汇计划？")).toBeVisible();
		// shadcn AlertDialog 的 content role 是 alertdialog（非 dialog）
		await page
			.getByRole("alertdialog")
			.getByRole("button", { name: "确认完成", exact: true })
			.click();
		await expect(page.getByText("计划已完成")).toBeVisible({ timeout: 10_000 });
		await expect(
			page.getByRole("button", { name: "重新开启", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "完成确认", exact: true }),
		).toBeHidden();
		await saveScreenshot(page, "11-plan-usage", "T-USAGE-001-04-completed");

		await logger.saveToFile();
	});

	test("T-USAGE-002: 超额拦截（金额 > 剩余分配）→ 提示含当前剩余，数据不变", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：超额拦截");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin("usage-over");
		await seedOnboarding(user.accessToken, "CNY");
		await seedTransaction(user.accessToken, "USD", "10000");
		const planId = await seedPlanWithAllocation(
			user.accessToken,
			"USD",
			"2000",
		);

		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/plans/${planId}`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByText("目标币种 USD")).toBeVisible();

		// 使用 2,500 > 剩余分配 2,000 → 内联提示（含当前剩余 2,000），不记账
		await recordUsage(page, "2500", utc8TodayYmd());
		await expect(page.getByText(/剩余分配不足，当前剩余 2000/)).toBeVisible({
			timeout: 10_000,
		});

		// 余额与进度不变：使用进度仍 0%、列表仍空态
		await expect(
			page.getByText("使用进度：已使用 0 / 目标 10000 USD"),
		).toBeVisible();
		await expect(page.getByText("还没有使用记录")).toBeVisible();
		await saveScreenshot(page, "11-plan-usage", "T-USAGE-002-01-over-alloc");

		await logger.saveToFile();
	});

	test("T-USAGE-003: 日期拦截（晚于今天）→ 可区分提示，不记账", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：日期拦截");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin("usage-date");
		await seedOnboarding(user.accessToken, "CNY");
		await seedTransaction(user.accessToken, "USD", "10000");
		const planId = await seedFullyAllocatedPlan(
			user.accessToken,
			"USD",
			"10000",
		);

		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/plans/${planId}`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByText("目标币种 USD")).toBeVisible();

		// 填明天日期（绕过 input max 属性模拟手改）→ 前端校验拦截
		await page.getByRole("button", { name: "记录使用", exact: true }).click();
		await page.getByLabel(/使用金额/).fill("100");
		await page.fill("#usage-used-at", utc8TomorrowYmd());
		await page.getByRole("button", { name: "确认记录", exact: true }).click();
		await expect(page.getByText("使用日期不能晚于今天")).toBeVisible();

		// 关闭对话框：无任何记账
		await page.getByRole("button", { name: "取消", exact: true }).click();
		await expect(page.getByText("还没有使用记录")).toBeVisible();
		await saveScreenshot(page, "11-plan-usage", "T-USAGE-003-01-future-date");

		await logger.saveToFile();
	});

	test("T-USAGE-004: 账户流水 USAGE 行成本展示（不再为空）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：账户流水成本展示");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin("usage-ledger");
		await seedOnboarding(user.accessToken, "CNY");
		await seedTransaction(user.accessToken, "USD", "10000");
		const planId = await seedFullyAllocatedPlan(
			user.accessToken,
			"USD",
			"10000",
		);
		// API 记一笔使用 4,000（unitCost = 1 → 成本 4,000）
		await seedUsage(user.accessToken, planId, "4000");

		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/accounts/USD`);
		await page.waitForLoadState("networkidle");

		// USAGE 行出现且成本列为本笔成本（非「—」）
		const usageRow = page.getByRole("row").filter({
			has: page.getByText("使用", { exact: true }),
		});
		await expect(usageRow).toBeVisible();
		await expect(usageRow).toContainText("4000.0000");
		await saveScreenshot(page, "11-plan-usage", "T-USAGE-004-01-ledger-cost");

		await logger.saveToFile();
	});
});
