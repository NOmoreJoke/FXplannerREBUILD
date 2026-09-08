import type { Page } from "@playwright/test";

/**
 * E2E 测试辅助函数
 * 提供通用的测试操作，如注册、登录等
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";

/**
 * 注册测试用户
 * @param page Playwright Page 对象
 * @param email 邮箱
 * @param password 密码
 * @returns 是否注册成功
 */
export async function registerTestUser(
	page: Page,
	email: string,
	password: string,
): Promise<boolean> {
	try {
		await page.goto(`${BASE_URL}/register`);
		await page.waitForLoadState("networkidle");

		await page.fill('input[name="email"]', email);
		await page.fill('input[name="password"]', password);
		await page.fill('input[name="confirmPassword"]', password);

		await page.click('button[type="submit"]');

		// 等待跳转或错误提示
		await Promise.race([
			page.waitForURL(`${BASE_URL}/`, { timeout: 5000 }),
			page.waitForTimeout(5000),
		]);

		// 检查是否注册成功（跳转到公开首页）
		const url = page.url();
		return url === `${BASE_URL}/`;
	} catch (error) {
		console.log(`⚠️ 注册用户失败: ${email}`, error);
		return false;
	}
}

/**
 * 登录测试用户
 * @param page Playwright Page 对象
 * @param email 邮箱
 * @param password 密码
 * @returns 是否登录成功
 */
export async function loginTestUser(
	page: Page,
	email: string,
	password: string,
): Promise<boolean> {
	try {
		// 清除现有 token
		await page.goto(`${BASE_URL}/login`);
		await page.evaluate(() => localStorage.clear());
		await page.reload();
		await page.waitForLoadState("networkidle");

		await page.fill('input[name="email"]', email);
		await page.fill('input[name="password"]', password);

		await page.click('button[type="submit"]');

		// 等待跳转或错误提示
		await Promise.race([
			page.waitForURL(`${BASE_URL}/`, { timeout: 10000 }),
			page.waitForTimeout(10000),
		]);

		// 检查是否登录成功
		const url = page.url();
		const token = await page.evaluate(() =>
			localStorage.getItem("accessToken"),
		);

		return url === `${BASE_URL}/` && !!token;
	} catch (error) {
		console.log(`⚠️ 登录失败: ${email}`, error);
		return false;
	}
}

/**
 * 注册或登录测试用户（智能处理）
 * 如果用户已存在则直接登录，不存在则先注册
 * @param page Playwright Page 对象
 * @param email 邮箱
 * @param password 密码
 * @returns 是否成功
 */
export async function ensureTestUser(
	page: Page,
	email: string,
	password: string,
): Promise<boolean> {
	// 先尝试登录
	const loginSuccess = await loginTestUser(page, email, password);
	if (loginSuccess) {
		console.log(`✓ 用户已存在，登录成功: ${email}`);
		return true;
	}

	// 登录失败，尝试注册
	console.log(`⚠️ 用户不存在，开始注册: ${email}`);
	const registerSuccess = await registerTestUser(page, email, password);

	if (registerSuccess) {
		console.log(`✓ 注册成功: ${email}`);
		return true;
	}

	console.log(`❌ 注册和登录都失败: ${email}`);
	return false;
}
