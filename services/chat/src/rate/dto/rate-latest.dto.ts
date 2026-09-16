import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
	ArrayMaxSize,
	IsArray,
	IsBoolean,
	IsIn,
	IsOptional,
	IsString,
} from "class-validator";
import { normalizeCurrency, SUPPORTED_CURRENCIES } from "../rate.constants";

const CURRENCY_CODES = [...SUPPORTED_CURRENCIES];

/** 逗号分隔字符串 → 规范化币种数组；空串视为未提供（回落到缺省值） */
const splitTargets = ({ value }: { value: unknown }) => {
	if (Array.isArray(value)) return value;
	if (typeof value !== "string") return value;
	const parsed = value
		.split(",")
		.map((item) => normalizeCurrency(item))
		.filter((item) => item.length > 0);
	return parsed.length > 0 ? parsed : undefined;
};

/** "true"/"false" → boolean；其他非法值原样透传，由 @IsBoolean 拒绶为 400 */
const toBoolean = ({ value }: { value: unknown }) => {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	return value;
};

export class LatestRateQueryDto {
	@ApiPropertyOptional({
		description:
			"逗号分隔的目标币种（须在支持清单内，最多 15 个）；缺省为 USD。与 base 相同的币种返回恒等报价（rate=1）",
		example: "CNY,JPY",
		type: [String],
	})
	@IsOptional()
	@Transform(splitTargets)
	@IsArray()
	@ArrayMaxSize(CURRENCY_CODES.length)
	@IsIn(CURRENCY_CODES, { each: true })
	targets?: string[];

	@ApiPropertyOptional({
		description:
			"忽略 5 分钟有效期窗口，强制向数据源回源确认（录入页进入刷新、最终确认前重查用）",
		default: false,
		example: false,
	})
	@IsOptional()
	@Transform(toBoolean)
	@IsBoolean()
	refresh = false;
}

/** 项级/响应级错误体（502 与 items 内 error 同构） */
export class RateErrorDto {
	@ApiProperty({
		description: "机器可读错误码",
		enum: ["RATE_PAIR_UNSUPPORTED", "RATE_SOURCE_UNAVAILABLE"],
		example: "RATE_PAIR_UNSUPPORTED",
		type: String,
	})
	@IsString()
	code!: string;

	@ApiProperty({
		description: "人类可读错误说明",
		example: "汇率数据源不支持 USD → TWD 报价，无法提供该币种有效报价",
		type: String,
	})
	@IsString()
	message!: string;

	@ApiProperty({
		description:
			"该币对库中最后一条报价的时间（ISO 8601）；数据源不可用时供前端兜底提示，无历史报价或币对不支持时为 null",
		nullable: true,
		example: "2026-02-13T08:00:00.000Z",
		type: String,
	})
	@IsString()
	lastObservedAt!: string | null;
}

/** 多目标响应的项：错误下沉到项，不拖垮同组其他币种 */
export class LatestRateItemDto {
	@ApiProperty({ description: "目标币种代码", example: "CNY", type: String })
	@IsString()
	target!: string;

	@ApiPropertyOptional({
		description:
			"报价（1 单位 base 可兑换的 target 数量），按来源报价四舍五入保留 8 位小数",
		example: "0.13910462",
		type: String,
	})
	@IsString()
	rate?: string;

	@ApiPropertyOptional({
		description:
			"现汇卖出价（1 单位 target 兑 X base），四舍五入保留 8 位小数；仅 abc（农行牌价）源返回，其余源缺省，录入价取 sellRate ?? rate",
		example: "0.67401235",
		type: String,
	})
	@IsOptional()
	@IsString()
	sellRate?: string;

	@ApiPropertyOptional({
		description:
			"报价来源（数据源标识；恒等报价为 identity；多源：abc 农行牌价 / frankfurter / er-api）",
		example: "abc",
		type: String,
	})
	@IsString()
	source?: string;

	@ApiPropertyOptional({
		description:
			"报价所属日，数据源标注并如实展示（可能为最近一个工作日，不因确认而变为今天），ISO 8601",
		example: "2026-02-13T00:00:00.000Z",
		type: String,
	})
	@IsString()
	observedAt?: string;

	@ApiPropertyOptional({
		description:
			"有效期窗口终点 = 最后确认时间 + 5 分钟，ISO 8601；恰好满 5 分钟视为过期",
		example: "2026-02-16T08:05:00.000Z",
		type: String,
	})
	@IsString()
	validUntil?: string;

	@ApiPropertyOptional({
		description: "当前是否仍在有效期内（now < validUntil）",
		example: true,
		type: Boolean,
	})
	@IsBoolean()
	fresh?: boolean;

	@ApiPropertyOptional({
		type: RateErrorDto,
		description: "项级错误；出现时本项无报价数据",
	})
	error?: RateErrorDto;
}

/** 单目标（缺省 targets）平铺响应结构 */
export class LatestRateResponseDto {
	@ApiProperty({ description: "基准币种代码", example: "CNY", type: String })
	@IsString()
	base!: string;

	@ApiProperty({ description: "目标币种代码", example: "USD", type: String })
	@IsString()
	target!: string;

	@ApiProperty({
		description:
			"报价（1 单位 base 可兑换的 target 数量），四舍五入保留 8 位小数",
		example: "0.13910462",
		type: String,
	})
	@IsString()
	rate!: string;

	@ApiPropertyOptional({
		description:
			"现汇卖出价（1 单位 target 兑 X base），四舍五入保留 8 位小数；仅 abc（农行牌价）源返回，录入价取 sellRate ?? rate",
		example: "0.67401235",
		type: String,
	})
	@IsOptional()
	@IsString()
	sellRate?: string;

	@ApiProperty({
		description: "报价来源（数据源标识；恒等报价为 identity；多源：abc / frankfurter / er-api）",
		example: "abc",
		type: String,
	})
	@IsString()
	source!: string;

	@ApiProperty({
		description: "报价所属日（如实展示），ISO 8601",
		example: "2026-02-13T00:00:00.000Z",
		type: String,
	})
	@IsString()
	observedAt!: string;

	@ApiProperty({
		description: "有效期窗口终点，ISO 8601",
		example: "2026-02-16T08:05:00.000Z",
		type: String,
	})
	@IsString()
	validUntil!: string;

	@ApiProperty({
		description: "当前是否仍在有效期内",
		example: true,
		type: Boolean,
	})
	@IsBoolean()
	fresh!: boolean;
}

/** 多目标（targets 含 ≥1 个外部币种）响应结构：HTTP 整体 200，错误下沉到 items 项 */
export class LatestRateGroupResponseDto {
	@ApiProperty({ description: "基准币种代码", example: "USD", type: String })
	@IsString()
	base!: string;

	@ApiProperty({
		type: [LatestRateItemDto],
		description: "逐目标报价项（顺序与请求 targets 一致）",
	})
	items!: LatestRateItemDto[];
}
