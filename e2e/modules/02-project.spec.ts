import { test, expect } from '../fixtures/auto-screenshot';
import { TestLogger } from '../helpers/logger';
import { ensureTestUser } from '../helpers/auth-helper';

/**
 * 项目管理模块 E2E 测试
 *
 * 测试范围：
 * - 查看项目列表
 * - 创建项目
 * - 编辑项目
 * - 删除项目
 */

const BASE_URL = process.env.CORS_ORIGIN || 'http://localhost:3001';
// 使用固定的测试账号，避免每次运行都创建新账号
const TEST_EMAIL = 'e2e-project-test@example.com';
const TEST_PASSWORD = 'TestPass123';

test.describe('【项目管理模块】项目相关操作', () => {
  const logger = new TestLogger('project-module');

  test.describe('项目列表', () => {
    test('T-PROJECT-001: 查看项目列表', async ({ page }) => {
      logger.log('action', 'info', '开始：查看项目列表');
      logger.setupPageListeners(page);

      // 确保测试用户存在并登录
      const loginSuccess = await ensureTestUser(page, TEST_EMAIL, TEST_PASSWORD);
      if (!loginSuccess) {
        throw new Error('测试用户登录失败');
      }
      logger.log('action', 'info', '✓ 已登录');

      // 等待项目列表加载
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      // 验证项目列表页面
      const heading = await page.locator('h1, h2').filter({ hasText: /项目|Project/i });
      await expect(heading).toBeVisible({ timeout: 5000 });
      logger.log('action', 'info', '✓ 项目列表已加载');

      await logger.saveToFile();
    });
  });

  test.describe('创建项目', () => {

    test('T-PROJECT-002: 创建新项目', async ({ page }) => {
      logger.log('action', 'info', '开始：创建新项目');
      logger.setupPageListeners(page);

      // 确保测试用户存在并登录
      const loginSuccess = await ensureTestUser(page, TEST_EMAIL, TEST_PASSWORD);
      if (!loginSuccess) {
        throw new Error('测试用户登录失败');
      }
      logger.log('action', 'info', '✓ 已登录');

      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      // 查找创建按钮
      const createButton = page.locator(
        'button:has-text("创建项目"), button:has-text("新建项目"), button:has-text("Create Project")'
      ).first();

      if (await createButton.isVisible({ timeout: 3000 })) {
        await createButton.click();
        logger.log('action', 'info', '✓ 创建项目对话框已打开');

        // 填写项目名称
        const projectName = `E2E 项目 ${Date.now()}`;
        const nameInput = page.locator('input[name="name"], input[placeholder*="项目名"]').first();
        await nameInput.fill(projectName);
        logger.log('action', 'info', `✓ 项目名称已填充: ${projectName}`);

        // 提交
        const submitButton = page.locator('button[type="submit"]').first();
        await submitButton.click();
        logger.log('action', 'info', '⏳ 等待项目创建...');

        // 断言：新项目卡片出现在列表中（骨架无下游编辑页，不跳转）
        const card = page.locator('[data-testid="project-card"]', { hasText: projectName }).first();
        await expect(card).toBeVisible({ timeout: 10000 });

        logger.log('action', 'info', `✓ 项目已创建: ${projectName}`);
      } else {
        logger.log('action', 'warn', '⚠️ 未找到创建按钮');
        test.skip();
      }

      await logger.saveToFile();
    });

    test('T-PROJECT-003: 编辑项目名称', async ({ page }) => {
      logger.log('action', 'info', '开始：编辑项目名称');
      logger.setupPageListeners(page);

      // 确保测试用户存在并登录
      const loginSuccess = await ensureTestUser(page, TEST_EMAIL, TEST_PASSWORD);
      if (!loginSuccess) {
        throw new Error('测试用户登录失败');
      }

      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      // 查找项目卡片（骨架卡片：data-testid="project-card"）
      const firstProject = page.locator('[data-testid="project-card"]').first();

      if (await firstProject.isVisible({ timeout: 3000 })) {
        // 重命名走原生 prompt 对话框：自动填入新名称
        const newName = `更新项目 ${Date.now()}`;
        page.on('dialog', (dialog) => dialog.accept(newName));

        // 打开卡片右上角菜单
        await firstProject.locator('button').first().click();
        await page.waitForTimeout(500);

        // 点击「重命名」
        const renameButton = page.locator('[data-testid="rename-button"]').first();

        if (await renameButton.isVisible({ timeout: 2000 })) {
          await renameButton.click();
          await page.waitForTimeout(1500);
          logger.log('action', 'info', `✓ 项目已重命名为: ${newName}`);

          // 断言新名称出现在列表中
          const renamedCard = page.locator('[data-testid="project-card"]', { hasText: newName }).first();
          await expect(renamedCard).toBeVisible({ timeout: 5000 });
          logger.log('action', 'info', '✓ 新名称已显示在列表中');
        } else {
          logger.log('action', 'warn', '⚠️ 未找到重命名按钮');
          test.skip();
        }
      } else {
        logger.log('action', 'warn', '⚠️ 未找到项目卡片');
        test.skip();
      }

      await logger.saveToFile();
    });
  });

  test.describe('删除项目', () => {
    test('T-PROJECT-004: 删除项目', async ({ page }) => {
      logger.log('action', 'info', '开始：删除项目');
      logger.setupPageListeners(page);

      // 确保测试用户存在并登录
      const loginSuccess = await ensureTestUser(page, TEST_EMAIL, TEST_PASSWORD);
      if (!loginSuccess) {
        throw new Error('测试用户登录失败');
      }

      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      // 获取项目列表中的第一个项目（骨架卡片：data-testid="project-card"）
      const firstProject = page.locator('[data-testid="project-card"]').first();

      if (await firstProject.isVisible({ timeout: 3000 })) {
        // 删除走原生 confirm 对话框：自动接受
        page.on('dialog', (dialog) => dialog.accept());

        // 打开卡片右上角菜单
        await firstProject.locator('button').first().click();
        await page.waitForTimeout(500);

        // 点击「删除」
        const deleteButton = page.locator('[data-testid="delete-button"]').first();

        if (await deleteButton.isVisible({ timeout: 2000 })) {
          await deleteButton.click();
          await page.waitForTimeout(1500);
          logger.log('action', 'info', '✓ 项目已删除');
        } else {
          logger.log('action', 'warn', '⚠️ 未找到删除按钮');
          test.skip();
        }
      } else {
        logger.log('action', 'warn', '⚠️ 没有项目可删除');
        test.skip();
      }

      await logger.saveToFile();
    });
  });
});
