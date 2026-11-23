import {
	Body,
	Controller,
	Get,
	HttpException,
	Inject,
	Logger,
	Param,
	Post,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBadRequestResponse,
	ApiBearerAuth,
	ApiBody,
	ApiConflictResponse,
	ApiCreatedResponse,
	ApiExtraModels,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from "@nestjs/swagger";
import type { User } from "@prisma/client";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentActor } from "../authorization/decorators/current-actor.decorator";
import { BusinessOrgScopeGuard } from "../authorization/guards/business-org-scope.guard";
import type { ActorContext } from "../authorization/authorization.types";
import {
	CreateUsageDto,
	CreateUsageRespDto,
	UsageDto,
	UsageErrorDto,
	UsageListRespDto,
} from "./dto/usage.dto";
import { UsageService } from "./usage.service";

/**
 * 资金使用（usage-recording M7）：2 个功能入口，全部需登录，路由挂在 plans 下。
 * create 为五步事务（§3.1：条件扣分配 → 条件扣余额 → 插记录 → FIFO 分摊 →
 * 写分摊明细），任一失败整体回滚；list 只读（usedAt 倒序 limit 100 兑底）。
 */
@ApiTags("Usage")
@ApiBearerAuth()
@ApiExtraModels(CreateUsageDto, CreateUsageRespDto, UsageDto, UsageListRespDto)
@Controller("plans")
@UseGuards(JwtAuthGuard)
export class UsageController {
	private readonly logger = new Logger(UsageController.name);

	constructor(
		@Inject(UsageService)
		private readonly usageService: UsageService,
	) {}

	/** §7 可观测性：入口 Info（userId/planId/动作）；失败 Warn 含错误码（对齐 plan.controller 先例） */
	private async withLog<T>(
		action: string,
		userId: string,
		planId: string,
		run: () => Promise<T>,
	): Promise<T> {
		this.logger.log(`${action} userId=${userId} planId=${planId}`);
		try {
			return await run();
		} catch (error) {
			const code =
				error instanceof HttpException &&
				typeof error.getResponse() === "object"
					? (error.getResponse() as { code?: string }).code
					: undefined;
			this.logger.warn(
				`${action} failed userId=${userId} planId=${planId} code=${code ?? "UNKNOWN"}`,
			);
			throw error;
		}
	}

	@Post(":id/usages")
	@ApiOperation({
		summary: "记录使用（五步事务：扣分配/扣余额/FIFO 分摊）",
		description:
			"事务内依次执行：① $executeRaw 条件扣分配（used + 本次 ≤ 分配总额，行数 = 0 返回 409 INSUFFICIENT_PLAN_ALLOCATION 附当前剩余）→ ② 条件扣账户余额（防御兜底）→ ③ 插使用记录（version = 1）→ ④ FIFO 成本分摊（同日先初始持仓再按买入先后）→ ⑤ 写分摊明细 + 递减批次；任一失败整体回滚。非幂等：一次确认 = 一笔新使用。出参含提交后计划资金面快照（fundStatus/canComplete），前端一次往返即可刷新进度区。",
	})
	@ApiBody({ type: CreateUsageDto })
	@ApiCreatedResponse({
		description: "记账成功，响应体为 { success, data: { usage, plan }, message } 包装",
		type: CreateUsageRespDto,
	})
	@ApiBadRequestResponse({
		description:
			"参数非法（INVALID_USAGE_PARAMS：金额/精度/上限/日期上下界/备注长度）",
		type: UsageErrorDto,
	})
	@ApiConflictResponse({
		description:
			"非进行中计划（PLAN_INVALID_TRANSITION）/ 剩余分配不足（INSUFFICIENT_PLAN_ALLOCATION，附 remainingAllocation）/ 余额不足（INSUFFICIENT_ACCOUNT_BALANCE）/ 批次不足（USAGE_LOT_SHORTAGE）",
		type: UsageErrorDto,
	})
	@ApiNotFoundResponse({
		description: "计划不存在或不属于本人（PLAN_NOT_FOUND，防枚举）",
		type: UsageErrorDto,
	})
	async create(
		@CurrentUser() user: User,
		@Param("id") id: string,
		@Body() dto: CreateUsageDto,
	) {
		return this.withLog("POST /plans/:id/usages", user.id, id, () =>
			this.usageService.create(user.id, id, dto),
		).then(
			(data) => ({ success: true, data, message: "使用记录已保存" }),
		);
	}

	@Get(":id/usages")
	@ApiOperation({
		summary: "使用记录列表（usedAt 倒序，limit 100 兑底）",
		description:
			"返回该计划的使用记录（含每笔 FIFO 使用成本），usedAt 倒序、同刻按录入先后倒序；个人工具量级无分页，服务端 limit 100 兑底。计划不存在或不属于本人均 404（防枚举）。",
	})
	@ApiOkResponse({
		description: "获取成功，响应体为 { success, data: { items }, message } 包装",
		type: UsageListRespDto,
	})
	@ApiNotFoundResponse({
		description: "计划不存在或不属于本人（PLAN_NOT_FOUND，防枚举）",
		type: UsageErrorDto,
	})
	@UseGuards(BusinessOrgScopeGuard)
	async list(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Param("id") id: string,
	) {
		return this.withLog("GET /plans/:id/usages", user.id, id, () =>
			this.usageService.list(
				{ userId: actor.userId, organizationId: actor.organizationId },
				id,
			),
		).then(
			(data) => ({ success: true, data, message: "使用记录获取成功" }),
		);
	}
}
