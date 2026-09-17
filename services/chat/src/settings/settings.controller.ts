import {
	Body,
	Controller,
	Get,
	HttpCode,
	HttpStatus,
	Inject,
	Patch,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBadRequestResponse,
	ApiBearerAuth,
	ApiBody,
	ApiConflictResponse,
	ApiExtraModels,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from "@nestjs/swagger";
import type { User } from "@prisma/client";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import {
	SettingsErrorDto,
	SettingsViewDto,
	UpdateSettingsDto,
} from "./dto/update-settings.dto";
import { SettingsService } from "./settings.service";

/**
 * 用户设置（onboarding-rework 技术方案 §4.3/§4.4）：常驻偏好读写入口，需登录。
 * 全局只有 ThrottlerGuard，JWT 必须显式挂载；本位币只读（无更新通道）。
 */
@ApiTags("Settings")
@ApiBearerAuth()
// 手动 $ref 的响应模型需显式注册进 components（GET / PATCH 共用 SettingsViewDto）
@ApiExtraModels(SettingsViewDto)
@Controller("settings")
@UseGuards(JwtAuthGuard)
export class SettingsController {
	constructor(
		@Inject(SettingsService)
		private readonly settingsService: SettingsService,
	) {}

	@Get()
	@ApiOperation({
		summary: "查询用户设置（完整视图）",
		description:
			"返回邮箱、地区、语言、本位币（只读）、准备偏好、提醒开关与记账起点。未完成首次设置 → 409 ONBOARDING_NOT_COMPLETED。只读无副作用。",
	})
	@ApiOkResponse({
		description: "设置查询成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/SettingsViewDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiConflictResponse({
		description: "尚未完成首次设置（ONBOARDING_NOT_COMPLETED）",
		type: SettingsErrorDto,
	})
	async getSettings(@CurrentUser() user: User) {
		const data = await this.settingsService.getSettings(user.id);
		return { success: true, data, message: "设置查询成功" };
	}

	@Patch()
	@ApiOperation({
		summary: "更新偏好设置（幂等）",
		description:
			"白名单四字段 region/locale/prepPreference/reminderEnabled，全部可选但至少一项（全空 400 SETTINGS_UPDATE_EMPTY）；枚举非法 400；重复提交同值幂等无副作用。baseCurrency 无更新通道：DTO 不含该字段，未知字段被全局 ValidationPipe 静默剥离（含 baseCurrency 的请求剥后为空 → 400）。未建账 409 ONBOARDING_NOT_COMPLETED。",
	})
	@ApiBody({ type: UpdateSettingsDto })
	@ApiOkResponse({
		description: "设置已更新，返回更新后的完整视图",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/SettingsViewDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description: "全空入参（SETTINGS_UPDATE_EMPTY）或枚举非法",
		type: SettingsErrorDto,
	})
	@ApiConflictResponse({
		description: "尚未完成首次设置（ONBOARDING_NOT_COMPLETED）",
		type: SettingsErrorDto,
	})
	@HttpCode(HttpStatus.OK)
	async updateSettings(
		@CurrentUser() user: User,
		@Body() dto: UpdateSettingsDto,
	) {
		const data = await this.settingsService.updateSettings(user.id, dto);
		return { success: true, data, message: "设置已更新" };
	}
}
