import {
	Controller,
	Get,
	HttpCode,
	HttpStatus,
	Inject,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBearerAuth,
	ApiExtraModels,
	ApiOperation,
	ApiOkResponse,
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
import { HomeStateDto, PortfolioDto } from "./dto/home.dto";
import { HomeService } from "./home.service";
import { OrganizationLockGuard } from "../authorization/guards/organization-lock.guard";

/**
 * 首页状态（home-state-routing，技术方案 §3.1）：单一查询入口，需登录。
 * 只读、无副作用、幂等；无业务错误分支（除全局 401），任何登录用户都得到完整状态。
 */
@ApiTags("Home")
@ApiBearerAuth()
// 手动 $ref 的响应模型需显式注册进 components（HomeStateDto 内嵌摘要数组，PortfolioDto 内嵌分币种数组）
@ApiExtraModels(HomeStateDto, PortfolioDto)
@Controller("home")
@UseGuards(JwtAuthGuard)
export class HomeController {
	constructor(
		@Inject(HomeService)
		private readonly homeService: HomeService,
	) {}

	@Get("state")
	@ApiOperation({
		summary: "查询首页状态（分流 + 摘要）",
		description:
			"一次请求返回分流三布尔（onboardingCompleted / hasAccounts / hasPlans）+ 账户与计划全量摘要 + 汇率全表最新观测时间。分流规则（如是否空账本）由前端按三布尔决策，后端保持数据中立。",
	})
	@ApiOkResponse({
		description: "状态查询成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/HomeStateDto" },
				message: { type: "string" },
			},
		},
	})
	@HttpCode(HttpStatus.OK)
	@UseGuards(BusinessOrgScopeGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("account.read")
	async getState(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
	) {
		const data = await this.homeService.getState(actor);
		return { success: true, data, message: "首页状态查询成功" };
	}

	@Get("portfolio")
	@ApiOperation({
		summary: "查询持仓聚合（CostLot 剩余持仓）",
		description:
			"按币种聚合剩余持仓（remainingQty > 0）：Σ剩余数量、Σ剩余持仓成本、平均单位成本，附本位币。口径：unitCost 以用户当前本位币计价（本位币买入价），本位币历史变更不重算；聚合在 SQL 层完成，仅返回 remainingQty > 0 的币种，按 currencyCode 升序。",
	})
	@ApiOkResponse({
		description: "持仓聚合查询成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/PortfolioDto" },
				message: { type: "string" },
			},
		},
	})
	@HttpCode(HttpStatus.OK)
	@UseGuards(BusinessOrgScopeGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("account.read")
	async getPortfolio(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
	) {
		const data = await this.homeService.getPortfolio(actor);
		return { success: true, data, message: "持仓聚合查询成功" };
	}
}
