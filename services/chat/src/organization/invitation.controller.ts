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
	UseGuards,
} from "@nestjs/common";
import {
	ApiBearerAuth,
	ApiConflictResponse,
	ApiCreatedResponse,
	ApiExtraModels,
	ApiForbiddenResponse,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from "@nestjs/swagger";
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
import type { User } from "@prisma/client";
import { InvitationService } from "./invitation.service";
import {
	CreateInvitationDto,
	InvitationCreatedDto,
	InvitationSummaryDto,
	InvitationViewDto,
} from "./dto/member.dto";

/**
 * 邀请端点（需求 MEM-01；技术方案 §7.2；W19）。
 * 组织内端点走完整 Guard 链；/organization-invitations/:token* 为登录个人端点
 * （不挂组织 Guard——受邀者此时还不属于组织）。
 */
@ApiTags("Invitations")
@ApiBearerAuth()
@ApiExtraModels(InvitationCreatedDto, InvitationViewDto, InvitationSummaryDto)
@ApiForbiddenResponse({ description: "403 PERMISSION_DENIED / INVITATION_EMAIL_MISMATCH" })
@ApiNotFoundResponse({ description: "404 INVITATION_NOT_FOUND（防枚举）" })
@ApiConflictResponse({ description: "409 INVITATION_NOT_ACCEPTABLE（状态机）" })
@Controller()
@UseGuards(JwtAuthGuard)
export class InvitationController {
	constructor(
		@Inject(InvitationService)
		private readonly invitationService: InvitationService,
	) {}

	@Post("organizations/current/invitations")
	@OrganizationRoute()
	@UseGuards(OrganizationContextGuard, PermissionGuard)
	@RequiresPermission("member.invite")
	@ApiOperation({
		summary: "创建邀请（原始 token 仅本次响应出现；同事务审计）",
		description:
			"Owner/Admin（Admin 限普通角色，禁邀 OWNER）按邮箱邀请，默认 7 天有效；同邮箱存在有效未过期邀请时幂等复用（reused=true，不重发 token）。服务端只存 token 的 SHA-256 hash。",
	})
	@ApiCreatedResponse({ type: InvitationCreatedDto })
	async create(
		@CurrentActor() actor: ActorContext,
		@Body() dto: CreateInvitationDto,
	) {
		const data = await this.invitationService.create(actor, dto);
		return { success: true, data, message: "邀请已创建" };
	}

	@Get("organizations/current/invitations")
	@OrganizationRoute()
	@UseGuards(OrganizationContextGuard, PermissionGuard)
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
	@UseGuards(OrganizationContextGuard, PermissionGuard)
	@RequiresPermission("member.invite")
	@ApiOperation({
		summary: "撤回有效邀请（同事务审计）",
		description: "仅 OPEN 状态可撤回；已接受/拒绝/过期返回 409。",
	})
	async revoke(
		@CurrentActor() actor: ActorContext,
		@Param("id") invitationId: string,
	) {
		const data = await this.invitationService.revoke(actor, invitationId);
		return { success: true, data, message: "邀请已撤回" };
	}

	@Get("organization-invitations/:token")
	@ApiOperation({
		summary: "受邀摘要（登录个人端点；脱敏）",
		description:
			"按 token 返回组织名、角色、邀请人显示名、有效期与状态；不含任何账户余额、交易明细或组织业务数据（MEM-01.7）。无效 token 统一 404（防枚举）。",
	})
	@ApiOkResponse({ type: InvitationSummaryDto })
	async summary(
		@CurrentUser() _user: User,
		@Param("token") token: string,
	) {
		const data = await this.invitationService.getSummary(token);
		return { success: true, data, message: "查询成功" };
	}

	@Post("organization-invitations/:token/accept")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "接受邀请（登录 + 邮箱严格匹配；事务消费 + 恢复/新建成员关系）",
		description:
			"登录邮箱须与受邀邮箱一致（trim+小写规范化）；并发双抢由条件更新保证仅产生一个有效 Membership；被移除（DISABLED）成员重新获邀按新角色恢复 ACTIVE。接受后同事务写审计。",
	})
	async accept(
		@CurrentUser() user: User,
		@Param("token") token: string,
	) {
		const data = await this.invitationService.accept(token, {
			id: user.id,
			email: user.email,
		});
		return { success: true, data, message: "已加入组织" };
	}

	@Post("organization-invitations/:token/decline")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "拒绝邀请（登录 + 邮箱匹配；不自动加入组织）",
		description: "重复拒绝幂等返回 DECLINED；已接受/撤回/过期返回 409。",
	})
	async decline(
		@CurrentUser() user: User,
		@Param("token") token: string,
	) {
		const data = await this.invitationService.decline(token, {
			id: user.id,
			email: user.email,
		});
		return { success: true, data, message: "已拒绝邀请" };
	}
}
