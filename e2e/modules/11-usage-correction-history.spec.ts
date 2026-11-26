import { test, expect } from "../fixtures/auto-screenshot";
import type { components } from "../../clients/chat-web/lib/api/schema.gen";
import {
	api,
	injectLoginCookie,
	seedOnboarding,
	seedPlanWithAllocation,
	seedRegisterAndLogin,
	seedTransaction,
	seedUsage,
} from "../helpers/api-seeder";
import { buildApiUrl, localFetch, resolveApiBase } from "../helpers/api-url";

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";
const API_URL = resolveApiBase(process.env.API_URL, "http://localhost:4001");
type Schemas = components["schemas"];

// W6-08：验证计划回跳、单笔历史隔离以及真实成功与失败日志的前后值展示。
test("使用更正确认和取消返回所属计划，单笔历史展示成功与失败", async ({ page }) => {
	const { accessToken, defaultOrganizationId } = await seedRegisterAndLogin(
		"usage-history",
	);
	const orgHeaders = { "X-Organization-Id": defaultOrganizationId };
	await seedOnboarding(accessToken, "CNY", defaultOrganizationId);
	await seedTransaction(accessToken, "CAD", "7800", defaultOrganizationId);
	const planId = await seedPlanWithAllocation(
		accessToken,
		"CAD",
		"3000",
		undefined,
		defaultOrganizationId,
	);
	const usage = await seedUsage(accessToken, planId, "800", defaultOrganizationId);
	await seedUsage(accessToken, planId, "200", defaultOrganizationId);
	await injectLoginCookie(page.context(), accessToken, BASE_URL);

	const query = new URLSearchParams({ targetType: "USAGE", targetId: usage.id });
	const { target } = await api<{ target: { version: number; usedAt: string } }>(
		`/api/corrections/target?${query}`,
		{ method: "GET", token: accessToken, headers: orgHeaders },
	);
	const date = target.usedAt.slice(0, 10);
	const appliedReason = "收据核对后修正金额";
	const failedReason = "补录金额超过当时可用资金";
	const planPath = `/plans/${planId}`;
	const planUrl = new URL(planPath, BASE_URL).href;

	await page.goto(planUrl);
	const usageSection = page.locator("section").filter({
		has: page.getByRole("heading", { name: "使用记录", exact: true }),
	});
	const usageRow = (amount: string) =>
		usageSection.getByRole("listitem").filter({
			has: page.getByText(`${amount} CAD`, { exact: true }),
		});
	const originalRow = usageRow("800");
	const openHistory = originalRow.getByRole("button", { name: /更正历史/ });
	await openHistory.focus();
	await openHistory.press("Enter");
	await expect(openHistory).toHaveAttribute("aria-expanded", "true");
	await expect(originalRow.getByText(/暂无更正历史/)).toBeVisible();
	await openHistory.click();

	// 直接提交超出账本资金但低于计划目标的更正。UI 预览会拦截此请求，
	// 因此通过真实 apply 复核写入 FAILED，模拟预览后资金不再充足的留痕结果。
	const rejectedChange = {
		targetType: "USAGE",
		targetId: usage.id,
		baseVersion: target.version,
		reason: failedReason,
		changes: { amount: "9000" },
	} satisfies Schemas["CorrectionRequestDto"];
	const blocked = await api<Schemas["CorrectionPreviewDto"]>("/api/corrections/preview", {
		method: "POST",
		token: accessToken,
		headers: orgHeaders,
		body: rejectedChange,
	});
	expect(blocked.blockers).toEqual(
		expect.arrayContaining([expect.objectContaining({ code: "CORRECTION_HISTORICAL_SHORTFALL" })]),
	);
	expect(blocked.expectedUsageImpact).toMatch(/^[a-f0-9]{64}$/);
	const failed = await localFetch(buildApiUrl(API_URL, "/api/corrections"), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
			...orgHeaders,
		},
		body: JSON.stringify({
			...rejectedChange,
			expectedUsageImpact: blocked.expectedUsageImpact,
		}),
	});
	expect(failed.status).toBe(409);
	expect(await failed.json()).toMatchObject({ code: "CORRECTION_HISTORICAL_SHORTFALL" });

	await originalRow.getByTestId("usage-correction-entry").click();
	await expect(page.getByRole("heading", { name: "更正使用记录" })).toBeVisible();
	await expect(page.getByRole("link", { name: "返回计划" })).toHaveAttribute("href", planPath);
	await page.getByRole("link", { name: "取消", exact: true }).click();
	await expect(page).toHaveURL(planUrl);

	await openHistory.click();
	await expect(originalRow.getByText("提交失败", { exact: true })).toBeVisible();
	await originalRow.getByTestId("usage-correction-entry").click();
	await page.getByLabel("使用金额", { exact: true }).fill("500");
	await page.getByLabel(/修改原因/).fill(appliedReason);
	await page.getByTestId("correction-preview-button").click();
	const confirm = page.getByTestId("correction-confirm-button");
	await expect(confirm).toBeEnabled();
	await confirm.click();
	await expect(page).toHaveURL(planUrl);

	const corrected = usageRow("500");
	await corrected.getByRole("button", { name: /更正历史/ }).click();
	const history = corrected.getByTestId("correction-history-list");
	const applied = history.getByRole("listitem").filter({ hasText: appliedReason });
	await expect(applied.getByText("更正已生效", { exact: true })).toBeVisible();
	await expect(applied.getByRole("columnheader", { name: "修改后" })).toBeVisible();
	await expect(applied.getByRole("row", { name: /使用金额/ }).getByRole("cell")).toHaveText([
		"800.0000 CAD",
		"500.0000 CAD",
	]);
	await expect(applied.getByRole("row", { name: /使用日期/ }).getByRole("cell")).toHaveText([
		date,
		date,
	]);

	const rejected = history.getByRole("listitem").filter({ hasText: failedReason });
	await expect(rejected.getByText("提交失败", { exact: true })).toBeVisible();
	await expect(rejected.getByText(/失败原因.*资金不足/)).toBeVisible();
	await expect(rejected.getByRole("columnheader", { name: "拟修改值" })).toBeVisible();
	await expect(rejected.getByRole("row", { name: /使用金额/ }).getByRole("cell")).toHaveText([
		"800.0000 CAD",
		"9000 CAD",
	]);

	const other = usageRow("200");
	await other.getByRole("button", { name: /更正历史/ }).click();
	await expect(other.getByText(/暂无更正历史/)).toBeVisible();
	await expect(other.getByTestId("correction-history-list")).toHaveCount(0);
});
