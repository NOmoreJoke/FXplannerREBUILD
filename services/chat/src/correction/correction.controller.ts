import {
	Body,
	Controller,
	Get,
	HttpCode,
	HttpStatus,
	Inject,
	Post,
	Query,
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
	ApiNotFoundResponse,
	ApiOperation,
	ApiResponse,
	ApiTags,
} from "@nestjs/swagger";
import type { User } from "@prisma/client";
import type { Request } from "express";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentActor } from "../authorization/decorators/current-actor.decorator";
import { OrganizationContextGuard } from "../authorization/guards/organization-context.guard";
import { PermissionGuard } from "../authorization/guards/permission.guard";
import { RequiresPermission } from "../authorization/decorators/requires-permission.decorator";
import type { ActorContext } from "../authorization/authorization.types";
import { extractRequestId } from "../authorization/request-id";
import {
	CorrectionApplyResultDto,
	CorrectionErrorDto,
	CorrectionListDto,
	CorrectionPreviewDto,
	CorrectionRequestDto,
	CorrectionTargetDto,
} from "./dto/correction.dto";
import { CorrectionService } from "./correction.service";
import { OrganizationLockGuard } from "../authorization/guards/organization-lock.guard";

/**
 * 更正与日志（corrections，M8 技术方案 §6）：4 个功能入口，全部需登录。
 * - POST /preview：影响预览（只读重放：前后对比 + 余额/分配/成本影响 + 缺口/拦截明细）；
 * - POST /：提交更正（baseVersion 乐观校验 → 事务内重放复核 → 新版本 + 重建成本批次 + 留痕）；
 * - GET /target：目标当前内容（更正页表单初值与乐观校验基准的数据源）；
 * - GET /：修改记录列表（含 APPLIED 与 FAILED，供详情页版本历史区展示）。
 * 错误体 { code, message, details? }；错误码经 DTO enum 进入 OpenAPI（方案 §6）。
 */
@ApiTags("Correction")
@ApiBearerAuth()
@ApiExtraModels(
	CorrectionPreviewDto,
	CorrectionApplyResultDto,
	CorrectionListDto,
	CorrectionTargetDto,
)
@Controller("corrections")
@UseGuards(JwtAuthGuard)
export class CorrectionController {
	constructor(
		@Inject(CorrectionService)
		private readonly correctionService: CorrectionService,
	) {}

	// 只读预览（@Post 但不落库）：与业务 GET 同一守卫链（评审 I-12——禁离职成员/
	// 跨组织上下文取账本重放快照，禁 Operator/Viewer 绕过 correction.preview 权限点），
	// 并同样以 actor 作为读作用域（评审 R2-I02——此前只传 user.id，守卫形同虚设：
	// 带其他组织头仍返回本人别的组织的账本重放，受邀成员则按自己的空账本重放）
	@Post("preview")
	@HttpCode(HttpStatus.OK)
	@UseGuards(OrganizationContextGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("correction.preview")
	@ApiOperation({
		summary: "影响预览（只读重放）",
		description:
			"只读重放受影响币种账本（UTC+8 日 → 初始<买入<使用 → 首录顺序确定性重放），返回前后对比、余额/成本影响、缺口与拦截明细；不落任何业务行。V1/V2/V3 类拦截以 blockers 返回 200（blockers 非空 = 不能提交）；参数/待确定项/报价缺失类直接 400。USAGE 目标于 MVP-F0-3 起支持（改金额/改日期；V4 矩阵拦截以 CORRECTION_NOT_ALLOWED 返回）。",
	})
	@ApiBody({ type: CorrectionRequestDto })
	@ApiResponse({
		status: HttpStatus.OK,
		description: "预览成功（blockers 非空表示存在拦截项）",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/CorrectionPreviewDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description:
			"参数非法（INVALID_CORRECTION_PARAMS）/ 待确定项拦截（CORRECTION_NOT_ALLOWED）/ 原时点报价不可得（RATE_QUOTE_UNAVAILABLE）",
		type: CorrectionErrorDto,
	})
	@ApiNotFoundResponse({
		description: "目标不存在或不属于当前组织（CORRECTION_TARGET_NOT_FOUND）",
		type: CorrectionErrorDto,
	})
	@ApiConflictResponse({
		description: "预览后目标已被其他修改更新（CORRECTION_TARGET_CHANGED）",
		type: CorrectionErrorDto,
	})
	async preview(@CurrentActor() actor: ActorContext, @Body() dto: CorrectionRequestDto) {
		const data = await this.correctionService.preview(actor, dto);
		return { success: true, data, message: "影响预览成功" };
	}

	@Post()
	@UseGuards(OrganizationContextGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("correction.apply")
	@ApiOperation({
		summary: "提交更正（事务）",
		description:
			"组织共享账本：须具备 correction.apply 权限（OWNER/ADMIN/FINANCE；OPERATOR/VIEWER 403 PERMISSION_DENIED 并写 DENIED 审计）。事务内依次执行：锁组织并按最新角色复验权限（锁等期间降权同样 403）→ 校验组织已建账 → 锁定受影响币种的组织账户与相关计划行（W30 MIG-E/F 后组织账本恒有归属，无存量收口步骤） → 按组织账本重算。USAGE 须确认本次影响，初始持仓改币种须确认预览报价。版本或使用影响失配返回 409 CORRECTION_TARGET_CHANGED（另一成员已更新目标时不覆盖后者，须重新预览），报价失配返回 409 CORRECTION_QUOTE_CHANGED。校验通过后重放账本并写入 APPLIED（含所属组织与操作者）；资金、分配或历史缺口拒绝时，业务数据零变化，另写带组织与操作者的 FAILED 尝试留痕及 FAILED 审计。",
	})
	@ApiBody({ type: CorrectionRequestDto })
	@ApiResponse({
		status: HttpStatus.CREATED,
		description: "更正成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/CorrectionApplyResultDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description:
			"参数非法（INVALID_CORRECTION_PARAMS）/ 待确定项拦截（CORRECTION_NOT_ALLOWED）/ 报价不可得（RATE_QUOTE_UNAVAILABLE）/ 缺少组织上下文（ORGANIZATION_REQUIRED）",
		type: CorrectionErrorDto,
	})
	@ApiForbiddenResponse({
		description:
			"无 correction.apply 权限（PERMISSION_DENIED，如 OPERATOR/VIEWER；写 DENIED 审计）",
		type: CorrectionErrorDto,
	})
	@ApiNotFoundResponse({
		description:
			"目标不存在或不属于当前组织（CORRECTION_TARGET_NOT_FOUND）；非有效成员或已禁用（ORGANIZATION_NOT_FOUND）",
		type: CorrectionErrorDto,
	})
	@ApiConflictResponse({
		description:
			"版本或使用影响失配（CORRECTION_TARGET_CHANGED）/ 报价确认键缺失或失配（CORRECTION_QUOTE_CHANGED）/ 资金缺口（CORRECTION_INSUFFICIENT_FUNDS）/ 分配冲突（CORRECTION_ALLOCATION_CONFLICT）/ 历史时点缺口（CORRECTION_HISTORICAL_SHORTFALL）/ 组织尚未完成首次设置（ONBOARDING_NOT_COMPLETED）",
		type: CorrectionErrorDto,
	})
	async apply(
		@CurrentActor() actor: ActorContext,
		@Body() dto: CorrectionRequestDto,
		@Req() request: Request,
	) {
		const data = await this.correctionService.apply(
			actor,
			dto,
			extractRequestId(request),
		);
		return { success: true, data, message: "更正已生效" };
	}

	@Get("target")
	@ApiOperation({
		summary: "更正目标当前内容",
		description:
			"返回被更正记录的当前完整内容（金额 4 位、时间 ISO；含乐观校验基准字段 version / updatedAt），作为更正页表单初值数据源。组织共享账本：同组织成员的记录均可查看。不存在或不属于当前组织一律 404（不泄露存在性）。",
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: "查询成功",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/CorrectionTargetDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiNotFoundResponse({
		description: "目标不存在或不属于当前组织（CORRECTION_TARGET_NOT_FOUND）",
		type: CorrectionErrorDto,
	})
	@UseGuards(OrganizationContextGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("correction.read")
	async getTarget(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Query("targetType") targetType: string,
		@Query("targetId") targetId: string,
	) {
		const data = await this.correctionService.getTarget(
			actor,
			targetType,
			targetId,
		);
		return { success: true, data, message: "查询成功" };
	}

	@Get()
	@ApiOperation({
		summary: "修改记录列表（版本历史）",
		description:
			"按 targetType+targetId 返回修改记录（createdAt 倒序分页；含 APPLIED 与 FAILED，FAILED 附 failReason），供记录详情页版本历史区展示；每条含所属组织 organizationId 与实际操作者 actorUserId。目标不存在或不属于当前组织一律 404（不泄露存在性）；targetType/targetId 缺失 400。",
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: "查询成功",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/CorrectionListDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description: "参数缺失（INVALID_CORRECTION_PARAMS）",
		type: CorrectionErrorDto,
	})
	@ApiNotFoundResponse({
		description: "目标不存在或不属于当前组织（CORRECTION_TARGET_NOT_FOUND）",
		type: CorrectionErrorDto,
	})
	@UseGuards(OrganizationContextGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("correction.read")
	async list(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Query("targetType") targetType: string,
		@Query("targetId") targetId: string,
		@Query("page") page: string,
	) {
		const data = await this.correctionService.list(
			actor,
			targetType,
			targetId,
			page,
		);
		return { success: true, data, message: "查询成功" };
	}
}
