import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";

/**
 * 邮箱验证码（OTP）登录 E2E（changes/ux-improvements）
 *
 * 覆盖流程：
 * - T-OTP-001: 只支持邮箱回归 —— 登录/验证码模式无「手机号」入口
 * - T-OTP-002: 邮箱验证码登录端到端 —— 发码（mock devCode 自动填充）→ 验证并登录 → /home
 *
 * 依赖后端邮件 mock 模式（未配置 Resend 时 dev 自动开启，send-code 响应带 devCode）。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";
const TEST_EMAIL = `e2e-otp-${Date.now()}@example.com`;

test.describe("【OTP 登录】邮箱验证码（mock 邮件）", () => {
	const logger = new TestLogger("otp-login");

	test("T-OTP-001: 登录页无手机号入口（仅邮箱）", async ({ page }) => {
		logger.log("action", "info", "开始：无手机号入口回归");
		logger.setupPageListeners(page);

		await page.goto(`${BASE_URL}/login`);
		await page.waitForLoadState("networkidle");
		await saveScreenshot(page, "05-otp-login", "T-OTP-001-01-login-page");

		// 切到验证码登录
		await page.click('[role="tab"]:has-text("验证码登录")');
		await page.waitForTimeout(300);
		await saveScreenshot(
			page,
			"05-otp-login",
			"T-OTP-001-02-otp-mode-email-only",
		);

		// 回归断言：OTP 模式下不存在「手机号」按钮/文案（R1）
		await expect(page.locator('button:has-text("手机号")')).toHaveCount(0);
		await expect(page.getByText("+8613800138000")).toHaveCount(0);
		// 邮箱输入框存在
		await expect(page.locator("#otpTarget")).toBeVisible();
		logger.log("action", "info", "✓ 无手机号入口，仅邮箱渠道");

		await logger.saveToFile();
	});

	test("T-OTP-002: 邮箱验证码登录端到端（mock devCode）", async ({ page }) => {
		logger.log("action", "info", "开始：邮箱验证码登录端到端");
		logger.setupPageListeners(page);

		await page.goto(`${BASE_URL}/login`);
		await page.waitForLoadState("networkidle");
		await page.click('[role="tab"]:has-text("验证码登录")');

		// 填邮箱并发码
		await page.fill("#otpTarget", TEST_EMAIL);
		await page.click('button:has-text("获取验证码")');
		logger.log("action", "info", `⏳ 已请求发码 ${TEST_EMAIL}`);

		// mock 模式：devCode 自动填充输入框（toast「验证码已发送（模拟）」同源）
		await expect(page.locator("#otpCode")).toHaveValue(/^\d{6}$/, {
			timeout: 15000,
		});
		const devCode = await page.inputValue("#otpCode");
		logger.log("action", "info", `✓ devCode 已自动填充（${devCode}）`);
		await saveScreenshot(page, "05-otp-login", "T-OTP-002-01-code-filled");

		// 「验证并登录」随 challengeId 就绪而启用
		const submit = page.locator('button:has-text("验证并登录")');
		await expect(submit).toBeEnabled();
		await submit.click();

		await page.waitForURL(`${BASE_URL}/home`, { timeout: 15000 });
		logger.log("action", "info", "✓ OTP 登录成功，已进入 /home");
		await saveScreenshot(page, "05-otp-login", "T-OTP-002-02-home");

		await logger.saveToFile();
	});
});
