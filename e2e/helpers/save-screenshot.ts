import type { Page } from "@playwright/test";
import fs from "fs";
import path from "path";

/**
 * 关键页面截图留存（changes/ux-improvements 验收证据）
 *
 * 统一落盘 e2e/test-results/screenshots/<模块>/<编号>-<节点>.png，
 * 与 auto-screenshot fixture 的步骤截图（playwright-output/，每次运行清理）不同，
 * 本目录为跨运行留存，供人工审查页面样式。
 */
const SCREENSHOT_ROOT = path.join("e2e", "test-results", "screenshots");

export async function saveScreenshot(
	page: Page,
	moduleName: string,
	name: string,
	fullPage = true,
): Promise<string> {
	const dir = path.join(SCREENSHOT_ROOT, moduleName);
	await fs.promises.mkdir(dir, { recursive: true });
	const filepath = path.join(dir, `${name}.png`);
	await page.screenshot({ path: filepath, fullPage });
	console.log(`📸 截图留存: ${filepath}`);
	return filepath;
}
