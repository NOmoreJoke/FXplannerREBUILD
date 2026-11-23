import {
	Body,
	Controller,
	Get,
	HttpCode,
	HttpStatus,
	Inject,
	Post,
	Query,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBadRequestResponse,
	ApiBearerAuth,
	ApiBody,
	ApiConflictResponse,
	ApiExtraModels,
	ApiNotFoundResponse,
	ApiOperation,
	ApiResponse,
	ApiTags,
} from "@nestjs/swagger";
import type { User } from "@prisma/client";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentActor } from "../authorization/decorators/current-actor.decorator";
import { BusinessOrgScopeGuard } from "../authorization/guards/business-org-scope.guard";
import type { ActorContext } from "../authorization/authorization.types";
import {
	CorrectionApplyResultDto,
	CorrectionErrorDto,
	CorrectionListDto,
	CorrectionPreviewDto,
	CorrectionRequestDto,
	CorrectionTargetDto,
} from "./dto/correction.dto";
import { CorrectionService } from "./correction.service";

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

	@Post("preview")
	@HttpCode(HttpStatus.OK)
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
		description: "目标不存在或不属于本人（CORRECTION_TARGET_NOT_FOUND）",
		type: CorrectionErrorDto,
	})
	@ApiConflictResponse({
		description: "预览后目标已被其他修改更新（CORRECTION_TARGET_CHANGED）",
		type: CorrectionErrorDto,
	})
	async preview(
		@CurrentUser() user: User,
		@Body() dto: CorrectionRequestDto,
	) {
		const data = await this.correctionService.preview(user.id, dto);
		return { success: true, data, message: "影响预览成功" };
	}

	@Post()
	@ApiOperation({
		summary: "提交更正（事务）",
		description:
			"事务内锁定受影响币种账户并重算。USAGE 须确认本次影响，初始持仓改币种须确认预览报价。版本或使用影响失配返回 409 CORRECTION_TARGET_CHANGED，报价失配返回 409 CORRECTION_QUOTE_CHANGED，均须重新预览。校验通过后重放账本并写入 APPLIED；资金、分配或历史缺口拒绝时，业务数据零变化，另写 FAILED 尝试留痕。",
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
			"参数非法（INVALID_CORRECTION_PARAMS）/ 待确定项拦截（CORRECTION_NOT_ALLOWED）/ 报价不可得（RATE_QUOTE_UNAVAILABLE）",
		type: CorrectionErrorDto,
	})
	@ApiNotFoundResponse({
		description: "目标不存在或不属于本人（CORRECTION_TARGET_NOT_FOUND）",
		type: CorrectionErrorDto,
	})
	@ApiConflictResponse({
		description:
			"版本或使用影响失配（CORRECTION_TARGET_CHANGED）/ 报价确认键缺失或失配（CORRECTION_QUOTE_CHANGED）/ 资金缺口（CORRECTION_INSUFFICIENT_FUNDS）/ 分配冲突（CORRECTION_ALLOCATION_CONFLICT）/ 历史时点缺口（CORRECTION_HISTORICAL_SHORTFALL）",
		type: CorrectionErrorDto,
	})
	async apply(@CurrentUser() user: User, @Body() dto: CorrectionRequestDto) {
		const data = await this.correctionService.apply(user.id, dto);
		return { success: true, data, message: "更正已生效" };
	}

	@Get("target")
	@ApiOperation({
		summary: "更正目标当前内容",
		description:
			"返回被更正记录的当前完整内容（金额 4 位、时间 ISO；含乐观校验基准字段 version / updatedAt），作为更正页表单初值数据源。仅本人可见：不存在或不属于本人一律 404（不泄露存在性）。",
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
		description: "目标不存在或不属于本人（CORRECTION_TARGET_NOT_FOUND）",
		type: CorrectionErrorDto,
	})
	@UseGuards(BusinessOrgScopeGuard)
	async getTarget(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Query("targetType") targetType: string,
		@Query("targetId") targetId: string,
	) {
		const data = await this.correctionService.getTarget(
			{ userId: actor.userId, organizationId: actor.organizationId },
			targetType,
			targetId,
		);
		return { success: true, data, message: "查询成功" };
	}

	@Get()
	@ApiOperation({
		summary: "修改记录列表（版本历史）",
		description:
			"按 targetType+targetId 返回修改记录（createdAt 倒序分页；含 APPLIED 与 FAILED，FAILED 附 failReason），供记录详情页版本历史区展示。目标不存在或不属于本人一律 404（不泄露存在性）；targetType/targetId 缺失 400。",
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
		description: "目标不存在或不属于本人（CORRECTION_TARGET_NOT_FOUND）",
		type: CorrectionErrorDto,
	})
	@UseGuards(BusinessOrgScopeGuard)
	async list(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Query("targetType") targetType: string,
		@Query("targetId") targetId: string,
		@Query("page") page: string,
	) {
		const data = await this.correctionService.list(
			{ userId: actor.userId, organizationId: actor.organizationId },
			targetType,
			targetId,
			page,
		);
		return { success: true, data, message: "查询成功" };
	}
}
