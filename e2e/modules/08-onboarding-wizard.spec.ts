import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import { selectRadixOption } from "../helpers/test-utils";
import {
	injectLoginCookie,
	seedOnboarding,
	seedRegisterAndLogin,
	seedTransaction,
} from "../helpers/api-seeder";
import { TEST_PASSWORD } from "../helpers/test-credentials";

/**
 * 最小建账向导 E2E（changes/onboarding-rework/技术方案.md §8.3 场景 1/2/3）
 *
 * 覆盖需求文档场景：
 * - 场景 1/2（登录门槛）：不勾选 → 发送验证码按钮不可用并提示；勾选两项 → OTP 登录 → 未建账进向导
 * - 场景 5：向导第二步「没有，直接开始」→ 空首页展示补录引导和免责声明；设置页本位币只读
 * - 场景 3/4：建账时填写初始持仓 → 核对页展示汇率/来源/时间/成本 → 返回改本位币再改回
 *   （汇率与成本重新展示、金额保留）→ 确认入账 → 首页 USD 账户卡、无引导卡
 * - 场景 6：向导第二步中途退出 → 重新登录从第一步开始，无残留
 *
 * 前置约定：核对页汇率依赖真实外部数据源（GET /rates/latest refresh=true 强制回源）；
 * 数据源不可用环境（离线 CI）下涉及核对区的用例按注释条件跳过，不误报。
 * 登录页勾选与按钮 testid 契约见 login-form.tsx / onboarding 向导页实现。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";
// 采用已定稿 A 版作为验收文案，独立于前端渲染组件。
const APPROVED_DISCLAIMER =
	"本工具由非持牌主体提供，非投资顾问服务；汇率与计划均为工具测算，不构成投资建议、不预测涨跌、不经手资金；据此操作的风险与损失由用户自行承担。";

test.describe("【建账向导】登录即用 + 最小建账", () => {
	const logger = new TestLogger("onboarding-wizard");

	test("T-OBW-001: 登录门槛——不勾选拦截发送，勾选两项 OTP 登录进向导（场景 1/2/5 前半）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：登录门槛与 OTP 登录进向导");
		logger.setupPageListeners(page);

		await page.goto(`${BASE_URL}/login`);
		await page.waitForLoadState("networkidle");
		await page.click('[role="tab"]:has-text("验证码登录")');

		// 两项勾选默认不勾
		await expect(
			page.locator('[data-testid="consent-age18"]'),
		).not.toBeChecked();
		await expect(
			page.locator('[data-testid="consent-terms"]'),
		).not.toBeChecked();
		await saveScreenshot(page, "08-onboarding", "T-OBW-001-01-login-page");

		// 填邮箱后不勾选：发送按钮不可用 + 提示文案（需求场景 1）
		await page.fill("#otpTarget", `e2e-obw-${Date.now()}@example.com`);
		await expect(page.locator('[data-testid="send-otp"]')).toBeDisabled();
		await expect(page.locator('[data-testid="consent-hint"]')).toContainText(
			"请先勾选确认年龄与条款",
		);
		logger.log("action", "info", "✓ 未勾选：发送验证码按钮不可用且有提示");
		await saveScreenshot(page, "08-onboarding", "T-OBW-001-02-blocked");

		// 勾选两项 → 按钮启用 → 发码（mock devCode 自动填充）→ 登录
		await page.check('[data-testid="consent-age18"]');
		await page.check('[data-testid="consent-terms"]');
		await expect(page.locator('[data-testid="send-otp"]')).toBeEnabled();
		await page.click('[data-testid="send-otp"]');
		await expect(page.locator("#otpCode")).toHaveValue(/^\d{6}$/, {
			timeout: 15000,
		});
		logger.log("action", "info", "✓ 已勾选并发码，devCode 自动填充");

		await page.click('[data-testid="otp-login-submit"]');
		// 未建账用户 → 建账向导第一步（需求场景 2）
		await page.waitForURL(`${BASE_URL}/onboarding`, { timeout: 15000 });
		await expect(page.locator('[data-testid="wizard-step-1"]')).toBeVisible();
		logger.log("action", "info", "✓ 未建账用户已进入向导第一步");
		await saveScreenshot(page, "08-onboarding", "T-OBW-001-03-wizard-step1");

		// 第一步：地区/本位币预填（CN → CNY，radix Select 显示 label 文本）+ 不可更换提示
		await expect(page.locator('[data-testid="region-select"]')).toContainText(
			"中国大陆",
		);
		await expect(
			page.locator('[data-testid="base-currency-select"]'),
		).toContainText("人民币");
		await expect(
			page.locator('[data-testid="base-currency-lock-hint"]'),
		).toContainText("不可更换");
		// 向导不出现偏好/提醒步骤（规格模块 2 验收路径）
		await expect(page.getByText("准备偏好", { exact: false })).toHaveCount(0);

		await logger.saveToFile();
	});

	test("T-OBW-002: 跳过持仓建账——「没有，直接开始」→ 首页引导卡 + 设置页本位币只读（场景 5）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：跳过持仓建账全流程");
		logger.setupPageListeners(page);

		// OTP 登录新用户（勾选两项）
		await page.goto(`${BASE_URL}/login`);
		await page.waitForLoadState("networkidle");
		await page.click('[role="tab"]:has-text("验证码登录")');
		await page.fill("#otpTarget", `e2e-obw-skip-${Date.now()}@example.com`);
		await page.check('[data-testid="consent-age18"]');
		await page.check('[data-testid="consent-terms"]');
		await page.click('[data-testid="send-otp"]');
		await expect(page.locator("#otpCode")).toHaveValue(/^\d{6}$/, {
			timeout: 15000,
		});
		await page.click('[data-testid="otp-login-submit"]');
		await page.waitForURL(`${BASE_URL}/onboarding`, { timeout: 15000 });

		// 第一步确认本位币（默认 CNY）→ 下一步
		await page.click('[data-testid="wizard-next"]');
		await expect(page.locator('[data-testid="wizard-step-2"]')).toBeVisible();
		await saveScreenshot(page, "08-onboarding", "T-OBW-002-01-step2");

		// 「没有，直接开始」（点击即提交建账并跳转首页）
		await page.click('[data-testid="holdings-skip"]');
		await page.waitForURL(`${BASE_URL}/home`, { timeout: 15000 });
		logger.log("action", "info", "✓ 建账完成进入首页");

		// 首页出现补录引导卡（空账本状态）
		await expect(
			page.locator('[data-testid="initial-backfill-card"]'),
		).toBeVisible({ timeout: 15000 });
		await expect(
			page.getByRole("heading", { name: "先建立第一笔跨币种资金准备" }),
		).toBeVisible();
		await expect(
			page.getByText(APPROVED_DISCLAIMER, { exact: true }),
		).toBeVisible();
		await saveScreenshot(
			page,
			"08-onboarding",
			"T-OBW-002-02-home-backfill-card",
		);
		logger.log("action", "info", "✓ 补录引导卡已出现");

		// 设置页本位币只读（需求场景 7；readonly input，value 含币种名）
		await page.goto(`${BASE_URL}/settings`);
		await page.waitForLoadState("networkidle");
		await expect(
			page.locator('[data-testid="settings-base-currency"]'),
		).toHaveValue(/CNY/);
		await expect(
			page.locator('[data-testid="base-currency-readonly-note"]'),
		).toContainText("不可更换");
		// 无任何本位币编辑控件
		await expect(
			page.locator(
				'[data-testid="settings-page"] [data-testid="base-currency-select"]',
			),
		).toHaveCount(0);
		await saveScreenshot(
			page,
			"08-onboarding",
			"T-OBW-002-03-settings-readonly",
		);
		logger.log("action", "info", "✓ 设置页本位币只读展示");

		await logger.saveToFile();
	});

	test("T-OBW-003: 建账时填写初始持仓——改币重核金额保留 + 确认入账（场景 3/4）", async ({
		page,
	}) => {
		test.info().annotations.push({
			type: "note",
			description:
				"核对区依赖真实外部汇率数据源；数据源不可用时跳过（接口/集成测试已覆盖成本口径）",
		});
		logger.log("action", "info", "开始：带初始持仓建账全流程");
		logger.setupPageListeners(page);

		const seed = await seedRegisterAndLogin("obw-holdings");
		logger.log("action", "info", `✓ 造数完成 ${seed.email}`);

		// 密码模式登录：先断言未勾选时登录按钮被拦截（双模式均拦截）
		await page.goto(`${BASE_URL}/login`);
		await page.waitForLoadState("networkidle");
		await page.fill('input[name="email"]', seed.email);
		await page.fill('input[name="password"]', TEST_PASSWORD);
		await expect(
			page.locator('[data-testid="password-login-submit"]'),
		).toBeDisabled();
		await expect(page.locator('[data-testid="consent-hint"]')).toBeVisible();
		await page.check('[data-testid="consent-age18"]');
		await page.check('[data-testid="consent-terms"]');
		await page.click('[data-testid="password-login-submit"]');

		await page.waitForURL(`${BASE_URL}/onboarding`, { timeout: 15000 });
		await page.click('[data-testid="wizard-next"]');
		await expect(page.locator('[data-testid="wizard-step-2"]')).toBeVisible();

		// 「有，填写」→ USD 1,000（radix Select：点开 trigger 选 option）
		await page.click('[data-testid="holdings-fill"]');
		await selectRadixOption(
			page,
			page.locator('[data-testid="holding-currency-0"]'),
			"USD · 美元",
		);
		await page.fill('[data-testid="holding-amount-0"]', "1000");
		logger.log("action", "info", "✓ 已填写 USD 1000，等待核对区取价");

		// 核对区：汇率成功加载，或数据源不可用提示（二选一先到者）
		const reviewRow = page.locator('[data-testid="review-row-USD"]');
		const rateFailed = page
			.locator('[data-testid="holding-review"] [role="alert"]')
			.or(page.getByText("汇率获取失败"));
		await expect(reviewRow.or(rateFailed).first()).toBeVisible({
			timeout: 30000,
		});
		if (await rateFailed.isVisible().catch(() => false)) {
			await saveScreenshot(page, "08-onboarding", "T-OBW-003-skip-rate-source");
			test.skip(true, "外部汇率数据源不可用，核对区无法加载");
		}
		await expect(reviewRow).toContainText("USD");
		await expect(reviewRow).toContainText("CNY");
		await saveScreenshot(page, "08-onboarding", "T-OBW-003-01-review");
		logger.log("action", "info", "✓ 核对区已展示汇率/来源/时间/成本");

		// 返回第一步改本位币（CNY→HKD）再进第二步：金额保留、汇率成本作废重核（需求场景 3）
		await page.click('[data-testid="wizard-back"]');
		await expect(page.locator('[data-testid="wizard-step-1"]')).toBeVisible();
		// radix Select 交互：点开 trigger → 选 option
		await selectRadixOption(
			page,
			page.locator('[data-testid="region-select"]'),
			"香港",
		);
		await expect(
			page.locator('[data-testid="base-currency-select"]'),
		).toContainText("港币");
		await page.click('[data-testid="wizard-next"]');
		await expect(page.locator('[data-testid="wizard-step-2"]')).toBeVisible();
		await expect(page.locator('[data-testid="holding-amount-0"]')).toHaveValue(
			"1000",
		);
		logger.log("action", "info", "✓ 改币后金额保留，等待重新核对");

		// 改回 CNY 再核对一次（报价方向恢复）
		await page.click('[data-testid="wizard-back"]');
		await selectRadixOption(
			page,
			page.locator('[data-testid="region-select"]'),
			"中国大陆",
		);
		await page.click('[data-testid="wizard-next"]');
		await expect(reviewRow.or(rateFailed).first()).toBeVisible({
			timeout: 30000,
		});
		if (await rateFailed.isVisible().catch(() => false)) {
			await saveScreenshot(
				page,
				"08-onboarding",
				"T-OBW-003-skip-rate-source-2",
			);
			test.skip(true, "外部汇率数据源不可用，改币重核无法加载");
		}
		await saveScreenshot(page, "08-onboarding", "T-OBW-003-02-re-review");
		logger.log("action", "info", "✓ 改回本位币后核对内容重新展示");

		// 确认入账 → 首页 USD 账户卡 + 无引导卡（需求场景 4/11）
		// 先注册 state 响应等待：complete 后首页 refetch 返回新数据再断言（消除导航时序竞态）
		const homeStateLoaded = page.waitForResponse(
			(res) =>
				res.url().includes("/api/home/state") &&
				res.request().method() === "GET" &&
				res.status() === 200,
		);
		await page.click('[data-testid="holdings-submit"]');
		await page.waitForURL(`${BASE_URL}/home`, { timeout: 15000 });
		await homeStateLoaded;
		await expect(
			page.locator('[data-testid="initial-backfill-card"]'),
		).toHaveCount(0);
		await expect(page.getByText("USD").first()).toBeVisible();
		// 余额原样展示（formatDisplayAmount 去尾零，无千分位）
		await expect(page.getByText("1000.0000").first()).toBeVisible();
		await saveScreenshot(page, "08-onboarding", "T-OBW-003-03-home-usd");
		logger.log("action", "info", "✓ USD 初始持仓已入账并展示在首页");

		await logger.saveToFile();
	});

	test("T-OBW-004: 向导中断无残留——重新登录从第一步开始（场景 6）", async ({
		page,
		context,
	}) => {
		logger.log("action", "info", "开始：向导中断场景");
		logger.setupPageListeners(page);

		const seed = await seedRegisterAndLogin("obw-interrupt");
		await page.goto(`${BASE_URL}/login`);
		await page.waitForLoadState("networkidle");
		await page.fill('input[name="email"]', seed.email);
		await page.fill('input[name="password"]', TEST_PASSWORD);
		await page.check('[data-testid="consent-age18"]');
		await page.check('[data-testid="consent-terms"]');
		await page.click('[data-testid="password-login-submit"]');
		await page.waitForURL(`${BASE_URL}/onboarding`, { timeout: 15000 });

		// 进入第二步中途（填写但未提交）后「关闭页面」
		await page.click('[data-testid="wizard-next"]');
		await expect(page.locator('[data-testid="wizard-step-2"]')).toBeVisible();
		await page.click('[data-testid="holdings-fill"]');
		await selectRadixOption(
			page,
			page.locator('[data-testid="holding-currency-0"]'),
			"USD · 美元",
		);
		await page.fill('[data-testid="holding-amount-0"]', "500");
		await page.close();
		logger.log("action", "info", "✓ 第二步中途关闭页面");

		// 重新登录（清登录态模拟新会话）
		const page2 = await context.newPage();
		await context.clearCookies();
		await page2.goto(`${BASE_URL}/login`);
		await page2.waitForLoadState("networkidle");
		await page2.fill('input[name="email"]', seed.email);
		await page2.fill('input[name="password"]', TEST_PASSWORD);
		await page2.check('[data-testid="consent-age18"]');
		await page2.check('[data-testid="consent-terms"]');
		await page2.click('[data-testid="password-login-submit"]');

		// 从第一步重新开始（后端无草稿：未建账 → 向导第一步）
		await page2.waitForURL(`${BASE_URL}/onboarding`, { timeout: 15000 });
		await expect(page2.locator('[data-testid="wizard-step-1"]')).toBeVisible();
		await saveScreenshot(page2, "08-onboarding", "T-OBW-004-01-restart-step1");
		// 第二步无上次填写残留（全新会话进入 choice 视图，先点「有，填写」再看金额行）
		await page2.click('[data-testid="wizard-next"]');
		await expect(page2.locator('[data-testid="wizard-step-2"]')).toBeVisible();
		await page2.click('[data-testid="holdings-fill"]');
		await expect(page2.locator('[data-testid="holding-amount-0"]')).toHaveValue(
			"",
		);
		await saveScreenshot(page2, "08-onboarding", "T-OBW-004-02-no-residue");
		logger.log("action", "info", "✓ 重新从第一步开始，无残留");
		await page2.close();

		await logger.saveToFile();
	});

	test("T-OBW-005: 有账户的正常首页展示已定稿免责声明", async ({ page }) => {
		const user = await seedRegisterAndLogin("obw-dashboard-disclaimer");
		await seedOnboarding(user.accessToken, "CNY");
		await seedTransaction(user.accessToken, "CAD", "6000");
		await injectLoginCookie(page.context(), user.accessToken, BASE_URL);

		await page.goto(`${BASE_URL}/home`);
		await expect(
			page.getByRole("heading", { name: "首页", exact: true }),
		).toBeVisible();
		await expect(
			page.getByText(APPROVED_DISCLAIMER, { exact: true }),
		).toBeVisible();
	});
});
