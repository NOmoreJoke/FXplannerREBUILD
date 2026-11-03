import { apiClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema.gen";

// ---------------------------------------------------------------------------
// 外汇账户（account-module M3 + 阶段5 §2 分配视图）：后端 AccountModule 已落地。
// 旧类型为「临时手写」先例（迁移待办见文件头注释）；新增类型一律取
// bun run generate:api 生成的 schema.gen（后端 DTO 唯一来源，禁止手写）。
// 金额一律字符串：账户金额 toFixed(4)、平均单位成本 toFixed(8)，前端不做二次舍入。
// ---------------------------------------------------------------------------

type Schemas = components["schemas"];

/** 账户列表项（GET /accounts 出参 accounts 元素；官方术语：持仓 = 余额） */
export type AccountListItem = {
	/** 币种代码（ISO 4217，3 位大写） */
	currencyCode: string;
	/** 持仓余额（金额字符串，Decimal(20,4)，如 "12000.0000"） */
	balance: string;
	/** 已分配金额 = Σ 全部计划剩余分配（金额字符串；CANCELLED/COMPLETED 计划剩余恒 0，无需状态过滤） */
	allocatedAmount: string;
	/** 未分配余额 = balance − allocatedAmount（金额字符串；不 clamp，数据异常时可为负，前端如实展示） */
	unallocatedAmount: string;
};

/** 账户列表响应（GET /accounts 的 data） */
export type AccountListResp = {
	/** 本位币；用户无 userSettings 时为 null（本位币相关展示退化为纯金额，不带币种代码） */
	baseCurrency: string | null;
	/** 全量账户，按 currencyCode 升序；未建任何账户时为空数组（前端显示引导态） */
	accounts: AccountListItem[];
};

/** 账户详情（GET /accounts/:currencyCode 的 data = 单账户字段 + 成本指标） */
export type AccountDetail = AccountListItem & {
	/** 剩余已记录成本 = Σ 批次 remainingQty × unitCost（金额字符串）；无批次时为 null */
	remainingTotalCost: string | null;
	/** 平均单位成本 = remainingTotalCost ÷ Σ remainingQty（toFixed(8) 字符串）；余额 0 或批次缺失时为 null，前端显示「—」 */
	averageUnitCost: string | null;
};

/** 账户流水类型（INITIAL = M1 预留、USAGE = M7 预留，上线前不出现，前端类型与标签映射须就绪） */
export type AccountLedgerItemType = "INITIAL" | "PURCHASE" | "USAGE";

/** 账户流水行（GET /accounts/:currencyCode/transactions 出参 items 元素） */
export type AccountLedgerItem = {
	/** 交易 ID（PURCHASE 行对应 /transactions/:id 详情页） */
	id: string;
	/** 流水类型 */
	type: AccountLedgerItemType;
	/** 发生时间，ISO 8601 UTC（列表按此倒序） */
	occurredAt: string;
	/** 数量（金额字符串；USAGE 行 = 使用金额） */
	quantity: string;
	/** 成本（金额字符串；买入 = 本金 + 手续费，手续费未知时 = 本金；USAGE = FIFO 消耗成本；缺失时 null 显示「—」） */
	totalCost: string | null;
	/** 手续费是否明确；false 时前端须显示「费用未明确」标记（doc 05 费用不完整说明义务） */
	feeKnown: boolean;
	/** 记录版本（M8 更正预留，当前恒为 1） */
	version: number;
};

/** 账户流水响应（GET /accounts/:currencyCode/transactions 的 data） */
export type AccountLedgerResp = {
	/** 本位币；用户无 userSettings 时为 null（成本列表头退化为「成本」，不带币种代码） */
	baseCurrency: string | null;
	/** 流水行，按 occurredAt 倒序（同刻按 createdAt 倒序稳定排列） */
	items: AccountLedgerItem[];
};

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
