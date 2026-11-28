import { test, expect, type Response } from "@playwright/test";
import {
	injectLoginCookie,
	seedOnboarding,
	seedRegisterAndLogin,
} from "../helpers/api-seeder";
import { withHistoricalCorrectionQuote } from "../helpers/correction-quote-db";

const BASE_URL = process.env.CORS_ORIGIN || "http://localhost:3001";

function isCorrectionApply(response: Response) {
	return response.request().method() === "POST" &&
		new URL(response.url()).pathname === "/api/corrections";
}

test("T-CORR-005 历史报价变动后须重新预览并确认初始持仓更正", async ({ page }) => {
	const user = await seedRegisterAndLogin("corr-quote-refresh");
	await seedOnboarding(user.accessToken);
	await injectLoginCookie(page.context(), user.accessToken, BASE_URL);

	await withHistoricalCorrectionQuote(user, async (fixture) => {
		const target = new URL("/corrections/new", BASE_URL);
		target.searchParams.set("targetType", "INITIAL_HOLDING");
		target.searchParams.set("targetId", fixture.holdingId);
		await page.goto(target.href);
		await page.getByRole("combobox", { name: "币种", exact: true }).selectOption("THB");
		await page.locator("#correction-reason").fill("实际持有泰铢");
		const preview = page.getByTestId("correction-preview-button");
		const confirm = page.getByTestId("correction-confirm-button");
		await preview.click();
		await expect(page.getByRole("heading", { name: "采用的历史报价" })).toBeVisible();
		await expect(page.getByText(/0\.21000000 · 来源 中国农业银行/)).toBeVisible();
		await expect(confirm).toBeEnabled();

		await fixture.replaceSellRate();
		const [rejected] = await Promise.all([
			page.waitForResponse(isCorrectionApply),
			confirm.click(),
		]);
		expect(rejected.status()).toBe(409);
		expect(await rejected.json()).toMatchObject({ code: "CORRECTION_QUOTE_CHANGED" });
		await expect(
			page.getByRole("alert").filter({
				hasText: "历史报价已变动，请重新查看影响并确认。",
			}),
		).toBeVisible();
		await expect(page.getByRole("heading", { name: "采用的历史报价" })).toHaveCount(0);
		await expect(confirm).toBeDisabled();
		expect(await fixture.readHolding()).toEqual({ currencyCode: "USD", cost: "7248.0000" });

		await preview.click();
		await expect(page.getByText(/0\.23000000 · 来源 中国农业银行/)).toBeVisible();
		await expect(confirm).toBeEnabled();
		const [applied] = await Promise.all([
			page.waitForResponse(isCorrectionApply),
			confirm.click(),
		]);
		expect(applied.status()).toBe(201);
		expect(await fixture.readAuditStatus()).toBe("APPLIED");
		expect(await fixture.readHolding()).toEqual({ currencyCode: "THB", cost: "230.0000" });
	});
});
