import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { AuditModule } from "../audit/audit.module";
import { OrganizationContextGuard } from "./guards/organization-context.guard";
import { PermissionGuard } from "./guards/permission.guard";

/**
 * 授权模块（技术方案 §4.3；Goal #3A W17）。
 *
 * 边界（AGENTS.md + eslint 后端模块护栏）：
 * - 仅提供组织上下文/权限 Guard、装饰器、错误族与纯函数策略（策略真源
 *   permission-policy.ts）；不做业务数据读写；
 * - 依赖 Prisma/Auth/Audit，禁止引入业务记账模块；
 * - Guard 以显式 @UseGuards 挂载（JwtAuthGuard → OrganizationContextGuard →
 *   PermissionGuard），不做全局守卫（个人端点不受组织上下文约束）。
 */
@Module({
	imports: [PrismaModule, AuthModule, AuditModule],
	providers: [OrganizationContextGuard, PermissionGuard],
	exports: [OrganizationContextGuard, PermissionGuard],
})
export class AuthorizationModule {}
