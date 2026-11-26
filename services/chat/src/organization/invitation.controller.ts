import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Inject,
	Param,
	Post,
	Req,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBearerAuth,
	ApiBody,
	ApiConflictResponse,
	ApiCreatedResponse,
	ApiExtraModels,
	ApiForbiddenResponse,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiParam,
	ApiTags,
} from "@nestjs/swagger";
import type { Request } from "express";
import type { User } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { CurrentActor } from "../authorization/decorators/current-actor.decorator";
import {
	OrganizationContextGuard,
} from "../authorization/guards/organization-context.guard";
import { PermissionGuard } from "../authorization/guards/permission.guard";
import {
	RequiresPermission,
} from "../authorization/decorators/requires-permission.decorator";
import { OrganizationRoute } from "../authorization/decorators/organization-route.decorator";
import type { ActorContext } from "../authorization/authorization.types";
import { InvitationService } from "./invitation.service";
import {
	CreateInvitationDto,
	InvitationAcceptResultDto,
	InvitationCreatedDto,
	InvitationStatusResultDto,
	InvitationSummaryDto,
	InvitationViewDto,
} from "./dto/member.dto";
import { OrganizationLockGuard } from "../authorization/guards/organization-lock.guard";

/** 邀请 token 路径段约束（base64url，43 字符） */
const TOKEN_PARAM = {
	name: "token",
	type: String,
	required: true,
	description: "邀请 token（创建邀请响应中一次性发放）",
} as const;

/**
 * 邀请端点（需求 MEM-01；技术方案 §7.2；W19）。
 * 组织内端点走完整 Guard 链；/organization-invitations/:token* 为登录个人端点
 * （不挂组织 Guard——受邀者此时还不属于组织），但一律先做受邀邮箱匹配，
 * 不匹配不返回任何组织/邀请人元数据（技术方案 §7.2「仅返回本人可处理的邀请摘要」）。
 */
@ApiTags("Invitations")
@ApiBearerAuth()
@ApiExtraModels(
	InvitationCreatedDto,
	InvitationViewDto,
	InvitationSummaryDto,
	InvitationAcceptResultDto,
	InvitationStatusResultDto,
)
@ApiForbiddenResponse({
	description:
		"403 PERMISSION_DENIED / INVITATION_EMAIL_MISMATCH（受邀邮箱与登录身份不一致，不返回元数据）",
})
@ApiNotFoundResponse({ description: "404 INVITATION_NOT_FOUND（防枚举）" })
@ApiConflictResponse({
	description:
		"409 INVITATION_NOT_ACCEPTABLE（状态机）/ MEMBER_ALREADY_ACTIVE（已是有效成员）",
})
@Controller()
@UseGuards(JwtAuthGuard)
export class InvitationController {
	constructor(
		@Inject(InvitationService)
		private readonly invitationService: InvitationService,
	) {}

	@Post("organizations/current/invitations")
	@OrganizationRoute()
	@UseGuards(OrganizationContextGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("member.invite")
	@ApiOperation({
		summary: "创建邀请（原始 token 仅本次响应出现；同事务审计）",
		description:
			"Owner/Admin（Admin 限普通角色，禁邀 OWNER）按邮箱邀请，默认 7 天有效；该邮箱已是组织有效成员时返回 409 MEMBER_ALREADY_ACTIVE。同邮箱存在有效未过期邀请时幂等复用（reused=true，不重发 token）。服务端只存 token 的 SHA-256 hash。",
	})
	@ApiBody({ type: CreateInvitationDto })
	@ApiCreatedResponse({ type: InvitationCreatedDto })
	async create(
		@CurrentActor() actor: ActorContext,
		@Body() dto: CreateInvitationDto,
		@Req() request: Request,
	) {
		const data = await this.invitationService.create(
			actor,
			dto,
			request.headers["x-request-id"] as string | undefined,
		);
		return { success: true, data, message: "邀请已创建" };
	}

	@Get("organizations/current/invitations")
	@OrganizationRoute()
	@UseGuards(OrganizationContextGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("member.read")
	@ApiOperation({
		summary: "当前组织邀请列表（不回吐 tokenHash）",
		description: "按创建时间倒序（上限 100），含状态归并（OPEN/ACCEPTED/DECLINED/REVOKED/EXPIRED）。",
	})
	@ApiOkResponse({ type: [InvitationViewDto] })
	async list(@CurrentActor() actor: ActorContext) {
		const data = await this.invitationService.list(actor);
		return { success: true, data, message: "邀请列表获取成功" };
	}

	@Delete("organizations/current/invitations/:id")
	@OrganizationRoute()
	@UseGuards(OrganizationContextGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("member.invite")
	@ApiOperation({
		summary: "撤回有效邀请（同事务审计）",
		description:
			"仅 OPEN 状态可撤回；资格按邀请自身角色判定（Admin 不可撤回 Owner 发出的 Admin 角色邀请）；已接受/拒绝/过期返回 409。",
	})
	@ApiOkResponse({ type: InvitationStatusResultDto })
	async revoke(
		@CurrentActor() actor: ActorContext,
		@Param("id") invitationId: string,
		@Req() request: Request,
	) {
		const data = await this.invitationService.revoke(
			actor,
			invitationId,
			request.headers["x-request-id"] as string | undefined,
		);
		return { success: true, data, message: "邀请已撤回" };
	}

	@Get("organization-invitations/:token")
	@ApiParam(TOKEN_PARAM)
	@ApiOperation({
		summary: "受邀摘要（登录个人端点；脱敏）",
		description:
			"按 token 返回组织名、角色、邀请人显示名、有效期与状态；不含任何账户余额、交易明细或组织业务数据（MEM-01.7）。仅受邀本人可读：登录邮箱或已验证的邮箱验证码标识须与受邀邮箱一致，否则 403 且不返回任何元数据。无效 token 统一 404（防枚举）。",
	})
	@ApiOkResponse({ type: InvitationSummaryDto })
	async summary(@CurrentUser() user: User, @Param("token") token: string) {
		const data = await this.invitationService.getSummary(token, {
			id: user.id,
			email: user.email,
		});
		return { success: true, data, message: "查询成功" };
	}

	@Post("organization-invitations/:token/accept")
	@HttpCode(HttpStatus.OK)
	@ApiParam(TOKEN_PARAM)
	@ApiOperation({
		summary: "接受邀请（登录 + 邮箱匹配；事务消费 + 恢复/新建成员关系）",
		description:
			"登录身份须与受邀邮箱一致；组织锁内以完整开放态条件消费邀请，并发/已撤回/已拒绝/过期一律 409；被移除（DISABLED）成员重新获邀按新角色恢复 ACTIVE；已是有效成员返回 409 且不覆写既有角色。接受后同事务写审计。",
	})
	@ApiOkResponse({ type: InvitationAcceptResultDto })
	async accept(
		@CurrentUser() user: User,
		@Param("token") token: string,
		@Req() request: Request,
	) {
		const data = await this.invitationService.accept(
			token,
			{ id: user.id, email: user.email },
			request.headers["x-request-id"] as string | undefined,
		);
		return { success: true, data, message: "已加入组织" };
	}

	@Post("organization-invitations/:token/decline")
	@HttpCode(HttpStatus.OK)
	@ApiParam(TOKEN_PARAM)
	@ApiOperation({
		summary: "拒绝邀请（登录 + 邮箱匹配；不自动加入组织）",
		description: "重复拒绝幂等返回 DECLINED；已接受/撤回/过期返回 409。",
	})
	@ApiOkResponse({ type: InvitationStatusResultDto })
	async decline(
		@CurrentUser() user: User,
		@Param("token") token: string,
		@Req() request: Request,
	) {
		const data = await this.invitationService.decline(
			token,
			{ id: user.id, email: user.email },
			request.headers["x-request-id"] as string | undefined,
		);
		return { success: true, data, message: "已拒绝邀请" };
	}
}
