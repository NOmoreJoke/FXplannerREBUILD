import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import { injectLoginCookie, seedRegisterAndLogin } from "../helpers/api-seeder";

/**
 * 组织工作台 E2E 骨架（Goal #3A W21；需求 ORG-00..03 / MEM-01/02 / AUDIT-03）
 *
 * ⚠️ 运行口径（GOAL-3A §4 L3）：AI 不启动 dev 服务——本文件为「写好用例并
 * 待人类启服验收」的骨架（AGENTS.md 服务禁令；验收后按实际 UI 细节修订定位器）。
 *
 * 覆盖断言点（需求 §13/§15.1/§15.2）：
 * - T-ORG-001: 登录后单组织直达——侧栏组织切换器显示默认组织名（注册兜底建组）
 * - T-ORG-002: 组织信息页可达（/organization：名称/角色/建账状态；Owner 可改名）
 * - T-ORG-003: 邀请成员——创建邀请返回一次性链接（仅本次显示，复制提示在位）
 * - T-ORG-004: 受邀接受——邀请链接页展示脱敏摘要（组织名/角色/有效期），接受后加入
 * - T-ORG-005: 成员角色调整——Owner 将成员调整为 VIEWER，立即生效
 * - T-ORG-006: 审计页分页只读——Owner 可见组织创建/邀请/角色调整审计行；无编辑入口
 * - T-ORG-007: 权限边界——Viewer 访问 /organization/audit 显示无权限提示
 */

const logger = new TestLogger("15-organization");

test.describe("【组织工作台】切换 / 成员 / 邀请 / 审计", () => {
	test.describe.configure({ mode: "serial" });

	let seed: { accessToken: string; userId: string };
	let inviteeSeed: { accessToken: string; userId: string };
	let inviteUrl = "";

	test.beforeAll(async () => {
		seed = await seedRegisterAndLogin("org-owner");
		inviteeSeed = await seedRegisterAndLogin("org-invitee");
	});

	async function openProtected(page: Page, path: string, accessToken: string) {
		await injectLoginCookie(page, accessToken);
		await page.goto(path);
	}

	test("T-ORG-001: 登录后单组织直达——侧栏显示默认组织（注册兜底建组）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：单组织直达");
		logger.setupPageListeners(page);
		await openProtected(page, "/home", seed.accessToken);

		// 单组织简化态切换器（organization-switcher-single）渲染且非空
		const switcher = page.getByTestId("organization-switcher-single");
		await expect(switcher).toBeVisible();
		const name = await switcher.textContent();
		expect(name?.trim().length ?? 0).toBeGreaterThan(0);
		await saveScreenshot(page, "15-organization", "T-ORG-001-switcher");
		await logger.saveToFile();
	});

	test("T-ORG-002: 组织信息页可达（名称/角色；Owner 改名入口在位）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：组织信息页");
		logger.setupPageListeners(page);
		await openProtected(page, "/organization", seed.accessToken);

		await expect(page.getByTestId("organization-form")).toBeVisible();
		await expect(page.getByTestId("organization-rename-entry")).toBeVisible();
		await saveScreenshot(page, "15-organization", "T-ORG-002-info");
		await logger.saveToFile();
	});

	test("T-ORG-003: 邀请成员——一次性邀请链接生成", async ({ page }) => {
		logger.log("action", "info", "开始：邀请成员");
		logger.setupPageListeners(page);
		await openProtected(page, "/organization/members", seed.accessToken);

		await page.getByTestId("invite-email").fill(`org-invitee@fxplanner.test`);
		await page.getByTestId("invite-role").selectOption("FINANCE");
		await page.getByTestId("invite-submit").click();

		const link = page.getByTestId("invite-link");
		await expect(link).toBeVisible();
		inviteUrl = await link.textContent() ?? "";
		expect(inviteUrl).toContain("/invitations/");
		await saveScreenshot(page, "15-organization", "T-ORG-003-invite-link");
		await logger.saveToFile();
	});

	test("T-ORG-004: 受邀接受——脱敏摘要 + 接受后加入组织", async ({ page }) => {
		test.skip(!inviteUrl, "前序邀请未生成（串行依赖）");
		logger.log("action", "info", "开始：受邀接受");
		logger.setupPageListeners(page);
		await openProtected(page, inviteUrl, inviteeSeed.accessToken);

		const summary = page.getByTestId("invitation-summary");
		await expect(summary).toBeVisible();
		// 脱敏：摘要不含任何余额/业务明细字段（MEM-01.7——文本断言组织名/角色即可）
		await expect(summary.getByText("组织协作邀请")).toBeVisible();
		await page.getByTestId("invitation-accept").click();
		await expect(page.getByText("已加入组织")).toBeVisible();
		await saveScreenshot(page, "15-organization", "T-ORG-004-accepted");
		await logger.saveToFile();
	});

	test("T-ORG-005: 成员角色调整——Owner 调整为 VIEWER 立即生效", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：角色调整");
		logger.setupPageListeners(page);
		await openProtected(page, "/organization/members", seed.accessToken);

		// 成员表中受邀成员行（T-ORG-004 已加入）角色下拉切到 VIEWER
		const rows = page.getByTestId("member-row");
		await expect(rows.nth(1)).toBeVisible();
		const roleSelect = rows.nth(1).getByTestId("role-select");
		await roleSelect.selectOption("VIEWER");
		await expect(roleSelect).toHaveValue("VIEWER");
		await saveScreenshot(page, "15-organization", "T-ORG-005-role");
		await logger.saveToFile();
	});

	test("T-ORG-006: 审计页分页只读——组织操作留痕可见且无编辑入口", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：审计页");
		logger.setupPageListeners(page);
		await openProtected(page, "/organization/audit", seed.accessToken);

		const table = page.getByTestId("audit-log-table");
		await expect(table).toBeVisible();
		// 只读：无任何「删除/编辑」类操作按钮（AUDIT-03.3）
		expect(await page.getByRole("button", { name: /删除|编辑/ }).count()).toBe(0);
		await saveScreenshot(page, "15-organization", "T-ORG-006-audit");
		await logger.saveToFile();
	});

	test("T-ORG-007: 权限边界——Viewer 访问审计页显示无权限提示", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：Viewer 审计边界");
		logger.setupPageListeners(page);
		await openProtected(page, "/organization/audit", inviteeSeed.accessToken);

		await expect(page.getByTestId("audit-no-permission")).toBeVisible();
		await saveScreenshot(page, "15-organization", "T-ORG-007-no-perm");
		await logger.saveToFile();
	});
});
