import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

/**
 * 资金使用模块 DTO：OpenAPI 契约唯一来源，前端类型由 generate:api 产出。
 * 每个 @ApiProperty 必须显式标注 type，不得依赖转译器元数据推断。
 * 金额一律字符串传输，固定 4 位小数（Decimal(20, 4)）；
 * 日期一律 ISO 8601 UTC（00:00:00.000Z）。
 * 值域校验（金额 > 0 / 币种精度 / 上限 / 日期上下界 / 备注长度等）
 * 统一在 UsageService 以 { code, message } 400 抛出，保持错误契约一致
 * （对齐 plan.dto.ts 头注释口径）。
 */

/** POST /api/plans/:id/usages 请求体 */
export class CreateUsageDto {
	@ApiProperty({
		description:
			"使用金额（正数字符串，≤ 币种精度：日元/韩元整数、其余 2 位小数，≤ 单笔上限 100,000,000,000，≤ 计划剩余分配）",
		example: "4000.0000",
		type: String,
	})
	@IsString({ message: "使用金额必须是字符串" })
	amount!: string;

	@ApiProperty({
		description:
			"使用日期（ISO 8601，服务端截取 UTC 0 点；不晚于今天 UTC+8 口径、不早于记账起点）",
		example: "2026-09-20T00:00:00.000Z",
		type: String,
	})
	@IsString({ message: "使用日期必须是字符串" })
	usedAt!: string;

	@ApiProperty({
		description: "备注（可选，≤ 200 字符；缺省存 null）",
		example: "秋季学费第一期",
		type: String,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "备注必须是字符串" })
	remark?: string;
}

/** 单条使用记录（GET 列表项与 POST 出参 usage 共用；cost 为 FIFO 分摊合计成本） */
export class UsageDto {
	@ApiProperty({
		description: "使用记录 ID（cuid）",
		example: "cme…",
		type: String,
	})
	id!: string;

	@ApiProperty({
		description: "所属计划 ID（cuid）",
		example: "cmd…",
		type: String,
	})
	planId!: string;

	@ApiProperty({
		description: "币种（ISO 4217，即计划目标币种）",
		example: "USD",
		type: String,
	})
	currencyCode!: string;

	@ApiProperty({
		description: "使用金额（固定 4 位小数字符串）",
		example: "4000.0000",
		type: String,
	})
	amount!: string;

	@ApiProperty({
		description: "使用日期（ISO 8601 UTC 0 点）",
		example: "2026-09-20T00:00:00.000Z",
		type: String,
	})
	usedAt!: string;

	@ApiProperty({
		description: "备注（未填为 null）",
		example: "秋季学费第一期",
		type: String,
		nullable: true,
	})
	remark!: string | null;

	@ApiProperty({
		description:
			"记录人用户 ID（LEDGER-01.4：组织账本由成员共享，记录人仅用于展示与审计，不是权限筛选条件；组织化之前的存量记录为 null）",
		example: "cme…",
		type: String,
		nullable: true,
	})
	createdById!: string | null;

	@ApiProperty({
		description: "本笔使用成本（FIFO 分摊合计，本位币，固定 4 位小数字符串）",
		example: "9400.0000",
		type: String,
	})
	cost!: string;

	@ApiProperty({
		description: "版本号（恒 1，M8 使用更正预留，本期只写不改）",
		example: 1,
		type: Number,
	})
	version!: number;

	@ApiProperty({
		description: "记录时间（ISO 8601，同日排序次序键）",
		example: "2026-09-20T08:00:00.000Z",
		type: String,
	})
	createdAt!: string;
}

/** GET /api/plans/:id/usages 响应 data */
export class UsageListRespDto {
	@ApiProperty({
		description: "使用记录（usedAt 倒序、同刻 createdAt 倒序；limit 100 兑底）",
		type: [UsageDto],
	})
	items!: UsageDto[];
}

/** 计划资金面快照（POST 出参 plan；前端一次往返即可刷新进度区） */
export class PlanFundSummaryDto {
	@ApiProperty({
		description: "目标金额（固定 4 位小数字符串）",
		example: "10000.0000",
		type: String,
	})
	targetAmount!: string;

	@ApiProperty({
		description: "累计已使用（扣减后，固定 4 位小数字符串）",
		example: "4000.0000",
		type: String,
	})
	usedAmount!: string;

	@ApiProperty({
		description: "分配总额（固定 4 位小数字符串）",
		example: "10000.0000",
		type: String,
	})
	allocatedAmount!: string;

	@ApiProperty({
		description: "计划剩余分配（扣减后，固定 4 位小数字符串）",
		example: "6000.0000",
		type: String,
	})
	remainingAllocation!: string;

	@ApiProperty({
		description:
			"还需使用金额 = max(0, 目标 − 累计已使用)（固定 4 位小数字符串）",
		example: "6000.0000",
		type: String,
	})
	stillNeeded!: string;

	@ApiProperty({
		description: "资金缺口（固定 4 位小数字符串）",
		example: "0.0000",
		type: String,
	})
	gap!: string;

	@ApiProperty({
		description:
			"资金状态（服务端计算）：PREPARING=准备中（有缺口）/ READY=资金已备齐 / USED_UP=资金已使用完成",
		example: "READY",
		enum: ["PREPARING", "READY", "USED_UP"],
	})
	fundStatus!: "PREPARING" | "READY" | "USED_UP";

	@ApiProperty({
		description: "可否完成确认（复用计划详情 canComplete 口径）",
		example: false,
		type: Boolean,
	})
	canComplete!: boolean;
}

/** POST /api/plans/:id/usages 响应 data */
export class CreateUsageRespDto {
	@ApiProperty({ description: "本次写入的使用记录", type: UsageDto })
	usage!: UsageDto;

	@ApiProperty({
		description: "提交后计划资金面快照",
		type: PlanFundSummaryDto,
	})
	plan!: PlanFundSummaryDto;
}

/** 模块错误响应体（统一 { code, message, data? }，对齐 plan 模块 PlanErrorDto） */
export class UsageErrorDto {
	@ApiProperty({
		description:
			"错误码：INVALID_USAGE_PARAMS / PLAN_NOT_FOUND / PLAN_INVALID_TRANSITION / INSUFFICIENT_PLAN_ALLOCATION / INSUFFICIENT_ACCOUNT_BALANCE / USAGE_LOT_SHORTAGE",
		example: "INSUFFICIENT_PLAN_ALLOCATION",
		type: String,
	})
	code!: string;

	@ApiProperty({
		description: "错误描述",
		example: "计划剩余分配不足",
		type: String,
	})
	message!: string;
}
