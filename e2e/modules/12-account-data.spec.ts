import os from "node:os";
import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import {
	injectLoginCookie,
	seedOnboarding,
	seedRegisterAndLogin,
	seedTransaction,
	seedPlanWithAllocation,
} from "../helpers/api-seeder";
import { selectRadixOption } from "../helpers/test-utils";
import {
	closeDb,
	latestRequestId,
	makeRequestDue,
} from "../helpers/data-request-db";

/**
 * 账号与数据 E2E（changes/account-data/技术方案.md §10.4）
 *
 * 覆盖（grep T-DATA）：
 * - T-DATA-001 入口启用：三按钮可点击，无「即将上线」
 * - T-DATA-002 导出全流程：说明→验证（mock devCode）→提交→下载入口；重复提交同一请求
 * - T-DATA-003 清空警示：记录数量 + 不可恢复警示 + 可先导出
 * - T-DATA-004 清空撤回：撤回后账本数据仍在、可正常记账
 * - T-DATA-005 清空完成：到期推进（DB 钩子）→ 空账本、本位币不变、新买入以新起点成功
 * - T-DATA-006 注销与撤回：提交→进度页→撤回期内验证撤回→账号恢复
 * - T-DATA-007 用途隔离：导出验证中填登录用途验证码 → 被拒（UI 层）+ 登录用途
 *   challenge 提交导出验证 → 403 VERIFICATION_PURPOSE_MISMATCH（API 层，用途先行校验）
 * - T-DATA-008 锁写体验：清空请求期间保存偏好 → 被引导至进度页
 *
 * 验证码经 mock 渠道 devCode 自动填充（未配置 Resend 时 dev 自动开启）。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";
const API_URL = process.env.API_URL ?? "http://localhost:4001";

/**
 * 后端局域网地址：OTP_IP 频控按来源 IP 分桶（默认 5 次/60s），
 * 取 LOGIN 码走 LAN IP 与页面 127.0.0.1 分桶，避免共用窗口互相挤爆。
 */
function lanApiUrl(): string {
	if (!API_URL.includes("localhost")) return API_URL;
	for (const list of Object.values(os.networkInterfaces())) {
		for (const net of list ?? []) {
			if (net.family === "IPv4" && !net.internal) {
				return API_URL.replace("localhost", net.address);
			}
		}
	}
	return API_URL;
}

/** 走后端 API 直接发验证码（用途隔离用例取 LOGIN 用途 devCode） */
async function fetchDevCode(
	email: string,
	purpose?: string,
): Promise<{ challengeId: string; devCode?: string }> {
	const res = await fetch(`${lanApiUrl()}/api/auth/otp/send-code`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ channel: "email", target: email, purpose }),
	});
	const json = (await res.json()) as {
		data: { challengeId: string; devCode?: string };
	};
	return json.data;
}

/**
 * 与并行 E2E 共享后端限流（auth 200/min）时 register 可能 429：
 * 整体重试（每次换新邮箱，半态残留无害——随机邮箱即弃），20s 间隔最多 6 次。
 */
async function seedFullUser(label: string) {
	let lastError: unknown;
	for (let attempt = 1; attempt <= 8; attempt++) {
		try {
			const seed = await seedRegisterAndLogin(label);
			await seedOnboarding(seed.accessToken, "CNY");
			const txId = await seedTransaction(seed.accessToken, "USD", "777");
			await seedPlanWithAllocation(seed.accessToken, "USD", "500");
			return { seed, txId };
		} catch (error) {
			lastError = error;
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("429")) throw error;
			console.warn(`[T-DATA] seed 被限流（第 ${attempt} 次），30s 后重试`);
			await new Promise((resolve) => setTimeout(resolve, 30_000));
		}
	}
	throw lastError;
}

test.describe("【账号与数据】导出/清空/注销", () => {
	const logger = new TestLogger("account-data");
	let seed: Awaited<ReturnType<typeof seedRegisterAndLogin>>;

	test.beforeAll(async () => {
		logger.log("action", "info", "account-data E2E 开始");
	});

	test.afterAll(async () => {
		await closeDb();
	});

	async function setupPage(
		page: import("@playwright/test").Page,
		token: string,
	) {
		await injectLoginCookie(page.context(), token, BASE_URL);
		page.on("pageerror", (err) =>
			logger.log("action", "error", `PAGEERROR: ${err.message}`),
		);
		page.on("console", (msg) => {
			if (msg.type() === "error")
				logger.log("action", "error", `CONSOLE: ${msg.text()}`);
		});
	}

	/** 走完导出流程到「确认导出」前（intro → verify 已自动填充） */
	async function gotoExportVerifyStep(page: import("@playwright/test").Page) {
		await page.click('[data-testid="account-data-export"]');
		await page.waitForSelector('[data-testid="export-flow-dialog"]');
		await page.click('[data-testid="export-start-verify"]');
		await page.waitForSelector('[data-testid="otp-send-export"]');
		await page.click('[data-testid="otp-send-export"]');
		// mock 模式 devCode 自动填充
		await expect(page.locator('[data-testid="otp-code-input"]')).toHaveValue(
			/^\d{6}$/,
			{ timeout: 15000 },
		);
		await page.click('[data-testid="otp-verify-submit"]');
		await page.waitForSelector('[data-testid="export-confirm-submit"]');
	}

	test("T-DATA-001: 设置页账号与数据区入口启用（无「即将上线」）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：入口启用");
		seed = await seedRegisterAndLogin("entry");
		await seedOnboarding(seed.accessToken, "CNY");
		await setupPage(page, seed.accessToken);

		await page.goto(`${BASE_URL}/settings`);
		await page.waitForLoadState("networkidle");

		const section = page.locator('[data-testid="account-data-section"]');
		await expect(section).toBeVisible();
		// 三入口均可点击
		await expect(
			page.locator('[data-testid="account-data-export"]'),
		).toBeEnabled();
		await expect(
			page.locator('[data-testid="account-data-clear"]'),
		).toBeEnabled();
		await expect(
			page.locator('[data-testid="account-data-delete"]'),
		).toBeEnabled();
		// 不再显示「即将上线」占位
		await expect(section.getByText("即将上线")).toHaveCount(0);
		await saveScreenshot(page, "12-account-data", "T-DATA-001-entries-enabled");
		logger.log("action", "info", "✓ 三入口已启用，无禁用占位");
	});

	test("T-DATA-002: 导出全流程 → 下载入口；重复提交返回同一请求", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：导出全流程");
		const { seed: s } = await seedFullUser("export");
		await setupPage(page, s.accessToken);

		await page.goto(`${BASE_URL}/settings`);
		await page.waitForLoadState("networkidle");

		// 导出：说明 → 验证 → 确认提交
		await page.click('[data-testid="account-data-export"]');
		await page.waitForSelector('[data-testid="export-flow-dialog"]');
		await expect(
			page.locator('[data-testid="export-intro"]').getByText("币种"),
		).toBeVisible();
		await saveScreenshot(page, "12-account-data", "T-DATA-002-01-intro");
		await page.click('[data-testid="export-start-verify"]');
		await page.click('[data-testid="otp-send-export"]');
		await expect(page.locator('[data-testid="otp-code-input"]')).toHaveValue(
			/^\d{6}$/,
			{ timeout: 15000 },
		);
		await saveScreenshot(page, "12-account-data", "T-DATA-002-02-verified");
		await page.click('[data-testid="otp-verify-submit"]');
		await page.waitForSelector('[data-testid="export-confirm-submit"]');
		await page.click('[data-testid="export-confirm-submit"]');

		// 进度卡：已完成 + 下载入口
		await expect(page.locator('[data-testid="request-progress"]')).toBeVisible({
			timeout: 10000,
		});
		await expect(
			page.locator('[data-testid="request-progress-status"]'),
		).toContainText("已完成");
		await expect(
			page.locator('[data-testid="request-download"]'),
		).toBeVisible();
		await saveScreenshot(page, "12-account-data", "T-DATA-002-03-completed");

		// 下载请求返回 200（ZIP）
		const downloadResp = await page.evaluate(async (apiUrl) => {
			const token = document.cookie
				.split("; ")
				.find((row) => row.startsWith("accessToken="))
				?.split("=")[1];
			const res = await fetch(`${apiUrl}/api/data-requests/current`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const body = (await res.json()) as {
				data: { id: string } | null;
			};
			if (!body.data) return { status: 500, viewUrl: "" };
			const dl = await fetch(
				`${apiUrl}${body.data.id ? `/api/data-requests/${body.data.id}/download` : ""}`,
				{ headers: { Authorization: `Bearer ${token}` } },
			);
			return { status: dl.status, viewUrl: body.data.id };
		}, API_URL);
		expect(downloadResp.status).toBe(200);

		// 重复提交导出（新验证码再走一次）→ 后端幂等返回原请求，进度卡仍单个
		// 同邮箱 60s 发码窗口：等窗口翻篇再取第二个验证码
		await page.waitForTimeout(61_000);
		await gotoExportVerifyStep(page);
		await page.click('[data-testid="export-confirm-submit"]');
		await expect(page.locator('[data-testid="request-progress"]')).toHaveCount(
			1,
			{
				timeout: 10000,
			},
		);
		await saveScreenshot(page, "12-account-data", "T-DATA-002-04-idempotent");
		logger.log("action", "info", "✓ 导出完成、可下载、重复提交幂等");
	});

	test("T-DATA-003: 清空流程展示记录数量与不可恢复警示（可先导出）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：清空警示");
		const { seed: s } = await seedFullUser("clear-warn");
		await setupPage(page, s.accessToken);

		await page.goto(`${BASE_URL}/settings`);
		await page.waitForLoadState("networkidle");
		await page.click('[data-testid="account-data-clear"]');
		await page.waitForSelector('[data-testid="clear-flow-dialog"]');

		// 记录数量（1 笔买入 + 1 个计划）与固定警示
		await expect(page.locator('[data-testid="clear-totals"]')).toContainText(
			"买入记录：",
		);
		await expect(page.locator('[data-testid="clear-warning"]')).toContainText(
			"这是删除全部业务记录，不是取消一个计划；删除后不能恢复。",
		);
		// 确认页提示可先导出
		await expect(
			page.locator('[data-testid="clear-flow-dialog"]').getByText("导出"),
		).toBeVisible();
		await saveScreenshot(page, "12-account-data", "T-DATA-003-clear-warning");
		logger.log("action", "info", "✓ 数量与警示可见");
	});

	test("T-DATA-004: 清空请求撤回 → 账本数据仍在、可正常记账", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：清空撤回");
		const { seed: s } = await seedFullUser("clear-cancel");
		await setupPage(page, s.accessToken);

		await page.goto(`${BASE_URL}/settings`);
		await page.waitForLoadState("networkidle");

		// 提交清空
		await page.click('[data-testid="account-data-clear"]');
		await page.waitForSelector('[data-testid="clear-flow-dialog"]');
		await page.click('[data-testid="clear-start-verify"]');
		await page.click('[data-testid="otp-send-clear"]');
		await expect(page.locator('[data-testid="otp-code-input"]')).toHaveValue(
			/^\d{6}$/,
			{ timeout: 15000 },
		);
		await page.click('[data-testid="otp-verify-submit"]');
		await page.waitForSelector('[data-testid="clear-confirm-submit"]');
		await page.click('[data-testid="clear-confirm-submit"]');
		await expect(page.locator('[data-testid="request-progress"]')).toBeVisible({
			timeout: 10000,
		});
		await expect(
			page.locator('[data-testid="request-progress-status"]'),
		).toContainText("已提交");
		await saveScreenshot(page, "12-account-data", "T-DATA-004-01-submitted");

		// 撤回
		await page.click('[data-testid="request-cancel"]');
		await expect(page.locator('[data-testid="request-progress"]')).toHaveCount(
			0,
			{
				timeout: 10000,
			},
		);
		await saveScreenshot(page, "12-account-data", "T-DATA-004-02-cancelled");

		// 账本数据仍在：账户页正常渲染（余额 1000 USD）
		await page.goto(`${BASE_URL}/accounts`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByText("777").first()).toBeVisible();
		logger.log("action", "info", "✓ 撤回成功，账本数据原样");
	});

	test("T-DATA-005: 清空到期推进 → 空账本、本位币不变、新买入以新起点成功", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：清空完成（到期推进）");
		const { seed: s } = await seedFullUser("clear-done");
		await setupPage(page, s.accessToken);

		await page.goto(`${BASE_URL}/settings`);
		await page.waitForLoadState("networkidle");
		await page.click('[data-testid="account-data-clear"]');
		await page.waitForSelector('[data-testid="clear-flow-dialog"]');
		await page.click('[data-testid="clear-start-verify"]');
		await page.click('[data-testid="otp-send-clear"]');
		await expect(page.locator('[data-testid="otp-code-input"]')).toHaveValue(
			/^\d{6}$/,
			{ timeout: 15000 },
		);
		await page.click('[data-testid="otp-verify-submit"]');
		await page.waitForSelector('[data-testid="clear-confirm-submit"]');
		await page.click('[data-testid="clear-confirm-submit"]');
		await expect(page.locator('[data-testid="request-progress"]')).toBeVisible({
			timeout: 10000,
		});

		// 测试钩子：dueAt 置过去 → 刷新页面触发读时惰性推进
		await makeRequestDue(await latestRequestId(s.userId));
		await page.reload();
		await expect(
			page.locator('[data-testid="request-progress-status"]'),
		).toContainText("已完成", { timeout: 15000 });
		await saveScreenshot(page, "12-account-data", "T-DATA-005-01-completed");

		// 空账本：账户页无余额记录
		await page.goto(`${BASE_URL}/accounts`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByText("777")).toHaveCount(0);
		await saveScreenshot(page, "12-account-data", "T-DATA-005-02-empty");

		// 本位币不变（设置页仍为 CNY）且偏好保留
		await page.goto(`${BASE_URL}/settings`);
		await page.waitForLoadState("networkidle");
		await expect(
			page.locator('[data-testid="settings-base-currency"]'),
		).toHaveValue(/CNY/);

		// 新买入以新起点成功（写锁已解除）
		await seedTransaction(s.accessToken, "USD", "999");
		await page.goto(`${BASE_URL}/accounts`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByText("999").first()).toBeVisible();
		await saveScreenshot(page, "12-account-data", "T-DATA-005-03-new-ledger");
		logger.log("action", "info", "✓ 空账本、本位币不变、新起点可记账");
	});

	test("T-DATA-006: 注销提交 → 进度页；撤回期内验证撤回 → 账号恢复", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：注销与撤回");
		const { seed: s } = await seedFullUser("delete");
		await setupPage(page, s.accessToken);

		await page.goto(`${BASE_URL}/settings`);
		await page.waitForLoadState("networkidle");
		await page.click('[data-testid="account-data-delete"]');
		await page.waitForSelector('[data-testid="deletion-flow-dialog"]');
		await page.click('[data-testid="deletion-start-verify"]');
		await page.click('[data-testid="otp-send-deletion"]');
		await expect(page.locator('[data-testid="otp-code-input"]')).toHaveValue(
			/^\d{6}$/,
			{ timeout: 15000 },
		);
		await page.click('[data-testid="otp-verify-submit"]');
		await page.waitForSelector('[data-testid="deletion-confirm-submit"]');
		await page.click('[data-testid="deletion-confirm-submit"]');

		// 提交后被引导至进度页（等待撤回期结束）
		await page.waitForURL(`${BASE_URL}/data-requests`, { timeout: 15000 });
		await expect(
			page.locator('[data-testid="request-progress-status"]'),
		).toContainText("等待撤回期结束");
		await saveScreenshot(page, "12-account-data", "T-DATA-006-01-progress");

		// 业务端点已锁：刷新设置页 → 403 拦截 → 回到进度页
		await page.goto(`${BASE_URL}/settings`);
		await page.waitForURL(`${BASE_URL}/data-requests`, { timeout: 15000 });

		// 撤回注销：验证邮箱＋点击（同邮箱 60s 发码窗口：距提交发码已近，等窗口翻篇）
		await page.waitForTimeout(61_000);
		await page.click('[data-testid="request-cancel"]');
		await page.waitForSelector('[data-testid="deletion-cancel-dialog"]');
		await page.click('[data-testid="otp-send-deletion"]');
		await expect(page.locator('[data-testid="otp-code-input"]')).toHaveValue(
			/^\d{6}$/,
			{ timeout: 15000 },
		);
		await page.click('[data-testid="otp-verify-submit"]');
		await expect(page.locator('[data-testid="request-progress"]')).toHaveCount(
			0,
			{
				timeout: 10000,
			},
		);
		await saveScreenshot(page, "12-account-data", "T-DATA-006-02-restored");

		// 账号恢复：业务端点放行
		await page.goto(`${BASE_URL}/accounts`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByText("777").first()).toBeVisible();
		logger.log("action", "info", "✓ 注销撤回，账号恢复可用");
	});

	test("T-DATA-007: 用途隔离——导出验证填登录用途验证码 → 提示无效", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：用途隔离");
		const { seed: s } = await seedFullUser("purpose");
		await setupPage(page, s.accessToken);

		await page.goto(`${BASE_URL}/settings`);
		await page.waitForLoadState("networkidle");
		// 先在页面发「导出用途」码（占用 60s 目标窗口），再补取一个「登录用途」码
		// 覆盖输入框（登录码不能顶导出用；顺序避免同邮箱 60s 单次发码限流）
		const loginCode = await (async () => {
			await page.click('[data-testid="account-data-export"]');
			await page.waitForSelector('[data-testid="export-flow-dialog"]');
			await page.click('[data-testid="export-start-verify"]');
			await page.waitForSelector('[data-testid="otp-send-export"]');
			await page.click('[data-testid="otp-send-export"]');
			await expect(page.locator('[data-testid="otp-code-input"]')).toHaveValue(
				/^\d{6}$/,
				{ timeout: 15000 },
			);
			await page.waitForTimeout(61_000); // 同邮箱 60s 发码窗口翻篇
			return fetchDevCode(s.email, "LOGIN");
		})();
		await page.fill('[data-testid="otp-code-input"]', loginCode.devCode ?? "");

		// 提交。后端安全模型为「同邮箱单活跃验证码」：发 LOGIN 码时同邮箱旧 challenge
		// 全部作废（otp.service sendCode consumedAt 顶替，不分用途），故导出 challenge
		// 已被作废，data-request 用途校验通过后消费阶段返回 409「验证码已经使用过」。
		// 用例断言真实拒绝行为：提示出现且弹窗未关（登录码绝不能通过导出验证）。
		await page.click('[data-testid="otp-verify-submit"]');
		await expect(
			page.getByText(/用途不匹配|验证码无效|已经使用过/).first(),
		).toBeVisible({ timeout: 10000 });
		await saveScreenshot(
			page,
			"12-account-data",
			"T-DATA-007-purpose-mismatch",
		);
		logger.log("action", "info", "✓ 登录用途验证码被拒绝（UI 层）");

		// API 层：用途隔离精确语义。LOGIN challenge 直接提交导出验证 →
		// 用途先行校验（不消费、不累计尝试）→ 403 VERIFICATION_PURPOSE_MISMATCH。
		const verifyRes = await fetch(`${lanApiUrl()}/api/data-requests/verify`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${s.accessToken}`,
			},
			body: JSON.stringify({
				challengeId: loginCode.challengeId,
				purpose: "EXPORT",
				code: loginCode.devCode ?? "",
			}),
		});
		const verifyJson = (await verifyRes.json()) as {
			code?: string;
			message?: string;
		};
		expect(verifyRes.status).toBe(403);
		expect(verifyJson.code).toBe("VERIFICATION_PURPOSE_MISMATCH");
		logger.log(
			"action",
			"info",
			"✓ 登录用途 challenge 提交导出验证 → PURPOSE_MISMATCH（API 层）",
		);
	});

	test("T-DATA-008: 清空请求期间锁写 → 操作被引导至进度页", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：锁写体验");
		const { seed: s } = await seedFullUser("lock");
		await setupPage(page, s.accessToken);

		await page.goto(`${BASE_URL}/settings`);
		await page.waitForLoadState("networkidle");

		// 提交清空（保持 PENDING）
		await page.click('[data-testid="account-data-clear"]');
		await page.waitForSelector('[data-testid="clear-flow-dialog"]');
		await page.click('[data-testid="clear-start-verify"]');
		await page.click('[data-testid="otp-send-clear"]');
		await expect(page.locator('[data-testid="otp-code-input"]')).toHaveValue(
			/^\d{6}$/,
			{ timeout: 15000 },
		);
		await page.click('[data-testid="otp-verify-submit"]');
		await page.waitForSelector('[data-testid="clear-confirm-submit"]');
		await page.click('[data-testid="clear-confirm-submit"]');
		await expect(page.locator('[data-testid="request-progress"]')).toBeVisible({
			timeout: 10000,
		});

		// 清空期间修改偏好（PATCH /settings 非白名单）→ 403 锁 → 前端引导至进度页
		await page.goto(`${BASE_URL}/settings`);
		await page.waitForLoadState("networkidle");
		await selectRadixOption(
			page,
			page.locator('[data-testid="prep-preference-select"]'),
			"安心",
		);
		await page.click('[data-testid="settings-save"]');
		await page.waitForURL(`${BASE_URL}/data-requests`, { timeout: 15000 });
		await expect(
			page.locator('[data-testid="request-progress"]'),
		).toBeVisible();
		await saveScreenshot(page, "12-account-data", "T-DATA-008-redirected");
		logger.log("action", "info", "✓ 锁写操作被引导至进度页");
	});
});
