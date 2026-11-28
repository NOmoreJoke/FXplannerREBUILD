import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/auto-screenshot";
import { TestLogger } from "../helpers/logger";
import { saveScreenshot } from "../helpers/save-screenshot";
import { buildApiUrl, localFetch, resolveApiBase } from "../helpers/api-url";
import {
	api,
	injectLoginCookie,
	seedFullyAllocatedPlan,
	seedOnboarding,
	seedPlanWithAllocation,
	seedRegisterAndLogin,
	seedTransaction,
	seedUsage,
} from "../helpers/api-seeder";
import { latestRequestId, makeRequestDue } from "../helpers/data-request-db";
import { expireInvitationForTest } from "../helpers/organization-db";
import { selectRadixOption } from "../helpers/test-utils";
import type { components } from "../../clients/chat-web/lib/api/schema.gen";

/**
 * 组织工作台与 ToB R1 GWT 全量验收 E2E（Goal #3A W21 + Goal #3C W31；
 * 需求 ORG-00..03 / MEM-01..02 / AUTH-01..02 / LEDGER-01..04 / AUDIT-01..03 / DATA-01..02；
 * 验收标准 §15.1–§15.3, §15.5：GWT-1..18 与 GWT-26..30；GWT-19..25 属 R2 Agent 留待 Goal #4）。
 *
 * 纪律：
 * - 严禁 test.skip、page.waitForTimeout / 硬编码 sleep、mock 同义反复断言；
 * - 所有直连组织业务端点的 api() / localFetch() 调用显式携带 "X-Organization-Id"；
 * - 共享夹具与 helper 统一复用 api-seeder / data-request-db / organization-db / test-utils。
 */

type OrganizationView = components["schemas"]["OrganizationViewDto"];
type MemberView = components["schemas"]["MemberViewDto"];
type AuditLogList = components["schemas"]["AuditLogListDto"];
type Seed = Awaited<ReturnType<typeof seedRegisterAndLogin>>;
type OrgRole = components["schemas"]["CreateInvitationDto"]["role"];

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";
const API_URL = resolveApiBase(process.env.API_URL, "http://localhost:4001");
const LOOPBACK_API_URL = API_URL.replace("localhost", "127.0.0.1");
const logger = new TestLogger("15-organization");

const SERVER_ID_SHAPE = /^[A-Za-z0-9]{1,64}$/;
const INVITATION_TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

function assertShape(value: string, pattern: RegExp, label: string): string {
	if (!pattern.test(value)) {
		throw new Error(`${label} 形状非法：${value}`);
	}
	return value;
}

/** Playwright name 匹配按正则/子串处理，组织名里的特殊字符需转义 */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Playwright 重试时派生独立造数标签，避免复用 Attempt #1 的已变更组织/成员状态 */
function retryLabel(base: string, retry: number): string {
	return retry === 0 ? base : `${base}-r${retry}`;
}

function orgHeaders(organizationId: string): Record<string, string> {
	return {
		"X-Organization-Id": assertShape(
			organizationId,
			SERVER_ID_SHAPE,
			"组织 id",
		),
	};
}

async function rawApi(
	path: string,
	init: {
		method: string;
		token?: string;
		organizationId?: string;
		body?: unknown;
	},
): Promise<{ status: number; json: Record<string, unknown> }> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (init.token) {
		headers.Authorization = `Bearer ${init.token}`;
	}
	if (init.organizationId) {
		headers["X-Organization-Id"] = assertShape(
			init.organizationId,
			SERVER_ID_SHAPE,
			"组织 id",
		);
	}
	const res = await localFetch(buildApiUrl(LOOPBACK_API_URL, path), {
		method: init.method,
		headers,
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
	const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	return { status: res.status, json };
}

async function listOrganizations(token: string): Promise<OrganizationView[]> {
	return api("/api/organizations", { method: "GET", token });
}

async function createOrganizationViaApi(
	token: string,
	name: string,
): Promise<OrganizationView> {
	return api<OrganizationView>("/api/organizations", {
		method: "POST",
		token,
		body: { name },
	});
}

async function createInvitationViaApi(
	ownerToken: string,
	organizationId: string,
	email: string,
	role: OrgRole,
): Promise<{ id: string; token: string }> {
	const headers = orgHeaders(organizationId);
	const invite = () =>
		api<{ id: string; token: string }>(
			"/api/organizations/current/invitations",
			{
				method: "POST",
				token: ownerToken,
				headers,
				body: { email, role },
			},
		);
	let created = await invite();
	if (!created.token) {
		await api(
			`/api/organizations/current/invitations/${assertShape(created.id, SERVER_ID_SHAPE, "邀请 id")}`,
			{ method: "DELETE", token: ownerToken, headers },
		);
		created = await invite();
	}
	return created;
}

async function inviteAndJoinViaApi(
	ownerToken: string,
	organizationId: string,
	invitee: Seed,
	role: OrgRole,
): Promise<{ membershipId: string }> {
	const headers = orgHeaders(organizationId);
	const members = await api<MemberView[]>("/api/organizations/current/members", {
		method: "GET",
		token: ownerToken,
		headers,
	});
	const existing = members.find(
		(member) => member.userId === invitee.userId && member.status === "ACTIVE",
	);
	if (existing) {
		if (existing.role !== role && role !== "ADMIN") {
			await api(
				`/api/organizations/current/members/${assertShape(existing.id, SERVER_ID_SHAPE, "成员 id")}`,
				{
					method: "PATCH",
					token: ownerToken,
					headers,
					body: { role },
				},
			);
		}
		return { membershipId: existing.id };
	}
	const created = await createInvitationViaApi(
		ownerToken,
		organizationId,
		invitee.email,
		role,
	);
	const token = assertShape(
		created.token,
		INVITATION_TOKEN_SHAPE,
		"邀请 token",
	);
	return api<{ membershipId: string }>(
		`/api/organization-invitations/${token}/accept`,
		{ method: "POST", token: invitee.accessToken },
	);
}

/** 多组织未选时 (protected)/layout 整屏渲染 OrganizationPicker：点选指定名称的组织 */
async function pickOrganization(page: Page, orgName: string): Promise<void> {
	const option = page
		.getByTestId("organization-picker-list")
		.getByRole("button", { name: new RegExp(escapeRegExp(orgName)) });
	await expect(option).toBeVisible();
	await option.click();
}

/** 经多组织下拉切换器切换：先点开当前组织，再在选项里点目标组织 */
async function switchOrganization(
	page: Page,
	currentOrgName: string,
	targetOrgName: string,
): Promise<void> {
	const switcher = page.getByTestId("organization-switcher");
	await switcher
		.getByRole("button", { name: new RegExp(escapeRegExp(currentOrgName)) })
		.click();
	await switcher
		.getByRole("option", { name: new RegExp(escapeRegExp(targetOrgName)) })
		.getByRole("button")
		.click();
}

async function openProtected(
	page: Page,
	path: string,
	accessToken: string,
): Promise<void> {
	await injectLoginCookie(page.context(), accessToken, BASE_URL);
	await page.goto(path.startsWith("http") ? path : `${BASE_URL}${path}`);
}

test.describe("【组织工作台】切换 / 成员 / 邀请 / 审计", () => {
	test.describe.configure({ mode: "serial" });

	let seed: Seed;
	let inviteeSeed: Seed;
	/** 所有者注册兜底创建的默认组织名（侧栏/选择页/邀请摘要的共同锚点） */
	let ownerOrgName = "";
	/** 受邀者默认组织里的一条具名计划（T-ORG-007B：区分「当前显示的是哪个组织的数据」） */
	let inviteePlanName = "";
	let inviteUrl = "";

	test.beforeAll(async () => {
		seed = await seedRegisterAndLogin("org-owner");
		inviteeSeed = await seedRegisterAndLogin("org-invitee");
		await seedOnboarding(seed.accessToken, "CNY", seed.defaultOrganizationId);
		await seedOnboarding(
			inviteeSeed.accessToken,
			"CNY",
			inviteeSeed.defaultOrganizationId,
		);
		const ownerOrgs = await listOrganizations(seed.accessToken);
		ownerOrgName = ownerOrgs[0]?.name ?? "";
		expect(ownerOrgName.length).toBeGreaterThan(0);
		inviteePlanName = `E2E 受邀者计划 ${Date.now()}`;
		await seedPlanWithAllocation(
			inviteeSeed.accessToken,
			"USD",
			"0",
			inviteePlanName,
			inviteeSeed.defaultOrganizationId,
		);
	});

	test("T-ORG-001: 登录后单组织直达——侧栏显示默认组织（注册兜底建组）", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：单组织直达");
		logger.setupPageListeners(page);
		await openProtected(page, "/home", seed.accessToken);

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

		await page.getByTestId("invite-email").fill(inviteeSeed.email);
		await page.getByTestId("invite-role").selectOption("FINANCE");
		await page.getByTestId("invite-submit").click();

		const link = page.getByTestId("invite-link");
		await expect(link).toBeVisible();
		inviteUrl = ((await link.textContent()) ?? "").trim();
		expect(inviteUrl).toContain("/invitations/");
		await expect(
			page.getByTestId("invitation-row").filter({ hasText: inviteeSeed.email }),
		).toHaveCount(1);
		await saveScreenshot(page, "15-organization", "T-ORG-003-invite-link");
		await logger.saveToFile();
	});

	test("T-ORG-004: 受邀接受——脱敏摘要 + 面包屑不暴露 token + 接受后进入该组织", async ({
		page,
	}) => {
		expect(inviteUrl).toContain("/invitations/");
		logger.log("action", "info", "开始：受邀接受");
		logger.setupPageListeners(page);
		await openProtected(page, inviteUrl, inviteeSeed.accessToken);

		const summary = page.getByTestId("invitation-summary");
		await expect(summary).toBeVisible();
		await expect(summary).toContainText("组织协作邀请");
		await expect(summary).toContainText(ownerOrgName);
		await expect(summary).toContainText(inviteeSeed.email);

		const token = inviteUrl.split("/invitations/")[1] ?? "";
		expect(token.length).toBeGreaterThan(0);
		const breadcrumb = page.locator('[aria-label="面包屑"]');
		await expect(breadcrumb).toContainText("加入组织");
		await expect(breadcrumb).not.toContainText(token);

		await page.getByTestId("invitation-accept").click();
		await expect(page.getByText("已加入组织")).toBeVisible();
		await saveScreenshot(page, "15-organization", "T-ORG-004-accepted");

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

		const memberRow = page
			.getByTestId("member-row")
			.filter({ hasText: inviteeSeed.email });
		await expect(memberRow).toBeVisible();
		const roleSelect = memberRow.getByTestId("role-select");
		await expect(roleSelect).toBeEnabled();
		await roleSelect.selectOption("VIEWER");
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
		for (const action of [
			"organization.create",
			"invitation.create",
			"invitation.accept",
			"member.update",
		]) {
			await expect(table).toContainText(action);
		}
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
		const inviteeOrgs = await listOrganizations(inviteeSeed.accessToken);
		expect(inviteeOrgs.some((org) => org.name === ownerOrgName)).toBe(true);

		await openProtected(page, "/organization", inviteeSeed.accessToken);
		await pickOrganization(page, ownerOrgName);

		await expect(page).toHaveURL(`${BASE_URL}/organization`);
		await expect(page.getByTestId("organization-nav-members")).toBeVisible();
		await expect(page.getByTestId("organization-nav-audit")).toHaveCount(0);

		await page.goto(`${BASE_URL}/organization/audit`);
		await expect(page.getByTestId("audit-no-permission")).toBeVisible();
		await expect(page.getByTestId("audit-log-table")).toHaveCount(0);
		await saveScreenshot(page, "15-organization", "T-ORG-007-no-perm");
		await logger.saveToFile();
	});

	test("T-ORG-007B: 切换组织后挂载态页面数据刷新——停在计划列表页切换，旧组织数据不残留", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：切换组织后的页面数据刷新");
		logger.setupPageListeners(page);
		const inviteeOrgs = await listOrganizations(inviteeSeed.accessToken);
		const ownOrg = inviteeOrgs.find((org) => org.name !== ownerOrgName);
		expect(ownOrg).toBeDefined();

		await openProtected(page, "/plans", inviteeSeed.accessToken);
		await pickOrganization(page, ownOrg!.name);
		await expect(page).toHaveURL(`${BASE_URL}/plans`);
		const ownPlanCard = page
			.locator('a[href^="/plans/"]:not([href="/plans/new"])')
			.filter({ hasText: inviteePlanName });
		await expect(ownPlanCard).toBeVisible();

		await switchOrganization(page, ownOrg!.name, ownerOrgName);
		await expect(page).toHaveURL(`${BASE_URL}/plans`);
		await expect(page.getByText("还没有换汇计划")).toBeVisible();
		await expect(page.getByText(inviteePlanName)).toHaveCount(0);

		await switchOrganization(page, ownerOrgName, ownOrg!.name);
		await expect(ownPlanCard).toBeVisible();
		await saveScreenshot(page, "15-organization", "T-ORG-007B-switch-back");
		await logger.saveToFile();
	});

	test("T-ORG-008: 成员退出——Viewer 退出组织后回到单组织态", async ({
		page,
	}) => {
		logger.log("action", "info", "开始：成员退出");
		logger.setupPageListeners(page);
		await openProtected(page, "/organization/members", inviteeSeed.accessToken);
		await pickOrganization(page, ownerOrgName);

		await expect(page.getByTestId("leave-organization-entry")).toBeVisible();
		await page.getByTestId("leave-organization-entry").click();
		await page.getByTestId("leave-organization-confirm").click();

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

		const switcher = page.getByTestId("organization-switcher");
		await expect(switcher).toBeVisible();
		await expect(switcher).toContainText(secondOrgName);
		const newOrgs = await listOrganizations(seed.accessToken);
		expect(newOrgs.some((org) => org.name === secondOrgName)).toBe(true);

		await switcher
			.getByRole("button", { name: new RegExp(escapeRegExp(secondOrgName)) })
			.click();
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
		await pickOrganization(page, ownerOrgName);
		await expect(page.getByTestId("organization-form")).toBeVisible();

		await page.getByRole("button", { name: "退出登录" }).click();
		await expect(page).toHaveURL(/\/login/);

		const persisted = await page.evaluate(() => {
			const raw = window.localStorage.getItem("active-organization");
			return raw
				? (JSON.parse(raw) as { state?: { activeOrganizationId?: string | null } })
				: null;
		});
		expect(persisted?.state?.activeOrganizationId).toBeNull();
		await logger.saveToFile();
	});
});

test.describe("【GWT-1..5】默认组织 / 新建隔离 / 跨页切换 / 延迟防篡改 / 最后 Owner", () => {
	test("GWT-1: 默认组织视图——Owner 身份与原账户/计划/报告金额完整可见", async ({
		page,
	}, testInfo) => {
		const user = await seedRegisterAndLogin(
			retryLabel("gwt1-default", testInfo.retry),
		);
		const orgId = user.defaultOrganizationId;
		await seedOnboarding(user.accessToken, "CNY", orgId);
		await seedTransaction(user.accessToken, "CAD", "6000", orgId);
		await seedTransaction(user.accessToken, "CAD", "6000", orgId);
		const planName = `GWT1 默认计划 ${Date.now()}`;
		const planId = await seedPlanWithAllocation(
			user.accessToken,
			"CAD",
			"6000",
			planName,
			orgId,
		);
		await seedUsage(user.accessToken, planId, "1500", orgId);

		const orgs = await listOrganizations(user.accessToken);
		const defaultOrg = orgs[0];
		expect(defaultOrg?.role).toBe("OWNER");

		await openProtected(page, "/organization", user.accessToken);
		await expect(page.getByTestId("organization-switcher-single")).toContainText(
			defaultOrg!.name,
		);
		await expect(page.getByTestId("organization-form")).toContainText("所有者");
		await expect(page.getByTestId("organization-form")).toContainText(
			"已建账（本位币 CNY）",
		);

		// 12000 买入 - 1500 使用 = 10500 余额；6000 分配 - 1500 使用 = 4500 已分配；未分配 = 6000
		await page.goto(`${BASE_URL}/accounts`);
		const cadRow = page.locator("tbody tr").filter({ hasText: "CAD" });
		await expect(cadRow).toBeVisible();
		await expect(cadRow).toContainText("10500.0000");
		await expect(cadRow).toContainText("4500.0000");
		await expect(cadRow).toContainText("6000.0000");

		await page.goto(`${BASE_URL}/plans`);
		await expect(page.getByText(planName)).toBeVisible();

		await page.goto(`${BASE_URL}/reports`);
		const reportRow = page
			.getByTestId("report-plan-row")
			.filter({ hasText: planName });
		await expect(reportRow).toBeVisible();
		await expect(reportRow).toContainText("1500");
	});

	test("GWT-2: 新建组织 B 隔离与独立建账——B 无 A 账本且须独立完成首次设置", async ({
		page,
	}) => {
		const user = await seedRegisterAndLogin("gwt2-isolate");
		const orgAId = user.defaultOrganizationId;
		await seedOnboarding(user.accessToken, "CNY", orgAId);
		await seedTransaction(user.accessToken, "CAD", "5000", orgAId);
		const orgAPlanName = `GWT2 OrgA 计划 ${Date.now()}`;
		await seedPlanWithAllocation(
			user.accessToken,
			"CAD",
			"2000",
			orgAPlanName,
			orgAId,
		);
		const orgA = (await listOrganizations(user.accessToken))[0]!;
		const orgBName = `GWT2 隔离组织 B ${Date.now()}`;

		await openProtected(page, "/organization", user.accessToken);
		await page.getByTestId("create-organization-name").fill(orgBName);
		await page.getByTestId("create-organization-submit").click();
		await expect(page.getByTestId("organization-switcher")).toContainText(
			orgBName,
		);
		await expect(page.getByTestId("organization-form")).toContainText("待建账");

		// 进入首页 → 组织 B 未建账，自动分流到 /onboarding 独立建账
		await page.goto(`${BASE_URL}/home`);
		await expect(page).toHaveURL(
			new RegExp(`${escapeRegExp(BASE_URL)}/onboarding`),
		);
		await expect(page.getByTestId("wizard-step-1")).toBeVisible();
		await selectRadixOption(
			page,
			page.getByTestId("base-currency-select"),
			"USD · 美元",
		);
		await page.getByTestId("wizard-next").click();
		await expect(page.getByTestId("wizard-step-2")).toBeVisible();
		await page.getByTestId("holdings-skip").click();
		await expect(page).toHaveURL(new RegExp(`${escapeRegExp(BASE_URL)}/home$`));

		// B 内无 A 的账户和计划
		await page.goto(`${BASE_URL}/accounts`);
		await expect(page.getByText("还没有任何外汇账户")).toBeVisible();
		await expect(page.getByText("5000.0000")).toHaveCount(0);

		await page.goto(`${BASE_URL}/plans`);
		await expect(page.getByText("还没有换汇计划")).toBeVisible();
		await expect(page.getByText(orgAPlanName)).toHaveCount(0);

		// 切回 Org A：原数据完好
		await switchOrganization(page, orgBName, orgA.name);
		await expect(page.getByText(orgAPlanName)).toBeVisible();
	});

	test("GWT-3: A↔B 跨页切换一致性——首页/账户/计划/报告仅显示当前组织数据", async ({
		page,
	}, testInfo) => {
		const user = await seedRegisterAndLogin(
			retryLabel("gwt3-crosspage", testInfo.retry),
		);
		const orgAId = user.defaultOrganizationId;
		await seedOnboarding(user.accessToken, "CNY", orgAId);
		await seedTransaction(user.accessToken, "CAD", "4000", orgAId);
		const planAName = `GWT3 OrgA ${Date.now()}`;
		const planAId = await seedPlanWithAllocation(
			user.accessToken,
			"CAD",
			"2000",
			planAName,
			orgAId,
		);
		await seedUsage(user.accessToken, planAId, "1000", orgAId);

		const orgB = await createOrganizationViaApi(
			user.accessToken,
			`GWT3 OrgB ${Date.now()}`,
		);
		await seedOnboarding(user.accessToken, "USD", orgB.id);
		await seedTransaction(user.accessToken, "EUR", "2500", orgB.id);
		const planBName = `GWT3 OrgB 计划 ${Date.now()}`;
		const planBId = await seedPlanWithAllocation(
			user.accessToken,
			"EUR",
			"1500",
			planBName,
			orgB.id,
		);
		await seedUsage(user.accessToken, planBId, "500", orgB.id);
		const orgA = (await listOrganizations(user.accessToken)).find(
			(o) => o.id === orgAId,
		)!;

		await openProtected(page, "/home", user.accessToken);
		await pickOrganization(page, orgA.name);
		await expect(page.getByText(planAName)).toBeVisible();
		await expect(page.getByText(planBName)).toHaveCount(0);

		// 首页 A → B
		await switchOrganization(page, orgA.name, orgB.name);
		await expect(page.getByText(planBName)).toBeVisible();
		await expect(page.getByText(planAName)).toHaveCount(0);

		// 计划页 B → A
		await page.goto(`${BASE_URL}/plans`);
		await expect(page.getByText(planBName)).toBeVisible();
		await expect(page.getByText(planAName)).toHaveCount(0);
		await switchOrganization(page, orgB.name, orgA.name);
		await expect(page.getByText(planAName)).toBeVisible();
		await expect(page.getByText(planBName)).toHaveCount(0);

		// 账户页 A → B（Org A: 4000 CAD - 1000 usage = 3000.0000，无 EUR；Org B: 2500 EUR - 500 usage = 2000.0000，无 CAD）
		await page.goto(`${BASE_URL}/accounts`);
		await expect(
			page.locator("tbody tr").filter({ hasText: "CAD" }),
		).toContainText("3000.0000");
		await expect(
			page.locator("tbody tr").filter({ hasText: "EUR" }),
		).toHaveCount(0);
		await switchOrganization(page, orgA.name, orgB.name);
		await expect(
			page.locator("tbody tr").filter({ hasText: "EUR" }),
		).toContainText("2000.0000");
		await expect(
			page.locator("tbody tr").filter({ hasText: "CAD" }),
		).toHaveCount(0);

		// 报告页 B → A
		await page.goto(`${BASE_URL}/reports`);
		await expect(
			page.getByTestId("report-plan-row").filter({ hasText: planBName }),
		).toBeVisible();
		await expect(
			page.getByTestId("report-plan-row").filter({ hasText: planAName }),
		).toHaveCount(0);
		await switchOrganization(page, orgB.name, orgA.name);
		await expect(
			page.getByTestId("report-plan-row").filter({ hasText: planAName }),
		).toBeVisible();
		await expect(
			page.getByTestId("report-plan-row").filter({ hasText: planBName }),
		).toHaveCount(0);
	});

	test("GWT-4: 延迟响应防篡改——Org A 迟到 /api/plans 响应在切到 Org B 后到达，不覆盖 Org B", async ({
		page,
	}) => {
		const user = await seedRegisterAndLogin("gwt4-race");
		const orgAId = user.defaultOrganizationId;
		await seedOnboarding(user.accessToken, "CNY", orgAId);
		const planAName = `GWT4 慢响应 OrgA ${Date.now()}`;
		await seedPlanWithAllocation(
			user.accessToken,
			"USD",
			"0",
			planAName,
			orgAId,
		);

		const orgB = await createOrganizationViaApi(
			user.accessToken,
			`GWT4 稳定 OrgB ${Date.now()}`,
		);
		await seedOnboarding(user.accessToken, "CNY", orgB.id);
		const planBName = `GWT4 稳定 OrgB ${Date.now()}`;
		await seedPlanWithAllocation(
			user.accessToken,
			"EUR",
			"0",
			planBName,
			orgB.id,
		);
		const orgA = (await listOrganizations(user.accessToken)).find(
			(o) => o.id === orgAId,
		)!;

		// 先停在 /home 选中 Org A
		await openProtected(page, "/home", user.accessToken);
		await pickOrganization(page, orgA.name);
		await expect(page.getByTestId("organization-switcher")).toContainText(
			orgA.name,
		);

		// 确定性 Promise 屏障：拦住 Org A 的 GET /api/plans，直到切到 Org B 且 Org B 响应完成再放行
		let markOrgAInFlight!: () => void;
		const orgAInFlight = new Promise<void>((resolve) => {
			markOrgAInFlight = resolve;
		});
		let releaseOrgA!: () => void;
		const orgABarrier = new Promise<void>((resolve) => {
			releaseOrgA = resolve;
		});
		let orgAIntercepted = false;

		await page.route("**/api/plans*", async (route) => {
			const req = route.request();
			if (
				!orgAIntercepted &&
				req.method() === "GET" &&
				req.headers()["x-organization-id"] === orgA.id
			) {
				orgAIntercepted = true;
				markOrgAInFlight();
				await orgABarrier;
			}
			await route.continue();
		});

		// 点击侧栏进入计划页，触发 Org A 的 GET /api/plans 并被屏障挂起
		await page.click('aside a[href="/plans"]');
		await orgAInFlight;

		// 在 Org A 请求尚未返回时切到 Org B，等待 Org B 的 /api/plans 200 返回并渲染
		const orgBResponsePromise = page.waitForResponse(
			(res) =>
				res.url().includes("/api/plans") &&
				res.request().method() === "GET" &&
				res.request().headers()["x-organization-id"] === orgB.id &&
				res.status() === 200,
		);
		await switchOrganization(page, orgA.name, orgB.name);
		await orgBResponsePromise;
		await expect(page.getByText(planBName)).toBeVisible();

		// 放行 Org A 迟到响应并等待其真实返回落地
		const orgALateResponsePromise = page.waitForResponse(
			(res) =>
				res.url().includes("/api/plans") &&
				res.request().method() === "GET" &&
				res.request().headers()["x-organization-id"] === orgA.id,
		);
		releaseOrgA();
		await orgALateResponsePromise;

		// 页面稳定展示 Org B 数据，绝不被迟到的 Org A 响应覆盖
		await expect(page.getByTestId("organization-switcher")).toContainText(
			orgB.name,
		);
		await expect(page.getByText(planBName)).toBeVisible();
		await expect(page.getByText(planAName)).toHaveCount(0);
	});

	test("GWT-5: 最后 Owner 保护——不可退出也不可自降权（UI 隐藏 + API 409 LAST_OWNER_REQUIRED）", async ({
		page,
	}, testInfo) => {
		const owner = await seedRegisterAndLogin(
			retryLabel("gwt5-last-owner", testInfo.retry),
		);
		const orgId = owner.defaultOrganizationId;
		await seedOnboarding(owner.accessToken, "CNY", orgId);

		await openProtected(page, "/organization/members", owner.accessToken);
		const ownerRow = page
			.getByTestId("member-row")
			.filter({ hasText: owner.email });
		await expect(ownerRow).toBeVisible();
		await expect(ownerRow).toContainText("所有者");
		await expect(ownerRow.getByTestId("role-select")).toHaveCount(0);
		await expect(page.getByTestId("leave-organization-entry")).toHaveCount(0);

		const members = await api<MemberView[]>(
			"/api/organizations/current/members",
			{
				method: "GET",
				token: owner.accessToken,
				headers: orgHeaders(orgId),
			},
		);
		const ownerMember = members.find((m) => m.userId === owner.userId)!;

		const leaveRes = await rawApi("/api/organizations/current/members/leave", {
			method: "POST",
			token: owner.accessToken,
			organizationId: orgId,
		});
		expect(leaveRes.status).toBe(409);
		expect(leaveRes.json.code).toBe("LAST_OWNER_REQUIRED");

		const demoteRes = await rawApi(
			`/api/organizations/current/members/${assertShape(ownerMember.id, SERVER_ID_SHAPE, "成员 id")}`,
			{
				method: "PATCH",
				token: owner.accessToken,
				organizationId: orgId,
				body: { role: "ADMIN" },
			},
		);
		expect(demoteRes.status).toBe(409);
		expect(demoteRes.json.code).toBe("LAST_OWNER_REQUIRED");
	});
});

test.describe("【GWT-6..14】邀请边界 / 五角色权限 / 跨组织隔离 / 降权移除转移", () => {
	test("GWT-6: 未登录访问邀请链接 → 跳转 /login?redirect=... → 登录后回跳接受并可见共享账本", async ({
		page,
	}, testInfo) => {
		const owner = await seedRegisterAndLogin(
			retryLabel("gwt6-owner", testInfo.retry),
		);
		const invitee = await seedRegisterAndLogin(
			retryLabel("gwt6-finance", testInfo.retry),
		);
		const orgId = owner.defaultOrganizationId;
		await seedOnboarding(owner.accessToken, "CNY", orgId);
		await seedOnboarding(
			invitee.accessToken,
			"CNY",
			invitee.defaultOrganizationId,
		);
		await seedTransaction(owner.accessToken, "USD", "3200", orgId);

		const invitation = await createInvitationViaApi(
			owner.accessToken,
			orgId,
			invitee.email,
			"FINANCE",
		);
		const invitePath = `/invitations/${assertShape(invitation.token, INVITATION_TOKEN_SHAPE, "邀请 token")}`;

		// 未登录访问 /invitations/<token> → 自动跳转 /login?redirect=...
		await page.goto(`${BASE_URL}${invitePath}`);
		await expect(page).toHaveURL(
			(url) =>
				url.pathname === "/login" &&
				url.searchParams.get("redirect") === invitePath,
		);
		await page.waitForLoadState("networkidle");

		// 登录表单完成登录 → 自动回跳 /invitations/<token>
		await page.fill('input[name="email"]', invitee.email);
		await page.fill('input[name="password"]', invitee.password);
		const age18 = page.getByTestId("consent-age18");
		const terms = page.getByTestId("consent-terms");
		await age18.check();
		await terms.check();
		await expect(age18).toBeChecked();
		await expect(terms).toBeChecked();
		await page.click('button[type="submit"]');

		await expect(page).toHaveURL(`${BASE_URL}${invitePath}`);
		await page.getByTestId("invitation-accept").click();
		await expect(page.getByText("已加入组织")).toBeVisible();

		await page.getByRole("link", { name: "进入工作台" }).click();
		await expect(page).toHaveURL(/\/home/);
		await page.goto(`${BASE_URL}/accounts`);
		const usdRow = page.locator("tbody tr").filter({ hasText: "USD" });
		await expect(usdRow).toBeVisible();
		await expect(usdRow).toContainText("3200.0000");
	});

	test("GWT-7: 错误邮箱拒绝接受——邮箱 B 打开邮箱 A 邀请被拒且不产生成员关系", async ({
		page,
	}, testInfo) => {
		const owner = await seedRegisterAndLogin(
			retryLabel("gwt7-owner", testInfo.retry),
		);
		const intended = await seedRegisterAndLogin(
			retryLabel("gwt7-a", testInfo.retry),
		);
		const wrongUser = await seedRegisterAndLogin(
			retryLabel("gwt7-b", testInfo.retry),
		);
		const orgId = owner.defaultOrganizationId;
		await seedOnboarding(owner.accessToken, "CNY", orgId);

		const invitation = await createInvitationViaApi(
			owner.accessToken,
			orgId,
			intended.email,
			"FINANCE",
		);
		const token = assertShape(
			invitation.token,
			INVITATION_TOKEN_SHAPE,
			"邀请 token",
		);

		await openProtected(page, `/invitations/${token}`, wrongUser.accessToken);
		await expect(page.locator("main").getByRole("alert")).toContainText(
			"邀请邮箱与当前登录邮箱不一致",
		);
		await expect(page.getByTestId("invitation-accept")).toHaveCount(0);

		const acceptRes = await rawApi(
			`/api/organization-invitations/${token}/accept`,
			{
				method: "POST",
				token: wrongUser.accessToken,
			},
		);
		expect(acceptRes.status).toBe(403);
		expect(acceptRes.json.code).toBe("INVITATION_EMAIL_MISMATCH");

		const members = await api<MemberView[]>(
			"/api/organizations/current/members",
			{
				method: "GET",
				token: owner.accessToken,
				headers: orgHeaders(orgId),
			},
		);
		expect(members.some((m) => m.userId === wrongUser.userId)).toBe(false);
	});

	test("GWT-8: 过期 / 撤销 / 重放邀请链接均被拒绝，不新增成员", async ({
		page,
	}) => {
		const owner = await seedRegisterAndLogin("gwt8-owner");
		const userRevoked = await seedRegisterAndLogin("gwt8-revoked");
		const userExpired = await seedRegisterAndLogin("gwt8-expired");
		const userReplayed = await seedRegisterAndLogin("gwt8-replayed");
		const orgId = owner.defaultOrganizationId;
		await seedOnboarding(owner.accessToken, "CNY", orgId);

		// 1. 撤销邀请
		const revokedInv = await createInvitationViaApi(
			owner.accessToken,
			orgId,
			userRevoked.email,
			"VIEWER",
		);
		await openProtected(page, "/organization/members", owner.accessToken);
		const revokeRow = page
			.getByTestId("invitation-row")
			.filter({ hasText: userRevoked.email });
		await revokeRow.getByTestId("invitation-revoke").click();
		await expect(revokeRow).toContainText("已撤回");

		await openProtected(
			page,
			`/invitations/${assertShape(revokedInv.token, INVITATION_TOKEN_SHAPE, "撤回 token")}`,
			userRevoked.accessToken,
		);
		await expect(page.getByText(/REVOKED.*不可再接受/)).toBeVisible();
		await expect(page.getByTestId("invitation-accept")).toHaveCount(0);
		const revokedAccept = await rawApi(
			`/api/organization-invitations/${revokedInv.token}/accept`,
			{ method: "POST", token: userRevoked.accessToken },
		);
		expect(revokedAccept.status).toBe(409);

		// 2. 过期邀请（DB 置 expiresAt 过去时刻，不等待 7 天）
		const expiredInv = await createInvitationViaApi(
			owner.accessToken,
			orgId,
			userExpired.email,
			"VIEWER",
		);
		await expireInvitationForTest(expiredInv.id);
		await openProtected(
			page,
			`/invitations/${assertShape(expiredInv.token, INVITATION_TOKEN_SHAPE, "过期 token")}`,
			userExpired.accessToken,
		);
		await expect(page.getByText(/EXPIRED.*不可再接受/)).toBeVisible();
		await expect(page.getByTestId("invitation-accept")).toHaveCount(0);
		const expiredAccept = await rawApi(
			`/api/organization-invitations/${expiredInv.token}/accept`,
			{ method: "POST", token: userExpired.accessToken },
		);
		expect(expiredAccept.status).toBe(409);

		// 3. 已接受邀请重放
		const replayInv = await createInvitationViaApi(
			owner.accessToken,
			orgId,
			userReplayed.email,
			"VIEWER",
		);
		const replayToken = assertShape(
			replayInv.token,
			INVITATION_TOKEN_SHAPE,
			"重放 token",
		);
		await openProtected(
			page,
			`/invitations/${replayToken}`,
			userReplayed.accessToken,
		);
		await page.getByTestId("invitation-accept").click();
		await expect(page.getByText("已加入组织")).toBeVisible();

		await page.goto(`${BASE_URL}/invitations/${replayToken}`);
		await expect(page.getByText(/ACCEPTED.*不可再接受/)).toBeVisible();
		await expect(page.getByTestId("invitation-accept")).toHaveCount(0);
		const replayAccept = await rawApi(
			`/api/organization-invitations/${replayToken}/accept`,
			{ method: "POST", token: userReplayed.accessToken },
		);
		expect(replayAccept.status).toBe(409);

		const members = await api<MemberView[]>(
			"/api/organizations/current/members",
			{
				method: "GET",
				token: owner.accessToken,
				headers: orgHeaders(orgId),
			},
		);
		expect(members.some((m) => m.userId === userRevoked.userId)).toBe(false);
		expect(members.some((m) => m.userId === userExpired.userId)).toBe(false);
		expect(members.some((m) => m.userId === userReplayed.userId)).toBe(true);
	});

	test("GWT-9 & GWT-10: 五角色关键路径——Operator 建计划可/记账拒；Viewer 只读且越权写进 DENIED 审计", async ({
		page,
		browser,
	}, testInfo) => {
		const owner = await seedRegisterAndLogin(
			retryLabel("gwt9-owner", testInfo.retry),
		);
		const admin = await seedRegisterAndLogin(
			retryLabel("gwt9-admin", testInfo.retry),
		);
		const operator = await seedRegisterAndLogin(
			retryLabel("gwt9-operator", testInfo.retry),
		);
		const viewer = await seedRegisterAndLogin(
			retryLabel("gwt9-viewer", testInfo.retry),
		);
		const orgId = owner.defaultOrganizationId;
		await seedOnboarding(owner.accessToken, "CNY", orgId);
		const txId = await seedTransaction(owner.accessToken, "USD", "5000", orgId);
		const orgName = (await listOrganizations(owner.accessToken))[0]!.name;

		await inviteAndJoinViaApi(owner.accessToken, orgId, admin, "ADMIN");
		await inviteAndJoinViaApi(owner.accessToken, orgId, operator, "OPERATOR");
		await inviteAndJoinViaApi(owner.accessToken, orgId, viewer, "VIEWER");

		// Admin 关键路径：可读审计/可见清空入口/不可见删除组织与转移所有权
		const adminCtx = await browser.newContext();
		const adminPage = await adminCtx.newPage();
		try {
			await openProtected(adminPage, "/organization/members", admin.accessToken);
			await pickOrganization(adminPage, orgName);
			await expect(adminPage.getByTestId("invite-form")).toBeVisible();
			await expect(
				adminPage.getByTestId("transfer-ownership-entry"),
			).toHaveCount(0);
			await adminPage.goto(`${BASE_URL}/settings`);
			await expect(adminPage.getByTestId("account-data-clear")).toBeVisible();
			await expect(
				adminPage.getByTestId("organization-data-delete"),
			).toHaveCount(0);
		} finally {
			await adminCtx.close();
		}

		// Operator 边界：UI 可创建计划；买入与更正呈无权提示；API 写买入/更正 403 且账本不变
		const opPlanName = `GWT9 Operator 计划 ${Date.now()}`;
		await openProtected(page, "/plans/new", operator.accessToken);
		await pickOrganization(page, orgName);
		await page.fill("#plan-name", opPlanName);
		await selectRadixOption(
			page,
			page.locator('[aria-label="目标币种"]'),
			"USD · 美元",
		);
		await page.fill("#plan-target-amount", "1000");
		await page.fill("#plan-expect-use-date", "2030-05-15");
		const createBtn = page.getByRole("button", { name: "创建计划" });
		await expect(createBtn).toBeEnabled();
		await createBtn.click();
		await expect(page).toHaveURL(new RegExp(`${escapeRegExp(BASE_URL)}/home$`));
		await expect(page.getByRole("heading", { name: opPlanName })).toBeVisible();

		await page.goto(`${BASE_URL}/transactions/new`);
		await expect(
			page.getByTestId("transaction-create-no-permission"),
		).toBeVisible();
		await page.goto(
			`${BASE_URL}/corrections/new?targetType=TRANSACTION&targetId=${txId}`,
		);
		await expect(page.getByTestId("correction-no-permission")).toBeVisible();

		const opTxRes = await rawApi("/api/transactions", {
			method: "POST",
			token: operator.accessToken,
			organizationId: orgId,
			body: {
				currencyCode: "USD",
				principalAmount: "100",
				exchangeRate: "1",
				quantity: "100",
				feeAmount: "0",
				transactedAt: new Date().toISOString(),
			},
		});
		expect(opTxRes.status).toBe(403);
		expect(opTxRes.json.code).toBe("PERMISSION_DENIED");
		const accountAfterOp = await api<{ balance: string }>("/api/accounts/USD", {
			method: "GET",
			token: owner.accessToken,
			headers: orgHeaders(orgId),
		});
		expect(accountAfterOp.balance).toBe("5000.0000");

		// Viewer 边界：UI 无新建入口与无权限提示；绕过界面构造写请求被 403 且审计落 DENIED
		const viewerCtx = await browser.newContext();
		const viewerPage = await viewerCtx.newPage();
		try {
			await openProtected(viewerPage, "/plans", viewer.accessToken);
			await pickOrganization(viewerPage, orgName);
			await expect(viewerPage.getByTestId("plan-create-entry")).toHaveCount(0);
			await viewerPage.goto(`${BASE_URL}/plans/new`);
			await expect(
				viewerPage.getByTestId("plan-create-no-permission"),
			).toBeVisible();
			await viewerPage.goto(`${BASE_URL}/settings`);
			await expect(
				viewerPage.getByTestId("organization-data-readonly-note"),
			).toBeVisible();
		} finally {
			await viewerCtx.close();
		}

		const viewerPlanRes = await rawApi("/api/plans", {
			method: "POST",
			token: viewer.accessToken,
			organizationId: orgId,
			body: {
				targetCurrency: "USD",
				targetAmount: "1000",
				expectUseDate: "2030-05-15T00:00:00.000Z",
				prepLeadDays: 3,
				pacePreference: "balanced",
				allocatedAmount: "0",
			},
		});
		expect(viewerPlanRes.status).toBe(403);
		expect(viewerPlanRes.json.code).toBe("PERMISSION_DENIED");

		await openProtected(page, "/organization/audit", owner.accessToken);
		await expect(page.getByTestId("audit-log-table")).toContainText("已拒绝");
		await expect(page.getByTestId("audit-log-table")).toContainText(
			"permission.denied",
		);
	});

	test("GWT-11: 跨组织隔离——仅属 A 的成员用 B 的记录 ID 访问详情/修改/导出均 404", async ({
		page,
	}) => {
		const memberA = await seedRegisterAndLogin("gwt11-member-a");
		const ownerB = await seedRegisterAndLogin("gwt11-owner-b");
		await seedOnboarding(
			memberA.accessToken,
			"CNY",
			memberA.defaultOrganizationId,
		);
		await seedOnboarding(
			ownerB.accessToken,
			"CNY",
			ownerB.defaultOrganizationId,
		);
		const bTxId = await seedTransaction(
			ownerB.accessToken,
			"USD",
			"2000",
			ownerB.defaultOrganizationId,
		);
		const bPlanId = await seedPlanWithAllocation(
			ownerB.accessToken,
			"USD",
			"1000",
			"OrgB 私密计划",
			ownerB.defaultOrganizationId,
		);

		// 为 ownerB 生成一份组织导出包（用于校验跨组织下载返回 404）
		const otp = await api<{ challengeId: string; devCode?: string }>(
			"/api/auth/otp/send-code",
			{
				method: "POST",
				body: { channel: "email", target: ownerB.email, purpose: "EXPORT" },
			},
		);
		await api("/api/organizations/current/data-requests/verify", {
			method: "POST",
			token: ownerB.accessToken,
			headers: orgHeaders(ownerB.defaultOrganizationId),
			body: {
				challengeId: otp.challengeId,
				purpose: "EXPORT",
				code: otp.devCode ?? "",
			},
		});
		const bExport = await api<{ id: string }>(
			"/api/organizations/current/data-requests",
			{
				method: "POST",
				token: ownerB.accessToken,
				headers: orgHeaders(ownerB.defaultOrganizationId),
				body: {
					type: "EXPORT",
					scope: "ORGANIZATION",
					challengeId: otp.challengeId,
				},
			},
		);

		// UI 层：访问 B 的计划详情 / 交易详情均提示不存在
		await openProtected(page, `/plans/${bPlanId}`, memberA.accessToken);
		await expect(page.getByText("换汇计划不存在")).toBeVisible();
		await page.goto(`${BASE_URL}/transactions/${bTxId}`);
		await expect(page.getByText("交易记录不存在")).toBeVisible();

		// API 层：带 Org A 头查/改/更正/报告/导出下载 B 的资源 → 全部 404；带 Org B 头（非成员）→ 404 ORGANIZATION_NOT_FOUND
		const crossPlan = await rawApi(`/api/plans/${bPlanId}`, {
			method: "GET",
			token: memberA.accessToken,
			organizationId: memberA.defaultOrganizationId,
		});
		expect(crossPlan.status).toBe(404);

		const crossPlanModify = await rawApi(`/api/plans/${bPlanId}`, {
			method: "PATCH",
			token: memberA.accessToken,
			organizationId: memberA.defaultOrganizationId,
			body: {
				newTargetAmount: "1500",
				expectedUpdatedAt: new Date().toISOString(),
			},
		});
		expect(crossPlanModify.status).toBe(404);

		const crossTx = await rawApi(`/api/transactions/${bTxId}`, {
			method: "GET",
			token: memberA.accessToken,
			organizationId: memberA.defaultOrganizationId,
		});
		expect(crossTx.status).toBe(404);

		const crossCorrection = await rawApi("/api/corrections", {
			method: "POST",
			token: memberA.accessToken,
			organizationId: memberA.defaultOrganizationId,
			body: {
				targetType: "TRANSACTION",
				targetId: bTxId,
				baseVersion: 1,
				reason: "跨组织越权更正尝试",
				changes: { feeAmount: "10" },
			},
		});
		expect(crossCorrection.status).toBe(404);

		const crossReport = await rawApi(`/api/reports/plans/${bPlanId}`, {
			method: "GET",
			token: memberA.accessToken,
			organizationId: memberA.defaultOrganizationId,
		});
		expect(crossReport.status).toBe(404);

		const crossExportDownload = await rawApi(
			`/api/organizations/current/data-requests/${assertShape(bExport.id, SERVER_ID_SHAPE, "OrgB 导出 id")}/download`,
			{
				method: "GET",
				token: memberA.accessToken,
				organizationId: memberA.defaultOrganizationId,
			},
		);
		expect(crossExportDownload.status).toBe(404);

		const nonMember = await rawApi(`/api/plans/${bPlanId}`, {
			method: "GET",
			token: memberA.accessToken,
			organizationId: ownerB.defaultOrganizationId,
		});
		expect(nonMember.status).toBe(404);
		expect(nonMember.json.code).toBe("ORGANIZATION_NOT_FOUND");
	});

	test("GWT-12: 即时降权——Finance 降为 Viewer 后，旧页面直接提交买入立即按 Viewer 拒绝（403）", async ({
		page,
	}) => {
		const owner = await seedRegisterAndLogin("gwt12-owner");
		const finance = await seedRegisterAndLogin("gwt12-finance");
		const orgId = owner.defaultOrganizationId;
		await seedOnboarding(owner.accessToken, "CNY", orgId);
		await seedOnboarding(
			finance.accessToken,
			"CNY",
			finance.defaultOrganizationId,
		);
		const orgName = (await listOrganizations(owner.accessToken))[0]!.name;
		const { membershipId } = await inviteAndJoinViaApi(
			owner.accessToken,
			orgId,
			finance,
			"FINANCE",
		);

		// Finance 打开旧页面 /transactions/new 并挂载表单
		await openProtected(page, "/transactions/new", finance.accessToken);
		await pickOrganization(page, orgName);
		await selectRadixOption(
			page,
			page.locator('[aria-label="买入币种"]'),
			"USD · 美元",
		);
		await page.fill("#transaction-principal", "500");
		await page.fill("#transaction-exchange-rate", "1");

		// Owner 在后台立即将其降权为 VIEWER（Finance 不刷新页面、不换 JWT）
		await api(
			`/api/organizations/current/members/${assertShape(membershipId, SERVER_ID_SHAPE, "成员 id")}`,
			{
				method: "PATCH",
				token: owner.accessToken,
				headers: orgHeaders(orgId),
				body: { role: "VIEWER" },
			},
		);

		// Finance 在旧页面直接提交 → 服务端实时查角色返回 403 PERMISSION_DENIED
		const [postResp] = await Promise.all([
			page.waitForResponse(
				(res) =>
					new URL(res.url()).pathname === "/api/transactions" &&
					res.request().method() === "POST",
			),
			page.click('button:has-text("保存")'),
		]);
		expect(postResp.status()).toBe(403);
		expect(await postResp.json()).toMatchObject({ code: "PERMISSION_DENIED" });
	});

	test("GWT-13: 成员移除——被移除后旧浏览器上下文刷新页面失去该组织访问权", async ({
		page,
	}) => {
		const owner = await seedRegisterAndLogin("gwt13-owner");
		const member = await seedRegisterAndLogin("gwt13-member");
		const orgId = owner.defaultOrganizationId;
		await seedOnboarding(owner.accessToken, "CNY", orgId);
		await seedOnboarding(
			member.accessToken,
			"CNY",
			member.defaultOrganizationId,
		);
		const orgAPlanName = `GWT13 OrgA 计划 ${Date.now()}`;
		await seedPlanWithAllocation(
			owner.accessToken,
			"USD",
			"0",
			orgAPlanName,
			orgId,
		);
		const orgName = (await listOrganizations(owner.accessToken))[0]!.name;
		const { membershipId } = await inviteAndJoinViaApi(
			owner.accessToken,
			orgId,
			member,
			"OPERATOR",
		);

		// 成员进入 Org A 计划列表并看到计划
		await openProtected(page, "/plans", member.accessToken);
		await pickOrganization(page, orgName);
		await expect(page.getByText(orgAPlanName)).toBeVisible();

		// Owner 移除成员（DISABLED）
		await api(
			`/api/organizations/current/members/${assertShape(membershipId, SERVER_ID_SHAPE, "成员 id")}`,
			{
				method: "DELETE",
				token: owner.accessToken,
				headers: orgHeaders(orgId),
			},
		);

		// 旧浏览器上下文刷新：回到单组织默认态与空计划列表，不再看到 Org A 的计划
		await page.reload();
		await expect(page.getByTestId("organization-switcher-single")).toBeVisible();
		await expect(page.getByText("还没有换汇计划")).toBeVisible();
		await expect(page.getByText(orgAPlanName)).toHaveCount(0);

		const apiCheck = await rawApi("/api/plans", {
			method: "GET",
			token: member.accessToken,
			organizationId: orgId,
		});
		expect(apiCheck.status).toBe(404);
		expect(apiCheck.json.code).toBe("ORGANIZATION_NOT_FOUND");
	});

	test("GWT-14: 所有权转移——新 Owner 可管理组织，原 Owner 降为 Admin，审计包含双方与组织", async ({
		page,
		browser,
	}, testInfo) => {
		const owner = await seedRegisterAndLogin(
			retryLabel("gwt14-owner", testInfo.retry),
		);
		const admin = await seedRegisterAndLogin(
			retryLabel("gwt14-admin", testInfo.retry),
		);
		const orgId = owner.defaultOrganizationId;
		await seedOnboarding(owner.accessToken, "CNY", orgId);
		await seedOnboarding(admin.accessToken, "CNY", admin.defaultOrganizationId);
		const orgName = (await listOrganizations(owner.accessToken))[0]!.name;
		const { membershipId: adminMembershipId } = await inviteAndJoinViaApi(
			owner.accessToken,
			orgId,
			admin,
			"ADMIN",
		);

		await openProtected(page, "/organization/members", owner.accessToken);
		const adminRow = page
			.getByTestId("member-row")
			.filter({ hasText: admin.email });
		await adminRow.getByTestId("transfer-ownership-entry").click();
		await page.getByTestId("transfer-ownership-confirm").click();

		// 原 Owner 变为 ADMIN（RoleSelect 对 Admin 渲染中文标签「管理员」，新 Owner 渲染「所有者」），不再具备转移所有权按钮
		await expect(page.getByTestId("transfer-ownership-entry")).toHaveCount(0);
		await expect(
			page.getByTestId("member-row").filter({ hasText: owner.email }),
		).toContainText("管理员");
		await expect(adminRow).toContainText("所有者");

		// 审计留痕包含 owner.transfer、组织、双方 userId/membershipId 与 detail.toUserId
		await page.goto(`${BASE_URL}/organization/audit`);
		await expect(page.getByTestId("audit-log-table")).toContainText(
			"owner.transfer",
		);
		const transferAudit = await api<AuditLogList>(
			"/api/organizations/current/audit-logs?action=owner.transfer&page=1&pageSize=20",
			{
				method: "GET",
				token: owner.accessToken,
				headers: orgHeaders(orgId),
			},
		);
		expect(transferAudit.items[0]).toMatchObject({
			organizationId: orgId,
			actorUserId: owner.userId,
			action: "owner.transfer",
			targetType: "membership",
			targetId: adminMembershipId,
			result: "SUCCESS",
			detail: expect.objectContaining({
				toUserId: admin.userId,
			}),
		});

		// 新 Owner 在独立上下文中拥有 OWNER 权限（隔离原 Owner 的 localStorage activeOrganizationId）
		const newOwnerCtx = await browser.newContext();
		const newOwnerPage = await newOwnerCtx.newPage();
		try {
			await openProtected(newOwnerPage, "/organization", admin.accessToken);
			await pickOrganization(newOwnerPage, orgName);
			await expect(
				newOwnerPage.getByTestId("organization-form"),
			).toContainText("所有者");
			await newOwnerPage.goto(`${BASE_URL}/organization/members`);
			await expect(
				newOwnerPage
					.getByTestId("member-row")
					.filter({ hasText: owner.email })
					.getByTestId("transfer-ownership-entry"),
			).toBeVisible();
			await newOwnerPage.goto(`${BASE_URL}/settings`);
			await expect(
				newOwnerPage.getByTestId("organization-data-delete"),
			).toBeVisible();
		} finally {
			await newOwnerCtx.close();
		}
	});
});

test.describe("【GWT-15..18】共享账本一致性 / 并发更正冲突 / 使用更正闭环 / 个人已读", () => {
	test("GWT-15: 共享账本一致性——Finance 录入买入后 Operator 刷新看到相同余额/成本/操作者审计", async ({
		page,
		browser,
	}) => {
		const owner = await seedRegisterAndLogin("gwt15-owner");
		const finance = await seedRegisterAndLogin("gwt15-finance");
		const operator = await seedRegisterAndLogin("gwt15-operator");
		const orgId = owner.defaultOrganizationId;
		await seedOnboarding(owner.accessToken, "CNY", orgId);
		await seedOnboarding(
			finance.accessToken,
			"CNY",
			finance.defaultOrganizationId,
		);
		await seedOnboarding(
			operator.accessToken,
			"CNY",
			operator.defaultOrganizationId,
		);
		const orgName = (await listOrganizations(owner.accessToken))[0]!.name;
		await inviteAndJoinViaApi(owner.accessToken, orgId, finance, "FINANCE");
		await inviteAndJoinViaApi(owner.accessToken, orgId, operator, "OPERATOR");

		// Finance 在页面录入买入：1400 CNY，汇率 7 → 200 USD
		await openProtected(page, "/transactions/new", finance.accessToken);
		await pickOrganization(page, orgName);
		await selectRadixOption(
			page,
			page.locator('[aria-label="买入币种"]'),
			"USD · 美元",
		);
		await page.fill("#transaction-principal", "1400");
		await page.fill("#transaction-exchange-rate", "7");
		await page.fill("#transaction-fee", "0");
		await page.click('button:has-text("保存")');
		await expect(page).toHaveURL(/\/transactions\/(?!new)[^/?]+$/);

		// Operator 在独立上下文进入 /accounts/USD，看到相同余额与单位成本
		const opCtx = await browser.newContext();
		const opPage = await opCtx.newPage();
		try {
			await openProtected(opPage, "/accounts/USD", operator.accessToken);
			await pickOrganization(opPage, orgName);
			await expect(opPage.getByText("200.0000").first()).toBeVisible();
			await expect(opPage.getByText("1400.0000").first()).toBeVisible();
			await expect(opPage.getByText("7.00000000").first()).toBeVisible();
		} finally {
			await opCtx.close();
		}

		// 审计记录中明确标注操作者（Finance userId 前缀）
		await page.goto(`${BASE_URL}/organization/audit`);
		const txAuditRow = page
			.getByTestId("audit-log-table")
			.locator("tr")
			.filter({ hasText: "transaction.create" })
			.first();
		await expect(txAuditRow).toContainText(finance.userId.slice(0, 8));
	});

	test("GWT-16: 并发更正冲突——A 预览后 B 先修改目标记录，A 提交旧预览被 409 拒绝且不覆盖 B", async ({
		page,
	}) => {
		const owner = await seedRegisterAndLogin("gwt16-owner");
		const financeA = await seedRegisterAndLogin("gwt16-fin-a");
		const financeB = await seedRegisterAndLogin("gwt16-fin-b");
		const orgId = owner.defaultOrganizationId;
		await seedOnboarding(owner.accessToken, "CNY", orgId);
		await seedOnboarding(
			financeA.accessToken,
			"CNY",
			financeA.defaultOrganizationId,
		);
		await seedOnboarding(
			financeB.accessToken,
			"CNY",
			financeB.defaultOrganizationId,
		);
		const orgName = (await listOrganizations(owner.accessToken))[0]!.name;
		await inviteAndJoinViaApi(owner.accessToken, orgId, financeA, "FINANCE");
		await inviteAndJoinViaApi(owner.accessToken, orgId, financeB, "FINANCE");

		const txId = await seedTransaction(owner.accessToken, "HKD", "1000", orgId);

		// Finance A 打开更正页并完成预览（此时目标 version=1）
		await openProtected(
			page,
			`/corrections/new?targetType=TRANSACTION&targetId=${txId}`,
			financeA.accessToken,
		);
		await pickOrganization(page, orgName);
		await page.selectOption("#correction-fee-mode", "value");
		await page.fill("#correction-fee-amount", "10");
		await page.fill("#correction-reason", "成员 A 拟修改手续费为 10");
		await page.getByTestId("correction-preview-button").click();
		await expect(
			page.getByTestId("correction-confirm-button"),
		).toBeEnabled();

		// Finance B 抢先将同一交易更正为手续费 25（version 1 → 2）
		await api("/api/corrections", {
			method: "POST",
			token: financeB.accessToken,
			headers: orgHeaders(orgId),
			body: {
				targetType: "TRANSACTION",
				targetId: txId,
				baseVersion: 1,
				reason: "成员 B 抢先更正手续费为 25",
				changes: { feeAmount: "25" },
			},
		});

		// Finance A 提交旧预览 → 409 CORRECTION_TARGET_CHANGED，显示过期提示与重载后的最新版本，B 结果不被覆盖
		const [conflictResp] = await Promise.all([
			page.waitForResponse(
				(res) =>
					new URL(res.url()).pathname === "/api/corrections" &&
					res.request().method() === "POST",
			),
			page.getByTestId("correction-confirm-button").click(),
		]);
		expect(conflictResp.status()).toBe(409);
		expect(await conflictResp.json()).toMatchObject({
			code: "CORRECTION_TARGET_CHANGED",
		});
		await expect(
			page.getByText(
				"该记录刚被其他修改更新，已为您重新加载最新内容，请重新查看影响后再提交。",
			),
		).toBeVisible();
		// TRANSACTION 冲突后会保留当前预览表单并自动重载最新目标（v2 / 手续费 25.0000）
		await expect(page.getByText("v2", { exact: true })).toBeVisible();
		await expect(page.getByText("25.0000").first()).toBeVisible();

		const latestTx = await api<{ feeAmount: string | null; version: number }>(
			`/api/transactions/${txId}`,
			{
				method: "GET",
				token: owner.accessToken,
				headers: orgHeaders(orgId),
			},
		);
		expect(latestTx).toMatchObject({ version: 2, feeAmount: "25.0000" });

		// 基于重载后的 v2 重新预览影响：展示 25.0000 → 10.0000，证明确认基线已更新
		await page.getByTestId("correction-preview-button").click();
		await expect(page.getByText("25.0000 → 10.0000")).toBeVisible();
	});

	test("GWT-17: 组织级 USAGE 更正端到端闭环——余额/分配/FIFO 成本/报告/审计全一致", async ({
		page,
	}) => {
		const owner = await seedRegisterAndLogin("gwt17-owner");
		const finance = await seedRegisterAndLogin("gwt17-finance");
		const orgId = owner.defaultOrganizationId;
		await seedOnboarding(owner.accessToken, "CNY", orgId);
		await seedOnboarding(
			finance.accessToken,
			"CNY",
			finance.defaultOrganizationId,
		);
		const orgName = (await listOrganizations(owner.accessToken))[0]!.name;
		await inviteAndJoinViaApi(owner.accessToken, orgId, finance, "FINANCE");

		await seedTransaction(owner.accessToken, "CAD", "7800", orgId);
		const planName = `GWT17 使用更正计划 ${Date.now()}`;
		const planId = await seedPlanWithAllocation(
			owner.accessToken,
			"CAD",
			"3000",
			planName,
			orgId,
		);
		await seedUsage(finance.accessToken, planId, "800", orgId);

		await openProtected(page, `/plans/${planId}`, finance.accessToken);
		await pickOrganization(page, orgName);
		await page.getByTestId("usage-correction-entry").click();
		await page.fill("#correction-使用金额", "500");
		await page.fill("#correction-reason", "组织使用记录多记 300");
		await page.getByTestId("correction-preview-button").click();
		await expect(
			page.getByText("未分配余额 +300.0000 CAD（收到返还）", { exact: true }),
		).toBeVisible();
		await page.getByTestId("correction-confirm-button").click();

		await expect(page).toHaveURL(`${BASE_URL}/plans/${planId}`);
		await expect(page.getByText("500 CAD", { exact: true })).toBeVisible();

		// 账户余额与分配一致（7800 - 500 = 7300；剩余分配 2200；未分配 5100）
		await page.goto(`${BASE_URL}/accounts/CAD`);
		await expect(page.getByText("7300.0000").first()).toBeVisible();
		await expect(page.getByText("2200.0000").first()).toBeVisible();
		await expect(page.getByText("5100.0000").first()).toBeVisible();

		// 报告页 FIFO 成本与已使用数量一致
		await page.goto(`${BASE_URL}/reports`);
		const row = page
			.getByTestId("report-plan-row")
			.filter({ hasText: planName });
		await expect(row).toContainText("500");

		// 审计日志显示组织操作者与动作
		await page.goto(`${BASE_URL}/organization/audit`);
		const auditRow = page
			.getByTestId("audit-log-table")
			.locator("tr")
			.filter({ hasText: "correction.apply" })
			.first();
		await expect(auditRow).toContainText(finance.userId.slice(0, 8));
		await expect(auditRow).toContainText("成功");
	});

	test("GWT-18: 双成员个人 ReminderRead 互不清除——Owner 已读后 Finance 仍未读", async ({
		page,
		browser,
	}) => {
		const owner = await seedRegisterAndLogin("gwt18-owner");
		const finance = await seedRegisterAndLogin("gwt18-finance");
		const orgId = owner.defaultOrganizationId;
		await seedOnboarding(owner.accessToken, "CNY", orgId);
		await seedOnboarding(
			finance.accessToken,
			"CNY",
			finance.defaultOrganizationId,
		);
		const orgName = (await listOrganizations(owner.accessToken))[0]!.name;
		await inviteAndJoinViaApi(owner.accessToken, orgId, finance, "FINANCE");

		// COMPLETE_READY（used == target && 剩余分配 == 0）无工作日限制，全天候稳定触发
		await seedTransaction(owner.accessToken, "USD", "10000", orgId);
		const planId = await seedFullyAllocatedPlan(
			owner.accessToken,
			"USD",
			"10000",
			"6000",
			orgId,
		);
		await seedUsage(owner.accessToken, planId, "10000", orgId);

		// Owner 标为已读
		await openProtected(page, "/reminders", owner.accessToken);
		const ownerCard = page.getByTestId("reminder-card").first();
		await expect(ownerCard).toBeVisible();
		await expect(ownerCard).toHaveAttribute("data-read", "false");
		await page.getByTestId("reminder-read-all").click();
		await expect(ownerCard).toHaveAttribute("data-read", "true");
		await expect(page.getByTestId("reminder-unread-dot")).toHaveCount(0);

		// Finance 在独立浏览器上下文打开 /reminders：未读状态仍然存在
		const finCtx = await browser.newContext();
		const finPage = await finCtx.newPage();
		try {
			await openProtected(finPage, "/reminders", finance.accessToken);
			await pickOrganization(finPage, orgName);
			const finCard = finPage.getByTestId("reminder-card").first();
			await expect(finCard).toBeVisible();
			await expect(finCard).toHaveAttribute("data-read", "false");
			await expect(finCard.getByTestId("reminder-unread-dot")).toBeVisible();
		} finally {
			await finCtx.close();
		}
	});
});

test.describe("【GWT-26..30】组织清空隔离 / 最后 Owner 注销 / 导出移除阻断 / 审计完整与不可改", () => {
	test("GWT-26: Org A 清空不影响成员在 Org B 的数据（记账起点重置 + Org B 数据不变）", async ({
		page,
		browser,
	}) => {
		const adminA = await seedRegisterAndLogin("gwt26-owner-a");
		const memberB = await seedRegisterAndLogin("gwt26-member-b");
		const orgAId = adminA.defaultOrganizationId;
		const orgBId = memberB.defaultOrganizationId;
		await seedOnboarding(adminA.accessToken, "CNY", orgAId);
		await seedOnboarding(memberB.accessToken, "USD", orgBId);

		await seedTransaction(adminA.accessToken, "USD", "777", orgAId);
		const planAName = `GWT26 OrgA 清空目标 ${Date.now()}`;
		await seedPlanWithAllocation(
			adminA.accessToken,
			"USD",
			"500",
			planAName,
			orgAId,
		);
		await inviteAndJoinViaApi(adminA.accessToken, orgAId, memberB, "FINANCE");

		await seedTransaction(memberB.accessToken, "EUR", "888", orgBId);
		const planBName = `GWT26 OrgB 保留计划 ${Date.now()}`;
		await seedPlanWithAllocation(
			memberB.accessToken,
			"EUR",
			"400",
			planBName,
			orgBId,
		);
		const orgBName = (await listOrganizations(memberB.accessToken)).find(
			(o) => o.id === orgBId,
		)!.name;

		// Admin A 在设置页提交 Org A 清空
		await openProtected(page, "/settings", adminA.accessToken);
		await page.getByTestId("account-data-clear").click();
		await page.getByTestId("clear-start-verify").click();
		await page.getByTestId("otp-send-clear").click();
		await expect(page.getByTestId("otp-code-input")).toHaveValue(/^\d{6}$/, {
			timeout: 15000,
		});
		await page.getByTestId("otp-verify-submit").click();
		await page.getByTestId("clear-confirm-submit").click();
		await expect(page.getByTestId("request-progress")).toBeVisible({
			timeout: 10000,
		});

		// 到期推进（DB 钩子）后刷新进度页触发惰性清空完成
		await makeRequestDue(await latestRequestId(adminA.userId));
		await page.goto(`${BASE_URL}/data-requests`);
		await expect(page.getByTestId("request-progress-status")).toContainText(
			"已完成",
			{ timeout: 15000 },
		);

		// Org A 账本已空（先等空态可见，再断言旧数据不在页面上）
		await page.goto(`${BASE_URL}/accounts`);
		await expect(page.getByText("还没有任何外汇账户")).toBeVisible();
		await expect(page.getByText("777")).toHaveCount(0);
		await page.goto(`${BASE_URL}/plans`);
		await expect(page.getByText("还没有换汇计划")).toBeVisible();
		await expect(page.getByText(planAName)).toHaveCount(0);

		// 本位币保留 CNY、记账起点已重置（ledgerStartedAt=null），清空后可重新按新起点记账
		await page.goto(`${BASE_URL}/settings`);
		await expect(page.getByTestId("settings-base-currency")).toHaveValue(
			/CNY/,
		);
		const settingsAfterClear = await api<{
			baseCurrency: string;
			ledgerStartedAt: string | null;
		}>("/api/settings", {
			method: "GET",
			token: adminA.accessToken,
			headers: orgHeaders(orgAId),
		});
		expect(settingsAfterClear).toMatchObject({
			baseCurrency: "CNY",
			ledgerStartedAt: null,
		});
		await seedTransaction(adminA.accessToken, "USD", "999", orgAId);
		await page.goto(`${BASE_URL}/accounts`);
		await expect(page.getByText("999").first()).toBeVisible();

		// Member B 在 Org B 的账户与计划完好无损
		const bCtx = await browser.newContext();
		const bPage = await bCtx.newPage();
		try {
			await openProtected(bPage, "/accounts", memberB.accessToken);
			await pickOrganization(bPage, orgBName);
			await expect(bPage.getByText("888").first()).toBeVisible();
			await bPage.goto(`${BASE_URL}/plans`);
			await expect(bPage.getByText(planBName)).toBeVisible();
		} finally {
			await bCtx.close();
		}
	});

	test("GWT-27: 最后 Owner 个人注销被 409 LAST_OWNER_REQUIRED 拦截并展示阻塞组织与引导链接", async ({
		page,
	}) => {
		const soleOwner = await seedRegisterAndLogin("gwt27-sole-owner");
		await seedOnboarding(
			soleOwner.accessToken,
			"CNY",
			soleOwner.defaultOrganizationId,
		);
		const orgName = (await listOrganizations(soleOwner.accessToken))[0]!.name;

		await openProtected(page, "/settings", soleOwner.accessToken);
		await page.getByTestId("account-data-delete").click();
		await page.getByTestId("deletion-start-verify").click();
		await page.getByTestId("otp-send-deletion").click();
		await expect(page.getByTestId("otp-code-input")).toHaveValue(/^\d{6}$/, {
			timeout: 15000,
		});
		await page.getByTestId("otp-verify-submit").click();

		const [rejected] = await Promise.all([
			page.waitForResponse(
				(res) =>
					new URL(res.url()).pathname === "/api/data-requests" &&
					res.request().method() === "POST",
			),
			page.getByTestId("deletion-confirm-submit").click(),
		]);
		expect(rejected.status()).toBe(409);
		expect(await rejected.json()).toMatchObject({ code: "LAST_OWNER_REQUIRED" });

		const blocked = page.getByTestId("deletion-blocked");
		await expect(blocked).toBeVisible();
		await expect(blocked).toContainText("暂时无法注销账号");
		const row = page.getByTestId("blocking-organization-row");
		await expect(row).toHaveCount(1);
		await expect(row).toContainText(orgName);

		await page.getByTestId("blocking-organization-link").click();
		await expect(page).toHaveURL(
			new RegExp(`${escapeRegExp(BASE_URL)}/organization$`),
		);
	});

	test("GWT-28: Org 导出后成员被移除不可再下载（404 ORGANIZATION_NOT_FOUND）", async ({
		page,
	}) => {
		const owner = await seedRegisterAndLogin("gwt28-owner");
		const finance = await seedRegisterAndLogin("gwt28-finance");
		const orgId = owner.defaultOrganizationId;
		await seedOnboarding(owner.accessToken, "CNY", orgId);
		await seedOnboarding(
			finance.accessToken,
			"CNY",
			finance.defaultOrganizationId,
		);
		await seedTransaction(owner.accessToken, "USD", "1500", orgId);
		const orgName = (await listOrganizations(owner.accessToken))[0]!.name;
		const { membershipId } = await inviteAndJoinViaApi(
			owner.accessToken,
			orgId,
			finance,
			"FINANCE",
		);

		// Finance 在当前组织发起组织导出
		await openProtected(page, "/settings", finance.accessToken);
		await pickOrganization(page, orgName);
		await page.getByTestId("organization-data-export").click();
		await page.getByTestId("export-start-verify").click();
		await page.getByTestId("otp-send-export").click();
		await expect(page.getByTestId("otp-code-input")).toHaveValue(/^\d{6}$/, {
			timeout: 15000,
		});
		await page.getByTestId("otp-verify-submit").click();
		await page.getByTestId("export-confirm-submit").click();

		const orgCard = page
			.getByTestId("organization-data-section")
			.getByTestId("request-progress");
		await expect(orgCard).toBeVisible({ timeout: 10000 });
		await expect(
			orgCard.getByTestId("request-progress-status"),
		).toContainText("已完成");
		await expect(orgCard.getByTestId("request-download")).toBeVisible();

		const exportReq = await api<{ id: string }>(
			"/api/organizations/current/data-requests/current",
			{
				method: "GET",
				token: finance.accessToken,
				headers: orgHeaders(orgId),
			},
		);
		const exportId = assertShape(
			exportReq.id,
			SERVER_ID_SHAPE,
			"组织导出请求 id",
		);

		// 移除前下载返回 200
		const beforeRemove = await localFetch(
			buildApiUrl(
				LOOPBACK_API_URL,
				`/api/organizations/current/data-requests/${exportId}/download`,
			),
			{
				method: "GET",
				headers: {
					Authorization: `Bearer ${finance.accessToken}`,
					...orgHeaders(orgId),
				},
			},
		);
		expect(beforeRemove.status).toBe(200);

		// Owner 移除 Finance（DISABLED）
		await api(
			`/api/organizations/current/members/${assertShape(membershipId, SERVER_ID_SHAPE, "成员 id")}`,
			{
				method: "DELETE",
				token: owner.accessToken,
				headers: orgHeaders(orgId),
			},
		);

		// 移除后使用旧下载链接立即失败（404 ORGANIZATION_NOT_FOUND）
		const afterRemove = await rawApi(
			`/api/organizations/current/data-requests/${exportId}/download`,
			{
				method: "GET",
				token: finance.accessToken,
				organizationId: orgId,
			},
		);
		expect(afterRemove.status).toBe(404);
		expect(afterRemove.json.code).toBe("ORGANIZATION_NOT_FOUND");
	});

	test("GWT-29 & GWT-30: 审计日志完整展示多类操作且 UI/API 均无任何修改/删除入口", async ({
		page,
	}) => {
		const owner = await seedRegisterAndLogin("gwt29-owner");
		const finance = await seedRegisterAndLogin("gwt29-finance");
		const orgId = owner.defaultOrganizationId;
		await seedOnboarding(owner.accessToken, "CNY", orgId);
		const txId = await seedTransaction(owner.accessToken, "CAD", "2000", orgId);
		await seedPlanWithAllocation(
			owner.accessToken,
			"CAD",
			"500",
			"GWT29 审计计划",
			orgId,
		);
		await inviteAndJoinViaApi(owner.accessToken, orgId, finance, "FINANCE");

		// Finance 执行更正
		await api("/api/corrections", {
			method: "POST",
			token: finance.accessToken,
			headers: orgHeaders(orgId),
			body: {
				targetType: "TRANSACTION",
				targetId: txId,
				baseVersion: 1,
				reason: "GWT29 审计更正校验",
				changes: { feeAmount: "15" },
			},
		});

		await openProtected(page, "/organization/audit", owner.accessToken);
		const table = page.getByTestId("audit-log-table");
		await expect(table).toBeVisible();
		for (const action of [
			"invitation.create",
			"invitation.accept",
			"plan.create",
			"correction.apply",
		]) {
			await expect(table).toContainText(action);
		}
		await expect(table).toContainText(owner.userId.slice(0, 8));
		await expect(table).toContainText(finance.userId.slice(0, 8));
		await expect(table).toContainText("成功");

		// UI 无任何修改/删除按钮
		await expect(
			page.getByRole("button", { name: /删除|编辑|修改/ }),
		).toHaveCount(0);

		// 服务端无修改/删除接口，且审计记录包含完整组织/操作者/目标/结果/明细字段
		const auditList = await api<AuditLogList>(
			"/api/organizations/current/audit-logs?page=1&pageSize=20",
			{
				method: "GET",
				token: owner.accessToken,
				headers: orgHeaders(orgId),
			},
		);
		for (const [action, expectedActorId, expectedTargetType] of [
			["invitation.create", owner.userId, "invitation"],
			["invitation.accept", finance.userId, "invitation"],
			["plan.create", owner.userId, "plan"],
			["correction.apply", finance.userId, "transaction"],
		] as const) {
			const entry = auditList.items.find((item) => item.action === action);
			expect(entry).toMatchObject({
				organizationId: orgId,
				actorUserId: expectedActorId,
				action,
				targetType: expectedTargetType,
				targetId: expect.any(String),
				result: "SUCCESS",
				detail: expect.any(Object),
			});
		}
		const firstId = assertShape(
			auditList.items[0]!.id,
			SERVER_ID_SHAPE,
			"审计记录 id",
		);
		const patchRes = await rawApi(
			`/api/organizations/current/audit-logs/${firstId}`,
			{
				method: "PATCH",
				token: owner.accessToken,
				organizationId: orgId,
				body: { result: "FAILED" },
			},
		);
		expect(patchRes.status).toBe(404);
		const deleteRes = await rawApi(
			`/api/organizations/current/audit-logs/${firstId}`,
			{
				method: "DELETE",
				token: owner.accessToken,
				organizationId: orgId,
			},
		);
		expect(deleteRes.status).toBe(404);
	});
});
