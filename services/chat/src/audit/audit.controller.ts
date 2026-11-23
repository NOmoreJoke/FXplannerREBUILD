import {
	Controller,
	Get,
	Inject,
	Query,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBearerAuth,
	ApiExtraModels,
	ApiForbiddenResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import {
	CurrentActor,
} from "../authorization/decorators/current-actor.decorator";
import {
	OrganizationContextGuard,
} from "../authorization/guards/organization-context.guard";
import { PermissionGuard } from "../authorization/guards/permission.guard";
import {
	RequiresPermission,
} from "../authorization/decorators/requires-permission.decorator";
import { OrganizationRoute } from "../authorization/decorators/organization-route.decorator";
import type { ActorContext } from "../authorization/authorization.types";
import { AuditService } from "./audit.service";
import { AuditLogListDto, ListAuditLogsQueryDto } from "./dto/audit.dto";

/**
 * 组织审计只读端点（AUDIT-03；技术方案 §4.3 Guard 链；Goal #3A W17 挂链）。
 *
 * Guard 顺序：JwtAuthGuard → OrganizationContextGuard → PermissionGuard
 * （@RequiresPermission("audit.read")：仅 Owner/Admin/Finance 可读；
 * Operator/Viewer 403 PERMISSION_DENIED 并落 DENIED 审计）。
 * 非成员/禁用/不存在统一 404 ORGANIZATION_NOT_FOUND（不泄露存在性）。
 * 本控制器严禁提供任何写/删接口（AUDIT-03.3）。
 */
@ApiTags("Audit")
@ApiBearerAuth()
@ApiExtraModels(AuditLogListDto)
@ApiForbiddenResponse({ description: "403 PERMISSION_DENIED（Operator/Viewer）" })
@Controller("organizations")
@UseGuards(JwtAuthGuard)
export class AuditController {
	constructor(
		@Inject(AuditService) private readonly auditService: AuditService,
	) {}

	@Get("current/audit-logs")
	@OrganizationRoute()
	@UseGuards(OrganizationContextGuard, PermissionGuard)
	@RequiresPermission("audit.read")
	@ApiOperation({
		summary: "当前组织审计日志（只读分页；Owner/Admin/Finance 可读）",
		description:
			"按时间起止/操作者/动作/结果筛选的分页只读查询；无任何写/删接口（AUDIT-03.3）；Operator/Viewer 403 并落 DENIED 审计。",
	})
	@ApiOkResponse({ type: AuditLogListDto })
	async listCurrent(
		@CurrentActor() actor: ActorContext,
		@Query() query: ListAuditLogsQueryDto,
	): Promise<{ success: true; data: AuditLogListDto; message: string }> {
		return {
			success: true,
			data: await this.auditService.listAuditLogs(
				actor.organizationId,
				query,
			),
			message: "查询成功",
		};
	}
}
