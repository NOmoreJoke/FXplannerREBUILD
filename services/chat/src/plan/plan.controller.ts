import {
	Body,
	Controller,
	Get,
	HttpCode,
	HttpException,
	HttpStatus,
	Inject,
	Logger,
	Param,
	Patch,
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
	ApiOkResponse,
	ApiOperation,
	ApiResponse,
	ApiTags,
} from "@nestjs/swagger";
import type { User } from "@prisma/client";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentActor } from "../authorization/decorators/current-actor.decorator";
import { BusinessOrgScopeGuard } from "../authorization/guards/business-org-scope.guard";
import { PermissionGuard } from "../authorization/guards/permission.guard";
import { RequiresPermission } from "../authorization/decorators/requires-permission.decorator";
import type { ActorContext } from "../authorization/authorization.types";
import type { ReadScope } from "../authorization/organization-scope";
import {
	AdjustCapsDto,
	AdjustImpactDto,
	AdjustPlanDto,
	AdjustPreviewDto,
	AdjustPreviewResultDto,
	AllocatableCapsDto,
	CreatePlanDto,
	PlanAdjustSnapshotDto,
	PlanChangeLogDto,
	PlanDetailDto,
	PlanDto,
	PlanErrorDto,
	PlanInstallmentDto,
	PlanListDto,
	PlanListItemDto,
	PlanListQueryDto,
	SchedulePreviewDto,
	SchedulePreviewResultDto,
} from "./dto/plan.dto";
import { PlanService } from "./plan.service";

/**
 * 换汇计划（plan-creation + plan-management）：8 个功能入口，全部需登录。
 * preview 只读不落库（随表单防抖反复调用）；create 事务内重检余额（并发安全权威防线）；
 * M5 管理六端点：列表/详情/修改预览（只读）/提交修改（事务内乐观锁 + 重算重校验）/完成/取消。
 */
@ApiTags("Plan")
@ApiBearerAuth()
// 手动 $ref 的响应模型需显式注册进 components（内嵌 installments/caps 子模型一并注册）
@ApiExtraModels(
	PlanDto,
	SchedulePreviewResultDto,
	PlanInstallmentDto,
	AllocatableCapsDto,
	PlanListItemDto,
	PlanListDto,
	PlanDetailDto,
	PlanChangeLogDto,
	AdjustPreviewDto,
	AdjustPlanDto,
	AdjustPreviewResultDto,
	AdjustCapsDto,
	AdjustImpactDto,
	PlanAdjustSnapshotDto,
	PlanListQueryDto,
)
@Controller("plans")
@UseGuards(JwtAuthGuard)
export class PlanController {
	private readonly logger = new Logger(PlanController.name);

	constructor(
		@Inject(PlanService)
		private readonly planService: PlanService,
	) {}

	/** §7 可观测性：入口 Info（userId/planId/动作摘要）；事务失败 Warn 含错误码 */
	private async withLog<T>(
		action: string,
		userId: string,
		planId: string | null,
		run: () => Promise<T>,
	): Promise<T> {
		this.logger.log(
			`${action} userId=${userId} planId=${planId ?? "-"}`,
		);
		try {
			return await run();
		} catch (error) {
			const code =
				error instanceof HttpException &&
				typeof error.getResponse() === "object"
					? (error.getResponse() as { code?: string }).code
					: undefined;
			this.logger.warn(
				`${action} failed userId=${userId} planId=${planId ?? "-"} code=${code ?? "UNKNOWN"}`,
			);
			throw error;
		}
	}

	// 只读预览（@Post 但不落库）：与业务 GET 同一守卫链（评审 I-12——禁离职成员/
	// 跨组织上下文取快照，禁 Viewer 绕过 plan.create 权限点）
	@Post("schedule-preview")
	@UseGuards(BusinessOrgScopeGuard, PermissionGuard)
	@RequiresPermission("plan.create")
	@ApiOperation({
		summary: "分批排期预览（只读，不落库）",
		description:
			"按目标金额/用途日期/提前天数/节奏实时生成分批排期（3/2/1 批），并返回该币种可分配余额 caps 供前端对「计入已有外币」做实时预检。可随表单输入反复调用，不产生任何落库副作用。错误：400 INVALID_PLAN_PARAMS（币种/金额/日期/天数/节奏非法）、NO_AVAILABLE_DATES（可安排工作日为 0）、AMOUNT_TOO_SMALL（分批取整后某批为 0）。",
	})
	@ApiBody({ type: SchedulePreviewDto })
	@ApiOkResponse({
		description: "预览成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/SchedulePreviewResultDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description:
			"参数非法（INVALID_PLAN_PARAMS）或无法生成排期（NO_AVAILABLE_DATES / AMOUNT_TOO_SMALL）",
		type: PlanErrorDto,
	})
	@HttpCode(HttpStatus.OK)
	async preview(
		@CurrentUser() user: User,
		@Body() dto: SchedulePreviewDto,
	) {
		const data = await this.planService.preview(user.id, dto);
		return { success: true, data, message: "排期预览生成成功" };
	}

	@Post()
	@ApiOperation({
		summary: "创建换汇计划（事务）",
		description:
			"事务内依次执行：重检可分配余额（409 INSUFFICIENT_ALLOCATABLE_BALANCE 时附 caps 现值）→ 插入计划（最晚准备日服务端重算，不信任前端）→ 分配记录（usedAmount = 0）→ 分批排期；任一失败全部回滚。allocatedAmount 允许 0（不占用余额的纯新建目标）。",
	})
	@ApiBody({ type: CreatePlanDto })
	@ApiCreatedPlanResponse()
	@ApiBadRequestResponse({
		description:
			"参数非法（INVALID_PLAN_PARAMS）或无法生成排期（NO_AVAILABLE_DATES / AMOUNT_TOO_SMALL）",
		type: PlanErrorDto,
	})
	@ApiConflictResponse({
		description: "分配超可配余额（INSUFFICIENT_ALLOCATABLE_BALANCE，附 caps 现值）",
		type: PlanErrorDto,
	})
	async create(@CurrentUser() user: User, @Body() dto: CreatePlanDto) {
		const data = await this.planService.create(user.id, dto);
		return { success: true, data, message: "换汇计划创建成功" };
	}

	// ────────────────── M5 计划管理（plan-management §4.1~4.6）──────────────────

	@Get()
	@ApiOperation({
		summary: "计划列表（本人，updatedAt 倒序，limit 100 兑底）",
		description:
			"返回本人全部计划（可按状态过滤：ACTIVE / COMPLETED / CANCELLED，缺省全部；非法值 400）。含目标金额、累计已使用、分配总额、计划剩余分配、资金缺口、最晚准备日期、下一准备节点。个人工具量级无分页，服务端 limit 100 兑底。",
	})
	@ApiOkResponse({
		description: "获取成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/PlanListDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description: "status 非法（不在三值枚举内），无模块 code",
		type: PlanErrorDto,
	})
	@UseGuards(BusinessOrgScopeGuard, PermissionGuard)
	@RequiresPermission("plan.read")
	async list(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Query() query: PlanListQueryDto,
	) {
		const scope: ReadScope = actor;
		return this.withLog(`GET /plans status=${query.status ?? "ALL"}`, user.id, null, () =>
			this.planService.list(scope, query.status),
		).then(
			(data) => ({ success: true, data, message: "计划列表获取成功" }),
		);
	}

	@Get(":id")
	@ApiOperation({
		summary: "计划详情（含准备节点 / 修改记录 / 操作标记）",
		description:
			"返回计划全量信息：列表项字段 + 节奏/准备缓冲/预计使用日期/开始准备日 + 准备节点 + 修改记录（倒序）+ canModify/canCancel/canComplete/canReopen（服务端按状态与数据计算，前端据此显隐操作按钮）。不存在或不属于本人均 404（防枚举）。",
	})
	@ApiOkResponse({
		description: "获取成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/PlanDetailDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiNotFoundResponse({
		description: "计划不存在或不属于本人（PLAN_NOT_FOUND）",
		type: PlanErrorDto,
	})
	@UseGuards(BusinessOrgScopeGuard, PermissionGuard)
	@RequiresPermission("plan.read")
	async getDetail(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Param("id") id: string,
	) {
		const scope: ReadScope = actor;
		return this.withLog("GET /plans/:id", user.id, id, () =>
			this.planService.getDetail(scope, id),
		).then(
			(data) => ({ success: true, data, message: "计划详情获取成功" }),
		);
	}

	@Post(":id/adjust-preview")
	@HttpCode(HttpStatus.OK)
	@UseGuards(BusinessOrgScopeGuard, PermissionGuard)
	@RequiresPermission("plan.adjust")
	@ApiOperation({
		summary: "修改预览（只读，不落库）",
		description:
			"两段式修改第一段：按新目标/新分配/节奏/准备缓冲/开始日计算影响（释放额、新缺口、新排期、caps 三值），不变更任何数据。仅进行中可预览；已完成计划提高目标返回 reopen 标记（提交时须带 confirmReopen: true）；已取消预览 409。至少提供一项修改内容，否则 400。",
	})
	@ApiBody({ type: AdjustPreviewDto })
	@ApiOkResponse({
		description: "预览成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/AdjustPreviewResultDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description:
			"参数非法（INVALID_PLAN_PARAMS：至少一项 / 金额超 4 位小数 / 缓冲越界等）或无法生成新排期（NO_AVAILABLE_DATES / AMOUNT_TOO_SMALL）",
		type: PlanErrorDto,
	})
	@ApiConflictResponse({
		description:
			"已取消计划不可预览，或已完成计划非严格完成态 + 调高目标（PLAN_INVALID_TRANSITION）",
		type: PlanErrorDto,
	})
	@ApiNotFoundResponse({
		description: "计划不存在或不属于本人（PLAN_NOT_FOUND）",
		type: PlanErrorDto,
	})
	async previewAdjust(
		@CurrentUser() user: User,
		@Param("id") id: string,
		@Body() dto: AdjustPreviewDto,
	) {
		return this.withLog("POST /plans/:id/adjust-preview", user.id, id, () =>
			this.planService.previewAdjust(user.id, id, dto),
		).then(
			(data) => ({ success: true, data, message: "修改预览生成成功" }),
		);
	}

	@Patch(":id")
	@ApiOperation({
		summary: "提交修改 / 重新开启（事务 + 乐观锁）",
		description:
			"两段式修改第二段：事务内条件更新（id + userId + updatedAt = expectedUpdatedAt）原子完成乐观锁检查与写入，行数 = 0 返回 409 PLAN_STATE_CHANGED；随后事务内重算重校验（预览结果不作为提交依据），目标/分配/排期/变更记录同一事务落库，任一失败全部回滚。已完成计划提高目标需 confirmReopen: true（缺失 400；重开时不得同时携带分配/节奏/准备缓冲参数）；进行中计划携带 confirmReopen 会被忽略。返回提交后详情。",
	})
	@ApiBody({ type: AdjustPlanDto })
	@ApiOkResponse({
		description: "修改成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/PlanDetailDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description:
			"参数非法（INVALID_PLAN_PARAMS）/ 目标低于已用（PLAN_TARGET_BELOW_USED）/ 分配低于已用（PLAN_ALLOCATION_BELOW_USED，附 used 与差额）/ 超上限（PLAN_ALLOCATION_LIMIT，附最新 caps）/ 排期不可生成（NO_AVAILABLE_DATES / AMOUNT_TOO_SMALL）",
		type: PlanErrorDto,
	})
	@ApiConflictResponse({
		description:
			"乐观锁失配（PLAN_STATE_CHANGED）或非法状态流转（PLAN_INVALID_TRANSITION）",
		type: PlanErrorDto,
	})
	@ApiNotFoundResponse({
		description: "计划不存在或不属于本人（PLAN_NOT_FOUND）",
		type: PlanErrorDto,
	})
	async adjust(
		@CurrentUser() user: User,
		@Param("id") id: string,
		@Body() dto: AdjustPlanDto,
	) {
		return this.withLog("PATCH /plans/:id", user.id, id, () =>
			this.planService.adjust(user.id, id, dto),
		).then((data) => ({ success: true, data, message: "计划修改成功" }));
	}

	@Post(":id/complete")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "完成确认（仅进行中；数据不变）",
		description:
			"事务内条件更新（WHERE status = 'ACTIVE'）原子防「并发取消 + 完成」双写，行数 = 0 返回 409。仅当已使用 = 目标且剩余分配 = 0 且无超用可完成（PLAN_COMPLETE_NOT_READY 400 附当前差值；超用提示先走更正流程）。成功后状态转 COMPLETED 并写完成记录，计划数据不变。无请求体。",
	})
	@ApiOkResponse({
		description: "完成成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/PlanDetailDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description: "未达标或存在超用（PLAN_COMPLETE_NOT_READY，附差值）",
		type: PlanErrorDto,
	})
	@ApiConflictResponse({
		description: "仅进行中的计划可完成（PLAN_INVALID_TRANSITION）",
		type: PlanErrorDto,
	})
	@ApiNotFoundResponse({
		description: "计划不存在或不属于本人（PLAN_NOT_FOUND）",
		type: PlanErrorDto,
	})
	async complete(@CurrentUser() user: User, @Param("id") id: string) {
		return this.withLog("POST /plans/:id/complete", user.id, id, () =>
			this.planService.complete(user.id, id),
		).then((data) => ({ success: true, data, message: "计划已完成" }));
	}

	@Post(":id/cancel")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "取消计划（释放剩余分配，终态）",
		description:
			"事务内条件更新（WHERE status = 'ACTIVE'）保证与完成/其他修改并发时恰一成功，行数 = 0 返回 409。分配总额下调为累计已使用（释放全部剩余分配回未分配余额，账户余额与已发生的换汇、使用记录不动），准备节点清空，状态转 CANCELLED（终态）并写取消记录。无请求体。",
	})
	@ApiOkResponse({
		description: "取消成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/PlanDetailDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiConflictResponse({
		description: "仅进行中的计划可取消（PLAN_INVALID_TRANSITION）",
		type: PlanErrorDto,
	})
	@ApiNotFoundResponse({
		description: "计划不存在或不属于本人（PLAN_NOT_FOUND）",
		type: PlanErrorDto,
	})
	async cancel(@CurrentUser() user: User, @Param("id") id: string) {
		return this.withLog("POST /plans/:id/cancel", user.id, id, () =>
			this.planService.cancel(user.id, id),
		).then((data) => ({ success: true, data, message: "计划已取消" }));
	}
}

/** 201 响应的 swagger 标注辅助（统一包装结构说明，风格与 onboarding 模块一致） */
function ApiCreatedPlanResponse() {
	return ApiResponse({
		status: HttpStatus.CREATED,
		description: "创建成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/PlanDto" },
				message: { type: "string" },
			},
		},
	});
}
