import { ApiProperty } from "@nestjs/swagger";
import {
	IsDefined,
	IsIn,
	IsInt,
	IsISO8601,
	IsOptional,
	IsString,
	MinLength,
	ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * 更正模块 DTO：OpenAPI 契约唯一来源，前端类型由 generate:api 产出（方案 §6）。
 * 金额一律字符串传输（与 transaction/plan 模块口径一致）；响应固定 4 位小数。
 * preview 与 apply 请求体同构（apply 透传 baseVersion/baseUpdatedAt 做乐观校验）。
 * 值域校验（白名单、三值自洽、V1~V4 等）统一在 CorrectionService 以 { code, message } 抛出。
 */

/** 更正目标类型（USAGE 依赖 M7 资金使用模块，落地前接口层返回 400 降级，方案 §10） */
export const CORRECTION_TARGET_TYPES = [
	"TRANSACTION",
	"USAGE",
	"INITIAL_HOLDING",
] as const;

export type CorrectionTargetTypeValue =
	(typeof CORRECTION_TARGET_TYPES)[number];

/** 模块错误码（经 OpenAPI enum 下发，前端据此分支提示；方案 §6 错误契约） */
export const CORRECTION_ERROR_CODES = [
	"CORRECTION_TARGET_NOT_FOUND",
	"INVALID_CORRECTION_PARAMS",
	"CORRECTION_NOT_ALLOWED",
	"RATE_QUOTE_UNAVAILABLE",
	"CORRECTION_QUOTE_CHANGED",
	"CORRECTION_TARGET_TYPE_UNAVAILABLE",
	"CORRECTION_TARGET_CHANGED",
	"CORRECTION_INSUFFICIENT_FUNDS",
	"CORRECTION_ALLOCATION_CONFLICT",
	"CORRECTION_HISTORICAL_SHORTFALL",
] as const;

export type CorrectionErrorCode = (typeof CORRECTION_ERROR_CODES)[number];

/** 拟变更集合：三类型字段合并声明，service 按 targetType 白名单校验（白名单外 400） */
export class CorrectionChangesDto {
	@ApiProperty({
		description:
			"目标币种（TRANSACTION / INITIAL_HOLDING 可改；15 币种内；改币种触发两币种全量重放）",
		example: "CAD",
		type: String,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "币种必须是字符串" })
	currencyCode?: string;

	@ApiProperty({
		description: "本金金额（TRANSACTION 可改；正数字符串，≤ 4 位小数）",
		example: "7800.00",
		type: String,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "本金金额必须是字符串" })
	principalAmount?: string;

	@ApiProperty({
		description: "到账数量（TRANSACTION 可改；正数字符串，小数位 ≤ 币种精度）",
		example: "1000.00",
		type: String,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "到账数量必须是字符串" })
	quantity?: string;

	@ApiProperty({
		description:
			"手续费（TRANSACTION 可改）；提供即生效——字符串 = 补录金额，null = 改回「未知」（≠ 0）；缺省字段 = 不修改",
		example: "20.00",
		type: String,
		nullable: true,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "手续费必须是字符串" })
	feeAmount?: string | null;

	@ApiProperty({
		description:
			"交易日期（TRANSACTION 可改；ISO 8601；UTC+8 口径不晚于今天、不早于账本起点）",
		example: "2026-09-20T00:00:00.000Z",
		type: String,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "交易日期必须是字符串" })
	transactedAt?: string;

	@ApiProperty({
		description:
			"金额（USAGE = 使用金额须 > 0；INITIAL_HOLDING = 初始金额，允许 0）",
		example: "1000.0000",
		type: String,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "金额必须是字符串" })
	amount?: string;

	@ApiProperty({
		description: "使用日期（USAGE 可改；ISO 8601；不能早于账本起点）",
		example: "2026-09-04T00:00:00.000Z",
		type: String,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "使用日期必须是字符串" })
	usedAt?: string;
}

/** preview / apply 共用请求体（方案 §6.1/§6.2：apply 透传同一结构做乐观校验） */
export class CorrectionRequestDto {
	@ApiProperty({
		description:
			"更正目标类型（TRANSACTION / USAGE / INITIAL_HOLDING；USAGE 自 MVP-F0-3 起支持改金额与改日期）",
		example: "TRANSACTION",
		enum: [...CORRECTION_TARGET_TYPES],
		type: String,
	})
	@IsString({ message: "targetType 必须是字符串" })
	@IsIn([...CORRECTION_TARGET_TYPES], {
		message: "targetType 必须是 TRANSACTION / USAGE / INITIAL_HOLDING 之一",
	})
	targetType!: CorrectionTargetTypeValue;

	@ApiProperty({
		description: "被更正记录 id",
		example: "cmb9...",
		type: String,
	})
	@IsString({ message: "targetId 必须是字符串" })
	targetId!: string;

	@ApiProperty({
		description:
			"乐观校验基准版本（TRANSACTION/USAGE 必填；preview 时所读到的目标 version）",
		example: 1,
		type: Number,
		required: false,
	})
	@IsOptional()
	@IsInt({ message: "baseVersion 必须是整数" })
	baseVersion?: number;

	@ApiProperty({
		description: "USAGE 提交必填，传回影响预览返回的 expectedUsageImpact",
		type: String,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "expectedUsageImpact 必须是字符串" })
	expectedUsageImpact?: string;

	@ApiProperty({
		description:
			"乐观校验基准更新时间（INITIAL_HOLDING 用，无 version 列；preview 时所读到的目标 updatedAt）",
		example: "2026-09-20T12:00:00.000Z",
		type: String,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "baseUpdatedAt 必须是字符串" })
	@IsISO8601({}, { message: "baseUpdatedAt 必须是有效的 ISO 8601 时间戳" })
	baseUpdatedAt?: string;

	@ApiProperty({
		description:
			"初始持仓改币种时，从影响预览的 holdingQuote.confirmationKey 原样提交；其他更正无需传入",
		type: String,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "previewQuoteKey 必须是字符串" })
	previewQuoteKey?: string;

	@ApiProperty({
		description: "修改原因（必填；失败尝试亦留痕该原因）",
		example: "手续费实际为 20 港元，当时漏填",
		type: String,
	})
	@IsString({ message: "修改原因必须是字符串" })
	@MinLength(1, { message: "修改原因必填" })
	reason!: string;

	@ApiProperty({
		description:
			"拟变更集合（按 targetType 白名单校验；缺省字段 = 不修改；至少一项有效变化）",
		type: CorrectionChangesDto,
	})
	// @ValidateNested + @Type 必须显式声明：whitelist 管道会剥离无验证装饰器的属性，
	// 缺失时 changes 会被静默剥离为 undefined（嵌套 DTO 丢失）
	@IsDefined({ message: "changes 必填" })
	@ValidateNested()
	@Type(() => CorrectionChangesDto)
	changes!: CorrectionChangesDto;
}

/** diff 项（前后对比；display 为面向展示的中文摘要，如「未知 → 20.0000」） */
export class CorrectionDiffItemDto {
	@ApiProperty({ description: "字段名", example: "feeAmount", type: String })
	field!: string;

	@ApiProperty({
		description: "原值（手续费未知时为 null）",
		example: null,
		nullable: true,
		type: String,
	})
	before!: string | null;

	@ApiProperty({
		description: "新值",
		example: "20.0000",
		nullable: true,
		type: String,
	})
	after!: string | null;

	@ApiProperty({
		description: "展示摘要（金额 4 位；日期 yyyy-MM-dd）",
		example: "未知 → 20.0000",
		type: String,
	})
	display!: string;
}

/** 余额影响（受影响币种的余额前后；初始持仓更正后重放终态） */
export class CorrectionBalanceImpactDto {
	@ApiProperty({ description: "币种", example: "USD", type: String })
	currencyCode!: string;

	@ApiProperty({
		description: "更正前余额（4 位）",
		example: "600.0000",
		type: String,
	})
	before!: string;

	@ApiProperty({
		description: "更正后余额（4 位）",
		example: "600.0000",
		type: String,
	})
	after!: string;
}

/** 使用金额更正对本计划分配与未分配资金的影响 */
export class CorrectionAllocationImpactDto {
	@ApiProperty({ description: "计划 ID", example: "cmb1...", type: String })
	planId!: string;

	@ApiProperty({ description: "币种", example: "USD", type: String })
	currencyCode!: string;

	@ApiProperty({
		description: "分配总额 前值（4 位）",
		example: "600.0000",
		type: String,
	})
	amountBefore!: string;

	@ApiProperty({
		description: "分配总额 后值（4 位）",
		example: "600.0000",
		type: String,
	})
	amountAfter!: string;

	@ApiProperty({
		description: "累计已使用 前值（4 位）",
		example: "400.0000",
		type: String,
	})
	usedBefore!: string;

	@ApiProperty({
		description: "累计已使用 后值（4 位）",
		example: "400.0000",
		type: String,
	})
	usedAfter!: string;

	@ApiProperty({ description: "增额中由原计划分配承担的金额（4 位）", type: String })
	fromPlan!: string;

	@ApiProperty({ description: "增额中从未分配余额补入的金额（4 位）", type: String })
	supplement!: string;

	@ApiProperty({
		description: "更正前的计划剩余分配（4 位）",
		example: "200.0000",
		type: String,
	})
	remainingBefore!: string;

	@ApiProperty({
		description: "更正后的计划剩余分配（4 位）",
		example: "0.0000",
		type: String,
	})
	remainingAfter!: string;

	@ApiProperty({
		description: "增加的用量中来自本计划原有剩余分配的金额（4 位）",
		example: "200.0000",
		type: String,
	})
	usedFromRemaining!: string;

	@ApiProperty({
		description: "未分配余额变动（4 位）：正值为返还，负值为补入本计划并立即使用",
		example: "-100.0000",
		type: String,
	})
	unallocatedDelta!: string;
}

/** 使用成本影响（受影响币种内每笔使用的成本前后；含「无使用记录」时空数组） */
export class CorrectionCostImpactDto {
	@ApiProperty({ description: "使用记录 ID", example: "cmbU...", type: String })
	usageId!: string;

	@ApiProperty({
		description: "更正前成本（4 位；无分摊明细时为 null）",
		example: "9400.0000",
		nullable: true,
		type: String,
	})
	costBefore!: string | null;

	@ApiProperty({
		description: "更正后成本（4 位；无分摊明细时为 null）",
		example: "9560.0000",
		nullable: true,
		type: String,
	})
	costAfter!: string | null;
}

/** 拦截明细（缺口日期/金额、受影响计划等；blockers 与 409/400 错误 details 共用结构） */
export class CorrectionBlockerDetailDto {
	@ApiProperty({
		description: "币种（资金/分配类拦截时）",
		example: "USD",
		type: String,
		nullable: true,
	})
	currencyCode?: string | null;

	@ApiProperty({
		description: "缺口数量（时点/终态不足时）",
		example: "400.0000",
		nullable: true,
		type: String,
	})
	shortfall?: string | null;

	@ApiProperty({
		description: "发生时间（历史时点缺口时，ISO 8601）",
		example: "2026-09-02T00:00:00.000Z",
		nullable: true,
		type: String,
	})
	usedAt?: string | null;

	@ApiProperty({
		description: "受影响计划 ID（分配冲突时）",
		example: "cmb1...",
		nullable: true,
		type: String,
	})
	planId?: string | null;
}

/** 拦截项（blockers 非空 = 不能提交；code 与错误码 enum 同值域子集） */
export class CorrectionBlockerDto {
	@ApiProperty({
		description:
			"拦截类型（CORRECTION_INSUFFICIENT_FUNDS / CORRECTION_ALLOCATION_CONFLICT / CORRECTION_HISTORICAL_SHORTFALL / CORRECTION_NO_CHANGES）",
		example: "CORRECTION_HISTORICAL_SHORTFALL",
		enum: [
			"CORRECTION_INSUFFICIENT_FUNDS",
			"CORRECTION_ALLOCATION_CONFLICT",
			"CORRECTION_HISTORICAL_SHORTFALL",
		],
		type: String,
	})
	code!: string;

	@ApiProperty({
		description: "不能提交的原因（面向用户展示）",
		example: "更正后 2026-09-02 的使用发生时同币种资金不足",
		type: String,
	})
	message!: string;

	@ApiProperty({
		description: "缺口/受影响明细",
		type: [CorrectionBlockerDetailDto],
	})
	details!: CorrectionBlockerDetailDto[];
}

/** 余额、计划分配与使用成本的影响汇总 */
export class CorrectionImpactSummaryDto {
	@ApiProperty({
		description: "余额影响（受影响币种）",
		type: [CorrectionBalanceImpactDto],
	})
	balances!: CorrectionBalanceImpactDto[];

	@ApiProperty({
		description: "使用金额更正的计划分配及资金来源影响；其他更正为空数组",
		type: [CorrectionAllocationImpactDto],
	})
	allocations!: CorrectionAllocationImpactDto[];

	@ApiProperty({
		description: "使用成本影响（受影响币种内每笔使用）",
		type: [CorrectionCostImpactDto],
	})
	costs!: CorrectionCostImpactDto[];

	@ApiProperty({
		description: "提示（如「存在手续费未明确的记录，成本说明继续保留」）",
		type: [String],
	})
	warnings!: string[];
}

/** 初始持仓改币种时用于重算成本的历史报价。 */
export class CorrectionHoldingQuoteDto {
	@ApiProperty({ description: "提交时原样回传的报价确认键", type: String })
	confirmationKey!: string;

	@ApiProperty({ description: "重算成本采用的汇率（8 位小数）", type: String })
	rate!: string;

	@ApiProperty({ description: "舍入前的原始采用价（10 位小数）", type: String })
	rawRate!: string;

	@ApiProperty({ description: "报价来源", example: "abc", type: String })
	source!: string;

	@ApiProperty({ description: "报价观测时间（ISO 8601）", type: String })
	observedAt!: string;
}

/** 影响预览响应（方案 §6.1：前后对比 + 余额/分配/成本影响 + 拦截明细） */
export class CorrectionPreviewDto {
	@ApiProperty({
		description: "目标类型",
		example: "TRANSACTION",
		enum: [...CORRECTION_TARGET_TYPES],
		type: String,
	})
	targetType!: CorrectionTargetTypeValue;

	@ApiProperty({
		description: "被更正记录 id",
		example: "cmb9...",
		type: String,
	})
	targetId!: string;

	@ApiProperty({
		description:
			"目标当前完整内容（金额 4 位、时间 ISO；字段随 targetType 不同）",
		type: Object,
		additionalProperties: true,
	})
	before!: Record<string, unknown>;

	@ApiProperty({
		description: "应用变更后的完整内容（未落库，仅供预览）",
		type: Object,
		additionalProperties: true,
	})
	after!: Record<string, unknown>;

	@ApiProperty({
		description: "初始持仓改币种采用的历史报价及确认键，仅改币种时返回",
		type: CorrectionHoldingQuoteDto,
		required: false,
	})
	holdingQuote?: CorrectionHoldingQuoteDto;

	@ApiProperty({
		description: "逐字段前后对比（仅列发生变化且有展示语义的字段）",
		type: [CorrectionDiffItemDto],
	})
	diff!: CorrectionDiffItemDto[];

	@ApiProperty({ description: "影响面汇总", type: CorrectionImpactSummaryDto })
	impacts!: CorrectionImpactSummaryDto;

	@ApiProperty({
		description: "拦截明细（非空 = 不能提交，确认按钮应禁用）",
		type: [CorrectionBlockerDto],
	})
	blockers!: CorrectionBlockerDto[];

	@ApiProperty({
		description: "USAGE 预览的影响指纹，提交时原样传回",
		type: String,
		required: false,
	})
	expectedUsageImpact?: string;
}

/** apply 响应（方案 §6.2） */
export class CorrectionApplyResultDto {
	@ApiProperty({
		description: "更正记录 ID（Correction.id）",
		example: "cmbC...",
		type: String,
	})
	correctionId!: string;

	@ApiProperty({
		description: "结果状态（apply 成功恒为 APPLIED）",
		example: "APPLIED",
		type: String,
	})
	status!: string;

	@ApiProperty({
		description: "目标类型",
		example: "TRANSACTION",
		type: String,
	})
	targetType!: CorrectionTargetTypeValue;

	@ApiProperty({
		description: "被更正记录 id",
		example: "cmb9...",
		type: String,
	})
	targetId!: string;

	@ApiProperty({
		description:
			"更正后版本号（TRANSACTION/USAGE = version+1；INITIAL_HOLDING 无版本列返回 null）",
		example: 2,
		nullable: true,
		type: Number,
	})
	targetVersion!: number | null;

	@ApiProperty({
		description: "留痕时间（ISO 8601）",
		example: "2026-09-20T12:00:00.000Z",
		type: String,
	})
	createdAt!: string;
}

/** 修改记录条目（列表响应；FAILED 附 failReason，快照原样透出） */
export class CorrectionDto {
	@ApiProperty({ description: "更正记录 ID", example: "cmbC...", type: String })
	id!: string;

	@ApiProperty({
		description: "目标类型",
		example: "TRANSACTION",
		enum: [...CORRECTION_TARGET_TYPES],
		type: String,
	})
	targetType!: CorrectionTargetTypeValue;

	@ApiProperty({
		description: "被更正记录 id",
		example: "cmb9...",
		type: String,
	})
	targetId!: string;

	@ApiProperty({
		description: "修改原因",
		example: "手续费实际为 20 港元",
		type: String,
	})
	reason!: string;

	@ApiProperty({
		description: "修改前快照（完整字段 + 影响面摘要；手续费保留 null 语义）",
		type: Object,
		additionalProperties: true,
	})
	beforeSnapshot!: Record<string, unknown>;

	@ApiProperty({
		description: "修改后快照（FAILED 时为空对象）",
		type: Object,
		additionalProperties: true,
	})
	afterSnapshot!: Record<string, unknown>;

	@ApiProperty({
		description: "结果状态：APPLIED = 已生效；FAILED = 提交失败（原数据不变）",
		example: "APPLIED",
		enum: ["APPLIED", "FAILED"],
		type: String,
	})
	status!: string;

	@ApiProperty({
		description: "失败原因（FAILED 时）",
		example: "更正后 USD 余额将变负",
		nullable: true,
		type: String,
	})
	failReason!: string | null;

	@ApiProperty({
		description: "留痕时间（ISO 8601）",
		example: "2026-09-20T12:00:00.000Z",
		type: String,
	})
	createdAt!: string;
}

/** 修改记录列表响应（GET /corrections?targetType=&targetId=&page=） */
export class CorrectionListDto {
	@ApiProperty({
		description: "修改记录（createdAt 倒序；含 APPLIED 与 FAILED）",
		type: [CorrectionDto],
	})
	items!: CorrectionDto[];

	@ApiProperty({ description: "总条数", example: 3, type: Number })
	total!: number;

	@ApiProperty({ description: "当前页（从 1 起）", example: 1, type: Number })
	page!: number;

	@ApiProperty({
		description: "每页条数（固定 20）",
		example: 20,
		type: Number,
	})
	pageSize!: number;
}

/** 目标当前内容响应（GET /corrections/target?targetType=&targetId=；更正页表单初值数据源） */
export class CorrectionTargetDto {
	@ApiProperty({
		description: "目标类型",
		example: "TRANSACTION",
		enum: [...CORRECTION_TARGET_TYPES],
		type: String,
	})
	targetType!: CorrectionTargetTypeValue;

	@ApiProperty({
		description: "被更正记录 id",
		example: "cmb9...",
		type: String,
	})
	targetId!: string;

	@ApiProperty({
		description:
			"目标当前完整内容（金额 4 位、时间 ISO；含乐观校验基准字段 version / updatedAt）",
		type: Object,
		additionalProperties: true,
	})
	target!: Record<string, unknown>;
}

/** 模块错误响应体（统一 { code, message, details? }，details 附缺口/计划明细） */
export class CorrectionErrorDto {
	@ApiProperty({
		description: "错误码（见 enum）",
		example: "CORRECTION_HISTORICAL_SHORTFALL",
		enum: [...CORRECTION_ERROR_CODES],
		type: String,
	})
	code!: string;

	@ApiProperty({
		description: "错误描述（面向用户展示）",
		example: "更正后历史使用发生时同币种资金不足，不能提交",
		type: String,
	})
	message!: string;

	@ApiProperty({
		description: "缺口/受影响计划明细（可选）",
		type: [CorrectionBlockerDetailDto],
		required: false,
	})
	details?: CorrectionBlockerDetailDto[];
}
