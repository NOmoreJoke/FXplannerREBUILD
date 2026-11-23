import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Inject,
	Param,
	Patch,
	Post,
	Req,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBearerAuth,
	ApiBody,
	ApiConflictResponse,
	ApiExtraModels,
	ApiForbiddenResponse,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from "@nestjs/swagger";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
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
import { MemberService } from "./member.service";
import {
	MemberRemoveResultDto,
	MemberRoleUpdateResultDto,
	MemberStatusResultDto,
	MemberViewDto,
	TransferOwnershipDto,
	TransferOwnershipResultDto,
	UpdateMemberDto,
} from "./dto/member.dto";

/**
 * 成员管理端点（需求 MEM-02 / ORG-03.3；技术方案 §7.2；W19）。
 * Guard 链：JwtAuthGuard（类级）→ OrganizationContextGuard → PermissionGuard。
 * 审计关联请求：x-request-id 透传进 AuditLog.requestId（技术方案 §13.1 / AUDIT-02）。
 */
@ApiTags("Members")
@ApiBearerAuth()
@ApiExtraModels(
	MemberViewDto,
	MemberRoleUpdateResultDto,
	MemberRemoveResultDto,
	MemberStatusResultDto,
	TransferOwnershipResultDto,
)
@ApiForbiddenResponse({
	description:
		"403 PERMISSION_DENIED（canManage 资格不足：Admin 不可管理 Owner/Admin，亦不可把成员提拔为 Admin）",
})
@ApiNotFoundResponse({ description: "404 MEMBER_NOT_FOUND / ORGANIZATION_NOT_FOUND" })
@ApiConflictResponse({
	description:
		"409 LAST_OWNER_REQUIRED（最后 Owner 保护）/ MEMBER_NOT_ACTIVE / MEMBERSHIP_CONFLICT / TRANSFER_CONFLICT",
})
@Controller("organizations")
@UseGuards(JwtAuthGuard)
export class MemberController {
	constructor(
		@Inject(MemberService) private readonly memberService: MemberService,
	) {}

	@Get("current/members")
	@OrganizationRoute()
	@UseGuards(OrganizationContextGuard, PermissionGuard)
	@RequiresPermission("member.read")
	@ApiOperation({
		summary: "当前组织成员列表（角色/状态/加入时间）",
		description:
			"全部有效成员可读（member.read 为全角色基础权限）；DISABLED 成员保留在列表中以维持历史可审计性。",
	})
	@ApiOkResponse({ type: [MemberViewDto] })
	async list(@CurrentActor() actor: ActorContext) {
		const data = await this.memberService.listMembers(actor.organizationId);
		return { success: true, data, message: "成员列表获取成功" };
	}

	@Patch("current/members/:id")
	@OrganizationRoute()
	@UseGuards(OrganizationContextGuard, PermissionGuard)
	@RequiresPermission("member.update")
	@ApiOperation({
		summary: "调整成员角色（同事务审计）",
		description:
			"Owner 可调整任意非 Owner 成员；Admin 仅可在普通角色（Finance/Operator/Viewer）之间调整——不可管理 Owner/Admin，也不可把成员提拔为 Admin。Owner 自降返回 409 LAST_OWNER_REQUIRED；已移除成员不可调整（409 MEMBER_NOT_ACTIVE）。",
	})
	@ApiBody({ type: UpdateMemberDto })
	@ApiOkResponse({ type: MemberRoleUpdateResultDto })
	async updateRole(
		@CurrentActor() actor: ActorContext,
		@Param("id") membershipId: string,
		@Body() dto: UpdateMemberDto,
		@Req() request: Request,
	) {
		const data = await this.memberService.updateRole(
			actor,
			membershipId,
			dto.role,
			request.headers["x-request-id"] as string | undefined,
		);
		return { success: true, data, message: "成员角色已更新" };
	}

	@Delete("current/members/:id")
	@OrganizationRoute()
	@UseGuards(OrganizationContextGuard, PermissionGuard)
	@RequiresPermission("member.remove")
	@ApiOperation({
		summary: "移除成员（DISABLED 保留历史归属；同事务审计）",
		description:
			"移除后该成员立即失去组织访问权（下一次请求 404 ORGANIZATION_NOT_FOUND）；历史操作者信息保留为审计快照。Owner 自移除返回 409 LAST_OWNER_REQUIRED；重复移除幂等。",
	})
	@ApiOkResponse({ type: MemberRemoveResultDto })
	async remove(
		@CurrentActor() actor: ActorContext,
		@Param("id") membershipId: string,
		@Req() request: Request,
	) {
		const data = await this.memberService.removeMember(
			actor,
			membershipId,
			request.headers["x-request-id"] as string | undefined,
		);
		return { success: true, data, message: "成员已移除" };
	}

	@Post("current/members/leave")
	@HttpCode(HttpStatus.OK)
	@OrganizationRoute()
	@UseGuards(OrganizationContextGuard, PermissionGuard)
	@RequiresPermission("member.read")
	@ApiOperation({
		summary: "主动退出组织（最后 Owner 409）",
		description:
			"成员自助退出（DISABLED 自身成员关系）；组织仅剩一名活跃 Owner 时拒绝并要求先转移所有权；重复退出幂等。",
	})
	@ApiOkResponse({ type: MemberStatusResultDto })
	@ApiConflictResponse({ description: "409 LAST_OWNER_REQUIRED" })
	async leave(@CurrentActor() actor: ActorContext, @Req() request: Request) {
		const data = await this.memberService.leave(
			actor,
			request.headers["x-request-id"] as string | undefined,
		);
		return { success: true, data, message: "已退出组织" };
	}

	@Post("current/transfer-ownership")
	@HttpCode(HttpStatus.OK)
	@OrganizationRoute()
	@UseGuards(OrganizationContextGuard, PermissionGuard)
	@RequiresPermission("owner.transfer")
	@ApiOperation({
		summary: "转移所有权（原 Owner 降为 ADMIN；先降后升保索引顺序）",
		description:
			"仅 Owner 可发起；目标须为当前组织 ACTIVE 成员且非本人。事务内先取组织级锁并重读双方状态，先将原 Owner 降为 ADMIN 再将目标升为 OWNER（memberships_single_active_owner_uidx 部分唯一索引顺序保护），同事务写审计；转移后新 Owner 权限立即生效。并发双提交时第二个事务回滚并返回 409 TRANSFER_CONFLICT。",
	})
	@ApiBody({ type: TransferOwnershipDto })
	@ApiOkResponse({ type: TransferOwnershipResultDto })
	@ApiConflictResponse({
		description: "409 TRANSFER_CONFLICT（并发转移）",
	})
	async transfer(
		@CurrentActor() actor: ActorContext,
		@Body() dto: TransferOwnershipDto,
		@Req() request: Request,
	) {
		const data = await this.memberService.transferOwnership(
			actor,
			dto.targetMembershipId,
			request.headers["x-request-id"] as string | undefined,
		);
		return { success: true, data, message: "所有权已转移" };
	}
}
