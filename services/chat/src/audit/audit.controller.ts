import {
	Controller,
	Get,
	Headers,
	Inject,
	Query,
	NotFoundException as NestNotFound,
	BadRequestException as NestBadRequest,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBearerAuth,
	ApiExtraModels,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from "@nestjs/swagger";
import type { User } from "@prisma/client";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "./audit.service";
import { AuditLogListDto, ListAuditLogsQueryDto } from "./dto/audit.dto";

/**
 * 组织审计只读端点（AUDIT-03；Goal #3A W16 建端点，W17 挂统一 Guard 链）。
 *
 * W16 过渡实现：JwtAuthGuard + 内联「x-organization-id ↔ ACTIVE Membership」
 * 校验（非成员/禁用统一 404，不泄露组织存在性）；W17 上线
 * OrganizationContextGuard + PermissionGuard(@RequiresPermission("audit.read"))
 * 后以内联注释声明的语义替换。本控制器严禁提供任何写/删接口（AUDIT-03.3）。
 */
@ApiTags("Audit")
@ApiBearerAuth()
@ApiExtraModels(AuditLogListDto)
@Controller("organizations")
@UseGuards(JwtAuthGuard)
export class AuditController {
	constructor(
		@Inject(AuditService) private readonly auditService: AuditService,
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	@Get("current/audit-logs")
	@ApiOperation({
		summary: "当前组织审计日志（只读分页；Owner/Admin/Finance 可读）",
		description:
			"W16 过渡：组织上下文与 audit.read 权限由内联 ACTIVE Membership 校验兜底，W17 切换统一 Guard 链。",
	})
	@ApiOkResponse({ type: AuditLogListDto })
	async listCurrent(
		@CurrentUser() user: User,
		@Headers("x-organization-id") organizationId: string | undefined,
		@Query() query: ListAuditLogsQueryDto,
	): Promise<AuditLogListDto> {
		if (
			typeof organizationId !== "string" ||
			organizationId.trim().length === 0
		) {
			throw new NestBadRequest({
				success: false,
				code: "ORGANIZATION_REQUIRED",
				message: "缺少组织上下文（X-Organization-Id）",
			});
		}
		const membership = await this.prisma.membership.findUnique({
			where: {
				organizationId_userId: { organizationId, userId: user.id },
			},
			select: { status: true },
		});
		if (!membership || membership.status !== "ACTIVE") {
			// 非成员/已禁用统一 404，不泄露组织存在性（技术方案 §7.1）
			throw new NestNotFound({
				success: false,
				code: "ORGANIZATION_NOT_FOUND",
				message: "组织不存在或无权访问",
			});
		}
		return this.auditService.listAuditLogs(organizationId, query);
	}
}
