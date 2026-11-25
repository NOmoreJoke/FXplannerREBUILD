import {
	Body,
	Controller,
	Get,
	HttpCode,
	HttpStatus,
	Inject,
	Patch,
	Req,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBadRequestResponse,
	ApiBearerAuth,
	ApiBody,
	ApiConflictResponse,
	ApiExtraModels,
	ApiForbiddenResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from "@nestjs/swagger";
import type { User } from "@prisma/client";
import type { Request } from "express";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentActor } from "../authorization/decorators/current-actor.decorator";
import { BusinessOrgScopeGuard } from "../authorization/guards/business-org-scope.guard";
import { PermissionGuard } from "../authorization/guards/permission.guard";
import { RequiresPermission } from "../authorization/decorators/requires-permission.decorator";
import type { ActorContext } from "../authorization/authorization.types";
import { extractRequestId } from "../authorization/request-id";
import {
	PersonalSettingsViewDto,
	SettingsErrorDto,
	SettingsViewDto,
	UpdatePersonalSettingsDto,
	UpdateSettingsDto,
} from "./dto/update-settings.dto";
import { SettingsService } from "./settings.service";

/**
 * 个人与组织设置（ToB R1 W22 分离个人展示偏好与组织账本偏好）：
 * - /api/settings：组织上下文视图与混合更新（个人字段 region/locale 放行所有成员，组织字段 prepPreference/reminderEnabled 要求 settings.update）；
 * - /api/settings/personal：纯个人展示偏好读写，仅要求登录，不依赖组织或建账状态；
 * - baseCurrency 建账后只读锁定，无任何更新通道。
 */
@ApiTags("Settings")
@ApiBearerAuth()
// 手动 $ref 的响应模型需显式注册进 components
@ApiExtraModels(SettingsViewDto, PersonalSettingsViewDto)
@Controller("settings")
@UseGuards(JwtAuthGuard)
export class SettingsController {
	constructor(
		@Inject(SettingsService)
		private readonly settingsService: SettingsService,
	) {}

	@Get("personal")
	@ApiOperation({
		summary: "查询个人展示偏好（不依赖组织或建账状态）",
		description:
			"仅要求登录，返回当前用户邮箱与个人展示偏好（region/locale；无个人设置行时回落产品默认值 CN / zh-CN）。",
	})
	@ApiOkResponse({
		description: "个人设置查询成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/PersonalSettingsViewDto" },
				message: { type: "string" },
			},
		},
	})
	async getPersonalSettings(@CurrentUser() user: User) {
		const data = await this.settingsService.getPersonalSettings(user.id, {
			email: user.email,
		});
		return { success: true, data, message: "个人设置查询成功" };
	}

	@Patch("personal")
	@ApiOperation({
		summary: "更新个人展示偏好（不依赖组织或建账状态）",
		description:
			"仅要求登录，允许任意用户（含未建账/无组织/VIEWER/OPERATOR）更新个人 region/locale（全空 400 SETTINGS_UPDATE_EMPTY）；绝不创建 OrganizationSettings。",
	})
	@ApiBody({ type: UpdatePersonalSettingsDto })
	@ApiOkResponse({
		description: "个人设置已更新",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/PersonalSettingsViewDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description: "全空入参（SETTINGS_UPDATE_EMPTY）或枚举非法",
		type: SettingsErrorDto,
	})
	@HttpCode(HttpStatus.OK)
	async updatePersonalSettings(
		@CurrentUser() user: User,
		@Body() dto: UpdatePersonalSettingsDto,
	) {
		const data = await this.settingsService.updatePersonalSettings(
			user.id,
			dto,
			{ email: user.email },
		);
		return { success: true, data, message: "个人设置已更新" };
	}

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
	@UseGuards(BusinessOrgScopeGuard, PermissionGuard)
	@RequiresPermission("settings.read")
	async getSettings(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
	) {
		const data = await this.settingsService.getSettings(actor, {
			email: user.email,
		});
		return { success: true, data, message: "设置查询成功" };
	}

	@Patch()
	@UseGuards(BusinessOrgScopeGuard)
	@ApiOperation({
		summary: "更新偏好设置（幂等；个人/组织字段分权校验）",
		description:
			"白名单四字段 region/locale/prepPreference/reminderEnabled，全部可选但至少一项（全空 400 SETTINGS_UPDATE_EMPTY）；枚举非法 400；重复提交同值幂等无副作用。更新 region/locale 放行全部有效组织成员；更新 prepPreference/reminderEnabled 须具备 settings.update 权限（无权 403 PERMISSION_DENIED + DENIED 审计）并同事务写 SUCCESS 审计。baseCurrency 无更新通道。未建账 409 ONBOARDING_NOT_COMPLETED。",
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
	@ApiForbiddenResponse({
		description: "无 settings.update 权限修改组织偏好（PERMISSION_DENIED）",
		type: SettingsErrorDto,
	})
	@ApiConflictResponse({
		description: "尚未完成首次设置（ONBOARDING_NOT_COMPLETED）",
		type: SettingsErrorDto,
	})
	@HttpCode(HttpStatus.OK)
	async updateSettings(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Body() dto: UpdateSettingsDto,
		@Req() request: Request,
	) {
		const data = await this.settingsService.updateSettings(
			actor,
			dto,
			{ email: user.email },
			extractRequestId(request),
		);
		return { success: true, data, message: "设置已更新" };
	}
}
