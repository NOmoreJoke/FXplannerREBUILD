import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

/**
 * 报告模块 DTO：OpenAPI 契约唯一来源，前端类型由 generate:api 产出。
 * 每个 @ApiProperty 必须显式标注 type，不得依赖转译器元数据推断。
 * 金额一律字符串传输，固定 4 位小数（Decimal(20, 4)）；单位成本固定 8 位小数
 * （roundRateTo8），对齐 account.dto.ts 文件头约定。
 * 展示层按币种精度舍入（JPY/KRW 0 位、其余 2 位）由前端用 money 包完成，
 * DTO 保持数据库 4 位字符串契约不混入展示口径（reports 技术方案 §4.1/§5）。
 */

/** GET /api/reports/plans 查询参数（均可选；枚举/币种合法性由 service 校验并抛 INVALID_REPORT_PARAMS，使错误体带模块 code） */
export class ReportPlanListQueryDto {
	@ApiProperty({
		description: "按计划状态过滤（缺省全部）",
		example: "ACTIVE",
		enum: ["ACTIVE", "COMPLETED", "CANCELLED"],
		required: false,
	})
	@IsOptional()
	@IsString()
	status?: string;

	@ApiProperty({
		description: "按目标币种过滤（3 位字母，ISO 4217，缺省全部）",
		example: "USD",
		required: false,
	})
	@IsOptional()
	@IsString()
	currencyCode?: string;
}

/** 报告中心列表单项（GET /api/reports/plans 出参 items 元素） */
export class ReportPlanListItemDto {
	@ApiProperty({
		description: "计划 ID（cuid）",
		example: "cmex5g2h70000abcd",
		type: String,
	})
	planId!: string;

	@ApiProperty({
		description: "计划名称（缺省为 null）",
		example: "今年换 5 万美元",
		type: String,
		nullable: true,
	})
	name!: string | null;

	@ApiProperty({
		description: "计划状态",
		example: "ACTIVE",
		enum: ["ACTIVE", "COMPLETED", "CANCELLED"],
		type: String,
	})
	status!: string;

	@ApiProperty({
		description: "目标币种（ISO 4217）",
		example: "USD",
		type: String,
	})
	currencyCode!: string;

	@ApiProperty({
		description: "目标金额（toFixed(4) 字符串）",
		example: "10000.0000",
		type: String,
	})
	targetAmount!: string;

	@ApiProperty({
		description: "累计已使用数量 = Σ UsageRecord.amount（toFixed(4) 字符串）",
		example: "400.0000",
		type: String,
	})
	usedQuantity!: string;

	@ApiProperty({
		description:
			"已使用成本（本位币，toFixed(4) 字符串）= Σ UsageLotAllocation.cost；无有效使用或成本缺失时为 null（缺成本不按零）",
		example: "2840.0000",
		type: String,
		nullable: true,
	})
	usedTotalCost!: string | null;

	@ApiProperty({
		description:
			"使用均价 = 已使用成本 ÷ 已使用数量（toFixed(8) 字符串）；从未使用时不计算，为 null（不显示 0）",
		example: "7.10000000",
		type: String,
		nullable: true,
	})
	usedUnitCost!: string | null;

	@ApiProperty({
		description:
			"是否涉及手续费未明确的买入（true 时前端显示「按已录入金额计算，部分交易费用未明确…」固定说明）",
		example: false,
		type: Boolean,
	})
	hasUnknownFee!: boolean;

	@ApiProperty({
		description:
			"信息更新时间（ISO 8601，展示口径 = max(使用记录 updatedAt, 相关更正 createdAt)；无记录 null）",
		example: "2026-09-08T02:00:00.000Z",
		type: String,
		nullable: true,
	})
	updatedAt!: string | null;
}

/** GET /api/reports/plans 出参 */
export class ReportPlanListDto {
	@ApiProperty({
		description:
			"本位币（成本币种，取 userSettings.baseCurrency）；新用户无设置行时为 null",
		example: "CNY",
		type: String,
		nullable: true,
	})
	baseCurrency!: string | null;

	@ApiProperty({
		description: "计划成本摘要列表，按计划创建时间倒序；无计划时空数组",
		type: [ReportPlanListItemDto],
	})
	items!: ReportPlanListItemDto[];
}

/** 来源拆分（单计划报告：初始持仓 / 后续买入各自的数量与成本） */
export class ReportSourceSplitItemDto {
	@ApiProperty({
		description: '该来源已使用数量（toFixed(4) 字符串；无该来源时为 "0.0000"）',
		example: "100.0000",
		type: String,
	})
	quantity!: string;

	@ApiProperty({
		description:
			'该来源已使用成本（toFixed(4) 字符串）；批次必有成本，无该来源时为 "0.0000"',
		example: "710.0000",
		type: String,
	})
	cost!: string;
}

/** 单计划报告来源拆分组 */
export class ReportSourceSplitDto {
	@ApiProperty({
		description: "初始持仓来源（成本为记账起点口径）",
		type: ReportSourceSplitItemDto,
	})
	initial!: ReportSourceSplitItemDto;

	@ApiProperty({ description: "后续买入来源", type: ReportSourceSplitItemDto })
	purchase!: ReportSourceSplitItemDto;
}

/** 单计划报告成本摘要组 */
export class ReportPlanCostDto {
	@ApiProperty({
		description:
			"已使用总成本（本位币，toFixed(4) 字符串）；无有效使用或成本缺失时为 null",
		example: "2840.0000",
		type: String,
		nullable: true,
	})
	usedTotalCost!: string | null;

	@ApiProperty({
		description:
			"使用均价（toFixed(8) 字符串）；从未使用时不计算，为 null（不显示 0）",
		example: "7.10000000",
		type: String,
		nullable: true,
	})
	usedUnitCost!: string | null;

	@ApiProperty({
		description: "是否涉及手续费未明确的买入（前端显示固定说明文案）",
		example: false,
		type: Boolean,
	})
	hasUnknownFee!: boolean;
}

/** 单计划报告基本信息组 */
export class ReportPlanInfoDto {
	@ApiProperty({
		description: "计划 ID（cuid）",
		example: "cmex5g2h70000abcd",
		type: String,
	})
	id!: string;

	@ApiProperty({
		description: "计划名称（缺省为 null）",
		example: "今年换 5 万美元",
		type: String,
		nullable: true,
	})
	name!: string | null;

	@ApiProperty({
		description: "计划状态",
		example: "ACTIVE",
		enum: ["ACTIVE", "COMPLETED", "CANCELLED"],
		type: String,
	})
	status!: string;

	@ApiProperty({
		description: "目标币种（ISO 4217）",
		example: "USD",
		type: String,
	})
	currencyCode!: string;

	@ApiProperty({
		description:
			"本位币（成本币种）；新用户无设置行时为 null（前端成本列退化为纯金额）",
		example: "CNY",
		type: String,
		nullable: true,
	})
	baseCurrency!: string | null;

	@ApiProperty({
		description: "目标金额（toFixed(4) 字符串）",
		example: "10000.0000",
		type: String,
	})
	targetAmount!: string;

	@ApiProperty({
		description: "累计已使用数量（toFixed(4) 字符串）",
		example: "400.0000",
		type: String,
	})
	usedQuantity!: string;

	@ApiProperty({
		description:
			"剩余待使用 = max(0, 目标 − 已使用)（toFixed(4) 字符串；完成后调小场景的「差额」展示）",
		example: "9600.0000",
		type: String,
	})
	remainingToUseAmount!: string;
}

/** 单计划报告收益占位组（算法定稿前不出数值，方案 §12） */
export class ReportYieldSectionDto {
	@ApiProperty({
		description:
			"收益区块展示类型：INITIAL_ONLY_NO_COMPARISON = 纯初始持仓，显示「不计算收益比较」；NOT_SUPPORTED_YET = 含买入来源，算法待确认，显示「收益比较将在后续版本提供」",
		example: "NOT_SUPPORTED_YET",
		enum: ["INITIAL_ONLY_NO_COMPARISON", "NOT_SUPPORTED_YET"],
		type: String,
	})
	displayType!: string;
}

/** 单计划报告元信息组 */
export class ReportPlanMetaDto {
	@ApiProperty({
		description:
			"信息更新时间（ISO 8601，展示口径 = max(使用记录 updatedAt, 相关更正 createdAt)；无记录 null）",
		example: "2026-09-08T02:00:00.000Z",
		type: String,
		nullable: true,
	})
	updatedAt!: string | null;

	@ApiProperty({
		description: "报告生成时间（ISO 8601；报告页脚展示）",
		example: "2026-09-08T10:00:00.000Z",
		type: String,
	})
	generatedAt!: string;
}

/** GET /api/reports/plans/:id 出参（页面摘要与打印视图共用数据源） */
export class PlanReportDto {
	@ApiProperty({ description: "计划基本信息与进度", type: ReportPlanInfoDto })
	plan!: ReportPlanInfoDto;

	@ApiProperty({ description: "成本摘要", type: ReportPlanCostDto })
	cost!: ReportPlanCostDto;

	@ApiProperty({
		description: "来源拆分（初始持仓 / 后续买入）",
		type: ReportSourceSplitDto,
	})
	sourceSplit!: ReportSourceSplitDto;

	@ApiProperty({
		description: "收益区块（本期占位，不出数值）",
		type: ReportYieldSectionDto,
	})
	yieldSection!: ReportYieldSectionDto;

	@ApiProperty({
		description: "元信息（更新时间 / 报告生成时间）",
		type: ReportPlanMetaDto,
	})
	meta!: ReportPlanMetaDto;
}

/** 模块错误响应体（统一 { code, message }，风格与 account/plan 模块一致） */
export class ReportErrorDto {
	@ApiProperty({
		description: "错误码",
		example: "PLAN_NOT_FOUND",
		enum: ["INVALID_REPORT_PARAMS", "PLAN_NOT_FOUND"],
		type: String,
	})
	code!: string;

	@ApiProperty({
		description: "错误描述",
		example: "计划不存在",
		type: String,
	})
	message!: string;
}
