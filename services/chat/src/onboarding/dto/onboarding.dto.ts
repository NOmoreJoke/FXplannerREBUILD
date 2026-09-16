import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsNotEmpty, IsString } from "class-validator";

/**
 * 首次设置模块 DTO：OpenAPI 契约唯一来源，前端类型由 generate:api 产出。
 * 每个 @ApiProperty 必须显式标注 type，不得依赖转译器元数据推断。
 */

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

	@ApiProperty({
		description: "换汇准备偏好",
		example: "balanced",
		type: String,
	})
	@IsString({ message: "准备偏好必须是字符串" })
	@IsNotEmpty({ message: "准备偏好不能为空" })
	prepPreference!: string;

	@ApiProperty({
		description: "是否启用到期提醒",
		example: true,
		type: Boolean,
	})
	@IsBoolean({ message: "提醒开关必须是布尔值" })
	reminderEnabled!: boolean;
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

/** 模块错误响应体（统一 { code, message }，风格与 rate 模块一致） */
export class OnboardingErrorDto {
	@ApiProperty({
		description:
			"错误码：CONSENT_REQUIRED / INVALID_BASE_CURRENCY / ONBOARDING_ALREADY_COMPLETED",
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
