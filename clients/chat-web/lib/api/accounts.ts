import { apiClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema.gen";

// ---------------------------------------------------------------------------
// 外汇账户（account-module M3 + 阶段5 §2 分配视图）：后端 AccountModule 已落地，
// 全部类型统一由 bun run generate:api 生成的 schema.gen 别名导出（禁止手写结构）。
// 金额一律字符串：账户金额 toFixed(4)、平均单位成本 toFixed(8)，前端不做二次舍入。
// ---------------------------------------------------------------------------

type Schemas = components["schemas"];

/** 账户列表项（GET /accounts 出参 accounts 元素；官方术语：持仓 = 余额） */
export type AccountListItem = Schemas["AccountListItemDto"];

/** 账户列表响应（GET /accounts 的 data） */
export type AccountListResp = Schemas["AccountListDto"];

/** 账户详情（GET /accounts/:currencyCode 的 data = 单账户字段 + 成本指标） */
export type AccountDetail = Schemas["AccountDetailDto"];

/** 账户流水类型（INITIAL = M1 预留、USAGE = M7 预留，前端类型与标签映射须就绪） */
export type AccountLedgerItemType = Schemas["AccountLedgerItemDto"]["type"];

/** 账户流水行（GET /accounts/:currencyCode/transactions 出参 items 元素） */
export type AccountLedgerItem = Schemas["AccountLedgerItemDto"];

/** 账户流水响应（GET /accounts/:currencyCode/transactions 的 data） */
export type AccountLedgerResp = Schemas["AccountLedgerDto"];

/** 按计划分配明细项（后端 AccountPlanAllocationDto，GET /accounts/:currencyCode/allocations 的 items 元素；阶段5 §2） */
export type AccountPlanAllocation = Schemas["AccountPlanAllocationDto"];

/** 按计划分配明细响应（GET /accounts/:currencyCode/allocations 的 data） */
export type AccountPlanAllocationResp = Schemas["AccountPlanAllocationListDto"];

export const accountsApi = {
	/**
	 * 账户列表（GET /accounts）
	 *
	 * 需登录，只读幂等。未建任何账户时 accounts 为空数组。
	 * 失败：401 由 apiClient 统一清理凭证并抛 ApiError。
	 */
	async list(): Promise<AccountListResp> {
		return apiClient<AccountListResp>("/accounts", {
			method: "GET",
		});
	},

	/**
	 * 账户详情（GET /accounts/:currencyCode）
	 *
	 * 需登录，只读幂等；路径参数大小写不敏感（后端统一转大写）。
	 * 失败：400 INVALID_ACCOUNT_CURRENCY（非支持币种）/
	 * 404 ACCOUNT_NOT_FOUND（该币种无账户，不泄露存在性）——
	 * 错误体 { code, message }，由 apiClient 抛 ApiError（code 可读）。
	 */
	async detail(currencyCode: string): Promise<AccountDetail> {
		return apiClient<AccountDetail>(`/accounts/${currencyCode}`, {
			method: "GET",
		});
	},

	/**
	 * 账户流水（GET /accounts/:currencyCode/transactions）
	 *
	 * 需登录，只读幂等；按 occurredAt 倒序返回，无分页（单用户流水 ≤ 万级，方案 §3.6）。
	 * 失败：400 INVALID_ACCOUNT_CURRENCY / 404 ACCOUNT_NOT_FOUND（同 detail，ApiError.code 可读）。
	 */
	async ledger(currencyCode: string): Promise<AccountLedgerResp> {
		return apiClient<AccountLedgerResp>(
			`/accounts/${currencyCode}/transactions`,
			{
				method: "GET",
			},
		);
	},

	/**
	 * 按计划分配明细（GET /accounts/:currencyCode/allocations，阶段5 §2 功能 13）
	 *
	 * 需登录，只读幂等；按计划创建时间升序、无分页。不过滤计划状态
	 * （CANCELLED 剩余 0 仍列出）；剩余分配由服务端算好下发，前端禁止重算。
	 * 失败：400 INVALID_ACCOUNT_CURRENCY / 404 ACCOUNT_NOT_FOUND（同 detail）。
	 */
	async allocations(currencyCode: string): Promise<AccountPlanAllocationResp> {
		return apiClient<AccountPlanAllocationResp>(
			`/accounts/${currencyCode}/allocations`,
			{
				method: "GET",
			},
		);
	},
};
