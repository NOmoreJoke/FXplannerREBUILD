import { test, expect } from '../fixtures/auto-screenshot';
import { TestLogger } from '../helpers/logger';

/**
 * 认证模块 E2E 测试
 *
 * 测试范围：
 * - 用户注册流程
 * - 用户登录流程
 * - 用户登出流程
 * - 错误场景（邮箱已存在、密码错误等）
 */

const BASE_URL = process.env.CORS_ORIGIN || 'http://localhost:3001';
const TEST_EMAIL = `e2e-auth-${Date.now()}@example.com`;
const TEST_PASSWORD = 'TestPass123';

test.describe('【认证模块】用户认证流程', () => {
  const logger = new TestLogger('auth-module');

  test.describe('注册流程', () => {
    test('T-AUTH-001: 用户注册成功', async ({ page }) => {
      logger.log('action', 'info', '开始：用户注册成功');
      logger.setupPageListeners(page);

      await page.goto(`${BASE_URL}/register`);
      await page.waitForLoadState('networkidle');

      // 验证注册页加载
      await expect(page).toHaveURL(/.*register/);
      logger.log('action', 'info', '✓ 注册页已加载');

      // 填写表单
      await page.fill('input[name="email"]', TEST_EMAIL);
      await page.fill('input[name="password"]', TEST_PASSWORD);
      await page.fill('input[name="confirmPassword"]', TEST_PASSWORD);
      logger.log('action', 'info', `✓ 表单已填充: ${TEST_EMAIL}`);

      // 提交注册
      await page.click('button[type="submit"]');
      logger.log('action', 'info', '⏳ 等待注册响应...');

      // 等待跳转到首页
      await page.waitForURL(`${BASE_URL}/projects`, { timeout: 10000 });
      logger.log('action', 'info', '✓ 已跳转到首页');

      // 验证 Token
      const token = await page.evaluate(() => localStorage.getItem('accessToken'));
      expect(token).toBeTruthy();
      logger.log('action', 'info', '✓ Token 已存储');

      await logger.saveToFile();
    });

    test('T-AUTH-002: 注册失败 - 邮箱已存在', async ({ page }) => {
      logger.log('action', 'info', '开始：注册失败 - 邮箱已存在');
      logger.setupPageListeners(page);

      await page.goto(`${BASE_URL}/register`);
      await page.waitForLoadState('networkidle');

      // 使用已存在的邮箱
      await page.fill('input[name="email"]', TEST_EMAIL);
      await page.fill('input[name="password"]', 'AnotherPass123');
      await page.fill('input[name="confirmPassword"]', 'AnotherPass123');
      logger.log('action', 'info', '✓ 使用已存在邮箱填充表单');

      // 提交
      await page.click('button[type="submit"]');
      await page.waitForTimeout(2000);

      // 应该仍在注册页
      const url = page.url();
      expect(url).toContain('/register');
      logger.log('action', 'info', '✓ 注册失败，页面停留在注册页');

      await logger.saveToFile();
    });
  });

  test.describe('登录流程', () => {
    test('T-AUTH-003: 用户登录成功', async ({ page }) => {
      logger.log('action', 'info', '开始：用户登录成功');
      logger.setupPageListeners(page);

      // 清除 token
      await page.goto(`${BASE_URL}/login`);
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.waitForLoadState('networkidle');

      // 验证登录页加载
      await expect(page).toHaveURL(/.*login/);
      logger.log('action', 'info', '✓ 登录页已加载');

      // 填写表单
      await page.fill('input[name="email"]', TEST_EMAIL);
      await page.fill('input[name="password"]', TEST_PASSWORD);
      logger.log('action', 'info', `✓ 登录表单已填充: ${TEST_EMAIL}`);

      // 提交登录
      await page.click('button[type="submit"]');
      logger.log('action', 'info', '⏳ 等待登录响应...');

      // 等待跳转到首页
      await page.waitForURL(`${BASE_URL}/projects`, { timeout: 10000 });
      logger.log('action', 'info', '✓ 已跳转到首页');

      // 验证 Token
      const token = await page.evaluate(() => localStorage.getItem('accessToken'));
      expect(token).toBeTruthy();
      logger.log('action', 'info', '✓ 登录成功');

      await logger.saveToFile();
    });

    test('T-AUTH-004: 登录失败 - 密码错误', async ({ page }) => {
      logger.log('action', 'info', '开始：登录失败 - 密码错误');
      logger.setupPageListeners(page);

      await page.goto(`${BASE_URL}/login`);
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.waitForLoadState('networkidle');

      // 填写错误密码
      await page.fill('input[name="email"]', TEST_EMAIL);
      await page.fill('input[name="password"]', 'WrongPassword123');
      logger.log('action', 'info', '✓ 填充错误的密码');

      // 提交
      await page.click('button[type="submit"]');
      await page.waitForTimeout(2000);

      // 应该仍在登录页
      const url = page.url();
      expect(url).toContain('/login');
      logger.log('action', 'info', '✓ 登录失败，页面停留在登录页');

      await logger.saveToFile();
    });
  });

  test.describe('公开区访问', () => {
    test('T-AUTH-006: 未登录访问落地页不被弹走', async ({ page }) => {
      logger.log('action', 'info', '开始：未登录访问落地页');
      logger.setupPageListeners(page);

      // 清空凭证，确保匿名状态
      await page.goto(`${BASE_URL}/login`);
      await page.evaluate(() => {
        localStorage.clear();
        document.cookie = 'accessToken=; path=/; max-age=0';
      });

      // 落地页是公开区：不应被重定向到登录页
      await page.goto(`${BASE_URL}/`);
      await page.waitForLoadState('networkidle');
      expect(page.url()).toBe(`${BASE_URL}/`);
      logger.log('action', 'info', '✓ 落地页公开可访问');

      await logger.saveToFile();
    });
  });

  test.describe('登出流程', () => {
    test('T-AUTH-005: 用户登出成功', async ({ page }) => {
      logger.log('action', 'info', '开始：用户登出成功');
      logger.setupPageListeners(page);

      // 先登录
      await page.goto(`${BASE_URL}/login`);
      await page.fill('input[name="email"]', TEST_EMAIL);
      await page.fill('input[name="password"]', TEST_PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL(`${BASE_URL}/projects`, { timeout: 10000 });
      logger.log('action', 'info', '✓ 已登录');

      // 清除 Token 模拟登出
      await page.evaluate(() => {
        localStorage.clear();
        document.cookie = 'accessToken=; path=/; max-age=0';
      });
      logger.log('action', 'info', '✓ Token 已清除');

      // 访问首页，应该被重定向到登录页
      await page.goto(`${BASE_URL}/projects`);
      await page.waitForURL(/\/login/, { timeout: 5000 });
      logger.log('action', 'info', '✓ 已被重定向到登录页');

      await logger.saveToFile();
    });
  });
});
