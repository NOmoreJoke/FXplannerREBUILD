import {
	Controller,
	Get,
	HttpException,
	Inject,
	Logger,
	Param,
	Query,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBadRequestResponse,
	ApiBearerAuth,
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
// biome-ignore lint/style/useImportType: 必须值导入 DTO：type-only 导入会让 tsc 在 design:paramtypes 发出 Function，ValidationPipe 会对 @Param() 对象误转换导致字段丢失（account.controller 先例注释）
import {
	PlanReportDto,
	ReportErrorDto,
	ReportPlanListDto,
	ReportPlanListQueryDto,
} from "./dto/report.dto";
import { ReportService } from "./report.service";

/**
 * 成本摘要与报告（reports 技术方案 §5）：2 个只读端点，全部需登录。
 * ⚠️ 项目无全局 JWT 守卫（app.module 仅全局挂 ThrottlerGuard），Controller 级
 * @UseGuards(JwtAuthGuard) + @ApiBearerAuth() 必须显式挂载（account.controller 先例）；
 * userId 取自鉴权上下文（@CurrentUser），禁止入参传入。
 * §11 可观测性：info 只记动作与路径参数、不打金额明细；失败 Warn 含错误码。
 */
@ApiTags("Report")
@ApiBearerAuth()
// 手动 $ref 的响应模型需显式注册进 components（内嵌子模型一并注册）
@ApiExtraModels(
	ReportPlanListDto,
	PlanReportDto,
	ReportErrorDto,
)
@Controller("reports")
@UseGuards(JwtAuthGuard)
export class ReportController {
	private readonly logger = new Logger(ReportController.name);

	constructor(
		@Inject(ReportService)
		private readonly reportService: ReportService,
	) {}

	/** §11 可观测性：入口 Info（userId/动作摘要）；失败 Warn 含错误码（account.controller withLog 先例） */
	private async withLog<T>(
		action: string,
		userId: string,
		planId: string | null,
		run: () => Promise<T>,
	): Promise<T> {
		this.logger.log(`${action} userId=${userId} planId=${planId ?? "-"}`);
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

	@Get("plans")
	@ApiOperation({
		summary: "报告中心列表（本人全部计划成本摘要，创建时间倒序）",
		description:
			"按计划列出成本摘要：状态、币种、目标金额、累计已使用数量、已使用成本（本位币）、使用均价、手续费未明确标记、信息更新时间。可按状态（ACTIVE / COMPLETED / CANCELLED）与币种过滤，缺省全部；非法值 400 INVALID_REPORT_PARAMS。不同币种金额绝不合计（无跨计划合计行）。M7 未上线（无使用分摊数据）时 usedQuantity=\"0.0000\"、成本与均价为 null（全链路「尚未使用」）。baseCurrency 取 userSettings，新用户 null。",
	})
	@ApiOkResponse({
		description: "获取成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/ReportPlanListDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description:
			"status 不在三值枚举内，或币种不在支持的 15 币种内（INVALID_REPORT_PARAMS）",
		type: ReportErrorDto,
	})
	@UseGuards(BusinessOrgScopeGuard)
	async listPlans(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Query() query: ReportPlanListQueryDto,
	) {
		return this.withLog(
			`GET /reports/plans status=${query.status ?? "ALL"} currencyCode=${query.currencyCode ?? "ALL"}`,
			user.id,
			null,
			() =>
				this.reportService.list(
					{ userId: actor.userId, organizationId: actor.organizationId },
					{
						status: query.status,
						currencyCode: query.currencyCode,
					},
				),
		).then((data) => ({
			success: true,
			data,
			message: "报告中心列表获取成功",
		}));
	}

	@Get("plans/:id")
	@ApiOperation({
		summary: "单计划报告（页面摘要与打印视图共用数据源）",
		description:
			"单计划成本报告：基本信息与进度（目标/已使用/剩余待使用差额）、成本摘要（已使用总成本/使用均价）、来源拆分（初始持仓/后续买入各自数量与成本）、手续费未明确标记、收益占位区块（算法定稿前不出数值：纯初始持仓 INITIAL_ONLY_NO_COMPARISON，含买入 NOT_SUPPORTED_YET）、信息更新时间与报告生成时间。id 格式非法 400 INVALID_REPORT_PARAMS；不存在或不属于本人均 404（防枚举）。",
	})
	@ApiOkResponse({
		description: "获取成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/PlanReportDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiBadRequestResponse({
		description: "计划 ID 格式非法（INVALID_REPORT_PARAMS）",
		type: ReportErrorDto,
	})
	@ApiNotFoundResponse({
		description: "计划不存在或不属于本人（PLAN_NOT_FOUND）",
		type: ReportErrorDto,
	})
	@UseGuards(BusinessOrgScopeGuard)
	async getPlanReport(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
		@Param("id") id: string,
	) {
		return this.withLog("GET /reports/plans/:id", user.id, id, () =>
			this.reportService.detail(
				{ userId: actor.userId, organizationId: actor.organizationId },
				id,
			),
		).then((data) => ({
			success: true,
			data,
			message: "计划报告获取成功",
		}));
	}
}