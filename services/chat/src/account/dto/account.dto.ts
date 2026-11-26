import { ApiProperty } from "@nestjs/swagger";
import { IsString, Matches } from "class-validator";

/**
 * 外汇账户模块 DTO：OpenAPI 契约唯一来源，前端类型由 generate:api 产出。
 * 每个 @ApiProperty 必须显式标注 type，不得依赖转译器元数据推断。
 * 金额一律字符串传输，固定 4 位小数（Decimal(20, 4)）；单位成本固定 8 位小数（Decimal(20, 10)）。
 * 术语对齐官方口径：「未分配余额」= balance − Σ所有计划剩余分配（15 清单，doc 04/14）。
 * ⚠️ 列表单项命名为 AccountListItemDto：home 模块已有 AccountSummaryDto（OpenAPI schema 同名冲突）。
 */

/** 账户列表单项（GET /api/accounts） */
export class AccountListItemDto {
	@ApiProperty({
		description: "币种代码（ISO 4217）",
		example: "CAD",
		type: String,
	})
	currencyCode!: string;

	@ApiProperty({
		description: "账户余额（Decimal(20, 4)，toFixed(4) 字符串）",
		example: "12000.0000",
		type: String,
	})
	balance!: string;

	@ApiProperty({
		description:
			"已分配金额 = Σ全部计划剩余分配（amount − usedAmount，全状态求和；toFixed(4) 字符串）",
		example: "6000.0000",
		type: String,
	})
	allocatedAmount!: string;

	@ApiProperty({
		description:
			"未分配余额 = 余额 − 已分配（toFixed(4) 字符串）；正常数据 ≥ 0，为负说明数据被破坏，接口如实返回不钳 0",
		example: "6000.0000",
		type: String,
	})
	unallocatedAmount!: string;
}

/** GET /api/accounts 出参 */
export class AccountListDto {
	@ApiProperty({
		description:
			"本位币（成本币种，取组织本位币（兼容窗口回落创建者默认设置））；新用户无设置行时为 null（前端成本列退化为纯金额）",
		example: "CNY",
		type: String,
		nullable: true,
	})
	baseCurrency!: string | null;

	@ApiProperty({
		description: "账户列表，按 currencyCode 升序；未建任何账户时空数组",
		type: [AccountListItemDto],
	})
	accounts!: AccountListItemDto[];
}

/** GET /api/accounts/:currencyCode 出参（baseCurrency + 列表单项字段 + 成本指标，§4） */
export class AccountDetailDto extends AccountListItemDto {
	@ApiProperty({
		description:
			"本位币（成本币种，取组织本位币（兼容窗口回落创建者默认设置））；新用户无设置行时为 null",
		example: "CNY",
		type: String,
		nullable: true,
	})
	baseCurrency!: string | null;

	@ApiProperty({
		description:
			"剩余已记录成本 = Σ(remainingQty × unitCost)（toFixed(4) 字符串）；无批次（旧数据未回填）时为 null",
		example: "18420.0000",
		type: String,
		nullable: true,
	})
	remainingTotalCost!: string | null;

	@ApiProperty({
		description:
			"平均单位成本 = 剩余成本 ÷ Σ remainingQty（toFixed(8) 字符串）；余额 0 或全部消耗时不计算，为 null（doc 04）",
		example: "1.00000000",
		type: String,
		nullable: true,
	})
	averageUnitCost!: string | null;
}

/** 账户流水条目（GET /api/accounts/:currencyCode/transactions；事件列表，非 FIFO 计算顺序） */
export class AccountLedgerItemDto {
	@ApiProperty({
		description: "事件记录 ID（cuid；PURCHASE 行即交易 ID，可跳转交易详情）",
		example: "cmb1...",
		type: String,
	})
	id!: string;

	@ApiProperty({
		description:
			"事件类型：PURCHASE = 买入；USAGE = 使用（M7 上线前不出现）；INITIAL = 初始持仓（M1 预留，当前不出现）",
		example: "PURCHASE",
		enum: ["PURCHASE", "USAGE", "INITIAL"],
		type: String,
	})
	type!: "PURCHASE" | "USAGE" | "INITIAL";

	@ApiProperty({
		description: "发生时间（ISO 8601 UTC；买入 = 交易日期，使用 = 使用日期）",
		example: "2026-09-08T02:00:00.000Z",
		type: String,
	})
	occurredAt!: string;

	@ApiProperty({
		description: "外币数量（toFixed(4) 字符串；USAGE 行 = 使用金额）",
		example: "10620.0000",
		type: String,
	})
	quantity!: string;

	@ApiProperty({
		description:
			"成本（toFixed(4) 字符串）：买入 = 本金 + 手续费（未知时 = 本金）；使用 = FIFO 消耗成本（M7 起，当前恒 null）",
		example: "10620.0000",
		type: String,
		nullable: true,
	})
	totalCost!: string | null;

	@ApiProperty({
		description:
			"手续费是否明确（买入行：feeAmount 非 null；使用行恒 true——使用无费用概念）",
		example: true,
		type: Boolean,
	})
	feeKnown!: boolean;

	@ApiProperty({
		description: "更正版本号（当前恒为 1，按最新有效版本过滤随 M8 实现）",
		example: 1,
		type: Number,
	})
	version!: number;
}

/** GET /api/accounts/:currencyCode/transactions 出参 */
export class AccountLedgerDto {
	@ApiProperty({
		description:
			"本位币（成本列币种，取组织本位币（兼容窗口回落创建者默认设置））；无设置行时为 null",
		example: "CNY",
		type: String,
		nullable: true,
	})
	baseCurrency!: string | null;

	@ApiProperty({
		description:
			"流水条目，按 occurredAt 倒序、同刻按录入时间倒序；无分页（单用户 ≤ 万级，§3.6）",
		type: [AccountLedgerItemDto],
	})
	items!: AccountLedgerItemDto[];
}

/** 账户按计划分配明细单项（GET /api/accounts/:currencyCode/allocations；阶段5 §2 功能 13 收尾） */
export class AccountPlanAllocationDto {
	@ApiProperty({
		description: "计划 ID（跳转计划详情用）",
		example: "cm9plan...",
		type: String,
	})
	planId!: string;

	@ApiProperty({
		description: "计划名称；未命名计划为 null（前端显示「未命名计划」）",
		example: "学费计划",
		type: String,
		nullable: true,
	})
	planName!: string | null;

	@ApiProperty({
		description: "计划状态（不过滤：CANCELLED 已释放剩余 0 仍如实列出，与 allocatedAmount 汇总口径一致）",
		example: "ACTIVE",
		enum: ["ACTIVE", "COMPLETED", "CANCELLED"],
		type: String,
	})
	planStatus!: string;

	@ApiProperty({
		description: "分配总额（PlanAllocation.amount，toFixed(4) 字符串）",
		example: "6000.0000",
		type: String,
	})
	amount!: string;

	@ApiProperty({
		description: "累计已使用（PlanAllocation.usedAmount，toFixed(4) 字符串）",
		example: "4000.0000",
		type: String,
	})
	usedAmount!: string;

	@ApiProperty({
		description: "剩余分配 = 分配总额 − 累计已使用（Decimal 服务端算好，toFixed(4) 字符串）；CANCELLED 计划为 0（取消时释放）",
		example: "2000.0000",
		type: String,
	})
	remainingAllocation!: string;
}

/** GET /api/accounts/:currencyCode/allocations 出参 */
export class AccountPlanAllocationListDto {
	@ApiProperty({
		description: "按计划逐条分配明细，按计划创建时间升序（稳定确定）；无分配账户为空数组",
		type: [AccountPlanAllocationDto],
	})
	items!: AccountPlanAllocationDto[];
}

/** 路径参数：币种代码（大小写不敏感，服务端统一转大写后按 money 包校验） */
export class AccountCurrencyParamDto {
	@ApiProperty({
		description: "币种代码（3 位字母，ISO 4217，大小写不敏感）",
		example: "CAD",
		type: String,
	})
	@IsString({ message: "币种代码必须是字符串" })
	@Matches(/^[a-zA-Z]{3}$/, { message: "币种代码必须是 3 位字母" })
	currencyCode!: string;
}

/** 模块错误响应体（统一 { code, message }，风格与 transaction/plan 模块一致） */
export class AccountErrorDto {
	@ApiProperty({
		description: "错误码",
		example: "ACCOUNT_NOT_FOUND",
		enum: ["INVALID_ACCOUNT_CURRENCY", "ACCOUNT_NOT_FOUND"],
		type: String,
	})
	code!: string;

	@ApiProperty({
		description: "错误描述",
		example: "该币种暂无外汇账户",
		type: String,
	})
	message!: string;
}
