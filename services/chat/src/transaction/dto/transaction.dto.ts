import { ApiProperty } from "@nestjs/swagger";
import {
	IsISO8601,
	IsIn,
	IsOptional,
	IsString,
	Matches,
} from "class-validator";
import { CURRENCIES } from "@fxplanner-new/money";

/**
 * 买入交易模块 DTO：OpenAPI 契约唯一来源，前端类型由 generate:api 产出。
 * 每个 @ApiProperty 必须显式标注 type，不得依赖转译器元数据推断。
 * 金额一律字符串传输（@IsString 拒绝 JSON number 引入浮点误差），
 * 响应固定 4 位小数（Decimal(20, 4)）；汇率固定 8 位小数（Decimal(20, 10)）。
 * 值域校验（金额有效数字/上限、小数位与币种精度、三值自洽、日期上下界等）
 * 统一在 TransactionService 以 { code, message } 400 抛出，保持错误契约一致。
 */

/** 15 个支持币种代码（DTO 值域校验与 OpenAPI enum 共用） */
const CURRENCY_CODES = CURRENCIES.map((currency) => currency.code);

/** 模块错误码（经 OpenAPI enum 下发，前端据此分支提示） */
export const TRANSACTION_ERROR_CODES = [
	"INVALID_TRANSACTION_PARAMS",
	"ROUND_TO_ZERO",
	"PLAN_CURRENCY_MISMATCH",
	"PLAN_NOT_FOUND",
	"TRANSACTION_NOT_FOUND",
] as const;

export type TransactionErrorCode = (typeof TRANSACTION_ERROR_CODES)[number];

/** POST /api/transactions 请求体（两种填法三值同送，后端做双向自洽校验） */
export class CreateTransactionDto {
	@ApiProperty({
		description: "买入币种（ISO 4217，必须在支持的 15 币种内）",
		example: "USD",
		enum: [...CURRENCY_CODES],
		type: String,
	})
	@IsString({ message: "币种必须是字符串" })
	@IsIn(CURRENCY_CODES, { message: "币种必须是支持的 15 种币种之一" })
	currencyCode!: string;

	@ApiProperty({
		description: "本金金额（本位币，正数字符串，< 单笔上限 100,000,000,000）",
		example: "72480.00",
		type: String,
	})
	@IsString({ message: "本金金额必须是字符串" })
	principalAmount!: string;

	@ApiProperty({
		description:
			"成交汇率（1 外币 = X 本位币，正数字符串，≤ 8 位小数，超位数拒绝不截断）",
		example: "7.24800000",
		type: String,
	})
	@IsString({ message: "汇率必须是字符串" })
	@Matches(/^\d+(\.\d{1,8})?$/, {
		message: "汇率必须是不超过 8 位小数的正数字符串",
	})
	exchangeRate!: string;

	@ApiProperty({
		description:
			"到账外币数量（正数字符串；小数位 ≤ 币种精度，JPY/KRW 必须为整数；< 单笔上限）",
		example: "10000.00",
		type: String,
	})
	@IsString({ message: "到账数量必须是字符串" })
	quantity!: string;

	@ApiProperty({
		description:
			'手续费（本位币，可选）；缺省 = 未知（落库 null，≠ 0）；"0" = 无手续费',
		example: "42.00",
		type: String,
		nullable: true,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "手续费必须是字符串" })
	feeAmount?: string | null;

	@ApiProperty({
		description: "交易日期（ISO 8601；UTC+8 口径不晚于今天，不早于账本起点）",
		example: "2026-09-20T00:00:00.000Z",
		type: String,
	})
	@IsString({ message: "交易日期必须是字符串" })
	@IsISO8601({}, { message: "交易日期必须是有效的 ISO 8601 日期" })
	transactedAt!: string;

	@ApiProperty({
		description:
			"关联计划 ID（可选，仅标记不触发分配；计划币种须与买入币种一致）",
		example: "cmb1...",
		type: String,
		nullable: true,
		required: false,
	})
	@IsOptional()
	@IsString({ message: "计划 ID 必须是字符串" })
	planId?: string | null;
}

/** 交易详情（创建与 GET /transactions/:id 共用）；金额固定 4 位、汇率固定 8 位小数字符串 */
export class TransactionDto {
	@ApiProperty({
		description: "交易 ID（cuid）",
		example: "cmb9...",
		type: String,
	})
	id!: string;

	@ApiProperty({
		description: "买入币种（ISO 4217）",
		example: "USD",
		type: String,
	})
	currencyCode!: string;

	@ApiProperty({
		description: "到账外币数量（固定 4 位小数字符串）",
		example: "10000.0000",
		type: String,
	})
	quantity!: string;

	@ApiProperty({
		description: "本金金额（本位币，固定 4 位小数字符串）",
		example: "72480.0000",
		type: String,
	})
	principalAmount!: string;

	@ApiProperty({
		description: "手续费（本位币，固定 4 位小数字符串）；null = 未知（≠ 0）",
		example: "42.0000",
		type: String,
		nullable: true,
	})
	feeAmount!: string | null;

	@ApiProperty({
		description:
			"交易总成本 = 本金 + 手续费（固定 4 位小数字符串）；手续费未知时为 null（绝不当 0 计算）",
		example: "72522.0000",
		type: String,
		nullable: true,
	})
	totalCost!: string | null;

	@ApiProperty({
		description: "手续费是否明确（false 时前端显示「费用未明确」提示）",
		example: true,
		type: Boolean,
	})
	feeKnown!: boolean;

	@ApiProperty({
		description: "成交汇率（1 外币 = X 本位币，固定 8 位小数字符串）",
		example: "7.24800000",
		type: String,
	})
	exchangeRate!: string;

	@ApiProperty({
		description: "关联计划 ID（仅标记，可空）",
		example: "cmb1...",
		type: String,
		nullable: true,
	})
	planId!: string | null;

	@ApiProperty({
		description: "关联计划名称（计划不存在或未关联时为 null）",
		example: "学费计划",
		type: String,
		nullable: true,
	})
	planName!: string | null;

	@ApiProperty({
		description: "交易日期（ISO 8601 UTC）",
		example: "2026-09-20T00:00:00.000Z",
		type: String,
	})
	transactedAt!: string;

	@ApiProperty({
		description: "更正版本号（本次恒为 1，交易更正能力随 M8 实现）",
		example: 1,
		type: Number,
	})
	version!: number;
}

/** 模块错误响应体（统一 { code, message }，风格与 plan/rate 模块一致） */
export class TransactionErrorDto {
	@ApiProperty({
		description: "错误码（见 enum）",
		example: "INVALID_TRANSACTION_PARAMS",
		enum: [...TRANSACTION_ERROR_CODES],
		type: String,
	})
	code!: string;

	@ApiProperty({
		description: "错误描述",
		example: "本金、汇率与到账数量不匹配，请按其中一种填法重新核对",
		type: String,
	})
	message!: string;
}
