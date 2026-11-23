import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import {
	api,
	injectLoginCookie,
	seedRegisterAndLogin,
} from "../helpers/api-seeder";
import type { components } from "../../clients/chat-web/lib/api/schema.gen";

/**
 * 组织工作台 E2E（Goal #3A W21；需求 ORG-00..03 / MEM-01/02 / AUDIT-03；
 * 外部评审前端批次回归）
 *
 * ⚠️ 运行口径（GOAL-3A §4 L3）：AI 不启动 dev 服务——本文件为「写好用例并
 * 待人类启服验收」（AGENTS.md 服务禁令；验收后按实际 UI 细节修订定位器）。
 *
 * 串行依赖链（serial）：001–003 建组/邀请 → 004 受邀接受 → 005 角色调整 →
 * 006 审计留痕 → 007–008 受邀者的权限边界与退出 → 009–010 所有者的多组织与登出。
 * 前序状态缺失时直接断言失败，不用 test.skip 静默跳过。
 *
 * 覆盖断言点（需求 §13/§15.1/§15.2）：
 * - T-ORG-001: 登录后单组织直达——侧栏组织切换器显示默认组织名（注册兜底建组）
 * - T-ORG-002: 侧栏「组织」入口可达组织信息页（名称/角色；Owner 改名与新建组织入口在位）
 * - T-ORG-003: 邀请成员——以受邀者真实邮箱创建邀请，返回一次性链接
 * - T-ORG-004: 受邀接受——邀请页展示脱敏摘要、面包屑不暴露 token；接受后直接进入该组织
 * - T-ORG-005: 成员角色调整——Owner 将成员调整为 VIEWER，立即生效
 * - T-ORG-006: 审计页只读——组织创建/邀请/接受/角色调整留痕可见；无编辑入口
 * - T-ORG-007: 权限边界——多组织未选先进入选择页；Viewer 不显示审计入口，直接访问审计页显示无权限
 * - T-ORG-008: 成员退出——Viewer 退出组织后回到单组织态
 * - T-ORG-009: 新建组织与切换——创建后进入新组织，可切回原组织
 * - T-ORG-010: 登出清除组织选择（换账号登录不得继承上一个账号的组织上下文）
 */

type OrganizationView = components["schemas"]["OrganizationViewDto"];
type Seed = Awaited<ReturnType<typeof seedRegisterAndLogin>>;

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";
const logger = new TestLogger("15-organization");

/** Playwright name 匹配按正则/子串处理，组织名里的特殊字符需转义 */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function listOrganizations(token: string): Promise<OrganizationView[]> {
	return api("/api/organizations", { method: "GET", token });
}

/** 多组织未选时 (protected)/layout 整屏渲染 OrganizationPicker：点选指定名称的组织 */
async function pickOrganization(page: Page, orgName: string): Promise<void> {
	const option = page
		.getByTestId("organization-picker-list")
		.getByRole("button", { name: new RegExp(escapeRegExp(orgName)) });
	await expect(option).toBeVisible();
	await option.click();
}

test.describe("【组织工作台】切换 / 成员 / 邀请 / 审计", () => {
	test.describe.configure({ mode: "serial" });

	let seed: Seed;
	let inviteeSeed: Seed;
	/** 所有者注册兜底创建的默认组织名（侧栏/选择页/邀请摘要的共同锚点） */
	let ownerOrgName = "";
	let inviteUrl = "";

	test.beforeAll(async () => {
		seed = await seedRegisterAndLogin("org-owner");
		inviteeSeed = await seedRegisterAndLogin("org-invitee");
		const ownerOrgs = await listOrganizations(seed.accessToken);
		ownerOrgName = ownerOrgs[0]?.name ?? "";
		expect(ownerOrgName.length).toBeGreaterThan(0);
	});

	async function openProtected(page: Page, path: string, accessToken: string) {
		await injectLoginCookie(page.context(), accessToken, BASE_URL);
		await page.goto(path.startsWith("http") ? path : `${BASE_URL}${path}`);
	}

	test("T-ORG-001: 登录后单组织直达——侧栏显示默认组织（注册兜底建组）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：单组织直达");
		logger.setupPageListeners(page);
		await openProtected(page, "/home", seed.accessToken);

		// 单组织简化态切换器渲染且显示默认组织名
		//（首页可能按建账态分流到向导，侧栏属于 (protected)/layout，不受影响）
		const switcher = page.getByTestId("organization-switcher-single");
		await expect(switcher).toBeVisible();
		await expect(switcher).toContainText(ownerOrgName);
		await saveScreenshot(page, "15-organization", "T-ORG-001-switcher");
		await logger.saveToFile();
	});

	test("T-ORG-002: 侧栏「组织」入口 → 组织信息页（名称/角色；改名与新建组织入口在位）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：组织信息页");
		logger.setupPageListeners(page);
		await openProtected(page, "/home", seed.accessToken);

		await page.click('aside a[href="/organization"]');
		await expect(page).toHaveURL(`${BASE_URL}/organization`);

		await expect(page.getByTestId("organization-form")).toBeVisible();
		await expect(page.getByTestId("organization-rename-entry")).toBeVisible();
		await expect(page.getByTestId("organization-nav-members")).toBeVisible();
		// Owner 具备 audit.read：审计入口可见
		await expect(page.getByTestId("organization-nav-audit")).toBeVisible();
		await expect(page.getByTestId("create-organization-card")).toBeVisible();
		await saveScreenshot(page, "15-organization", "T-ORG-002-info");
		await logger.saveToFile();
	});

	test("T-ORG-003: 邀请成员——以受邀者真实邮箱创建邀请，返回一次性链接", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：邀请成员");
		logger.setupPageListeners(page);
		await openProtected(page, "/organization/members", seed.accessToken);

		// 受邀邮箱必须是受邀者的登录邮箱（后端按邮箱匹配，否则接受时 403）
		await page.getByTestId("invite-email").fill(inviteeSeed.email);
		await page.getByTestId("invite-role").selectOption("FINANCE");
		await page.getByTestId("invite-submit").click();

		const link = page.getByTestId("invite-link");
		await expect(link).toBeVisible();
		inviteUrl = ((await link.textContent()) ?? "").trim();
		expect(inviteUrl).toContain("/invitations/");
		// 邀请记录出现对应行
		await expect(
			page.getByTestId("invitation-row").filter({ hasText: inviteeSeed.email }),
		).toHaveCount(1);
		await saveScreenshot(page, "15-organization", "T-ORG-003-invite-link");
		await logger.saveToFile();
	});

	test("T-ORG-004: 受邀接受——脱敏摘要 + 面包屑不暴露 token + 接受后进入该组织", async ({
		page,
	}) => {
		// 前序邀请未生成即失败（不用 skip 静默跳过）
		expect(inviteUrl).toContain("/invitations/");
		logger.log("action", "info", "开始：受邀接受");
		logger.setupPageListeners(page);
		await openProtected(page, inviteUrl, inviteeSeed.accessToken);

		const summary = page.getByTestId("invitation-summary");
		await expect(summary).toBeVisible();
		await expect(summary).toContainText("组织协作邀请");
		// 脱敏摘要只有组织名/邮箱/角色/邀请人/有效期，不含任何余额/业务明细（MEM-01.7）
		await expect(summary).toContainText(ownerOrgName);
		await expect(summary).toContainText(inviteeSeed.email);

		// 面包屑显示语义化名称；邀请 token 是一次性凭证，不得出现在页头
		const token = inviteUrl.split("/invitations/")[1] ?? "";
		expect(token.length).toBeGreaterThan(0);
		const breadcrumb = page.locator('[aria-label="面包屑"]');
		await expect(breadcrumb).toContainText("加入组织");
		await expect(breadcrumb).not.toContainText(token);

		await page.getByTestId("invitation-accept").click();
		await expect(page.getByText("已加入组织")).toBeVisible();
		await saveScreenshot(page, "15-organization", "T-ORG-004-accepted");

		// 接受后已切换到该组织：进入工作台不再经过组织选择页，切换器显示多组织态
		await page.getByRole("link", { name: "进入工作台" }).click();
		await expect(page.getByTestId("organization-picker-list")).toHaveCount(0);
		const switcher = page.getByTestId("organization-switcher");
		await expect(switcher).toBeVisible();
		await expect(switcher).toContainText(ownerOrgName);
		await logger.saveToFile();
	});

	test("T-ORG-005: 成员角色调整——Owner 将受邀成员调整为 VIEWER 立即生效", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：角色调整");
		logger.setupPageListeners(page);
		await openProtected(page, "/organization/members", seed.accessToken);

		// 按受邀者邮箱定位成员行（不依赖行序）
		const memberRow = page
			.getByTestId("member-row")
			.filter({ hasText: inviteeSeed.email });
		await expect(memberRow).toBeVisible();
		const roleSelect = memberRow.getByTestId("role-select");
		await expect(roleSelect).toBeEnabled();
		await roleSelect.selectOption("VIEWER");
		// 列表重拉后服务端角色生效（受控 select 在重拉前可能短暂回显旧值，断言自动重试）
		await expect(roleSelect).toHaveValue("VIEWER");
		await saveScreenshot(page, "15-organization", "T-ORG-005-role");
		await logger.saveToFile();
	});

	test("T-ORG-006: 审计页只读——组织操作留痕可见且无编辑入口", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：审计页");
		logger.setupPageListeners(page);
		await openProtected(page, "/organization/audit", seed.accessToken);

		const table = page.getByTestId("audit-log-table");
		await expect(table).toBeVisible();
		// 注册兜底建组 + 本链路的邀请/接受/角色调整全部留痕
		for (const action of [
			"organization.create",
			"invitation.create",
			"invitation.accept",
			"member.update",
		]) {
			await expect(table).toContainText(action);
		}
		// 只读：无任何「删除/编辑」类操作按钮（AUDIT-03.3）
		await expect(
			page.getByRole("button", { name: /删除|编辑/ }),
		).toHaveCount(0);
		await saveScreenshot(page, "15-organization", "T-ORG-006-audit");
		await logger.saveToFile();
	});

	test("T-ORG-007: 权限边界——Viewer 先经选择页进入组织；无审计入口，直接访问审计页显示无权限", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：Viewer 审计边界");
		logger.setupPageListeners(page);
		// 受邀者现有两个组织（自己的默认组织 + 所有者的组织）且本浏览器上下文未选择
		const inviteeOrgs = await listOrganizations(inviteeSeed.accessToken);
		expect(inviteeOrgs.some((org) => org.name === ownerOrgName)).toBe(true);

		await openProtected(page, "/organization", inviteeSeed.accessToken);
		await pickOrganization(page, ownerOrgName);

		await expect(page).toHaveURL(`${BASE_URL}/organization`);
		// Viewer 无 audit.read：组织页不显示审计入口卡片
		await expect(page.getByTestId("organization-nav-members")).toBeVisible();
		await expect(page.getByTestId("organization-nav-audit")).toHaveCount(0);

		// 直接访问审计路由：显示无权限提示，而不是数据
		await page.goto(`${BASE_URL}/organization/audit`);
		await expect(page.getByTestId("audit-no-permission")).toBeVisible();
		await expect(page.getByTestId("audit-log-table")).toHaveCount(0);
		await saveScreenshot(page, "15-organization", "T-ORG-007-no-perm");
		await logger.saveToFile();
	});

	test("T-ORG-008: 成员退出——Viewer 退出组织后回到单组织态", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：成员退出");
		logger.setupPageListeners(page);
		await openProtected(page, "/organization/members", inviteeSeed.accessToken);
		await pickOrganization(page, ownerOrgName);

		// 非 Owner 才有退出入口（最后 Owner 必须先转移所有权）
		await expect(page.getByTestId("leave-organization-entry")).toBeVisible();
		await page.getByTestId("leave-organization-entry").click();
		await page.getByTestId("leave-organization-confirm").click();

		// 退出后回到首页；只剩一个组织 → 单组织简化态切换器
		await expect(page).toHaveURL(new RegExp(`${escapeRegExp(BASE_URL)}/home$`));
		await expect(page.getByTestId("organization-switcher-single")).toBeVisible();

		const remaining = await listOrganizations(inviteeSeed.accessToken);
		expect(remaining.some((org) => org.name === ownerOrgName)).toBe(false);
		await saveScreenshot(page, "15-organization", "T-ORG-008-left");
		await logger.saveToFile();
	});

	test("T-ORG-009: 新建组织与切换——创建后进入新组织，可切回原组织", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：新建组织");
		logger.setupPageListeners(page);
		const secondOrgName = `E2E 第二组织 ${Date.now()}`;
		await openProtected(page, "/organization", seed.accessToken);

		await page.getByTestId("create-organization-name").fill(secondOrgName);
		await page.getByTestId("create-organization-submit").click();

		// 创建成功即切换到新组织：多组织下拉切换器显示新组织名
		const switcher = page.getByTestId("organization-switcher");
		await expect(switcher).toBeVisible();
		await expect(switcher).toContainText(secondOrgName);
		const newOrgs = await listOrganizations(seed.accessToken);
		expect(newOrgs.some((org) => org.name === secondOrgName)).toBe(true);

		// 下拉切回原组织
		await switcher.getByRole("button", { name: new RegExp(escapeRegExp(secondOrgName)) }).click();
		await switcher
			.getByRole("option", { name: new RegExp(escapeRegExp(ownerOrgName)) })
			.getByRole("button")
			.click();
		await expect(switcher).toContainText(ownerOrgName);
		await expect(switcher).not.toContainText(secondOrgName);
		await saveScreenshot(page, "15-organization", "T-ORG-009-switch-back");
		await logger.saveToFile();
	});

	test("T-ORG-010: 登出清除组织选择（换账号登录不得继承上一个账号的组织）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：登出清除组织选择");
		logger.setupPageListeners(page);
		await openProtected(page, "/organization", seed.accessToken);
		await expect(page.getByTestId("organization-form")).toBeVisible();

		await page.getByRole("button", { name: "退出登录" }).click();
		await expect(page).toHaveURL(/\/login/);

		// 持久化的组织选择随登出清空（zustand persist 结构：state.activeOrganizationId）
		const persisted = await page.evaluate(() => {
			const raw = window.localStorage.getItem("active-organization");
			return raw ? (JSON.parse(raw) as { state?: { activeOrganizationId?: string | null } }) : null;
		});
		expect(persisted?.state?.activeOrganizationId).toBeNull();
		await logger.saveToFile();
	});
});
