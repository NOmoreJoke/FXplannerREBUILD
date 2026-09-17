import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsBoolean,
	IsNotEmpty,
	IsOptional,
	IsString,
	ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * 首次设置模块 DTO：OpenAPI 契约唯一来源，前端类型由 generate:api 产出。
 * 每个 @ApiProperty 必须显式标注 type，不得依赖转译器元数据推断。
 */

/** 初始持仓单项（complete 可选入参 / 补录请求体元素共用） */
export class InitialHoldingItemDto {
	@ApiProperty({
		description: "持仓币种（ISO 4217，必须在 15 币种内且不等于本位币）",
		example: "USD",
		type: String,
	})
	@IsString({ message: "币种必须是字符串" })
	@IsNotEmpty({ message: "币种不能为空" })
	currencyCode!: string;

	@ApiProperty({
		description:
			"持仓金额（字符串；最多 2 位小数，JPY/KRW 整数；> 0 且 < 10¹¹）",
		example: "1000.00",
		type: String,
	})
	@IsString({ message: "金额必须是字符串" })
	@IsNotEmpty({ message: "金额不能为空" })
	amount!: string;
}

/** POST /api/onboarding/initial-holdings 请求体：建账后补录初始持仓 */
export class SaveInitialHoldingsDto {
	@ApiProperty({
		description:
			"初始持仓列表（1~14 项；币种校验规则同 complete 的 initialHoldings）",
		type: [InitialHoldingItemDto],
	})
	@IsArray({ message: "holdings 必须是数组" })
	@ArrayMinSize(1, { message: "holdings 不能为空" })
	@ArrayMaxSize(14, { message: "初始持仓最多 14 项（15 币种减本位币）" })
	@ValidateNested({ each: true })
	@Type(() => InitialHoldingItemDto)
	holdings!: InitialHoldingItemDto[];
}

/** POST /api/onboarding/complete 请求体：完整最终设置数据（向导一次性提交，无草稿） */
export class CompleteOnboardingDto {
	@ApiProperty({
		description: "地区（ISO 3166 国家/地区码或用户自填标识）",
		example: "CN",
		type: String,
	})
	@IsString({ message: "地区必须是字符串" })
	@IsNotEmpty({ message: "地区不能为空" })
	region!: string;

	@ApiProperty({
		description: "语言（BCP 47 标识）",
		example: "zh-CN",
		type: String,
	})
	@IsString({ message: "语言必须是字符串" })
	@IsNotEmpty({ message: "语言不能为空" })
	locale!: string;

	@ApiProperty({
		description:
			"本位币（ISO 4217，必须在支持的 15 币种内；完成设置后永久锁定）",
		example: "CNY",
		type: String,
	})
	@IsString({ message: "本位币必须是字符串" })
	@IsNotEmpty({ message: "本位币不能为空" })
	baseCurrency!: string;

	@ApiPropertyOptional({
		description:
			"换汇准备偏好（可选，缺省 balanced，由服务端兜底；向导不再收集）",
		example: "balanced",
		type: String,
	})
	@IsOptional()
	@IsString({ message: "准备偏好必须是字符串" })
	@IsNotEmpty({ message: "准备偏好不能为空" })
	prepPreference?: string;

	@ApiPropertyOptional({
		description: "是否启用到期提醒（可选，缺省 true，由服务端兜底）",
		example: true,
		type: Boolean,
	})
	@IsOptional()
	@IsBoolean({ message: "提醒开关必须是布尔值" })
	reminderEnabled?: boolean;

	@ApiPropertyOptional({
		description:
			"初始持仓（可选，最多 14 项 = 15 币种减本位币；币种不得重复且不得为本位币；任一项失败整单回滚）",
		type: [InitialHoldingItemDto],
	})
	@IsOptional()
	@ArrayMaxSize(14, { message: "初始持仓最多 14 项（15 币种减本位币）" })
	@ValidateNested({ each: true })
	@Type(() => InitialHoldingItemDto)
	initialHoldings?: InitialHoldingItemDto[];
}

/** POST /api/onboarding/consents 请求体：确认年龄与当前版本条款 */
export class SaveConsentsDto {
	@ApiProperty({
		description: "确认已满 18 周岁（必须为 true）",
		example: true,
		type: Boolean,
	})
	@IsBoolean({ message: "年龄确认必须是布尔值" })
	age18Confirmed!: boolean;

	@ApiProperty({
		description: "确认同意当前版本服务条款（必须为 true）",
		example: true,
		type: Boolean,
	})
	@IsBoolean({ message: "条款确认必须是布尔值" })
	termsConfirmed!: boolean;
}

/** 已保存的用户设置视图（只读；本位币完成后永久锁定，无任何更新入口） */
export class OnboardingSettingsViewDto {
	@ApiProperty({
		description: "本位币（ISO 4217，一经设定永久锁定）",
		example: "CNY",
		type: String,
	})
	baseCurrency!: string;

	@ApiProperty({ description: "语言", example: "zh-CN", type: String })
	locale!: string;

	@ApiProperty({ description: "地区", example: "CN", type: String })
	region!: string;

	@ApiProperty({
		description: "换汇准备偏好",
		example: "balanced",
		type: String,
	})
	prepPreference!: string;

	@ApiProperty({ description: "是否启用到期提醒", type: Boolean })
	reminderEnabled!: boolean;

	@ApiProperty({
		description: "记账起点（完成设置的时刻，ISO 8601；历史数据可能为空）",
		example: "2026-08-01T00:00:00.000Z",
		type: Date,
		nullable: true,
	})
	ledgerStartedAt!: Date | null;
}

/** GET /api/onboarding/status 响应 */
export class OnboardingStatusDto {
	@ApiProperty({
		description: "是否已完成首次设置（完成态判定，前端据此跳过向导）",
		type: Boolean,
	})
	completed!: boolean;

	@ApiProperty({
		description: "当前版本必要条款（age18 + terms）是否均已确认",
		type: Boolean,
	})
	requiredConsentsMet!: boolean;

	@ApiProperty({
		description: "已保存的设置；未完成时为 null",
		type: OnboardingSettingsViewDto,
		nullable: true,
	})
	settings!: OnboardingSettingsViewDto | null;

	@ApiProperty({
		description: "当前生效的服务条款版本",
		example: "2026-01",
		type: String,
	})
	currentTermsVersion!: string;
}

/** POST /api/onboarding/consents 响应：两条确认记录（重复确认保留首次时间） */
export class OnboardingConsentsResultDto {
	@ApiProperty({
		description: "确认时适用的条款版本",
		example: "2026-01",
		type: String,
	})
	termsVersion!: string;

	@ApiProperty({
		description: "年龄确认时间（首次确认时刻，ISO 8601）",
		example: "2026-08-01T00:00:00.000Z",
		type: Date,
	})
	age18ConsentedAt!: Date;

	@ApiProperty({
		description: "条款确认时间（首次确认时刻，ISO 8601）",
		example: "2026-08-01T00:00:00.000Z",
		type: Date,
	})
	termsConsentedAt!: Date;
}

/** POST /api/onboarding/complete 响应 */
export class OnboardingCompleteResultDto {
	@ApiProperty({
		description: "创建的用户设置",
		type: OnboardingSettingsViewDto,
	})
	settings!: OnboardingSettingsViewDto;

	@ApiProperty({
		description: "记账起点 = 完成设置确认成功的时刻（ISO 8601）",
		example: "2026-08-01T00:00:00.000Z",
		type: Date,
	})
	ledgerStartedAt!: Date;
}

/** 初始持仓入账结果单项（docs 02：金额、采用汇率、原报价、来源、报价时间、成本） */
export class InitialHoldingCreatedDto {
	@ApiProperty({
		description: "币种代码（ISO 4217，规范化大写）",
		example: "USD",
		type: String,
	})
	currencyCode!: string;

	@ApiProperty({
		description: "持仓金额（Decimal(20, 4)，toFixed(4) 字符串）",
		example: "1000.0000",
		type: String,
	})
	amount!: string;

	@ApiProperty({
		description:
			"采用汇率（来源报价 8 位小数 HALF_UP，toFixed(10) 字符串；1 外币 = X 本位币；现汇卖出价优先）",
		example: "7.2531000000",
		type: String,
	})
	rate!: string;

	@ApiProperty({
		description:
			"来源原报价（未采用 8 位舍入的原始值，toFixed(10) 字符串；与 rate 一起保存防 ExchangeRate 覆盖不可回溯）",
		example: "7.2531000000",
		type: String,
	})
	rawRate!: string;

	@ApiProperty({
		description: "报价来源标识（abc / er-api / frankfurter / identity）",
		example: "abc",
		type: String,
	})
	rateSource!: string;

	@ApiProperty({
		description: "报价观测时间（ISO 8601；5 分钟时效以此时间为锚）",
		example: "2026-08-01T00:00:00.000Z",
		type: Date,
	})
	rateObservedAt!: Date;

	@ApiProperty({
		description:
			"折算成本 = amount × rate 按本位币精度 HALF_UP 舍一次（toFixed(4) 字符串）",
		example: "7253.1000",
		type: String,
	})
	cost!: string;
}

/** POST /api/onboarding/initial-holdings 响应 */
export class InitialHoldingsResultDto {
	@ApiProperty({
		description: "本次入账的初始持仓记录（按入参顺序）",
		type: [InitialHoldingCreatedDto],
	})
	created!: InitialHoldingCreatedDto[];

	@ApiProperty({
		description: "记账起点（建账时的 ledgerStartedAt；ISO 8601）",
		example: "2026-08-01T00:00:00.000Z",
		type: Date,
	})
	ledgerStartedAt!: Date;
}

/** 模块错误响应体（统一 { code, message }，风格与 rate 模块一致） */
export class OnboardingErrorDto {
	@ApiProperty({
		description:
			"错误码：CONSENT_REQUIRED / INVALID_BASE_CURRENCY / ONBOARDING_ALREADY_COMPLETED / ONBOARDING_NOT_COMPLETED / INITIAL_HOLDING_EXISTS / RATE_UNAVAILABLE / INVALID_HOLDINGS / INVALID_AMOUNT",
		example: "ONBOARDING_ALREADY_COMPLETED",
		type: String,
	})
	code!: string;

	@ApiProperty({
		description: "错误描述",
		example: "首次设置已完成，本位币不可更改，设置不可重复提交",
		type: String,
	})
	message!: string;
}
