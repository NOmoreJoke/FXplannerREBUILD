import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import { buildApiUrl, localFetch, resolveApiBase } from "../helpers/api-url";
import type { components } from "../../clients/chat-web/lib/api/schema.gen";
import {
	api,
	injectLoginCookie,
	seedOnboarding,
	seedPlanWithAllocation,
	seedRegisterAndLogin,
	seedTransaction,
	seedUsage,
} from "../helpers/api-seeder";
import { setTestLedgerStart } from "../helpers/correction-db";

/**
 * 更正与日志 E2E（changes/corrections/技术方案.md §8.4，按用户操作路径编号）
 *
 * 覆盖场景：
 * - T-CORR-001: 交易详情「更正」→ 补录手续费 20 → 查看影响（未知 → 20.0000）→ 确认 →
 *   详情显示总成本 7,820、版本 v2、修改记录含原因（需求验收场景 1）
 * - T-CORR-002: 改币种被拦截（CAD 余额 0 < 计划剩余分配 1,000）→
 *   显示不能提交原因 + 确认禁用 + 原记录不变（需求验收场景 2 同型）
 * - T-CORR-003: 初始持仓金额更正（流水 INITIAL 行更正入口；依赖外部汇率源造数，不可用则 skip）
 * - T-CORR-004: 使用更正预览资金来源与返还 → 确认改小 → 分配联动 / v2 / 留痕
 * - W6-09: 日期更正区分同日可用买入与前一日历史资金缺口
 *
 * 造数：T-CORR-001/002/004 纯 API 造数，不依赖外部汇率源。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";
// 造数直连后端（对齐 api-seeder：前端无 /api 代理，经前端地址会 404）
const API_URL = resolveApiBase(process.env.API_URL, "http://localhost:4001");

type Schemas = components["schemas"];

/**
 * 录入一笔费用未知的买入（feeAmount 缺省 = 未知，doc 05），返回交易 id
 *
 * W30（MIG-D）：/transactions 是组织域端点——缺 X-Organization-Id 一律 400
 * ORGANIZATION_REQUIRED（不再回落唯一默认组织），故显式带上造数用户的组织。
 */
async function seedUnknownFeePurchase(
	token: string,
	organizationId: string,
	currencyCode: string,
): Promise<string> {
	const res = await localFetch(buildApiUrl(API_URL, "/api/transactions"), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			"X-Organization-Id": organizationId,
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
		const transactionId = await seedUnknownFeePurchase(
			user.accessToken,
			user.organizationId,
			"HKD",
		);
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
		const transactionId = await seedUnknownFeePurchase(
			user.accessToken,
			user.organizationId,
			"CAD",
		);
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
					// W30（MIG-D）：建账是组织域端点——缺组织头一律 400 ORGANIZATION_REQUIRED
					"X-Organization-Id": user.organizationId,
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

	test("T-CORR-004: 使用更正预览资金来源与返还 → 确认改小 → v2 / 留痕", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：使用更正改小全流程");
		logger.setupPageListeners(page);

		const { accessToken: token } = await seedRegisterAndLogin(
			`corr-usage-${Date.now()}`,
		);
		await seedOnboarding(token, "CNY");
		// 先买入 7,800 CAD（汇率 1），再分配 3,000，使用 800 后余额 7,000。
		await seedTransaction(token, "CAD", "7800");
		const planId = await seedPlanWithAllocation(token, "CAD", "3000");
		const usage = await seedUsage(token, planId, "800");
		await injectLoginCookie(page.context(), token, BASE_URL);

		const planPath = `/plans/${planId}`;
		const query = new URLSearchParams({
			targetType: "USAGE",
			targetId: usage.id,
		});
		const reason = "使用金额多记了 300";

		// 计划详情 → 使用列表 → 更正入口（MVP-F0-3 新增 usage-correction-entry）
		await page.goto(`${BASE_URL}${planPath}`);
		const entry = page.getByTestId("usage-correction-entry");
		const usageRow = page.getByRole("listitem").filter({ has: entry });
		await expect(usageRow.getByText("800 CAD", { exact: true })).toBeVisible();
		await saveScreenshot(page, "11-correction", "T-CORR-004-01-usage-list");
		await entry.click();
		await expect(page).toHaveURL(
			(url) =>
				url.pathname === "/corrections/new" &&
				url.searchParams.get("targetType") === "USAGE" &&
				url.searchParams.get("targetId") === usage.id,
		);
		await expect(page.getByRole("heading", { name: "更正使用记录" })).toBeVisible();

		const previewButton = page.getByTestId("correction-preview-button");

		// 800 → 1,800：增量 1,000 全取自计划，未分配余额不动。
		await page.fill("#correction-使用金额", "1800");
		await page.fill("#correction-reason", "核对更正的资金来源");
		await previewButton.click();
		await expect(
			page.getByText("从本计划剩余分配使用 1000.0000 CAD", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("未分配余额 0.0000 CAD", { exact: true }),
		).toBeVisible();

		// 800 → 3,800：计划出 2,200，未分配补 800，累计使用 3,800。
		await page.fill("#correction-使用金额", "3800");
		await previewButton.click();
		await expect(
			page.getByText("从本计划剩余分配使用 2200.0000 CAD", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("未分配余额 -800.0000 CAD（补入本计划并使用）", {
				exact: true,
			}),
		).toBeVisible();
		await expect(
			page.getByText("本计划累计已使用 800.0000 → 3800.0000 CAD", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("本计划分配总额 3000.0000 → 3800.0000 CAD", { exact: true }),
		).toBeVisible();

		// 800 → 500：确认前核对返还 300，剩余分配仍为 2,200。
		await page.fill("#correction-使用金额", "500");
		await page.fill("#correction-reason", reason);
		await saveScreenshot(page, "11-correction", "T-CORR-004-02-form");

		// 查看影响 → 确认
		await previewButton.click();
		for (const detail of [
			"本计划剩余分配 2200.0000 → 2200.0000 CAD",
			"本计划累计已使用 800.0000 → 500.0000 CAD",
			"未分配余额 +300.0000 CAD（收到返还）",
		]) {
			await expect(page.getByText(detail, { exact: true })).toBeVisible();
		}
		await expect(
			page.getByText("800.0000 → 500.0000", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("CAD：7000.0000 → 7300.0000", { exact: true }),
		).toBeVisible();
		const confirm = page.getByTestId("correction-confirm-button");
		await expect(confirm).toBeEnabled();
		await saveScreenshot(page, "11-correction", "T-CORR-004-03-preview");
		const [applyResponse] = await Promise.all([
			page.waitForResponse(
				(response) =>
					response.url() === buildApiUrl(API_URL, "/api/corrections") &&
					response.request().method() === "POST",
			),
			confirm.click(),
		]);
		expect(applyResponse.status()).toBe(201);

		// 提交成功后独立读取账本、计划分配和版本历史。
		const read = { method: "GET", token };
		const [ledger, target, history, account, allocations] = await Promise.all([
			api<Schemas["UsageListRespDto"]>(`/api/plans/${planId}/usages`, read),
			api<Schemas["CorrectionTargetDto"]>(
				`/api/corrections/target?${query}`,
				read,
			),
			api<Schemas["CorrectionListDto"]>(`/api/corrections?${query}`, read),
			api<Schemas["AccountDetailDto"]>("/api/accounts/CAD", read),
			api<Schemas["AccountPlanAllocationListDto"]>(
				"/api/accounts/CAD/allocations",
				read,
			),
		]);
		expect(ledger.items.find((item) => item.id === usage.id)).toMatchObject({
			amount: "500.0000",
			cost: "500.0000", // 500 × 1，按买入批次重算
		});
		expect(target.target).toMatchObject({ version: 2, amount: "500.0000" });
		expect(history.items).toHaveLength(1);
		expect(history.items[0]).toMatchObject({
			status: "APPLIED",
			targetType: "USAGE",
			targetId: usage.id,
			reason,
			beforeSnapshot: { target: { amount: "800.0000", version: 1 } },
			afterSnapshot: { target: { amount: "500.0000", version: 2 } },
		});
		expect(account).toMatchObject({
			balance: "7300.0000",
			allocatedAmount: "2200.0000",
			unallocatedAmount: "5100.0000",
		});
		expect(
			allocations.items.find((item) => item.planId === planId),
		).toMatchObject({
			amount: "2700.0000",
			usedAmount: "500.0000",
			remainingAllocation: "2200.0000",
		});

		await expect(page).toHaveURL(`${BASE_URL}${planPath}`);
		await expect(usageRow.getByText("500 CAD", { exact: true })).toBeVisible();
		await saveScreenshot(page, "11-correction", "T-CORR-004-04-applied");
		logger.log(
			"action",
			"info",
			"✓ 使用金额 500 / 余额与分配更新 / v2 / APPLIED 留痕",
		);

		await logger.saveToFile();
	});

	test("W6-03: 使用更正资金来源变化须重新预览并确认", async ({ page }) => {
		const user = await seedRegisterAndLogin(`corr-usage-impact-${Date.now()}`);
		await seedOnboarding(user.accessToken, "CNY");
		await seedTransaction(user.accessToken, "CAD", "7800");
		const planId = await seedPlanWithAllocation(user.accessToken, "CAD", "3000");
		const { id: usageId } = await seedUsage(user.accessToken, planId, "800");
		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);
		await page.goto(`${BASE_URL}/corrections/new?targetType=USAGE&targetId=${usageId}`);

		await page.locator("#correction-使用金额").fill("2600");
		await page.locator("#correction-reason").fill("使用金额少记了 1800");
		const preview = page.getByTestId("correction-preview-button");
		const confirm = page.getByTestId("correction-confirm-button");
		await preview.click();
		await expect(page.getByText("从本计划剩余分配使用 1800.0000 CAD", { exact: true })).toBeVisible();
		await expect(page.getByText("未分配余额 0.0000 CAD", { exact: true })).toBeVisible();

		await seedUsage(user.accessToken, planId, "800");
		const staleResponse = page.waitForResponse(
			(response) => response.url().endsWith("/api/corrections") && response.request().method() === "POST",
		);
		await confirm.click();
		expect((await staleResponse).status()).toBe(409);
		await expect(page.getByText("请重新查看影响，确认最新预览后再提交。")).toBeVisible();
		await expect(page.getByRole("heading", { name: "影响预览" })).toHaveCount(0);
		await expect(confirm).toBeDisabled();

		await preview.click();
		await expect(page.getByText("从本计划剩余分配使用 1400.0000 CAD", { exact: true })).toBeVisible();
		await expect(page.getByText("未分配余额 -400.0000 CAD（补入本计划并使用）", { exact: true })).toBeVisible();
		const appliedResponse = page.waitForResponse(
			(response) => response.url().endsWith("/api/corrections") && response.request().method() === "POST",
		);
		await confirm.click();
		const applied = await appliedResponse;
		expect(applied.status()).toBe(201);
		await expect(page).toHaveURL(`${BASE_URL}/plans/${planId}`);
		const query = new URLSearchParams({ targetType: "USAGE", targetId: usageId });
		const auth = { method: "GET", token: user.accessToken };
		const { target } = await api<{ target: { version: number; amount: string } }>(
			`/api/corrections/target?${query}`, auth,
		);
		expect(target).toMatchObject({ version: 2, amount: "2600.0000" });
		const { items } = await api<{ items: Array<{ status: string; reason: string }> }>(
			`/api/corrections?${query}`, auth,
		);
		expect(items).toEqual([
			expect.objectContaining({ status: "APPLIED", reason: "使用金额少记了 1800" }),
		]);
	});

	test("W6-09: 同日买入可用于日期更正，前一日显示历史缺口", async ({
		page,
	}) => {
		const user = await seedRegisterAndLogin("corr-usage-date");
		const token = user.accessToken;
		const now = Date.now();
		const day = (daysAgo: number) =>
			new Date(now - daysAgo * 86_400_000).toISOString().slice(0, 10);
		const previousDay = day(3);
		const purchaseDay = day(2);
		const originalDay = day(1);
		const originalUsedAt = `${originalDay}T10:00:00.000Z`;
		const correctedUsedAt = `${purchaseDay}T00:00:00.000Z`;
		const reason = "实际使用日期是买入当天";

		await seedOnboarding(token);
		// 让前一日通过起点校验，确保验证的是 FIFO 缺口。
		await setTestLedgerStart(user, new Date(`${previousDay}T00:00:00+08:00`));
		await api("/api/transactions", {
			method: "POST",
			token,
			body: {
				currencyCode: "CAD",
				principalAmount: "2000",
				exchangeRate: "2",
				quantity: "1000",
				feeAmount: "0",
				transactedAt: `${purchaseDay}T11:00:00.000Z`,
			},
		});
		const planId = await seedPlanWithAllocation(token, "CAD", "800");
		const { usage } = await api<{ usage: { id: string } }>(
			`/api/plans/${planId}/usages`,
			{
				method: "POST",
				token,
				body: { amount: "500", usedAt: originalUsedAt },
			},
		);
		const targetQuery = new URLSearchParams({
			targetType: "USAGE",
			targetId: usage.id,
		});
		const getTarget = async () =>
			(await api<{ target: { version: number; usedAt: string } }>(
				`/api/corrections/target?${targetQuery}`,
				{ method: "GET", token },
			)).target;

		await injectLoginCookie(page.context(), token, BASE_URL);
		await page.goto(`${BASE_URL}/plans/${planId}`);
		await page.getByTestId("usage-correction-entry").click();
		await expect(page.getByRole("heading", { name: "更正使用记录" })).toBeVisible();

		const dateInput = page.getByLabel("使用日期", { exact: true });
		const preview = page.getByRole("button", { name: "查看影响" });
		const confirm = page.getByRole("button", { name: "确认更正" });
		await page.getByLabel("修改原因").fill(reason);
		await dateInput.fill(previousDay);
		await preview.click();
		await expect(page.getByText(/历史使用发生时 CAD 资金不足/)).toBeVisible();
		await expect(
			page.getByText(`CAD · ${previousDay} 缺口 500.0000`, { exact: true }),
		).toBeVisible();
		await expect(confirm).toBeDisabled();
		expect(await getTarget()).toMatchObject({ version: 1, usedAt: originalUsedAt });

		await dateInput.fill(purchaseDay);
		await preview.click();
		await expect(
			page.getByText(`${originalUsedAt} → ${correctedUsedAt}`, { exact: true }),
		).toBeVisible();
		await expect(confirm).toBeEnabled();
		const [applied] = await Promise.all([
			page.waitForResponse(
				(response) => response.url().endsWith("/api/corrections") && response.request().method() === "POST",
			),
			confirm.click(),
		]);
		expect(applied.status()).toBe(201);
		await expect(page).toHaveURL(`${BASE_URL}/plans/${planId}`);

		expect(await getTarget()).toMatchObject({ version: 2, usedAt: correctedUsedAt });
		const { items } = await api<{ items: unknown[] }>(`/api/plans/${planId}/usages`, {
			method: "GET",
			token,
		});
		expect(items).toEqual([
			expect.objectContaining({
				id: usage.id,
				usedAt: correctedUsedAt,
				amount: "500.0000",
				cost: "1000.0000",
			}),
		]);
		const history = await api<{ items: unknown[] }>(`/api/corrections?${targetQuery}`, {
			method: "GET",
			token,
		});
		expect(history.items).toEqual([
			expect.objectContaining({ status: "APPLIED", reason }),
		]);
	});
});
