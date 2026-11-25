import {
	Body,
	Controller,
	Delete,
	Get,
	Inject,
	Patch,
	Post,
	Req,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBearerAuth,
	ApiBody,
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
import { OrganizationLockGuard } from "../authorization/guards/organization-lock.guard";
import { SkipOrganizationLock } from "../authorization/guards/data-lock.decorators";
import { DataRequestService } from "../data-request/data-request.service";
import {
	DataRequestErrorDto,
	DataRequestViewDto,
	OrganizationDeletionRequestDto,
} from "../data-request/dto/data-request.dto";
import {
	RequiresPermission,
} from "../authorization/decorators/requires-permission.decorator";
import { OrganizationRoute } from "../authorization/decorators/organization-route.decorator";
import type { RequestWithOrganizationLock } from "../authorization/guards/organization-lock.guard";
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
@ApiExtraModels(OrganizationViewDto, OrganizationCurrentDto, DataRequestViewDto)
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
		@Inject(DataRequestService)
		private readonly dataRequestService: DataRequestService,
	) {}

	@Get()
	@ApiOperation({
		summary: "列出本人有效组织（个人端点，单/多组织路由依据）",
		description:
			"返回当前登录用户全部 ACTIVE Membership 对应组织、角色、本位币与建账状态。新用户在注册/验证码首登时即拥有一个默认组织（ORG-01.2）；MIG-A 之后、默认组织兜底之前注册的存量验证码账号可能为空列表（进入新建组织流程，其存量数据由 MIG-B 回填归属）。",
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
			"事务内创建 Organization + OWNER/ACTIVE Membership 并写组织创建审计；不复制任何既有组织数据或成员（ORG-01.4/5），新组织需独立完成首次设置。名称 trim 后须为 1~100 字符（纯空白 400）。",
	})
	@ApiBody({ type: OrganizationUpsertDto })
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
				createdAt: created.createdAt,
			},
			message: "组织创建成功",
		};
	}

	@Get("current")
	@OrganizationRoute()
	// 锁守卫白名单：组织正在清空 / 删除时前端仍须拉取锁摘要（dataRequestLock），
	// 否则前端拿不到锁态 → 跳不进进度页 → 死锁。
	@SkipOrganizationLock()
	@UseGuards(OrganizationContextGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("organization.read")
	@ApiOperation({
		summary: "当前组织详情 + capabilities + 组织锁与建账状态",
		description:
			"按 X-Organization-Id 解析组织上下文（非成员/禁用统一 404 不泄露存在性）；返回当前角色、全部权限点布尔表（后端真源，前端据此渲染按钮）、组织数据请求锁摘要与建账状态。",
	})
	@ApiOkResponse({ type: OrganizationCurrentDto })
	async getCurrent(
		@CurrentActor() actor: ActorContext,
		@Req() request: Request,
	): Promise<{ success: true; data: OrganizationCurrentDto; message: string }> {
		return {
			success: true,
			data: await this.organizationService.getCurrent(
				actor,
				(request as RequestWithOrganizationLock).organizationLock,
			),
			message: "查询成功",
		};
	}

	@Patch("current")
	@OrganizationRoute()
	@UseGuards(OrganizationContextGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("organization.update")
	@ApiOperation({
		summary: "修改当前组织名称（同事务审计）",
		description:
			"仅 organization.update 权限（Owner/Admin）可改；同事务写入 organization.update 审计（含改名前后快照）。Operator/Viewer 403 PERMISSION_DENIED。",
	})
	@ApiBody({ type: OrganizationUpsertDto })
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
		const current = await this.organizationService.getCurrent(
			actor,
			(request as RequestWithOrganizationLock).organizationLock,
		);
		return {
			success: true,
			data: { ...current, name: updated.name },
			message: "更新成功",
		};
	}

	@Delete("current")
	@OrganizationRoute()
	// 锁守卫白名单（与类级控制面注释一致）：本端点属**控制面**——组织清空 /
	// 删除冷静期内仍须可达（否则死锁前端），且再次发起必须由服务层统一以
	// 409 DATA_REQUEST_CONFLICT 呈现（而非守卫级 403 ORGANIZATION_DATA_LOCKED）；
	// 真正发起删除的资格由 organization.delete 权限点 + 组织级请求互斥保证。
	@SkipOrganizationLock()
	@UseGuards(OrganizationContextGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("organization.delete")
	@ApiOperation({
		summary: "发起删除当前组织（7 日撤回期）",
		description:
			"仅 Owner 可发起（organization.delete 权限点）：提交后进入 7 日撤回期（PENDING），期间可凭 purpose=DELETION 的验证凭证撤回；到期才真正删除组织（清空账本 + 删除组织/成员关系/邀请/设置/审计，**不删除任何成员 User 账号**，成员身份保留）。必须携带 verify（purpose=DELETION）返回的已消费凭证——仅登录不算发起；组织已有进行中组织请求 → 409 DATA_REQUEST_CONFLICT。",
	})
	@ApiBody({ type: OrganizationDeletionRequestDto })
	@ApiOkResponse({
		description: "删除请求视图（PENDING，含撤回期截止时刻）",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/DataRequestViewDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiForbiddenResponse({ description: "非 Owner（PERMISSION_DENIED）", type: DataRequestErrorDto })
	@ApiNotFoundResponse({ description: "组织不存在 / 非有效成员", type: DataRequestErrorDto })
	async deleteCurrent(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Body() dto: OrganizationDeletionRequestDto,
	): Promise<{
		success: true;
		data: DataRequestViewDto;
		message: string;
	}> {
		const data = await this.dataRequestService.create(
			{
				type: "DELETION",
				scope: "ORGANIZATION",
				challengeId: dto.challengeId,
			},
			user,
			{
				scope: "ORGANIZATION",
				organizationId: actor.organizationId,
				membershipId: actor.membershipId,
			},
		);
		return { success: true, data, message: "删除请求已提交" };
	}
}
