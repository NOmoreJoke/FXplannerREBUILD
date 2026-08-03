import { Page } from '@playwright/test';

/**
 * 项目管理辅助函数（示例模块）
 *
 * 模板骨架中项目为纯列表 CRUD（无下游编辑页），
 * 创建成功后项目卡片出现在首页列表中。
 */

const BASE_URL = process.env.CORS_ORIGIN || 'http://localhost:3001';

/**
 * 创建测试项目
 * @param page Playwright Page 对象
 * @param projectName 项目名称
 * @returns 项目名（创建成功），失败返回 null
 */
export async function createTestProject(page: Page, projectName?: string): Promise<string | null> {
  try {
    const name = projectName || `E2E Test Project ${Date.now()}`;

    // 确保在首页
    const currentUrl = page.url();
    if (!currentUrl.includes(BASE_URL)) {
      await page.goto(`${BASE_URL}/projects`);
      await page.waitForLoadState('networkidle');
    }

    await page.waitForTimeout(1000);

    // 查找创建按钮
    const createButton = page.locator(
      'button:has-text("创建项目"), button:has-text("新建项目"), button:has-text("Create Project")'
    ).first();

    const isVisible = await createButton.isVisible({ timeout: 3000 });
    if (!isVisible) {
      console.log('⚠️ 未找到创建项目按钮');
      return null;
    }

    await createButton.click();
    await page.waitForTimeout(500);

    // 填写项目名称
    const nameInput = page.locator('input[name="name"], input[placeholder*="项目名"]').first();
    await nameInput.fill(name);

    // 提交
    const submitButton = page.locator('button[type="submit"]').first();
    await submitButton.click();

    // 等待项目卡片出现在列表中
    const card = page.locator('[data-testid="project-card"]', { hasText: name }).first();
    await card.waitFor({ state: 'visible', timeout: 10000 });

    console.log(`✓ 项目创建成功: ${name}`);
    return name;
  } catch (error) {
    console.log('❌ 创建项目失败:', error);
    return null;
  }
}

/**
 * 删除测试项目（通过卡片菜单）
 * @param page Playwright Page 对象
 * @param projectName 项目名
 * @returns 是否删除成功
 */
export async function deleteTestProject(page: Page, projectName: string): Promise<boolean> {
  try {
    await page.goto(`${BASE_URL}/projects`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const card = page.locator('[data-testid="project-card"]', { hasText: projectName }).first();
    if (!(await card.isVisible({ timeout: 3000 }))) {
      console.log('⚠️ 未找到项目卡片');
      return false;
    }

    // 打开卡片菜单 → 删除（页面原生 confirm 对话框自动接受）
    page.on('dialog', (dialog) => dialog.accept());
    await card.locator('button').first().click();
    await page.locator('[data-testid="delete-button"]').click();
    await page.waitForTimeout(1000);

    console.log(`✓ 项目已删除: ${projectName}`);
    return true;
  } catch (error) {
    console.log('❌ 删除项目失败:', error);
    return false;
  }
}
