import {
	Controller,
	Get,
	HttpException,
	Inject,
	Logger,
	Param,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBadRequestResponse,
	ApiBearerAuth,
	ApiExtraModels,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiParam,
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
// biome-ignore lint/style/useImportType: 必须值导入 DTO：type-only 导入会让 tsc 在 design:paramtypes 发出 Function，ValidationPipe 会对 @Param() 对象误转换导致字段丢失（500）
import {
	AccountCurrencyParamDto,
	AccountDetailDto,
	AccountErrorDto,
	AccountLedgerDto,
	AccountLedgerItemDto,
	AccountListDto,
	AccountListItemDto,
	AccountPlanAllocationDto,
	AccountPlanAllocationListDto,
} from "./dto/account.dto";
import { AccountService } from "./account.service";
import { OrganizationLockGuard } from "../authorization/guards/organization-lock.guard";

/**
 * 外汇账户（account-module 技术方案 §4 + 阶段5 §2）：四个只读端点，全部需登录。
 * ⚠️ 项目无全局 JWT 守卫（app.module 仅全局挂 ThrottlerGuard），Controller 级
 * @UseGuards(JwtAuthGuard) + @ApiBearerAuth() 必须显式挂载（plan.controller 先例）；
 * userId 取自鉴权上下文（@CurrentUser），禁止入参传入。
 * §7 可观测性：info 只记动作与路径参数、不打金额明细；负值 warn 在 service。
 */
@ApiTags("Account")
@ApiBearerAuth()
// 手动 $ref 的响应模型需显式注册进 components（内嵌单项模型一并注册）
@ApiExtraModels(
	AccountListDto,
	AccountListItemDto,
	AccountDetailDto,
	AccountLedgerDto,
	AccountLedgerItemDto,
	AccountPlanAllocationDto,
	AccountPlanAllocationListDto,
	AccountErrorDto,
)
@Controller("accounts")
@UseGuards(JwtAuthGuard)
export class AccountController {
	private readonly logger = new Logger(AccountController.name);

	constructor(
		@Inject(AccountService)
		private readonly accountService: AccountService,
	) {}

	/** §7 可观测性：入口 Info（userId/币种/动作摘要）；失败 Warn 含错误码（plan.controller withLog 先例） */
	private async withLog<T>(
		action: string,
		userId: string,
		currencyCode: string | null,
		run: () => Promise<T>,
	): Promise<T> {
		this.logger.log(
			`${action} userId=${userId} currencyCode=${currencyCode ?? "-"}`,
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
				`${action} failed userId=${userId} currencyCode=${currencyCode ?? "-"} code=${code ?? "UNKNOWN"}`,
			);
			throw error;
		}
	}

	@Get()
	@ApiOperation({
		summary: "账户列表（本人，currencyCode 升序）",
		description:
			"返回本人全部虚拟外汇账户（按币种合并，同币种单账户）：余额、已分配金额（Σ全部计划剩余分配，全状态求和）、未分配余额（余额 − 已分配）。未分配余额/已分配为负（数据破坏信号）时如实返回不钳 0（warn 日志，§3.3/§6）。baseCurrency 取 userSettings，新用户无设置行时为 null。",
	})
	@ApiOkResponse({
		description: "获取成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/AccountListDto" },
				message: { type: "string" },
			},
		},
	})
	@UseGuards(BusinessOrgScopeGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("account.read")
	async listAccounts(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
	) {
		const scope: ReadScope = actor;
		return this.withLog("GET /accounts", user.id, null, () =>
			this.accountService.list(scope),
		).then((data) => ({ success: true, data, message: "账户列表获取成功" }));
	}

	@Get(":currencyCode")
	@ApiOperation({
		summary: "账户详情（余额 / 已分配 / 未分配余额 / 剩余成本 / 平均单位成本）",
		description:
			"列表接口单账户字段 + 剩余已记录成本（toFixed(4)）与平均单位成本（toFixed(8)）；无批次（旧数据未回填）或余额 0 / 全部消耗时对应值为 null（doc 04：余额为 0 时不计算单位平均成本）。币种大小写不敏感：非 15 币种 400 INVALID_ACCOUNT_CURRENCY；该币种无账户（含他人账户）404 ACCOUNT_NOT_FOUND，不泄露存在性。",
	})
	@ApiOkResponse({
		description: "获取成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/AccountDetailDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description: "币种不在支持的 15 币种内（INVALID_ACCOUNT_CURRENCY）",
		type: AccountErrorDto,
	})
	@ApiNotFoundResponse({
		description: "该币种未建账户，含他人账户（ACCOUNT_NOT_FOUND）",
		type: AccountErrorDto,
	})
	@UseGuards(BusinessOrgScopeGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("account.read")
	async getAccount(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Param() params: AccountCurrencyParamDto,
	) {
		const scope: ReadScope = actor;
		return this.withLog(
			"GET /accounts/:currencyCode",
			user.id,
			params.currencyCode,
			() => this.accountService.detail(scope, params.currencyCode),
		).then((data) => ({ success: true, data, message: "账户详情获取成功" }));
	}

	@Get(":currencyCode/allocations")
	@ApiParam({
		name: "currencyCode",
		type: String,
		required: true,
		description: "币种代码（3 位字母，ISO 4217，大小写不敏感）",
		example: "CAD",
	})
	@ApiOperation({
		summary: "账户按计划分配明细（只读；分配与调整操作在计划中，本端点无写操作）",
		description:
			"按计划逐条返回该币种的分配明细（计划名/状态、分配总额、累计已使用、剩余分配），按计划创建时间升序，无分页（个位到十位级，take 100 兜底）。不过滤计划状态，与列表/详情 allocatedAmount 汇总口径一致（CANCELLED 已释放剩余 0 仍如实列出）；amount 与 usedAmount 均为 0 的计划不出明细行。鉴权与 400/404 口径同详情接口（ACCOUNT_NOT_FOUND 不泄露存在性）。",
	})
	@ApiOkResponse({
		description: "获取成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/AccountPlanAllocationListDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description: "币种不在支持的 15 币种内（INVALID_ACCOUNT_CURRENCY）",
		type: AccountErrorDto,
	})
	@ApiNotFoundResponse({
		description: "该币种未建账户，含他人账户（ACCOUNT_NOT_FOUND）",
		type: AccountErrorDto,
	})
	@UseGuards(BusinessOrgScopeGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("account.read")
	async getAllocations(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Param() params: AccountCurrencyParamDto,
	) {
		const scope: ReadScope = actor;
		return this.withLog(
			"GET /accounts/:currencyCode/allocations",
			user.id,
			params.currencyCode,
			() => this.accountService.allocations(scope, params.currencyCode),
		).then((data) => ({ success: true, data, message: "计划分配获取成功" }));
	}

	@Get(":currencyCode/transactions")
	@ApiOperation({
		summary: "账户流水（按时间倒序的事件列表，非 FIFO 计算顺序）",
		description:
			"账户详情页事件列表：买入（PURCHASE）与使用（USAGE，M7 上线前不出现；初始持仓 INITIAL 为 M1 预留），按 occurredAt 倒序、同刻按录入时间倒序。买入成本 = 本金 + 手续费（未知时 = 本金，feeKnown=false）；使用成本 M7 起由 FIFO 消耗聚合（当前恒 null）。无分页（单用户流水 ≤ 万级，§3.6）。鉴权与 404 口径同详情接口。",
	})
	@ApiOkResponse({
		description: "获取成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/AccountLedgerDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description: "币种不在支持的 15 币种内（INVALID_ACCOUNT_CURRENCY）",
		type: AccountErrorDto,
	})
	@ApiNotFoundResponse({
		description: "该币种未建账户，含他人账户（ACCOUNT_NOT_FOUND）",
		type: AccountErrorDto,
	})
	@UseGuards(BusinessOrgScopeGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("account.read")
	async getLedger(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Param() params: AccountCurrencyParamDto,
	) {
		const scope: ReadScope = actor;
		return this.withLog(
			"GET /accounts/:currencyCode/transactions",
			user.id,
			params.currencyCode,
			() => this.accountService.ledger(scope, params.currencyCode),
		).then((data) => ({ success: true, data, message: "账户流水获取成功" }));
	}
}
