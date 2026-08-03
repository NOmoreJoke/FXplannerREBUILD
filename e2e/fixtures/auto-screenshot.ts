import { test as base } from '@playwright/test';
import path from 'path';
import fs from 'fs';

/**
 * 自动截图配置
 * 可以在测试文件中通过环境变量或直接修改这里来配置
 */
export const SCREENSHOT_CONFIG = {
  // 哪些操作需要截图（true = 截图，false = 不截图）
  goto: true,        // 页面跳转（推荐开启）
  click: true,       // 点击按钮/链接（推荐开启）
  fill: false,       // 填写表单（通常不需要，除非调试表单问题）
  selectOption: false, // 下拉选择（通常不需要）
  type: false,       // 逐字输入（通常不需要）

  // 截图时机
  beforeAction: true,  // 操作前截图
  afterAction: true,   // 操作后截图

  // 高级选项
  fullPage: true,      // 全页面截图（包括滚动区域）
  waitAfterAction: 500, // 操作后等待时间（ms），等待动画完成
};

/**
 * 自动截图 Fixture
 * 根据配置自动在关键操作前后截图
 */

let screenshotCounter = 0;
let testOutputDir = '';

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    // 初始化截图目录
    screenshotCounter = 0;
    testOutputDir = path.join(testInfo.outputDir, 'step-screenshots');
    fs.mkdirSync(testOutputDir, { recursive: true });

    // 截图辅助函数
    const takeScreenshot = async (actionName: string) => {
      screenshotCounter++;
      const filename = `${String(screenshotCounter).padStart(3, '0')}-${actionName}.png`;
      const filepath = path.join(testOutputDir, filename);

      try {
        await page.screenshot({
          path: filepath,
          fullPage: SCREENSHOT_CONFIG.fullPage
        });
        console.log(`📸 ${filename}`);
      } catch (error) {
        console.log(`⚠️ 截图失败: ${actionName}`);
      }
    };

    // 包装 page 对象，拦截关键操作
    const originalGoto = page.goto.bind(page);
    const originalClick = page.click.bind(page);
    const originalFill = page.fill.bind(page);
    const originalSelectOption = page.selectOption.bind(page);
    const originalType = page.type.bind(page);

    // === 拦截 goto（页面跳转）===
    if (SCREENSHOT_CONFIG.goto) {
      page.goto = async (url: string, options?: any) => {
        const pageName = url.split('/').pop() || 'page';

        if (SCREENSHOT_CONFIG.beforeAction) {
          await takeScreenshot(`before-goto-${pageName}`);
        }

        const result = await originalGoto(url, options);
        await page.waitForLoadState('domcontentloaded').catch(() => {});

        if (SCREENSHOT_CONFIG.afterAction) {
          await takeScreenshot(`after-goto-${pageName}`);
        }

        return result;
      };
    }

    // === 拦截 click（点击）===
    if (SCREENSHOT_CONFIG.click) {
      page.click = async (selector: string, options?: any) => {
        // 尝试获取元素文本作为截图名称
        const elementText = await page.locator(selector).first().textContent().catch(() => '');
        const actionName = elementText
          ? elementText.slice(0, 20).replace(/[^a-z0-9]/gi, '-')
          : selector.split(' ').pop()?.replace(/[^a-z0-9]/gi, '-') || 'element';

        if (SCREENSHOT_CONFIG.beforeAction) {
          await takeScreenshot(`before-click-${actionName}`);
        }

        const result = await originalClick(selector, options);

        if (SCREENSHOT_CONFIG.waitAfterAction > 0) {
          await page.waitForTimeout(SCREENSHOT_CONFIG.waitAfterAction);
        }

        if (SCREENSHOT_CONFIG.afterAction) {
          await takeScreenshot(`after-click-${actionName}`);
        }

        return result;
      };
    }

    // === 拦截 fill（填写表单）===
    if (SCREENSHOT_CONFIG.fill) {
      page.fill = async (selector: string, value: string, options?: any) => {
        const fieldName = selector.match(/name="([^"]+)"/)?.[1] ||
                         selector.match(/id="([^"]+)"/)?.[1] ||
                         'field';

        if (SCREENSHOT_CONFIG.beforeAction) {
          await takeScreenshot(`before-fill-${fieldName}`);
        }

        const result = await originalFill(selector, value, options);

        if (SCREENSHOT_CONFIG.afterAction) {
          await takeScreenshot(`after-fill-${fieldName}`);
        }

        return result;
      };
    }

    // === 拦截 selectOption（下拉选择）===
    if (SCREENSHOT_CONFIG.selectOption) {
      page.selectOption = async (selector: string, values: any, options?: any) => {
        const fieldName = selector.match(/name="([^"]+)"/)?.[1] || 'select';

        if (SCREENSHOT_CONFIG.beforeAction) {
          await takeScreenshot(`before-select-${fieldName}`);
        }

        const result = await originalSelectOption(selector, values, options);

        if (SCREENSHOT_CONFIG.afterAction) {
          await takeScreenshot(`after-select-${fieldName}`);
        }

        return result;
      };
    }

    // === 拦截 type（逐字输入）===
    if (SCREENSHOT_CONFIG.type) {
      page.type = async (selector: string, text: string, options?: any) => {
        const fieldName = selector.match(/name="([^"]+)"/)?.[1] || 'field';

        if (SCREENSHOT_CONFIG.beforeAction) {
          await takeScreenshot(`before-type-${fieldName}`);
        }

        const result = await originalType(selector, text, options);

        if (SCREENSHOT_CONFIG.afterAction) {
          await takeScreenshot(`after-type-${fieldName}`);
        }

        return result;
      };
    }

    await use(page);
  },
});

export { expect } from '@playwright/test';
