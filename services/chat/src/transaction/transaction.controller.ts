import {
	Body,
	Controller,
	Get,
	HttpStatus,
	Inject,
	Param,
	Post,
	Req,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBadRequestResponse,
	ApiBearerAuth,
	ApiBody,
	ApiCreatedResponse,
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
import { BusinessOrgScopeGuard } from "../authorization/guards/business-org-scope.guard";
import { PermissionGuard } from "../authorization/guards/permission.guard";
import { RequiresPermission } from "../authorization/decorators/requires-permission.decorator";
import type { ActorContext } from "../authorization/authorization.types";
import { extractRequestId } from "../authorization/request-id";
import {
	CreateTransactionDto,
	TransactionDto,
	TransactionErrorDto,
} from "./dto/transaction.dto";
import { TransactionService } from "./transaction.service";
import { OrganizationLockGuard } from "../authorization/guards/organization-lock.guard";

/**
 * 买入交易（transaction-entry，技术方案 §5）：2 个功能入口，全部需登录。
 * create 为一个本地事务（自动建户 + 余额累加 + 落交易记录，任一失败全部回滚）；
 * detail 按 id + userId 联查，不存在或不属于本人一律 404（不泄露存在性）。
 * 互算不设独立预览接口：计算为 money 包纯函数、零 IO，前端本地完成（方案 §5.2）。
 */
@ApiTags("Transaction")
@ApiBearerAuth()
// 手动 $ref 的响应模型需显式注册进 components（风格与 plan.controller 一致）
@ApiExtraModels(TransactionDto)
@Controller("transactions")
@UseGuards(JwtAuthGuard)
export class TransactionController {
	constructor(
		@Inject(TransactionService)
		private readonly transactionService: TransactionService,
	) {}

	@Post()
	@UseGuards(BusinessOrgScopeGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("transaction.create")
	@ApiOperation({
		summary: "创建买入记录（事务）",
		description:
			"两种填法三值同送（本金/汇率/到账），服务端做双向自洽校验（receivedAmountOf(p,r)==q 或 impliedRate(p,q)==r 满足其一）。事务内依次执行：锁组织与复验 transaction.create 权限 → 解析组织偏好与校验交易日期 → 锁组织账本账户 → 关联计划校验（同组织归属 404 PLAN_NOT_FOUND、币种一致 400 PLAN_CURRENCY_MISMATCH，仅标记不触发分配）→ 组织账户 upsert 自动建户 + 余额原子累加 → 插入交易记录（version=1、rateSource=MANUAL）→ 补写成本批次 → 同事务写入审计日志；任一失败全部回滚。手续费缺省 = 未知（null，≠ 0）；\"0\" = 无手续费。",
	})
	@ApiBody({ type: CreateTransactionDto })
	@ApiCreatedResponse({
		description: "创建成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/TransactionDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description:
			"参数非法（INVALID_TRANSACTION_PARAMS，含三值不自洽、币种/金额/日期校验失败）或到账金额正数舍 0（ROUND_TO_ZERO）、计划币种不匹配（PLAN_CURRENCY_MISMATCH）",
		type: TransactionErrorDto,
	})
	@ApiForbiddenResponse({
		description: "无 transaction.create 权限（PERMISSION_DENIED，如 OPERATOR/VIEWER）",
		type: TransactionErrorDto,
	})
	@ApiNotFoundResponse({
		description: "关联计划不存在或不属于当前组织（PLAN_NOT_FOUND）",
		type: TransactionErrorDto,
	})
	async create(
		@CurrentActor() actor: ActorContext,
		@Body() dto: CreateTransactionDto,
		@Req() request: Request,
	) {
		const data = await this.transactionService.create(
			actor,
			dto,
			extractRequestId(request),
		);
		return { success: true, data, message: "买入记录创建成功" };
	}

	@Get(":id")
	@ApiOperation({
		summary: "交易详情",
		description:
			"返回单条买入记录（数量/本金/手续费/总成本/汇率等）；手续费未知时 feeAmount=null、totalCost=null、feeKnown=false，前端显示「费用未明确」。仅本人可见：不存在或不属于本人一律 404 TRANSACTION_NOT_FOUND。",
	})
	@ApiOkTransactionResponse()
	@ApiNotFoundResponse({
		description: "交易不存在或不属于本人（TRANSACTION_NOT_FOUND）",
		type: TransactionErrorDto,
	})
	@UseGuards(BusinessOrgScopeGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("transaction.read")
	async detail(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Param("id") id: string,
	) {
		const data = await this.transactionService.detail(
			actor,
			id,
		);
		return { success: true, data, message: "查询成功" };
	}
}

/** 详情 200 响应的 swagger 标注辅助（统一包装结构说明，风格与 plan 模块一致） */
function ApiOkTransactionResponse() {
	return ApiResponse({
		status: HttpStatus.OK,
		description: "查询成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/TransactionDto" },
				message: { type: "string" },
			},
		},
	});
}
