import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
	AccountNotFoundException,
	type AccountService,
} from "../../account/account.service";
import { isSupportedCurrency } from "../../rate/rate.constants";
import { formatAgentToolError, type ToolGuardRunner } from "./tool-guard";

export const ACCOUNT_SUMMARY_TOOL_NAME = "get_account_summary";

/**
 * 组织账户摘要只读工具（ToB R2 P7；技术方案 §8.2）。
 *
 * 严格注入闭包鉴权后的 freshActor，入参 schema 禁含 userId/organizationId/role；
 * 口径完全复用 AccountService.list / detail，保证与账户页逐字段一致。
 */
export function createAccountSummaryTool(
	accountService: AccountService,
	guard: ToolGuardRunner,
) {
	return tool(
		async (input) => {
			const currencyCode = input.currencyCode?.trim().toUpperCase();

			return guard({
				toolName: ACCOUNT_SUMMARY_TOOL_NAME,
				scope: "organization",
				requiredPermissions: ["agent.use", "agent.business_read", "account.read"],
				auditDetail: currencyCode ? { currencyCode: currencyCode.slice(0, 16) } : {},
				run: async (freshActor) => {
					if (currencyCode !== undefined && currencyCode.length > 0) {
						if (!isSupportedCurrency(currencyCode)) {
							return formatAgentToolError(
								"INVALID_ACCOUNT_CURRENCY",
								`不支持的币种 ${currencyCode}，请向用户说明支持的币种范围。`,
							);
						}
					}

					if (currencyCode) {
						try {
							const detail = await accountService.detail(
								freshActor,
								currencyCode,
							);
							return {
								kind: "organization_fact",
								source: "account_summary",
								baseCurrency: detail.baseCurrency,
								empty: false,
								accounts: [
									{
										currencyCode: detail.currencyCode,
										balance: detail.balance,
										allocatedAmount: detail.allocatedAmount,
										unallocatedAmount: detail.unallocatedAmount,
										remainingTotalCost: detail.remainingTotalCost,
										averageUnitCost: detail.averageUnitCost,
									},
								],
								note: "以上为当前组织账户实时余额与未分配余额（金额为字符串，禁止自行浮点重算）。",
							};
						} catch (error) {
							if (error instanceof AccountNotFoundException) {
								return {
									kind: "organization_fact",
									source: "account_summary",
									empty: true,
									currencyCode,
									accounts: [],
									note: `当前组织暂无 ${currencyCode} 外汇账户记录，请如实告知用户，严禁编造余额数字。`,
								};
							}
							throw error;
						}
					}

					const list = await accountService.list(freshActor);
					if (list.accounts.length === 0) {
						return {
							kind: "organization_fact",
							source: "account_summary",
							baseCurrency: list.baseCurrency,
							empty: true,
							accounts: [],
							note: "当前组织尚未建立任何外币账户记录，请如实告知用户无账户余额数据，严禁编造。",
						};
					}
					return {
						kind: "organization_fact",
						source: "account_summary",
						baseCurrency: list.baseCurrency,
						empty: false,
						accounts: list.accounts.map((item) => ({
							currencyCode: item.currencyCode,
							balance: item.balance,
							allocatedAmount: item.allocatedAmount,
							unallocatedAmount: item.unallocatedAmount,
						})),
						note: "以上为当前组织各币种实时余额与未分配余额（金额为字符串，禁止自行浮点重算）。",
					};
				},
			});
		},
		{
			name: ACCOUNT_SUMMARY_TOOL_NAME,
			description:
				"查询当前组织的账户余额、已分配金额和未分配余额（与账户页完全一致）。可选传入 currencyCode 只查单个币种。",
			schema: z
				.object({
					currencyCode: z
						.string()
						.optional()
						.describe("可选：3 字母币种代码，如 USD、JPY；省略则列出全部币种"),
				})
				.strict(),
		},
	);
}
