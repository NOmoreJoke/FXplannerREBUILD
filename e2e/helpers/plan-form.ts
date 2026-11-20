import { expect, type Page } from "@playwright/test";

export async function selectCadPlanCurrency(page: Page): Promise<void> {
	// 两个创建场景都以 CNY 开户。等表单回填本位币，确认客户端已就绪。
	await expect(
		page.getByRole("textbox", { name: "本位币", exact: true }),
	).toHaveValue("CNY");

	const trigger = page.getByRole("combobox", { name: "目标币种", exact: true });
	await trigger.click();

	const cadLabel = "CAD · 加元";
	const option = page
		.getByRole("listbox")
		.getByRole("option", { name: cadLabel, exact: true });
	await expect(option).toBeVisible();
	await option.click();
	await expect(trigger).toHaveText(cadLabel);
}
