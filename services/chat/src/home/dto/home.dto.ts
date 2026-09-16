import { ApiProperty } from "@nestjs/swagger";

/**
 * 首页状态模块 DTO：OpenAPI 契约唯一来源，前端类型由 generate:api 产出。
 * 每个 @ApiProperty 必须显式标注 type，不得依赖转译器元数据推断。
 * 金额一律字符串传输，固定 4 位小数（Decimal(20, 4)，方案 §3.3）。
 */

/** 账户摘要（GET /api/home/state） */
export class AccountSummaryDto {
	@ApiProperty({
		description: "币种代码（ISO 4217）",
		example: "USD",
		type: String,
	})
	currencyCode!: string;

	@ApiProperty({
		description: "账户余额（Decimal(20, 4)，固定 4 位小数字符串）",
		example: "1500.0000",
		type: String,
	})
	balance!: string;
}

/** 计划摘要（GET /api/home/state） */
export class PlanSummaryDto {
	@ApiProperty({
		description: "计划 ID（cuid）",
		example: "cmex5g2h70000abcd",
		type: String,
	})
	id!: string;

	@ApiProperty({
		description: "目标币种（ISO 4217）",
		example: "USD",
		type: String,
	})
	targetCurrency!: string;

	@ApiProperty({
		description: "目标金额（Decimal(20, 4)，固定 4 位小数字符串）",
		example: "10000.0000",
		type: String,
	})
	targetAmount!: string;

	@ApiProperty({
		description: '已分配金额（来自计划分配记录，无分配记录时为 "0.0000"）',
		example: "4000.0000",
		type: String,
	})
	allocatedAmount!: string;

	@ApiProperty({
		description:
			"剩余可分配 = 已分配 − 已使用（服务端计算，schema 注释：业务层计算，不存列）",
		example: "6000.0000",
		type: String,
	})
	remainingAmount!: string;

	@ApiProperty({
		description: "期望用汇日（ISO 8601 UTC）",
		example: "2026-10-01T00:00:00.000Z",
		type: String,
	})
	expectUseDate!: string;

	@ApiProperty({
		description: "最晚备汇日（存量列，ISO 8601 UTC）",
		example: "2026-09-25T00:00:00.000Z",
		type: String,
	})
	latestPrepDate!: string;

	@ApiProperty({
		description: "计划状态（大写枚举，与存量值一致）",
		example: "ACTIVE",
		enum: ["ACTIVE", "COMPLETED", "CANCELLED"],
	})
	status!: "ACTIVE" | "COMPLETED" | "CANCELLED";
}

/** 单币种持仓聚合（GET /api/home/portfolio） */
export class PortfolioByCurrencyDto {
	@ApiProperty({
		description: "币种代码（ISO 4217）",
		example: "USD",
		type: String,
	})
	currencyCode!: string;

	@ApiProperty({
		description:
			"剩余数量 Σ remainingQty（Decimal(20, 4)，固定 4 位小数字符串）",
		example: "1100.0000",
		type: String,
	})
	remainingQty!: string;

	@ApiProperty({
		description:
			"剩余持仓成本 Σ(remainingQty × unitCost)（本位币计价，固定 4 位小数字符串）",
		example: "8100.0000",
		type: String,
	})
	totalRemainingCost!: string;

	@ApiProperty({
		description:
			"平均单位成本 = totalRemainingCost ÷ remainingQty（对齐 CostLot.unitCost 的 Decimal(20, 10) 口径，固定 10 位小数字符串）",
		example: "7.3636363636",
		type: String,
	})
	avgUnitCost!: string;
}

/** GET /api/home/portfolio 响应：本位币 + CostLot 剩余持仓聚合 */
export class PortfolioDto {
	@ApiProperty({
		description:
			"本位币（user_settings.base_currency）；口径假设：CostLot.unitCost 以该币种计价；用户无设置记录时为 null",
		example: "CNY",
		type: String,
		nullable: true,
	})
	baseCurrency!: string | null;

	@ApiProperty({
		description:
			'全部币种剩余持仓成本合计（本位币计价，固定 4 位小数字符串）；无持仓为 "0.0000"',
		example: "8570.0000",
		type: String,
	})
	totalRemainingCost!: string;

	@ApiProperty({
		description:
			"分币种持仓聚合，仅含 remainingQty > 0 的币种，按 currencyCode 升序；无持仓为空数组",
		type: [PortfolioByCurrencyDto],
	})
	byCurrency!: PortfolioByCurrencyDto[];
}

/** GET /api/home/state 响应：分流三布尔 + 账户/计划摘要 + 最新汇率观测时间 */
export class HomeStateDto {
	@ApiProperty({
		description: "是否已完成首次设置（user_settings 中存在该用户记录）",
		example: true,
		type: Boolean,
	})
	onboardingCompleted!: boolean;

	@ApiProperty({
		description: "是否有账户记录（与 accounts.length > 0 恒一致）",
		example: false,
		type: Boolean,
	})
	hasAccounts!: boolean;

	@ApiProperty({
		description: "是否有计划记录（与 plans.length > 0 恒一致）",
		example: false,
		type: Boolean,
	})
	hasPlans!: boolean;

	@ApiProperty({
		description: "全量账户摘要，按 currencyCode 升序",
		type: [AccountSummaryDto],
	})
	accounts!: AccountSummaryDto[];

	@ApiProperty({
		description: "全量计划摘要，按 createdAt 降序，不分页",
		type: [PlanSummaryDto],
	})
	plans!: PlanSummaryDto[];

	@ApiProperty({
		description:
			"汇率全表最新观测时间（exchange_rates.observed_at 最大值，顶栏「最新刷新」数据源）；无任何汇率数据时为 null",
		example: "2026-09-24T01:30:00.000Z",
		type: String,
		nullable: true,
	})
	latestRateObservedAt!: string | null;
}
