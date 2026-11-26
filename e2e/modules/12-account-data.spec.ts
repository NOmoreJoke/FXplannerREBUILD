import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import {
	buildApiUrl,
	localFetch,
	resolveApiBase,
} from "../helpers/api-url";
import {
	api,
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
 * - T-DATA-002 导出全流程（个人域）→ 下载入口；重复提交同一请求；另先核对组织导出
 *   弹窗如实说明账本字段（W26/W28 双域拆分：个人导出不含账本，「币种」只在组织导出里）
 * - T-DATA-003 清空警示：记录数量 + 不可恢复警示 + 可先导出
 * - T-DATA-004 清空撤回：撤回后账本数据仍在、可正常记账
 * - T-DATA-005 清空完成：到期推进（DB 钩子）→ 空账本、本位币不变、新买入以新起点成功
 * - T-DATA-006 注销与撤回：唯一所有者被 409 LAST_OWNER_REQUIRED 阻断；转移所有权后
 *   提交→进度页→撤回期内验证撤回→账号恢复
 * - T-DATA-007 用途隔离：导出验证中填登录用途验证码 → 被拒（UI 层）+ 登录用途
 *   challenge 提交导出验证 → 403 VERIFICATION_PURPOSE_MISMATCH（API 层，用途先行校验）
 * - T-DATA-008 锁写体验：清空请求期间保存偏好 → 被引导至进度页
 *
 * 验证码经 mock 渠道 devCode 自动填充（未配置 Resend 时 dev 自动开启）。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";
const API_URL = resolveApiBase(process.env.API_URL, "http://localhost:4001");
/**
 * Node 侧直连后端用的回环地址（替代此前的 LAN IP 取址）。改用 127.0.0.1 是为了绕开
 * TUN / 虚拟网卡：os.networkInterfaces() 的首个非回环 IPv4 在开着 TUN 时是 utun 的
 * 198.18.0.1，连上去直接 SocketError；127.0.0.1 永不经过虚拟网卡。
 * 页面请求与这里的请求可能落在同一个 OTP_IP 频控桶：同 IP 上限的放宽依赖
 * e2e/scripts/run-e2e-tests.sh 注入的 OTP_IP_MAX_REQUESTS=200（不经脚本单跑时是默认值）。
 */
const LOOPBACK_API_URL = API_URL.replace("localhost", "127.0.0.1");

/** 个人域请求创建（POST /api/data-requests）的响应匹配器 */
function isPersonalDataRequestCreate(
	response: import("@playwright/test").Response,
): boolean {
	return (
		response.request().method() === "POST" &&
		new URL(response.url()).pathname === "/api/data-requests"
	);
}

/** 走后端 API 直接发验证码（用途隔离用例取 LOGIN 用途 devCode） */
async function fetchDevCode(
	email: string,
	purpose?: string,
): Promise<{ challengeId: string; devCode?: string }> {
	const res = await localFetch(
		buildApiUrl(LOOPBACK_API_URL, "/api/auth/otp/send-code"),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ channel: "email", target: email, purpose }),
		},
	);
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

/** 服务端 id（cuid）与邀请 token（base64url）进路径 / 请求体前的形状白名单 */
const SERVER_ID_SHAPE = /^[A-Za-z0-9]{1,64}$/;
const INVITATION_TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

function assertShape(value: string, pattern: RegExp, label: string): string {
	if (!pattern.test(value)) {
		throw new Error(`${label} 形状非法：${value}`);
	}
	return value;
}

/**
 * 把 owner 在其唯一组织里的所有权转给 successor（T-DATA-006 前置，全部走真实组织 API）：
 * 邀请（一次性 token 仅创建响应出现）→ 受邀者接受（返回其 Membership id）→ 转交所有权
 * （原 Owner 降为 ADMIN）。组织管理端点挂严格守卫，必须带 X-Organization-Id——
 * 造数 api() 缺省不带头，故显式传入。
 *
 * 可重入（Playwright 重试复用同一批用户）：已转交（原 Owner 已是 ADMIN）直接返回；
 * 上次中断在「已邀请未接受」→ 撤回旧邀请重建（reused=true 不重发 token）；
 * 中断在「已接受未转交」→ 受邀者已是有效成员，跳过邀请与接受。
 */
async function handOverOwnership(
	owner: Awaited<ReturnType<typeof seedRegisterAndLogin>>,
	successor: Awaited<ReturnType<typeof seedRegisterAndLogin>>,
): Promise<void> {
	const organizations = await api<{ id: string; role: string }[]>(
		"/api/organizations",
		{ method: "GET", token: owner.accessToken },
	);
	// owner 刚注册：名下只有注册兜底建的那个组织（恰好一个，无需挑选）
	expect(organizations).toHaveLength(1);
	const organization = organizations[0];
	if (!organization) throw new Error("handOverOwnership：owner 名下没有组织");
	if (organization.role !== "OWNER") return;
	const headers = {
		"X-Organization-Id": assertShape(
			organization.id,
			SERVER_ID_SHAPE,
			"组织 id",
		),
	};
	const members = await api<{ id: string; userId: string; status: string }[]>(
		"/api/organizations/current/members",
		{ method: "GET", token: owner.accessToken, headers },
	);
	const activeMembership = members.find(
		(member) => member.userId === successor.userId && member.status === "ACTIVE",
	);
	let targetMembershipId = activeMembership?.id;
	if (!targetMembershipId) {
		const createInvitation = () =>
			api<{ id: string; token: string }>(
				"/api/organizations/current/invitations",
				{
					method: "POST",
					token: owner.accessToken,
					headers,
					body: { email: successor.email, role: "ADMIN" },
				},
			);
		let invitation = await createInvitation();
		if (!invitation.token) {
			await api(
				`/api/organizations/current/invitations/${assertShape(invitation.id, SERVER_ID_SHAPE, "邀请 id")}`,
				{ method: "DELETE", token: owner.accessToken, headers },
			);
			invitation = await createInvitation();
		}
		const token = assertShape(
			invitation.token,
			INVITATION_TOKEN_SHAPE,
			"邀请 token",
		);
		const accepted = await api<{ membershipId: string }>(
			`/api/organization-invitations/${token}/accept`,
			{ method: "POST", token: successor.accessToken },
		);
		targetMembershipId = accepted.membershipId;
	}
	// 路径与前端 organizations.ts transferOwnership、openapi.json 一致
	// （member.controller：@Controller("organizations") + @Post("current/transfer-ownership")）
	await api("/api/organizations/current/transfer-ownership", {
		method: "POST",
		token: owner.accessToken,
		headers,
		body: {
			targetMembershipId: assertShape(
				targetMembershipId,
				SERVER_ID_SHAPE,
				"成员关系 id",
			),
		},
	});
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

	test("T-DATA-002: 组织导出说明如实列账本字段；个人导出全流程 → 下载入口；重复提交返回同一请求", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：导出全流程");
		const { seed: s } = await seedFullUser("export");
		await setupPage(page, s.accessToken);

		await page.goto(`${BASE_URL}/settings`);
		await page.waitForLoadState("networkidle");

		// W26/W28 双域拆分：账本字段（「币种」）只属于组织账本导出。先核对组织导出弹窗
		// 如实说明账本字段（入口按 data.export 能力显隐；owner 可见）
		await page.click('[data-testid="organization-data-export"]');
		await page.waitForSelector('[data-testid="export-flow-dialog"]');
		const organizationIntro = page.locator('[data-testid="export-intro"]');
		await expect(organizationIntro.getByText("币种")).toBeVisible();
		await expect(
			organizationIntro.getByText("导出包将包含当前组织的以下数据："),
		).toBeVisible();
		await saveScreenshot(
			page,
			"12-account-data",
			"T-DATA-002-00-organization-intro",
		);
		// 取消：这一步只核对说明文案，不提交组织导出
		await page
			.locator('[data-testid="export-flow-dialog"]')
			.getByRole("button", { name: "取消", exact: true })
			.click();
		await expect(page.locator('[data-testid="export-flow-dialog"]')).toHaveCount(
			0,
		);

		// 个人导出：说明 → 验证 → 确认提交（个人数据副本，不含任何组织的账本明细）
		await page.click('[data-testid="account-data-export"]');
		await page.waitForSelector('[data-testid="export-flow-dialog"]');
		const personalIntro = page.locator('[data-testid="export-intro"]');
		await expect(personalIntro.getByText("账号资料")).toBeVisible();
		// 个人导出不包含账本字段
		await expect(personalIntro.getByText("币种")).toHaveCount(0);
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

		// 个人域端点（不带组织头）：当前请求与下载均返回 200（ZIP）
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
			if (!body.data) return { currentStatus: res.status, status: 500, viewUrl: "" };
			// 路径参数先过形状白名单再拼接（服务端 id 为 cuid；防路径注入，静态
			// 污点分析也据此认可「校验 → 拼 URL」链路）
			const requestId = body.data.id;
			if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
				return { currentStatus: res.status, status: 500, viewUrl: "" };
			}
			const dl = await fetch(
				`${apiUrl}/api/data-requests/${requestId}/download`,
				{ headers: { Authorization: `Bearer ${token}` } },
			);
			return { currentStatus: res.status, status: dl.status, viewUrl: requestId };
		}, API_URL);
		expect(downloadResp.currentStatus).toBe(200);
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

	test("T-DATA-006: 唯一所有者注销被阻断；转移所有权后注销提交 → 进度页；撤回期内验证撤回 → 账号恢复", async ({
		page,
		browser,
	}) => {
		logger.log("action", "info", "开始：注销与撤回");
		const { seed: s } = await seedFullUser("delete");

		// ① 唯一所有者保护（W26）：本人仍是某组织唯一所有者时，个人注销被后端 409
		// LAST_OWNER_REQUIRED 拒绝，对话框内列出阻塞组织与处置入口。用独立用户验证，
		// 不占用 s 的同邮箱 60s 发码窗口（主流程随后还要发码）
		const sole = await seedRegisterAndLogin("delete-blocked");
		await seedOnboarding(sole.accessToken, "CNY");
		const soleContext = await browser.newContext();
		const solePage = await soleContext.newPage();
		try {
			await setupPage(solePage, sole.accessToken);
			await solePage.goto(`${BASE_URL}/settings`);
			await solePage.waitForLoadState("networkidle");
			await solePage.click('[data-testid="account-data-delete"]');
			await solePage.waitForSelector('[data-testid="deletion-flow-dialog"]');
			await solePage.click('[data-testid="deletion-start-verify"]');
			await solePage.click('[data-testid="otp-send-deletion"]');
			await expect(solePage.locator('[data-testid="otp-code-input"]')).toHaveValue(
				/^\d{6}$/,
				{ timeout: 15000 },
			);
			await solePage.click('[data-testid="otp-verify-submit"]');
			await solePage.waitForSelector('[data-testid="deletion-confirm-submit"]');
			const [rejected] = await Promise.all([
				solePage.waitForResponse(isPersonalDataRequestCreate),
				solePage.click('[data-testid="deletion-confirm-submit"]'),
			]);
			expect(rejected.status()).toBe(409);
			expect(await rejected.json()).toMatchObject({
				code: "LAST_OWNER_REQUIRED",
			});
			const blockedPanel = solePage.locator('[data-testid="deletion-blocked"]');
			await expect(blockedPanel).toBeVisible();
			await expect(blockedPanel).toContainText("暂时无法注销账号");
			// 阻塞组织与直达处置入口：唯一所有者的个人工作台，恰好 1 个
			await expect(
				solePage.locator('[data-testid="blocking-organization-row"]'),
			).toHaveCount(1);
			await expect(
				solePage.locator('[data-testid="blocking-organization-link"]'),
			).toBeVisible();
			await saveScreenshot(
				solePage,
				"12-account-data",
				"T-DATA-006-00-sole-owner-blocked",
			);
			logger.log("action", "info", "✓ 唯一所有者注销被 409 阻断并列出处置入口");
		} finally {
			await soleContext.close();
		}

		// ② 解除主用户的唯一所有者阻塞：邀请第二名用户加入并把所有权转交出去（真实组织
		// API）。s 降为 ADMIN——仍是成员、共享账本不受影响，但不再是唯一所有者
		const successor = await seedRegisterAndLogin("delete-successor");
		await handOverOwnership(s, successor);
		const [organizationAfter] = await api<{ role: string }[]>(
			"/api/organizations",
			{ method: "GET", token: s.accessToken },
		);
		expect(organizationAfter?.role).toBe("ADMIN");

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

		// 账号恢复：业务端点放行；组织的共享账本 777 USD 原样（注销个人账号不触碰组织账本）
		await page.goto(`${BASE_URL}/accounts`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByText("777").first()).toBeVisible();
		logger.log("action", "info", "✓ 注销撤回，账号恢复可用，共享账本完好");
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
		const verifyRes = await localFetch(
			buildApiUrl(LOOPBACK_API_URL, "/api/data-requests/verify"),
			{
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
			},
		);
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
