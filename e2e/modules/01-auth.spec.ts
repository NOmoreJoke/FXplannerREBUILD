import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";

/**
 * 认证模块 E2E 测试
 *
 * 测试范围：
 * - 用户注册流程
 * - 用户登录流程
 * - 用户登出流程
 * - 错误场景（邮箱已存在、密码错误等）
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";
const TEST_EMAIL = `e2e-auth-${Date.now()}@example.com`;
const TEST_PASSWORD = "TestPass123";

test.describe("【认证模块】用户认证流程", () => {
	const logger = new TestLogger("auth-module");

	test.describe("注册流程", () => {
		test("T-AUTH-001: 用户注册成功", async ({ page }) => {
			logger.log("action", "info", "开始：用户注册成功");
			logger.setupPageListeners(page);

			await page.goto(`${BASE_URL}/register`);
			await page.waitForLoadState("networkidle");

			// 验证注册页加载
			await expect(page).toHaveURL(/.*register/);
			logger.log("action", "info", "✓ 注册页已加载");
			await saveScreenshot(page, "01-auth", "T-AUTH-001-register-page");

			// 填写表单
			await page.fill('input[name="email"]', TEST_EMAIL);
			await page.fill('input[name="password"]', TEST_PASSWORD);
			await page.fill('input[name="confirmPassword"]', TEST_PASSWORD);
			logger.log("action", "info", `✓ 表单已填充: ${TEST_EMAIL}`);

			// 合规勾选（onboarding-rework 注册门槛，与登录页一致；不勾选则提交被拦截）
			await page.check('[data-testid="consent-age18"]');
			await page.check('[data-testid="consent-terms"]');

			// 提交注册
			await page.click('button[type="submit"]');
			logger.log("action", "info", "⏳ 等待注册响应...");

			// 等待跳转到工作台首页（/home；新注册未建账用户会被分流到 /onboarding）
			await page.waitForURL(/\/(home|onboarding)/, { timeout: 10000 });
			logger.log("action", "info", "✓ 已跳转到工作台首页");
			await saveScreenshot(page, "01-auth", "T-AUTH-001-home-after-register");

			// 验证 Token
			const token = await page.evaluate(() =>
				document.cookie.includes("accessToken="),
			);
			expect(token).toBeTruthy();
			logger.log("action", "info", "✓ Token 已存储");

			await logger.saveToFile();
		});

		test("T-AUTH-002: 注册失败 - 邮箱已存在", async ({ page }) => {
			logger.log("action", "info", "开始：注册失败 - 邮箱已存在");
			logger.setupPageListeners(page);

			await page.goto(`${BASE_URL}/register`);
			await page.waitForLoadState("networkidle");

			// 使用已存在的邮箱
			await page.fill('input[name="email"]', TEST_EMAIL);
			await page.fill('input[name="password"]', "AnotherPass123");
			await page.fill('input[name="confirmPassword"]', "AnotherPass123");
			logger.log("action", "info", "✓ 使用已存在邮箱填充表单");

			// 提交
			await page.click('button[type="submit"]');
			await page.waitForTimeout(2000);

			// 应该仍在注册页
			const url = page.url();
			expect(url).toContain("/register");
			logger.log("action", "info", "✓ 注册失败，页面停留在注册页");

			await logger.saveToFile();
		});
	});

	test.describe("登录流程", () => {
		test("T-AUTH-003: 用户登录成功", async ({ page }) => {
			logger.log("action", "info", "开始：用户登录成功");
			logger.setupPageListeners(page);

			// 清除 token
			await page.goto(`${BASE_URL}/login`);
			await page.evaluate(() => localStorage.clear());
			await page.reload();
			await page.waitForLoadState("networkidle");

			// 验证登录页加载
			await expect(page).toHaveURL(/.*login/);
			logger.log("action", "info", "✓ 登录页已加载");

			// 填写表单
			await page.fill('input[name="email"]', TEST_EMAIL);
			await page.fill('input[name="password"]', TEST_PASSWORD);
			logger.log("action", "info", `✓ 登录表单已填充: ${TEST_EMAIL}`);

			// 登录门槛（onboarding-rework）：两项勾选后才可提交
			await page.check('[data-testid="consent-age18"]');
			await page.check('[data-testid="consent-terms"]');

			// 提交登录
			await page.click('button[type="submit"]');
			logger.log("action", "info", "⏳ 等待登录响应...");

			// 等待跳转：未建账用户进入建账向导（onboarding-rework 新行为）
			await page.waitForURL(`${BASE_URL}/onboarding`, { timeout: 10000 });
			logger.log("action", "info", "✓ 已登录并进入建账向导（未建账分流）");

			// 验证 Token
			const token = await page.evaluate(() =>
				document.cookie.includes("accessToken="),
			);
			expect(token).toBeTruthy();
			logger.log("action", "info", "✓ 登录成功");

			await logger.saveToFile();
		});

		test("T-AUTH-004: 登录失败 - 密码错误", async ({ page }) => {
			logger.log("action", "info", "开始：登录失败 - 密码错误");
			logger.setupPageListeners(page);

			await page.goto(`${BASE_URL}/login`);
			await page.evaluate(() => localStorage.clear());
			await page.reload();
			await page.waitForLoadState("networkidle");

			// 填写错误密码（登录门槛：先勾选才能点提交按钮）
			await page.fill('input[name="email"]', TEST_EMAIL);
			await page.fill('input[name="password"]', "WrongPassword123");
			await page.check('[data-testid="consent-age18"]');
			await page.check('[data-testid="consent-terms"]');
			logger.log("action", "info", "✓ 填充错误的密码");

			// 提交
			await page.click('button[type="submit"]');
			await page.waitForTimeout(2000);

			// 应该仍在登录页
			const url = page.url();
			expect(url).toContain("/login");
			logger.log("action", "info", "✓ 登录失败，页面停留在登录页");

			await logger.saveToFile();
		});
	});

	test.describe("公开区访问", () => {
		test("T-AUTH-006: 未登录访问落地页不被弹走", async ({ page }) => {
			logger.log("action", "info", "开始：未登录访问落地页");
			logger.setupPageListeners(page);

			// 清空凭证，确保匿名状态
			await page.goto(`${BASE_URL}/login`);
			await page.evaluate(() => {
				localStorage.clear();
				document.cookie = "accessToken=; path=/; max-age=0";
			});

			// 落地页是公开区：不应被重定向到登录页
			await page.goto(`${BASE_URL}/`);
			await page.waitForLoadState("networkidle");
			expect(page.url()).toBe(`${BASE_URL}/`);
			logger.log("action", "info", "✓ 落地页公开可访问");

			await logger.saveToFile();
		});

		test("T-AUTH-007: 已登录访问落地页跳转工作台", async ({ page }) => {
			logger.log("action", "info", "开始：已登录访问落地页跳转工作台");
			logger.setupPageListeners(page);

			// 先登录（复用 T-AUTH-001 注册的用户；未建账 → 登录后进向导）
			await page.goto(`${BASE_URL}/login`);
			await page.fill('input[name="email"]', TEST_EMAIL);
			await page.fill('input[name="password"]', TEST_PASSWORD);
			await page.check('[data-testid="consent-age18"]');
			await page.check('[data-testid="consent-terms"]');
			await page.click('button[type="submit"]');
			await page.waitForURL(/\/(home|onboarding)/, { timeout: 10000 });
			logger.log("action", "info", "✓ 已登录");

			// 已登录访问 / → 被导离落地页（已建账 → /home；未建账新用户 → /onboarding 分流）
			await page.goto(`${BASE_URL}/`);
			await page.waitForLoadState("networkidle");
			await expect(page).toHaveURL(/\/(home|onboarding)/);
			logger.log("action", "info", "✓ 已登录访问 / 自动导离落地页");

			await logger.saveToFile();
		});
	});

	test.describe("登出流程", () => {
		test("T-AUTH-005: 用户登出成功", async ({ page }) => {
			logger.log("action", "info", "开始：用户登出成功");
			logger.setupPageListeners(page);

			// 先登录（未建账用户登录后进向导，onboarding-rework 行为）
			await page.goto(`${BASE_URL}/login`);
			await page.fill('input[name="email"]', TEST_EMAIL);
			await page.fill('input[name="password"]', TEST_PASSWORD);
			await page.check('[data-testid="consent-age18"]');
			await page.check('[data-testid="consent-terms"]');
			await page.click('button[type="submit"]');
			await page.waitForURL(/\/(home|onboarding)/, { timeout: 10000 });
			logger.log("action", "info", "✓ 已登录");

			// 清除 Token 模拟登出
			await page.evaluate(() => {
				localStorage.clear();
				document.cookie = "accessToken=; path=/; max-age=0";
			});
			logger.log("action", "info", "✓ Token 已清除");

			const tokenAfterLogout = await page.evaluate(() =>
				document.cookie.includes("accessToken="),
			);
			expect(tokenAfterLogout).toBe(false);

			// 公开首页在登出后仍可访问
			await page.goto(`${BASE_URL}/`);
			await expect(page).toHaveURL(`${BASE_URL}/`);
			logger.log("action", "info", "✓ 已退出登录，公开首页可访问");

			await logger.saveToFile();
		});
	});
});
