import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import { buildApiUrl, localFetch, resolveApiBase } from "../helpers/api-url";
import {
	injectLoginCookie,
	seedOnboarding,
	seedPlanWithAllocation,
	seedRegisterAndLogin,
	seedTransaction,
	seedUsage,
} from "../helpers/api-seeder";

/**
 * 更正与日志 E2E（changes/corrections/技术方案.md §8.4，按用户操作路径编号）
 *
 * 覆盖场景：
 * - T-CORR-001: 交易详情「更正」→ 补录手续费 20 → 查看影响（未知 → 20.0000）→ 确认 →
 *   详情显示总成本 7,820、版本 v2、修改记录含原因（需求验收场景 1）
 * - T-CORR-002: 改币种被拦截（CAD 余额 0 < 计划剩余分配 1,000）→
 *   显示不能提交原因 + 确认禁用 + 原记录不变（需求验收场景 2 同型）
 * - T-CORR-003: 初始持仓金额更正（流水 INITIAL 行更正入口；依赖外部汇率源造数，不可用则 skip）
 * - T-CORR-004: 使用记录更正改小（依赖 M7「记录使用」，本期 skip 标记）
 *
 * 造数：T-CORR-001/002 纯 API 造数（买入 fee 未知 / 计划分配），不依赖外部汇率源。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";
// 造数直连后端（对齐 api-seeder：前端无 /api 代理，经前端地址会 404）
const API_URL = resolveApiBase(process.env.API_URL, "http://localhost:6001");

/** 录入一笔费用未知的买入（feeAmount 缺省 = 未知，doc 05），返回交易 id */
async function seedUnknownFeePurchase(
	token: string,
	currencyCode: string,
): Promise<string> {
	const res = await localFetch(buildApiUrl(API_URL, "/api/transactions"), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			currencyCode,
			principalAmount: "7800.00",
			exchangeRate: "7.80000000",
			quantity: "1000.0000",
			transactedAt: new Date().toISOString(),
		}),
	});
	if (!res.ok) {
		throw new Error(
			`seedUnknownFeePurchase 失败：${res.status} ${await res.text()}`,
		);
	}
	const json = (await res.json()) as { data: { id: string } };
	return json.data.id;
}

test.describe("【更正与日志】交易/初始持仓更正", () => {
	const logger = new TestLogger("correction-module");

	test("T-CORR-001: 手续费补录 → 影响预览 → 确认 → 成本 7,820 / v2 / 留痕", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：手续费补录全流程");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin(`corr-fee-${Date.now()}`);
		await seedOnboarding(user.accessToken, "CNY");
		const transactionId = await seedUnknownFeePurchase(user.accessToken, "HKD");
		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);

		// 交易详情 → 更正入口
		await page.goto(`${BASE_URL}/transactions/${transactionId}`);
		await page.waitForLoadState("networkidle");
		await expect(page.locator('[data-testid="correction-entry"]')).toBeVisible({
			timeout: 15000,
		});
		await saveScreenshot(page, "11-correction", "T-CORR-001-01-detail");
		await page.click('[data-testid="correction-entry"]');
		await page.waitForURL(/\/corrections\/new\?targetType=TRANSACTION/, {
			timeout: 30000,
		});
		await page.waitForLoadState("networkidle");
		logger.log("action", "info", "✓ 进入更正页");

		// 填写：手续费 → 明确金额 20；原因必填
		await page.selectOption("#correction-fee-mode", "value");
		await page.fill("#correction-fee-amount", "20");
		await page.fill("#correction-reason", "手续费实际为 20 港元，当时漏填");
		await saveScreenshot(page, "11-correction", "T-CORR-001-02-form");

		// 查看影响：成本对比「未知 → 20.0000」且无拦截
		await page.click('[data-testid="correction-preview-button"]');
		await expect(page.getByText("未知 → 20.0000")).toBeVisible({
			timeout: 15000,
		});
		// 总成本派生对比：费用未知的原成本「不完整」（≠ 0）→ 7,820
		await expect(page.getByText("不完整 → 7820.0000")).toBeVisible();
		await saveScreenshot(page, "11-correction", "T-CORR-001-03-preview");
		logger.log("action", "info", "✓ 影响预览展示「未知 → 20.0000」");

		// 确认更正 → 跳回交易详情（URL 谓词避免动态 RegExp 构造）
		await page.click('[data-testid="correction-confirm-button"]');
		await page.waitForURL(
			(url) => url.pathname === `/transactions/${transactionId}`,
			{
				timeout: 15000,
			},
		);
		await page.waitForLoadState("networkidle");

		// 详情：总成本 7,820.0000、版本 v2（dd 精确匹配，避免 cuid 子串误命中）
		await expect(page.getByText("7820.0000").first()).toBeVisible();
		await expect(page.locator('dd:text-is("v2")')).toBeVisible();
		// 版本历史：更正已生效 + 原因留痕
		await expect(
			page.locator('[data-testid="correction-history-list"]'),
		).toBeVisible();
		await expect(page.getByText("更正已生效")).toBeVisible();
		await expect(
			page.getByText("手续费实际为 20 港元，当时漏填"),
		).toBeVisible();
		await saveScreenshot(page, "11-correction", "T-CORR-001-04-applied");
		logger.log("action", "info", "✓ 成本 7,820 / v2 / 修改记录已留痕");

		await logger.saveToFile();
	});

	test("T-CORR-002: 改币种被拦截 → 显示缺口原因、确认禁用、原记录不变", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：改币种拦截（计划分配无法覆盖）");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin(`corr-swap-${Date.now()}`);
		await seedOnboarding(user.accessToken, "CNY");
		const transactionId = await seedUnknownFeePurchase(user.accessToken, "CAD");
		await seedPlanWithAllocation(user.accessToken, "CAD", "1000");
		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);

		await page.goto(`${BASE_URL}/transactions/${transactionId}`);
		await page.waitForLoadState("networkidle");
		await page.click('[data-testid="correction-entry"]');
		await page.waitForURL(/\/corrections\/new\?targetType=TRANSACTION/, {
			timeout: 30000,
		});
		await page.waitForLoadState("networkidle");

		// 改币种 CAD → USD + 原因 → 查看影响
		await page.selectOption("#correction-买入币种", "USD");
		await page.fill("#correction-reason", "这笔实际是美元买入");
		await page.click('[data-testid="correction-preview-button"]');
		await expect(page.getByText(/不能提交/).first()).toBeVisible({
			timeout: 15000,
		});
		await expect(page.getByText(/未分配余额将变为/).first()).toBeVisible();
		await saveScreenshot(page, "11-correction", "T-CORR-002-01-blocked");

		// 确认按钮禁用（blockers 非空），原记录不落任何变更
		await expect(
			page.locator('[data-testid="correction-confirm-button"]'),
		).toBeDisabled();

		// 原记录数值不变：返回详情本金仍为 7800、版本仍 v1
		await page.goto(`${BASE_URL}/transactions/${transactionId}`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByText("7800.0000").first()).toBeVisible();
		await expect(page.locator('dd:text-is("v1")')).toBeVisible();
		await saveScreenshot(page, "11-correction", "T-CORR-002-02-unchanged");
		logger.log("action", "info", "✓ 拦截原因展示、确认禁用、原记录 v1 不变");

		await logger.saveToFile();
	});

	test("T-CORR-003: 初始持仓金额更正 → 原汇率重算 → 流水与版本历史可查", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：初始持仓金额更正");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin(`corr-holding-${Date.now()}`);
		// complete 带初始持仓（依赖真实外部汇率源；不可用环境 skip）
		await localFetch(buildApiUrl(API_URL, "/api/onboarding/consents"), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${user.accessToken}`,
			},
			body: JSON.stringify({ age18Confirmed: true, termsConfirmed: true }),
		}).then((res) => res.json());
		const completeRes = await localFetch(
			buildApiUrl(API_URL, "/api/onboarding/complete"),
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${user.accessToken}`,
				},
				body: JSON.stringify({
					baseCurrency: "CNY",
					locale: "zh-CN",
					region: "CN",
					prepPreference: "balanced",
					reminderEnabled: true,
					initialHoldings: [{ currencyCode: "USD", amount: "1000" }],
				}),
			},
		);
		if (!completeRes.ok) {
			test.skip(true, "外部汇率数据源不可用，初始持仓造数失败");
			return;
		}
		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);

		// 账户页 INITIAL 行 → 更正入口
		await page.goto(`${BASE_URL}/accounts/USD`);
		await page.waitForLoadState("networkidle");
		const entry = page
			.locator('[data-testid="initial-correction-entry"]')
			.first();
		await expect(entry).toBeVisible({ timeout: 15000 });
		await saveScreenshot(page, "11-correction", "T-CORR-003-01-ledger");
		await entry.click();
		await page.waitForURL(/\/corrections\/new\?targetType=INITIAL_HOLDING/, {
			timeout: 30000,
		});
		await page.waitForLoadState("networkidle");

		// 金额改 800 + 原因 → 影响预览（金额 1000 → 800）→ 确认
		await page.fill("#correction-初始金额", "800");
		await page.fill("#correction-reason", "初始金额多填了 200");
		await page.click('[data-testid="correction-preview-button"]');
		await expect(page.getByText("1000.0000 → 800.0000").first()).toBeVisible({
			timeout: 15000,
		});
		await page.click('[data-testid="correction-confirm-button"]');
		await page.waitForURL(/\/accounts\/USD/, { timeout: 15000 });
		await page.waitForLoadState("networkidle");

		// 流水出现更正后数值 800.0000（成本按原确认时点汇率重算，非今日行情）
		await expect(page.getByText("800.0000").first()).toBeVisible();
		await saveScreenshot(page, "11-correction", "T-CORR-003-02-updated");
		logger.log("action", "info", "✓ 初始持仓金额已更正、流水更新");

		await logger.saveToFile();
	});

	// MVP-F0-3 接线后启用：使用记录更正改小（需求验收场景 6；API 造数 +
	// 计划详情使用列表更正入口 → 更正页预览 → 确认 → v2 / 分配联动 / 留痕）
	test("T-CORR-004: 使用更正改小 → 入口 → 预览 → 确认 → v2 / 分配联动 / 留痕", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：使用更正改小全流程");
		logger.setupPageListeners(page);

		const user = await seedRegisterAndLogin(`corr-usage-${Date.now()}`);
		await seedOnboarding(user.accessToken, "CNY");
		// 造数：CAD 计划（分配 3,000）→ 买入 7,800（汇率 1，lot 7,800@1）→ 使用 800（耗 800@1）
		const planId = await seedPlanWithAllocation(user.accessToken, "CAD", "3000");
		await seedTransaction(user.accessToken, "CAD", "7800");
		const usage = await seedUsage(user.accessToken, planId, "800");
		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);

		// 计划详情 → 使用列表 → 更正入口（MVP-F0-3 新增 usage-correction-entry）
		await page.goto(`${BASE_URL}/plans/${planId}`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByTestId("usage-correction-entry").first()).toBeVisible({
			timeout: 15000,
		});
		await saveScreenshot(page, "11-correction", "T-CORR-004-01-usage-list");
		await page.getByTestId("usage-correction-entry").first().click();
		await page.waitForURL(/\/corrections\/new\?targetType=USAGE/, {
			timeout: 30000,
		});
		await page.waitForLoadState("networkidle");

		// 填写：金额改小 800 → 500；原因必填
		await page.fill("#correction-使用金额", "500");
		await page.fill("#correction-reason", "使用金额多记了 300");
		await saveScreenshot(page, "11-correction", "T-CORR-004-02-form");

		// 查看影响 → 确认
		await page.click('[data-testid="correction-preview-button"]');
		await page.waitForLoadState("networkidle");
		await saveScreenshot(page, "11-correction", "T-CORR-004-03-preview");
		await page.click('[data-testid="correction-confirm-button"]');

		// API 侧断言：记录 v2 / 金额 500 / 成本重算 / 留痕 APPLIED
		const usageRes = await localFetch(
			buildApiUrl(API_URL, `/api/plans/${planId}/usages`),
			{ headers: { Authorization: `Bearer ${user.accessToken}` } },
		);
		const usageJson = (await usageRes.json()) as {
			data: {
				items: Array<{ id: string; amount: string; cost: string }>;
			};
		};
		const updated = usageJson.data.items.find((item) => item.id === usage.id);
		expect(updated?.amount).toBe("500.0000");
		// 成本 = 500 × 1 = 500（改小后按批次重算；造数汇率为 1）
		expect(updated?.cost).toBe("500.0000");
		const correctionRes = await localFetch(
			buildApiUrl(
				API_URL,
				`/api/corrections?targetType=USAGE&targetId=${usage.id}`,
			),
			{ headers: { Authorization: `Bearer ${user.accessToken}` } },
		);
		const correctionJson = (await correctionRes.json()) as {
			data: {
				items: Array<{ status: string; targetType: string; reason: string }>;
			};
		};
		expect(correctionJson.data.items[0]?.status).toBe("APPLIED");
		expect(correctionJson.data.items[0]?.targetType).toBe("USAGE");
		expect(correctionJson.data.items[0]?.reason).toContain("使用金额多记了 300");
		// 版本断言：target 接口返回当前内容含 version = 2（乐观基准）
		const targetRes = await localFetch(
			buildApiUrl(
				API_URL,
				`/api/corrections/target?targetType=USAGE&targetId=${usage.id}`,
			),
			{ headers: { Authorization: `Bearer ${user.accessToken}` } },
		);
		const targetJson = (await targetRes.json()) as {
			data: { target: { version: number; amount: string } };
		};
		expect(targetJson.data.target.version).toBe(2);
		expect(targetJson.data.target.amount).toBe("500.0000");
		await saveScreenshot(page, "11-correction", "T-CORR-004-04-applied");
		logger.log("action", "info", "✓ 使用金额 500 / v2 / APPLIED 留痕");

		await logger.saveToFile();
	});
});
