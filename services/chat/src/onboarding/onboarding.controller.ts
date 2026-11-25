import {
	Body,
	Controller,
	Get,
	HttpCode,
	HttpStatus,
	Inject,
	Post,
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
	ApiResponse,
	ApiTags,
} from "@nestjs/swagger";
import type { User } from "@prisma/client";
import type { Request } from "express";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentActor } from "../authorization/decorators/current-actor.decorator";
import { BusinessOrgScopeGuard } from "../authorization/guards/business-org-scope.guard";
import { PermissionGuard } from "../authorization/guards/permission.guard";
import {
	RequiresPermission,
} from "../authorization/decorators/requires-permission.decorator";
import type { ActorContext } from "../authorization/authorization.types";
import { extractRequestId } from "../authorization/request-id";
import {
	CompleteOnboardingDto,
	InitialHoldingsResultDto,
	OnboardingCompleteResultDto,
	OnboardingConsentsResultDto,
	OnboardingErrorDto,
	OnboardingStatusDto,
	SaveConsentsDto,
	SaveInitialHoldingsDto,
} from "./dto/onboarding.dto";
import { OnboardingService } from "./onboarding.service";

/**
 * 首次设置（M1.1，技术方案 §2）：3 个功能入口，全部需登录。
 * 本位币锁定 = 模块不提供任何 settings 更新入口（完成设置后永久锁定）。
 */
@ApiTags("Onboarding")
@ApiBearerAuth()
// 手动 $ref 的响应模型需显式注册进 components（POST consents / POST complete）
@ApiExtraModels(
	OnboardingConsentsResultDto,
	OnboardingCompleteResultDto,
	InitialHoldingsResultDto,
)
@Controller("onboarding")
@UseGuards(JwtAuthGuard)
export class OnboardingController {
	constructor(
		@Inject(OnboardingService)
		private readonly onboardingService: OnboardingService,
	) {}

	// 只读状态查询与业务 GET 同一守卫链（评审 I-10：此前漏挂，离职成员/跨组织上下文
	// 仍可读，且完成态只看个人设置——现按当前组织的偏好判定）
	@Get("status")
	@UseGuards(BusinessOrgScopeGuard, PermissionGuard)
	@RequiresPermission("settings.read")
	@ApiOperation({
		summary: "查询首次设置状态（按当前组织）",
		description:
			"完成态判定 / 条款确认进度 / 已保存设置 / 当前条款版本。只读无副作用。完成态与设置以当前组织为准（组织设置优先；兼容窗口内回落到默认组织所有者的个人设置）；条款确认进度为个人维度。无组织头的单组织用户回落到其默认组织，多组织须带 X-Organization-Id。",
	})
	@ApiOkResponse({
		description: "状态查询成功，响应体为 { success, data, message } 包装",
		type: OnboardingStatusDto,
	})
	@HttpCode(HttpStatus.OK)
	async getStatus(@CurrentActor() actor: ActorContext) {
		const data = await this.onboardingService.getStatus(actor);
		return { success: true, data, message: "首次设置状态查询成功" };
	}

	@Post("consents")
	@ApiOperation({
		summary: "确认年龄与当前版本服务条款",
		description:
			"记录 age18 与 terms 两条确认（适用当前版本条款）。按 (userId, termsVersion, consentType) upsert：重复确认幂等，保留首次确认时间。",
	})
	@ApiBody({ type: SaveConsentsDto })
	@ApiCreated({ type: OnboardingConsentsResultDto })
	async saveConsents(
		@CurrentUser() user: User,
		@Body() dto: SaveConsentsDto,
	) {
		const data = await this.onboardingService.saveConsents(user.id, dto);
		return { success: true, data, message: "条款确认已记录" };
	}

	@Post("complete")
	@UseGuards(BusinessOrgScopeGuard, PermissionGuard)
	@RequiresPermission("settings.update")
	@ApiOperation({
		summary: "完成首次设置（当前组织，最终提交，不可重复）",
		description:
			"要求当前组织 settings.update 权限（仅 OWNER/ADMIN）。事务内依次校验：条款（400 CONSENT_REQUIRED）→ 本位币 15 币种（400 INVALID_BASE_CURRENCY）→ 当前组织已有设置（409 ONBOARDING_ALREADY_COMPLETED，多组织互不阻塞；并发重复由唯一约束兜底同样 409）。成功后创建当前组织设置（记账起点 = 完成当日 UTC+8 日初）并同事务写审计；可选 initialHoldings 初始持仓先取组织账本锁再同事务入账。本位币一经设定永久锁定。",
	})
	@ApiBody({ type: CompleteOnboardingDto })
	@ApiCreated({ type: OnboardingCompleteResultDto })
	@ApiBadRequestResponse({
		description: "未确认条款或本位币非法",
		type: OnboardingErrorDto,
	})
	@ApiForbiddenResponse({
		description: "无 settings.update 权限（PERMISSION_DENIED）",
		type: OnboardingErrorDto,
	})
	@ApiConflictResponse({
		description: "首次设置已完成（ONBOARDING_ALREADY_COMPLETED）",
		type: OnboardingErrorDto,
	})
	async complete(
		@CurrentActor() actor: ActorContext,
		@Body() dto: CompleteOnboardingDto,
		@Req() request: Request,
	) {
		const data = await this.onboardingService.complete(
			actor,
			dto,
			extractRequestId(request),
		);
		return {
			success: true,
			data,
			message: "首次设置完成，本位币已锁定",
		};
	}

	@Post("initial-holdings")
	@UseGuards(BusinessOrgScopeGuard, PermissionGuard)
	@RequiresPermission("settings.update")
	@ApiOperation({
		summary: "补录初始持仓（当前组织建账后，每币种仅一笔）",
		description:
			"要求当前组织 settings.update 权限（仅 OWNER/ADMIN）且已建账（409 ONBOARDING_NOT_COMPLETED）；先取组织账本锁再查重与入账，传入币种均不得已有初始记录（409 INITIAL_HOLDING_EXISTS，整单拒绝不做部分成功）并同事务写审计。",
	})
	@ApiBody({ type: SaveInitialHoldingsDto })
	@ApiCreated({ type: InitialHoldingsResultDto })
	@ApiBadRequestResponse({
		description: "无有效报价（RATE_UNAVAILABLE）或金额非法（INVALID_AMOUNT/INVALID_HOLDINGS）",
		type: OnboardingErrorDto,
	})
	@ApiForbiddenResponse({
		description: "无 settings.update 权限（PERMISSION_DENIED）",
		type: OnboardingErrorDto,
	})
	@ApiConflictResponse({
		description: "尚未建账（ONBOARDING_NOT_COMPLETED）或币种已有初始记录（INITIAL_HOLDING_EXISTS）",
		type: OnboardingErrorDto,
	})
	async saveInitialHoldings(
		@CurrentActor() actor: ActorContext,
		@Body() dto: SaveInitialHoldingsDto,
		@Req() request: Request,
	) {
		const data = await this.onboardingService.saveInitialHoldings(
			actor,
			dto,
			extractRequestId(request),
		);
		return { success: true, data, message: "初始持仓已入账" };
	}
}

/** 201 响应的 swagger 标注辅助（统一包装结构说明） */
function ApiCreated(options: { type: unknown }) {
	return ApiResponse({
		status: HttpStatus.CREATED,
		description: "成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: `#/components/schemas/${(options.type as { name: string }).name}` },
				message: { type: "string" },
			},
		},
	});
}
