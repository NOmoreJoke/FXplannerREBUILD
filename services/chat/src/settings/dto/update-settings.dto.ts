import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsOptional } from "class-validator";

/**
 * 设置模块 DTO：OpenAPI 契约唯一来源，前端类型由 generate:api 产出。
 * 每个 @ApiProperty 必须显式标注 type，不得依赖转译器元数据推断。
 *
 * 质量红线：本模块 DTO 不声明 baseCurrency 字段（本位币只读，无任何更新写路径）。
 * 全局 ValidationPipe（whitelist: true）会把请求中的未知字段（含 baseCurrency）
 * 静默剥离——含 baseCurrency 的请求剥后为空，由 service 空校验 400 拦截。
 */

/**
 * 准备偏好合法值集（prep 域唯一事实来源，拍板口径「后端合并值集」）。
 * settings PATCH 校验、GET 视图标注与 onboarding CompleteOnboardingDto 的 @IsIn
 * 均引用此常量；前端值集由 OpenAPI 生成类型（schema.gen）拉齐，禁止另写字面量。
 */
export const PREP_PREFERENCE_VALUES = [
	"cautious",
	"balanced",
	"proactive",
] as const;

export type PrepPreference = (typeof PREP_PREFERENCE_VALUES)[number];

/** PATCH /api/settings 请求体：偏好白名单四字段，全部可选（至少一项，全空 400） */
export class UpdateSettingsDto {
	@ApiPropertyOptional({
		description: "地区（ISO 3166 国家/地区码）",
		example: "HK",
		enum: ["HK", "CN"],
		type: String,
	})
	@IsOptional()
	@IsIn(["HK", "CN"], { message: "地区必须是 HK 或 CN" })
	region?: string;

	@ApiPropertyOptional({
		description: "语言（BCP 47 标识）",
		example: "zh-CN",
		enum: ["zh-CN", "en"],
		type: String,
	})
	@IsOptional()
	@IsIn(["zh-CN", "en"], { message: "语言必须是 zh-CN 或 en" })
	locale?: string;

	@ApiPropertyOptional({
		description: "换汇准备偏好",
		example: "balanced",
		enum: [...PREP_PREFERENCE_VALUES],
		type: String,
	})
	@IsOptional()
	@IsIn(PREP_PREFERENCE_VALUES, {
		message: "准备偏好必须是 cautious / balanced / proactive 之一",
	})
	prepPreference?: string;

	@ApiPropertyOptional({
		description: "是否启用到期提醒",
		example: true,
		type: Boolean,
	})
	@IsOptional()
	@IsBoolean({ message: "提醒开关必须是布尔值" })
	reminderEnabled?: boolean;
}

/** GET / PATCH /api/settings 出参：完整设置视图（email 来自 User，其余来自 UserSettings） */
export class SettingsViewDto {
	@ApiProperty({
		description: "账号邮箱（注册时填写；历史数据可能为空）",
		example: "user@example.com",
		type: String,
		nullable: true,
	})
	email!: string | null;

	@ApiProperty({ description: "地区", example: "CN", type: String })
	region!: string;

	@ApiProperty({ description: "语言", example: "zh-CN", type: String })
	locale!: string;

	@ApiProperty({
		description:
			"本位币（只读，来源 user_settings.base_currency；无任何更新通道，建账时锁定）",
		example: "CNY",
		type: String,
	})
	baseCurrency!: string;

	@ApiProperty({
		description: "换汇准备偏好",
		example: "balanced",
		enum: [...PREP_PREFERENCE_VALUES],
		type: String,
	})
	prepPreference!: string;

	@ApiProperty({ description: "是否启用到期提醒", type: Boolean })
	reminderEnabled!: boolean;

	@ApiProperty({
		description:
			"记账起点（完成设置当日 UTC+8 日初，ISO 8601；历史数据可能为空）",
		example: "2026-08-01T00:00:00.000Z",
		type: Date,
		nullable: true,
	})
	ledgerStartedAt!: Date | null;
}

/** 设置模块错误响应体（统一 { code, message }，风格与 onboarding 模块一致） */
export class SettingsErrorDto {
	@ApiProperty({
		description: "错误码：SETTINGS_UPDATE_EMPTY / ONBOARDING_NOT_COMPLETED",
		example: "SETTINGS_UPDATE_EMPTY",
		type: String,
	})
	code!: string;

	@ApiProperty({
		description: "错误描述",
		example: "至少提供一个要更新的设置字段",
		type: String,
	})
	message!: string;
}
