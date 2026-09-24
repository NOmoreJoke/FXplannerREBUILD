import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import { injectLoginCookie, seedRegisterAndLogin } from "../helpers/api-seeder";

/**
 * AI 助手 E2E（changes/ai-assistant/技术方案.md §3.2 / §8.3）
 *
 * 覆盖断言点（方案 §3.2：会话列表/新建/切换/删除、发送→流式回复→落库、
 * 多轮追问、流式中停止；§8.3 场景 1~4）：
 * - T-AI-001: 菜单可达——侧边栏「AI 助手」（NAV_ITEMS「汇率行情」后）→ /chat 渲染（空态）
 * - T-AI-002: 发送→流式回复→落库——用户气泡立即出现；流式光标出现后消失；
 *             最终回复与假流固定文案一致；会话列表出现该会话（done → invalidate）
 * - T-AI-003: 持久化与多轮追问——刷新后会话/消息完整；追问后 4 条消息；
 *             再刷新仍 4 条（落库闭环）
 * - T-AI-004: 新建与删除会话——新建（标题 = 首条消息前 20 字截断）→ 切换 →
 *             删除（确认弹窗）→ 列表消失 → 刷新后仍不出现
 * - T-AI-005: XSS 冒烟 + 流式中停止——XSS 载荷按纯文本渲染（DOM 无 script/img）；
 *             流式光标出现后点停止 → 输入框恢复、助手完整回复不出现、刷新后未落库
 * - T-AI-006: 切换模型发送与持久化（ai-model-whitelist 方案 §8.3 场景 6）——
 *             下拉列出 5 个白名单模型；默认项 GPT-4.1 Mini；选 GPT-5.5 后追问；
 *             气泡角标显示 GPT-5.5；刷新后角标仍在（落库回读）、选择器仍 GPT-5.5（persist）
 * - T-AI-007: 白名单缩编自愈（§8.3 场景 7，0 发送）——localStorage 预写非法 key
 *             （gpt-4o）→ 加载后选择器回退默认 GPT-4.1 Mini、store 自愈为 null
 *
 * 环境开关（方案 §5.3）：后端以 AI_E2E_FAKE_STREAM=true 启动（run-e2e-tests.sh 注入
 * AI_E2E_FAKE_STREAM/AI_PROVIDER_AIGYSD_API_KEY/AI_E2E_FAKE_INTERVAL_MS），LlmFactory 切换官方
 * FakeStreamingChatModel——真链路（前端 → 后端 SSE → fake LLM）零外呼。
 * ReAct 工具环与上下文窗口等真实链路语义由 §8.2 集成测试覆盖，E2E 不重复。
 *
 * 限流预算：AI 发消息端点路由级 @Throttle 硬编码 5/min/IP（ai.controller.ts
 * AI_SEND_THROTTLE，不受脚本 env 放大影响；新建与追问两端点分别计数）→
 * 全 spec 新建端点 4 次（T-AI-002/003/004/005）+ 追问端点 1 次（T-AI-006），
 * 各路由均在预算内，为失败重试（retries=1）留余量。
 * 帧间隔由脚本注入 AI_E2E_FAKE_INTERVAL_MS=80：固定回复 38 字符 × 80ms ≈ 3s
 * 流窗口，保证「光标出现→点停止」的时序余量；用例内不做时间敏感硬断言（§8.3）。
 *
 * 前置：seedRegisterAndLogin（保护区守卫只看 token，无需 onboarding/业务数据），
 * 登录态 cookie 注入。
 */

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";

/**
 * 假流式模型的固定回复副本（来源：services/chat/src/ai/llm/llm-factory.ts
 * E2E_FAKE_REPLY；独立成包不跨引用，改动上游时必须同步此处）。
 */
const E2E_FAKE_REPLY =
	"这是来自 FXPlanner 假流式模型的测试回复。\n第二行内容用于验证多行流式输出。";

/** 流式光标（message-bubble 流式气泡尾部，globals.css .chat-streaming-caret） */
const CARET = ".chat-streaming-caret";

/**
 * 隐藏 dev 环境 TanStack Query Devtools 悬浮层（react-query-provider.tsx dev-only 渲染）：
 * 其 fixed 容器（.tsqd-parent-container）会拦截底部输入区按钮的点击（环境噪音，
 * 非业务交互路径），纯样式隔离、不影响业务功能。
 */
async function hideQueryDevtools(page: Page): Promise<void> {
	await page.addStyleTag({
		content: ".tsqd-parent-container { display: none !important; }",
	});
}

/** 登录态 + 打开 /chat 并等待页面就绪（各用例共用入口；goto 即重置为新建视图） */
async function openChat(page: Page, accessToken: string): Promise<void> {
	await injectLoginCookie(page.context(), accessToken, BASE_URL);
	// dev 模式下部分页面 load 事件不稳定，统一 domcontentloaded + 显式断言驱动等待
	await page.goto(`${BASE_URL}/chat`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("chat-page")).toBeVisible();
	await hideQueryDevtools(page);
}

/** 刷新（addStyleTag 随 document 重建失效，需重新注入 devtools 隐藏样式） */
async function reloadChat(page: Page): Promise<void> {
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("chat-page")).toBeVisible();
	await hideQueryDevtools(page);
}

/** 会话列表中标题含指定文本的会话按钮（testid = conversation-<动态 id>，按文本定位） */
function conversationItem(page: Page, titlePart: string) {
	return page
		.getByTestId("conversation-list")
		.locator('button[data-testid^="conversation-"]')
		.filter({ hasText: titlePart });
}

/** 填入内容并发送（输入框 fill 后发送钮 enable，click 触发 onSend） */
async function sendMessage(page: Page, content: string): Promise<void> {
	await page.getByTestId("chat-input").fill(content);
	await page.getByTestId("chat-send").click();
}

// ── 用例 ───────────────────────────────────────────────────────────────────

test.describe("【AI 助手】菜单 / 流式 / 持久化 / 会话管理 / XSS 与停止", () => {
	const logger = new TestLogger("ai-chat");
	let seed: Awaited<ReturnType<typeof seedRegisterAndLogin>>;

	test.beforeAll(async () => {
		seed = await seedRegisterAndLogin("ai-chat");
		logger.log("action", "info", `✓ 造数完成 userId=${seed.userId}`);
	});

	test("T-AI-001: 菜单可达（侧边栏「AI 助手」在「汇率行情」后 → /chat 空态渲染）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：菜单可达");
		logger.setupPageListeners(page);

		await injectLoginCookie(page.context(), seed.accessToken, BASE_URL);
		// 先直达 /chat 预热 dev 按需编译（首次点击菜单触发编译可达 30s+，属环境
		// 噪音；预热后菜单导航断言的才是纯 SPA 路由行为），顺带覆盖直达 URL 可达
		await page.goto(`${BASE_URL}/chat`, { waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("chat-page")).toBeVisible({
			timeout: 60000,
		});
		await hideQueryDevtools(page);
		await page.goto(`${BASE_URL}/settings`, { waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("chat-page")).toHaveCount(0);

		// 侧边栏菜单项存在、label 正确，且紧跟「汇率行情」之后（NAV_ITEMS 顺序）
		const menuItem = page.locator('aside a[href="/chat"]');
		await expect(menuItem).toBeVisible();
		await expect(menuItem).toHaveText(/AI 助手/);
		const hrefs = await page
			.locator("aside")
			.locator("a")
			.evaluateAll((els) => els.map((el) => el.getAttribute("href")));
		expect(hrefs.indexOf("/chat")).toBe(hrefs.indexOf("/market") + 1);

		// 从相邻页经菜单点击进入 /chat，页面渲染（不白屏）
		await menuItem.click();
		await expect.poll(() => page.url(), { timeout: 10000 }).toContain("/chat");
		await expect(page.getByTestId("chat-page")).toBeVisible();
		await expect(menuItem).toHaveAttribute("aria-current", "page");
		await saveScreenshot(page, "14-ai-chat", "T-AI-001-01-menu-active");

		// 新用户空态：会话列表「暂无会话」+ 对话区空态提示
		await expect(page.getByTestId("conversation-list")).toContainText(
			"暂无会话",
		);
		await expect(page.getByTestId("message-empty")).toBeVisible();
		await saveScreenshot(page, "14-ai-chat", "T-AI-001-02-empty-state");

		await logger.saveToFile();
	});

	test("T-AI-002: 发送→流式回复→落库（用户气泡立即出现，光标出现后消失，回复全文一致，列表出会话）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：发送与流式回复");
		logger.setupPageListeners(page);

		await openChat(page, seed.accessToken);

		sendMessage(page, "你好");

		// 用户气泡立即出现（乐观插入，先于助手回复）
		await expect(page.getByTestId("message-user")).toHaveText("你好");

		// 流式指示出现（fake 流 ~3s 窗口）后消失（§8.3 主断言：出现→消失）
		await expect(page.locator(CARET).first()).toBeVisible();
		await saveScreenshot(page, "14-ai-chat", "T-AI-002-01-streaming-caret");
		await expect(page.locator(CARET)).toHaveCount(0);

		// 最终完整回复与假流固定文案一致（流式气泡与落库气泡过渡期取最后一个）
		// toContainText（非全文相等）：assistant 气泡内含模型角标后缀（§5.2 message-bubble）
		await expect(page.getByTestId("message-assistant").last()).toContainText(
			E2E_FAKE_REPLY,
		);
		// 角标：done 帧 model= 默认 key（未选模型走服务端回退）→ 显示 displayName
		await expect(
			page.getByTestId("message-model").filter({ hasText: "GPT-4.1 Mini" }),
		).toHaveCount(1);
		await saveScreenshot(page, "14-ai-chat", "T-AI-002-02-final-reply");

		// 落库刷新：done → invalidate → 会话列表出现该会话（短消息标题不截断）
		await expect(conversationItem(page, "你好")).toBeVisible();

		// 输入框恢复可用（流式中禁发解除：停止钮换回发送钮）
		await expect(page.getByTestId("chat-send")).toBeVisible();

		await logger.saveToFile();
	});

	test("T-AI-003: 持久化与多轮追问（刷新后会话/消息完整，追问后 4 条，再刷新仍 4 条）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：持久化与多轮追问");
		logger.setupPageListeners(page);

		await openChat(page, seed.accessToken);

		// 刷新（zustand 内存态重置为新建视图）后会话列表含 T-AI-002 的会话
		const convA = conversationItem(page, "你好");
		await expect(convA).toBeVisible();

		// 切换到该会话：消息完整（1 问 1 答）
		await convA.click();
		await expect(page.getByTestId("message-user")).toHaveCount(1);
		await expect(page.getByTestId("message-assistant")).toHaveCount(1);
		// toContainText（非全文相等）：assistant 气泡内含模型角标后缀（§5.2 message-bubble）
		await expect(page.getByTestId("message-assistant").last()).toContainText(
			E2E_FAKE_REPLY,
		);
		await saveScreenshot(page, "14-ai-chat", "T-AI-003-01-restored");

		// 多轮追问（假模型回复固定 → 断言消息序列而非内容；上下文窗口归 §8.2 集成测试）
		sendMessage(page, "第二轮追问：请继续");
		await expect(page.getByTestId("message-user")).toHaveCount(2);
		await expect(page.locator(CARET)).toHaveCount(0);
		await expect(page.getByTestId("message-assistant")).toHaveCount(2);
		await saveScreenshot(page, "14-ai-chat", "T-AI-003-02-follow-up");

		// 落库闭环：再次刷新后 4 条消息全在
		await reloadChat(page);
		await expect(convA).toBeVisible();
		await convA.click();
		await expect(page.getByTestId("message-user")).toHaveCount(2);
		await expect(page.getByTestId("message-assistant")).toHaveCount(2);

		await logger.saveToFile();
	});

	test("T-AI-004: 新建与删除会话（标题 20 字截断，切换独立，确认弹窗删除后消失）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：新建与删除会话");
		logger.setupPageListeners(page);

		await openChat(page, seed.accessToken);

		// 新建对话（可能已在新建视图，重复点击无害）：空态
		const LONG = "这是一条用来验证标题截断逻辑的长消息，长度超过二十个字符";
		await page.getByTestId("new-conversation").click();
		await expect(page.getByTestId("message-empty")).toBeVisible();

		// 发长消息建会话 B：标题 = 首条消息前 20 字（服务端截断）
		sendMessage(page, LONG);
		await expect(page.getByTestId("message-user")).toHaveText(LONG);
		await expect(page.locator(CARET)).toHaveCount(0);
		// toContainText（非全文相等）：assistant 气泡内含模型角标后缀（§5.2 message-bubble）
		await expect(page.getByTestId("message-assistant").last()).toContainText(
			E2E_FAKE_REPLY,
		);
		const truncatedTitle = LONG.slice(0, 20);
		const convB = conversationItem(page, truncatedTitle);
		await expect(convB).toBeVisible();
		await convB.hover();
		await expect(convB).toHaveAttribute("title", truncatedTitle);
		await saveScreenshot(page, "14-ai-chat", "T-AI-004-01-truncated-title");

		// 切走再切回：会话 B 独立（新建视图空态 → B 消息恢复）
		await page.getByTestId("new-conversation").click();
		await expect(page.getByTestId("message-empty")).toBeVisible();
		await convB.click();
		await expect(page.getByTestId("message-user")).toHaveText(LONG);

		// 删除会话 B：行内删除按钮（hover 显现）→ 确认弹窗 → 确认删除
		const rowB = convB.locator("xpath=..");
		await rowB.hover();
		await rowB
			.getByRole("button", { name: `删除会话 ${truncatedTitle}` })
			.click();
		await expect(page.getByText("确认删除这个会话？")).toBeVisible();
		await saveScreenshot(page, "14-ai-chat", "T-AI-004-02-delete-confirm");
		await page.getByRole("button", { name: "确认删除" }).click();

		// B 从列表消失，删除当前会话后回到新建视图（空态）
		await expect(convB).toHaveCount(0);
		await expect(page.getByTestId("message-empty")).toBeVisible();

		// 刷新后仍不出现（物理删除，所有入口不可见），其他会话不受影响
		await reloadChat(page);
		await expect(convB).toHaveCount(0);
		await expect(conversationItem(page, "你好")).toBeVisible();
		await saveScreenshot(page, "14-ai-chat", "T-AI-004-03-after-refresh");

		await logger.saveToFile();
	});

	test("T-AI-005: XSS 冒烟 + 流式中停止（纯文本渲染无 script/img，停止后回复不落库）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：XSS 冒烟与流式中停止");
		logger.setupPageListeners(page);

		await openChat(page, seed.accessToken);

		// XSS 载荷（赋值表达式而非 alert，避免 dialog 挂起；< 2000 字上限）
		const xssPayload =
			'<img src=x onerror="window.__e2eXss=1"><script>window.__e2eXss=2</script>';
		sendMessage(page, xssPayload);

		// 用户消息按纯文本渲染（React 转义）：气泡文本 = 原文
		await expect(page.getByTestId("message-user")).toHaveText(xssPayload);

		// DOM 中无 script / img 元素（若被当 HTML 注入会创建元素并触发 onerror）
		await expect(
			page.getByTestId("message-list").locator("script, img"),
		).toHaveCount(0);
		const xssProbe = await page.evaluate(
			() => (window as unknown as { __e2eXss?: number }).__e2eXss,
		);
		expect(xssProbe).toBeUndefined();
		await saveScreenshot(page, "14-ai-chat", "T-AI-005-01-xss-escaped");

		// 流式光标出现后点停止（§3.2 断言点：流式中停止）
		await expect(page.locator(CARET).first()).toBeVisible();
		await saveScreenshot(page, "14-ai-chat", "T-AI-005-02-stop-streaming");
		await page.getByTestId("chat-stop").click();

		// 输入框立即恢复：停止钮换回发送钮
		await expect(page.getByTestId("chat-send")).toBeVisible();

		// 负向等待覆盖假流总时长（38 字 × 80ms ≈ 3s + abort 透传余量）：
		// 若中断失败，流会在此窗口内完成并出现完整回复 → 断言失败
		await expect(
			page.getByTestId("message-assistant").filter({ hasText: E2E_FAKE_REPLY }),
		).toHaveCount(0, { timeout: 5000 });
		await expect(
			page.getByTestId("message-list").locator("script, img"),
		).toHaveCount(0);

		// 中止语义落库验证（§1.2：助手消息只在流式成功后落库）：刷新后仅用户消息
		const convXss = conversationItem(page, xssPayload.slice(0, 20));
		await expect(convXss).toBeVisible();
		await reloadChat(page);
		await expect(convXss).toBeVisible();
		await convXss.click();
		await expect(page.getByTestId("message-user")).toHaveCount(1);
		await expect(page.getByTestId("message-assistant")).toHaveCount(0);
		await saveScreenshot(page, "14-ai-chat", "T-AI-005-03-not-persisted");

		await logger.saveToFile();
	});

	test("T-AI-006: 切换模型发送与持久化（下拉 5 模型 → GPT-5.5 追问 → 角标 + persist）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：切换模型发送与持久化");
		logger.setupPageListeners(page);

		await openChat(page, seed.accessToken);

		// 打开 T-AI-002 的会话（标题 = 用户消息前 20 字「你好」）：追问走 POST /:id/messages（与新建端点限流分别计数，§8.3）
		const conv = conversationItem(page, "你好");
		await expect(conv).toBeVisible();
		await conv.click();
		await expect(page.getByTestId("message-assistant").first()).toBeVisible();

		// 默认项断言：未选择时触发器显示列表首项 = 服务端默认 GPT-4.1 Mini
		const trigger = page.getByTestId("model-selector-trigger");
		await expect(trigger).toHaveText(/GPT-4\.1 Mini/);

		// 下拉列出 5 个白名单模型（§4.1 出参全量）
		await trigger.click();
		await expect(page.getByTestId("model-selector-item")).toHaveCount(5);
		await saveScreenshot(page, "14-ai-chat", "T-AI-006-01-dropdown");

		// 选择 GPT-5.5 → 触发器切换；追问发送
		await page
			.locator('[data-testid="model-selector-item"][data-model-key="gpt-5.5"]')
			.click();
		await expect(trigger).toHaveText(/GPT-5\.5/);
		await sendMessage(page, "追问：这条消息应该使用 GPT-5.5 回答");
		await expect(
			page
				.getByTestId("message-assistant")
				.filter({ hasText: E2E_FAKE_REPLY })
				.last(),
		).toBeVisible();

		// 角标：done 帧 model= gpt-5.5 → 本条气泡显示 displayName「GPT-5.5」（恰 1 条，
		// 历史消息角标为默认模型）；刷新后仍在（落库回读）且选择器仍停留 GPT-5.5（persist）
		await expect(
			page.getByTestId("message-model").filter({ hasText: "GPT-5.5" }),
		).toHaveCount(1);
		await saveScreenshot(page, "14-ai-chat", "T-AI-006-02-model-badge");
		await reloadChat(page);
		await expect(conv).toBeVisible();
		await conv.click();
		await expect(
			page.getByTestId("message-model").filter({ hasText: "GPT-5.5" }),
		).toHaveCount(1);
		await expect(trigger).toHaveText(/GPT-5\.5/);
		await saveScreenshot(page, "14-ai-chat", "T-AI-006-03-persisted");

		await logger.saveToFile();
	});

	test("T-AI-007: 白名单缩编自愈（localStorage 非法 key → 回退默认，0 发送）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：白名单缩编自愈");
		logger.setupPageListeners(page);

		// 预写缩编后残留的非法 key（gpt-4o 不在白名单；persist JSON 结构与 chat-store 一致）
		await page.addInitScript(() => {
			window.localStorage.setItem(
				"preferred-chat-model",
				'{"state":{"selectedModel":"gpt-4o"},"version":0}',
			);
		});
		await openChat(page, seed.accessToken);

		// 自愈：useModels 列表加载后发现非法 key → setSelectedModel(null) → 显示默认
		const trigger = page.getByTestId("model-selector-trigger");
		await expect(trigger).toHaveText(/GPT-4\.1 Mini/, { timeout: 10000 });

		// store 同步归零：persist 落盘 selectedModel = null
		const stored = await page.evaluate(() =>
			window.localStorage.getItem("preferred-chat-model"),
		);
		const persisted = JSON.parse(stored ?? "{}") as {
			state?: { selectedModel?: string | null };
		};
		expect(persisted.state?.selectedModel).toBeNull();
		await saveScreenshot(page, "14-ai-chat", "T-AI-007-01-self-heal");

		await logger.saveToFile();
	});
});
