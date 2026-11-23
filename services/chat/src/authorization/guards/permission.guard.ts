import {
	type CanActivate,
	type ExecutionContext,
	Inject,
	Injectable,
	Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuditService } from "../../audit/audit.service";
import type { RequestWithActor } from "./organization-context.guard";
import { REQUIRES_PERMISSION_KEY } from "../decorators/requires-permission.decorator";
import { can } from "../permission-policy";
import type { Permission } from "../authorization.types";
import { PermissionDeniedException } from "../authorization.errors";

/**
 * 权限守卫（技术方案 §4.3 / §6.3；Goal #3A W17）。
 *
 * 职责：
 * 1. 读取 @RequiresPermission 元数据（无标注 → 直接放行，个人端点不受限）；
 * 2. 调用集中策略 can(actor.role, permission)——不接受客户端 role；
 * 3. 拒绝时写独立 DENIED 审计（recordStandalone：纯读拒绝场景）并抛
 *    403 PERMISSION_DENIED；审计写失败不掩盖 403（审计尽力而为）。
 *
 * 挂载顺序：@UseGuards(JwtAuthGuard, OrganizationContextGuard, PermissionGuard)。
 */
@Injectable()
export class PermissionGuard implements CanActivate {
	private readonly logger = new Logger(PermissionGuard.name);

	constructor(
		@Inject(Reflector) private readonly reflector: Reflector,
		@Inject(AuditService) private readonly auditService: AuditService,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const required = this.reflector.getAllAndOverride<Permission>(
			REQUIRES_PERMISSION_KEY,
			[context.getHandler(), context.getClass()],
		);
		if (!required) {
			return true; // 未标注权限点的路由不受权限约束
		}

		const request = context.switchToHttp().getRequest<RequestWithActor>();
		const actor = request.actor;
		// 权限判定必须基于组织上下文；actor 缺失属装配错误，fail-closed 拒绝
		if (!actor) {
			throw new PermissionDeniedException("组织上下文缺失，拒绝授权");
		}
		if (can(actor.role, required)) {
			return true;
		}

		// DENIED 审计（尽力而为：审计异常不掩盖 403；仅纯读拒绝场景，独立写）
		try {
			await this.auditService.recordStandalone({
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				actorType: "USER",
				action: `permission.denied.${required}`,
				result: "DENIED",
				detail: { required, role: actor.role },
			});
		} catch (error) {
			this.logger.warn(
				`DENIED 审计写入失败（不影响 403 返回）: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		throw new PermissionDeniedException();
	}
}
