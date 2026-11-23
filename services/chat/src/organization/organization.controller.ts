import {
	Body,
	Controller,
	Get,
	Inject,
	Patch,
	Post,
	Req,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBearerAuth,
	ApiCreatedResponse,
	ApiExtraModels,
	ApiForbiddenResponse,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from "@nestjs/swagger";
import type { Request } from "express";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import type { User } from "@prisma/client";
import {
	CurrentActor,
} from "../authorization/decorators/current-actor.decorator";
import {
	OrganizationContextGuard,
} from "../authorization/guards/organization-context.guard";
import { PermissionGuard } from "../authorization/guards/permission.guard";
import {
	RequiresPermission,
} from "../authorization/decorators/requires-permission.decorator";
import { OrganizationRoute } from "../authorization/decorators/organization-route.decorator";
import type { ActorContext } from "../authorization/authorization.types";
import { OrganizationService } from "./organization.service";
import {
	OrganizationCurrentDto,
	OrganizationUpsertDto,
	OrganizationViewDto,
} from "./dto/organization.dto";

/**
 * 组织端点（技术方案 §7.2；ORG-00..02；Goal #3A W17）。
 *
 * 个人端点（GET/POST /organizations）只挂 JwtAuthGuard，不要求组织上下文；
 * 组织上下文端点（/organizations/current）按 §4.3 Guard 链：
 * JwtAuthGuard（类级）→ OrganizationContextGuard → PermissionGuard。
 * 本控制器不承载成员/邀请/审计（分别见 W19 member/invitation 与 audit 模块）。
 */
@ApiTags("Organizations")
@ApiBearerAuth()
@ApiExtraModels(OrganizationViewDto, OrganizationCurrentDto)
@ApiForbiddenResponse({
	description: "403 PERMISSION_DENIED（角色无对应权限点）",
})
@ApiNotFoundResponse({ description: "404 ORGANIZATION_NOT_FOUND（非成员/禁用/不存在，不泄露存在性）" })
@Controller("organizations")
@UseGuards(JwtAuthGuard)
export class OrganizationController {
	constructor(
		@Inject(OrganizationService)
		private readonly organizationService: OrganizationService,
	) {}

	@Get()
	@ApiOperation({
		summary: "列出本人有效组织（个人端点，单/多组织路由依据）",
		description:
			"返回当前登录用户全部 ACTIVE Membership 对应组织、角色、本位币与建账状态；无组织用户返回空列表（W22 兼容窗口前不自动建组）。",
	})
	@ApiOkResponse({ type: [OrganizationViewDto] })
	async list(@CurrentUser() user: User): Promise<{
		success: true;
		data: OrganizationViewDto[];
		message: string;
	}> {
		return {
			success: true,
			data: await this.organizationService.listForUser(user.id),
			message: "查询成功",
		};
	}

	@Post()
	@ApiOperation({
		summary: "创建组织（创建者 OWNER + 空设置待建账；同事务审计）",
		description:
			"事务内创建 Organization + OWNER/ACTIVE Membership 并写组织创建审计；不复制任何既有组织数据或成员（ORG-01.4/5），新组织需独立完成首次设置。",
	})
	@ApiCreatedResponse({ type: OrganizationViewDto })
	async create(
		@CurrentUser() user: User,
		@Body() dto: OrganizationUpsertDto,
		@Req() request: Request,
	): Promise<{ success: true; data: OrganizationViewDto; message: string }> {
		const created = await this.organizationService.create(
			user.id,
			dto,
			request.headers["x-request-id"] as string | undefined,
		);
		return {
			success: true,
			data: {
				id: created.id,
				name: created.name,
				role: created.role,
				baseCurrency: null,
				onboardingCompleted: false,
				createdAt: new Date(),
			},
			message: "组织创建成功",
		};
	}

	@Get("current")
	@OrganizationRoute()
	@UseGuards(OrganizationContextGuard, PermissionGuard)
	@RequiresPermission("organization.read")
	@ApiOperation({
		summary: "当前组织详情 + capabilities + 组织锁与建账状态",
		description:
			"按 X-Organization-Id 解析组织上下文（非成员/禁用统一 404 不泄露存在性）；返回当前角色、全部权限点布尔表（后端真源，前端据此渲染按钮）、组织数据请求锁摘要与建账状态。",
	})
	@ApiOkResponse({ type: OrganizationCurrentDto })
	async getCurrent(
		@CurrentActor() actor: ActorContext,
	): Promise<{ success: true; data: OrganizationCurrentDto; message: string }> {
		return {
			success: true,
			data: await this.organizationService.getCurrent(actor),
			message: "查询成功",
		};
	}

	@Patch("current")
	@OrganizationRoute()
	@UseGuards(OrganizationContextGuard, PermissionGuard)
	@RequiresPermission("organization.update")
	@ApiOperation({
		summary: "修改当前组织名称（同事务审计）",
		description:
			"仅 organization.update 权限（Owner/Admin）可改；同事务写入 organization.update 审计（含改名前后快照）。Operator/Viewer 403 PERMISSION_DENIED。",
	})
	@ApiOkResponse({ type: OrganizationCurrentDto })
	async updateCurrent(
		@CurrentActor() actor: ActorContext,
		@Body() dto: OrganizationUpsertDto,
		@Req() request: Request,
	): Promise<{ success: true; data: OrganizationCurrentDto; message: string }> {
		const updated = await this.organizationService.update(
			actor,
			dto,
			request.headers["x-request-id"] as string | undefined,
		);
		const current = await this.organizationService.getCurrent(actor);
		return {
			success: true,
			data: { ...current, name: updated.name },
			message: "更新成功",
		};
	}
}
