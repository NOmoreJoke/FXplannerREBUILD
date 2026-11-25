import {
	Body,
	Controller,
	Get,
	HttpCode,
	HttpStatus,
	Inject,
	Param,
	Post,
	Res,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBearerAuth,
	ApiBody,
	ApiConflictResponse,
	ApiExtraModels,
	ApiForbiddenResponse,
	ApiGoneResponse,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { StreamableFile } from "@nestjs/common";
import type { User } from "@prisma/client";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentActor } from "../authorization/decorators/current-actor.decorator";
import {
	RequiresPermission,
} from "../authorization/decorators/requires-permission.decorator";
import { OrganizationRoute } from "../authorization/decorators/organization-route.decorator";
import {
	OrganizationContextGuard,
} from "../authorization/guards/organization-context.guard";
import { PermissionGuard } from "../authorization/guards/permission.guard";
import type { ActorContext } from "../authorization/authorization.types";
import { DataRequestService } from "./data-request.service";
import { OrganizationLockGuard } from "../authorization/guards/organization-lock.guard";
import { SkipOrganizationLock } from "../authorization/guards/data-lock.decorators";
import {
	CancelDataRequestDto,
	CreateDataRequestDto,
	DataRequestConflictBodyDto,
	DataRequestErrorDto,
	DataRequestViewDto,
	ImpactViewDto,
	VerifyDataRequestDto,
	VerifyResultDto,
} from "./dto/data-request.dto";

/**
 * 组织域数据权利请求（技术方案 §9.1–§9.3；Goal #3B W27）。
 *
 * **物理拆分后的组织域端点**（6 个）：进度 / 影响 / 验证 / 创建 / 撤回 / 下载，
 * 路径前缀 `/api/organizations/current/data-requests`。
 *
 * 守卫链（挂载顺序铁律）：JwtAuthGuard → OrganizationContextGuard（解析
 * actor.organizationId）→ **OrganizationLockGuard**（检组织锁）→ PermissionGuard
 * （检权限）。严禁把 OrganizationLockGuard 放前（actor 未解析）或放后
 * （权限拒绝先于锁原因返回）。
 *
 * 白名单（@SkipOrganizationLock）：进度 / 验证码 / 撤回 / 下载——组织正在清空或
 * 删除时，前端仍须能拉取锁摘要、验证、撤回与下载，避免「全锁 → 前端拿不到状态 →
 * 死锁」。白名单端点仍会推进到期请求，只是不做锁判定。
 */
@ApiTags("DataRequest")
@ApiBearerAuth()
@ApiExtraModels(DataRequestViewDto, VerifyResultDto, ImpactViewDto)
@Controller("organizations/current/data-requests")
@OrganizationRoute()
// 类级白名单（评审 I-3 / N-1）：组织数据请求属**控制平面**——清空 / 删除冷静期内
// 仍须能提交、撤回、查进度与下载；组织级互斥由服务层统一以
// 409 DATA_REQUEST_CONFLICT 呈现（普通业务端点仍由 OrganizationLockGuard 拦成
// 403 ORGANIZATION_DATA_LOCKED，两条语义互不遮蔽）。
@SkipOrganizationLock()
@UseGuards(JwtAuthGuard, OrganizationContextGuard, OrganizationLockGuard, PermissionGuard)
export class OrganizationDataRequestController {
	constructor(
		@Inject(DataRequestService)
		private readonly dataRequestService: DataRequestService,
	) {}

	@Get("current")
	@RequiresPermission("organization.read")
	@ApiOperation({
		summary: "查询当前组织数据请求（组织进度页）",
		description:
			"返回当前组织最近 30 天内最新一条非撤回**组织域**请求的进度视图（任意有效成员可查看）；无进行中组织请求返回 null。白名单端点：组织正在清空 / 删除时仍可拉取锁摘要，避免前端死锁。",
	})
	@ApiOkResponse({
		description: "当前组织请求视图或 null",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: {
					oneOf: [
						{ $ref: "#/components/schemas/DataRequestViewDto" },
						{ type: "null" },
					],
				},
				message: { type: "string" },
			},
		},
	})
	async getCurrent(@CurrentActor() actor: ActorContext) {
		const data = await this.dataRequestService.getOrganizationCurrentView(
			actor.organizationId,
		);
		return { success: true, data, message: "查询成功" };
	}

	@Get("impact")
	@RequiresPermission("data.clear")
	@ApiOperation({
		summary: "查询组织清空影响（确认页）",
		description:
			"返回**当前组织**各业务记录数量与是否存在可下载的组织导出包（需 data.clear 权限）；CLEAR 提交时的 confirmedTotals 快照与此比对，不一致 409 IMPACT_CHANGED。记录数量口径与清空 / 导出同一账本作用域。",
	})
	@ApiOkResponse({
		description: "记录数量与可下载导出提示",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/ImpactViewDto" },
				message: { type: "string" },
			},
		},
	})
	async getImpact(@CurrentActor() actor: ActorContext) {
		const data = await this.dataRequestService.getImpact(
			actor.userId,
			actor.organizationId,
		);
		return { success: true, data, message: "查询成功" };
	}

	@Post("verify")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "组织数据操作验证码校验（生成 10 分钟确认凭证）",
		description:
			"校验 challenge 用途（LOGIN 不放行）并消费验证码，返回确认截止时刻（消费 +10 分钟）；用途不匹配 403 VERIFICATION_PURPOSE_MISMATCH，码错沿用 OTP 语义。白名单端点：组织删除冷静期内仍须能验证并撤回删除请求。",
	})
	@ApiBody({ type: VerifyDataRequestDto })
	@ApiOkResponse({
		description: "验证通过，返回确认凭证与截止时刻",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/VerifyResultDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiForbiddenResponse({
		description: "用途不匹配 / 验证码无效",
		type: DataRequestErrorDto,
	})
	async verify(@CurrentUser() user: User, @Body() dto: VerifyDataRequestDto) {
		const data = await this.dataRequestService.verify(dto, user);
		return { success: true, data, message: "验证成功" };
	}

	@Post()
	@ApiOperation({
		summary: "提交组织数据请求（EXPORT 同步生成 / CLEAR、DELETION 进入 7 日流程）",
		description:
			"仅受理组织域（ORGANIZATION）的 EXPORT / CLEAR / DELETION：传 scope = PERSONAL 一律 400 SCOPE_TYPE_MISMATCH（个人数据权利见 POST /api/data-requests）。权限由服务端 permission-policy 严格判定：EXPORT 需 data.export、CLEAR 需 data.clear、DELETION 需 organization.delete（仅 Owner）；组织已有进行中请求 → 409 DATA_REQUEST_CONFLICT；组织尚未建账 → 409 ONBOARDING_NOT_COMPLETED；CLEAR 必带 confirmedTotals 且与服务端重算一致。",
	})
	@ApiBody({ type: CreateDataRequestDto })
	@ApiOkResponse({
		description: "请求视图（EXPORT 为 COMPLETED 含下载入口）",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/DataRequestViewDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiConflictResponse({
		description:
			"互斥（DATA_REQUEST_CONFLICT 附原请求）/ 影响变化（IMPACT_CHANGED）",
		type: DataRequestConflictBodyDto,
	})
	@HttpCode(HttpStatus.OK)
	async create(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Body() dto: CreateDataRequestDto,
	) {
		const data = await this.dataRequestService.create(dto, user, {
			scope: "ORGANIZATION",
			organizationId: actor.organizationId,
			membershipId: actor.membershipId,
		});
		return { success: true, data, message: "请求已提交" };
	}

	@Post(":id/cancel")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "撤回组织请求",
		description:
			"CLEAR PENDING 直接撤回；DELETION PENDING 需携带 purpose=DELETION 的新验证凭证（仅登录不算撤回）；撤回权限按请求类型在事务内持组织成员锁重读（data.clear / organization.delete）；跨组织 / 非本人 / 不存在一律 404。白名单端点：组织正在清空 / 删除时仍可撤回。",
	})
	@ApiBody({ type: CancelDataRequestDto })
	@ApiOkResponse({
		description: "撤回后的请求视图（CANCELLED）",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/DataRequestViewDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiForbiddenResponse({ description: "DELETION 撤回缺验证凭证", type: DataRequestErrorDto })
	@ApiNotFoundResponse({ description: "请求不存在 / 跨组织 / 非本人", type: DataRequestErrorDto })
	@ApiConflictResponse({ description: "当前状态不可撤回", type: DataRequestErrorDto })
	async cancel(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Param("id") id: string,
		@Body() dto: CancelDataRequestDto,
	) {
		const data = await this.dataRequestService.cancel(
			id,
			user,
			dto,
			{
				scope: "ORGANIZATION",
				organizationId: actor.organizationId,
				membershipId: actor.membershipId,
			},
		);
		return { success: true, data, message: "已撤回" };
	}

	@Get(":id/download")
	@RequiresPermission("data.export")
	@ApiOperation({
		summary: "下载组织导出包（ZIP 流式返回）",
		description:
			"仅本人发起的组织域 EXPORT COMPLETED 且 24 小时内可下载；**实时复验**：下载者仍须是当前组织 ACTIVE 成员且角色具备 data.export——降权为 Operator / Viewer → **403 PERMISSION_DENIED**（权限点丢失）；被移出组织（DISABLED）→ **404 ORGANIZATION_NOT_FOUND**（组织上下文不可达）；组织绑定校验——切错 X-Organization-Id → **404 DATA_REQUEST_NOT_FOUND**（绝不凭旧 id 偷下组织账本）；非本人 → 404 DATA_REQUEST_NOT_FOUND；过期/文件已清理 410 DOWNLOAD_EXPIRED。白名单端点：组织正在清空 / 删除时仍可下载已生成的导出包。",
	})
	@ApiOkResponse({
		description: "ZIP 二进制（Content-Disposition 附件下载）",
		schema: { type: "string", format: "binary" },
	})
	@ApiForbiddenResponse({
		description:
			"下载者仍是有效成员但角色已无 data.export（降权为 Operator / Viewer）→ 403 PERMISSION_DENIED",
		type: DataRequestErrorDto,
	})
	@ApiGoneResponse({ description: "下载链接已失效", type: DataRequestErrorDto })
	@ApiNotFoundResponse({
		description:
			"404 ORGANIZATION_NOT_FOUND（已被移出组织 / 组织不可达）或 404 DATA_REQUEST_NOT_FOUND（请求不存在 / 跨组织 / 非本人）",
		type: DataRequestErrorDto,
	})
	async download(
		@CurrentActor() actor: ActorContext,
		@Param("id") id: string,
		@Res({ passthrough: true }) res: Response,
	): Promise<StreamableFile> {
		const { buffer, filename } = await this.dataRequestService.loadDownload(
			id,
			actor.userId,
			{
				scope: "ORGANIZATION",
				organizationId: actor.organizationId,
				membershipId: actor.membershipId,
			},
		);
		res.set({
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="${filename}"`,
			"Content-Length": String(buffer.length),
		});
		return new StreamableFile(buffer);
	}
}
