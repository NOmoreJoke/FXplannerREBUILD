import { SetMetadata } from "@nestjs/common";
import type { Permission } from "../authorization.types";

/**
 * 权限点装饰器（技术方案 §4.3 / §6.1；Goal #3A W17）：
 * Controller/handler 标注所需权限点，PermissionGuard 读取元数据并调用
 * 集中策略 can(actor.role, permission)；策略真源在 permission-policy.ts，
 * 本装饰器不携带角色判断逻辑。
 */
export const REQUIRES_PERMISSION_KEY = "requiresPermission";

export const RequiresPermission = (permission: Permission) =>
	SetMetadata(REQUIRES_PERMISSION_KEY, permission);
