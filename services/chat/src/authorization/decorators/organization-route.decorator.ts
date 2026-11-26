import { SetMetadata } from "@nestjs/common";

/**
 * 组织路由标记装饰器（技术方案 §4.3；Goal #3A W17）：
 * 标注该路由族为「组织上下文路由」，供文档生成与前端契约识别——
 * 个人端点（/auth/me、组织列表、邀请接受）不标注、不挂组织 Guard。
 * 元数据本身不改变行为；守卫链仍由 @UseGuards 显式声明。
 *
 * W30（MIG-D）：兼容窗口逻辑已删除，本装饰器不再参与任何请求期判定。
 */
export const ORGANIZATION_ROUTE_KEY = "organizationRoute";

export const OrganizationRoute = () => SetMetadata(ORGANIZATION_ROUTE_KEY, true);
