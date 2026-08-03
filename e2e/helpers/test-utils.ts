import { Page, expect } from '@playwright/test';

/**
 * E2E 测试辅助工具
 * 提供网络监听、日志记录、错误捕获等功能
 */

interface ApiRequest {
  url: string;
  method: string;
  headers: any;
  postData: any;
  timestamp: string;
}

interface ApiResponse {
  url: string;
  status: number;
  statusText: string;
  body: any;
  timestamp: string;
}

interface NetworkLog {
  requests: ApiRequest[];
  responses: ApiResponse[];
}

/**
 * 启用详细的网络日志
 * 监听所有 API 请求和响应
 */
export function enableNetworkLogging(page: Page): NetworkLog {
  const log: NetworkLog = {
    requests: [],
    responses: [],
  };

  // 监听请求
  page.on('request', (request) => {
    if (request.url().includes('/api/')) {
      const reqLog: ApiRequest = {
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        postData: request.postData(),
        timestamp: new Date().toISOString(),
      };
      log.requests.push(reqLog);
      console.log(`📤 [${reqLog.method}] ${reqLog.url}`);
      if (reqLog.postData) {
        console.log('   Body:', reqLog.postData);
      }
    }
  });

  // 监听响应
  page.on('response', async (response) => {
    if (response.url().includes('/api/')) {
      let body = null;
      try {
        body = await response.json();
      } catch (e) {
        body = await response.text().catch(() => null);
      }

      const resLog: ApiResponse = {
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
        body,
        timestamp: new Date().toISOString(),
      };
      log.responses.push(resLog);

      const statusEmoji = response.status() < 400 ? '✅' : '❌';
      console.log(`${statusEmoji} [${resLog.status}] ${resLog.url}`);
      if (body) {
        console.log('   Response:', JSON.stringify(body, null, 2));
      }
    }
  });

  return log;
}

/**
 * 等待特定的 API 请求并捕获响应
 */
export async function waitForApiResponse(
  page: Page,
  urlPattern: string | RegExp
): Promise<ApiResponse> {
  return new Promise((resolve) => {
    page.on('response', async (response) => {
      const url = response.url();
      const matches =
        typeof urlPattern === 'string'
          ? url.includes(urlPattern)
          : urlPattern.test(url);

      if (matches) {
        let body = null;
        try {
          body = await response.json();
        } catch (e) {
          body = await response.text().catch(() => null);
        }

        resolve({
          url: response.url(),
          status: response.status(),
          statusText: response.statusText(),
          body,
          timestamp: new Date().toISOString(),
        });
      }
    });
  });
}

/**
 * 启用浏览器控制台日志捕获
 */
export function enableConsoleLogging(page: Page) {
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();

    const emoji = {
      log: '📝',
      info: 'ℹ️',
      warn: '⚠️',
      error: '❌',
      debug: '🔍',
    }[type] || '💬';

    console.log(`${emoji} [Browser ${type.toUpperCase()}] ${text}`);
  });

  // 捕获页面错误
  page.on('pageerror', (error) => {
    console.error('🚨 [Browser Error]', error.message);
    console.error('   Stack:', error.stack);
  });
}

/**
 * 验证 API 响应
 */
export function assertApiResponse(
  response: ApiResponse | null,
  expectedStatus: number,
  expectedMessagePattern?: RegExp
) {
  console.log('\n🧪 验证 API 响应...');

  expect(response).not.toBeNull();
  console.log(`   URL: ${response!.url}`);
  console.log(`   Status: ${response!.status}`);

  expect(response!.status).toBe(expectedStatus);
  console.log(`✅ 状态码验证通过: ${expectedStatus}`);

  if (expectedMessagePattern && response!.body?.message) {
    expect(response!.body.message).toMatch(expectedMessagePattern);
    console.log(`✅ 错误消息验证通过: ${response!.body.message}`);
  }

  console.log('');
}

/**
 * 登录辅助函数（带详细日志）
 */
export async function loginWithLogging(
  page: Page,
  baseUrl: string,
  email: string,
  password: string
): Promise<{ success: boolean; response: ApiResponse | null }> {
  console.log('\n🔐 开始登录流程...');
  console.log(`   邮箱: ${email}`);

  const responsePromise = waitForApiResponse(page, '/api/auth/login');

  await page.goto(`${baseUrl}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');

  const response = await responsePromise;

  const success = response.status >= 200 && response.status < 300;
  console.log(success ? '✅ 登录成功' : '❌ 登录失败');

  return { success, response };
}

/**
 * 截图并保存（失败时使用）
 */
export async function takeDebugScreenshot(page: Page, name: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `debug-${name}-${timestamp}.png`;
  await page.screenshot({ path: `e2e/test-results/${filename}`, fullPage: true });
  console.log(`📸 截图已保存: ${filename}`);
}

/**
 * 检查 localStorage 中的 Token
 */
export async function checkStoredToken(page: Page): Promise<{
  hasToken: boolean;
  token: string | null;
  isValidJwt: boolean;
}> {
  const token = await page.evaluate(() => localStorage.getItem('accessToken'));
  const hasToken = !!token;
  const isValidJwt = hasToken && /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(token!);

  console.log('\n🔑 Token 检查:');
  console.log(`   存在: ${hasToken ? '✅' : '❌'}`);
  if (hasToken) {
    console.log(`   格式: ${isValidJwt ? '✅ 有效的 JWT' : '❌ 格式错误'}`);
    console.log(`   Token: ${token!.substring(0, 20)}...`);
  }
  console.log('');

  return { hasToken, token, isValidJwt };
}

/**
 * 检查 Cookie 中的 Token
 */
export async function checkCookieToken(page: Page): Promise<{
  hasCookie: boolean;
  token: string | null;
}> {
  const cookies = await page.context().cookies();
  const tokenCookie = cookies.find((c) => c.name === 'accessToken');
  const hasCookie = !!tokenCookie;
  const token = tokenCookie?.value || null;

  console.log('\n🍪 Cookie 检查:');
  console.log(`   存在: ${hasCookie ? '✅' : '❌'}`);
  if (hasCookie) {
    console.log(`   Token: ${token!.substring(0, 20)}...`);
    console.log(`   过期时间: ${new Date((tokenCookie!.expires || 0) * 1000).toLocaleString()}`);
  }
  console.log('');

  return { hasCookie, token };
}

/**
 * 打印测试步骤
 */
export function logStep(step: number, description: string) {
  console.log(`\n📍 步骤 ${step}: ${description}`);
}

/**
 * 打印分隔线
 */
export function logSeparator(title?: string) {
  const line = '='.repeat(60);
  if (title) {
    console.log(`\n${line}`);
    console.log(`  ${title}`);
    console.log(`${line}\n`);
  } else {
    console.log(`\n${line}\n`);
  }
}
