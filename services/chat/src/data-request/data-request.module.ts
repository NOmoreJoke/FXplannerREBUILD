import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { ORGANIZATION_LOCK_RESOLVER } from "../authorization/guards/organization-lock.guard";
import { DataRequestController } from "./data-request.controller";
import { OrganizationDataRequestController } from "./organization-data-request.controller";
import { DataRequestService } from "./data-request.service";
import { PersonalAccountLockGuard } from "./personal-account-lock.guard";
import { DataRequestOrganizationLockResolver } from "./organization-lock-resolver";

/**
 * 数据权利请求模块（account-data 技术方案 §9；ToB R1 技术方案 §9；Goal #3B W27）。
 *
 * 双域物理拆分：
 * - 个人域：`/api/data-requests/*`（DataRequestController，仅 JwtAuthGuard）；
 * - 组织域：`/api/organizations/current/data-requests/*`
 *   （OrganizationDataRequestController，JwtAuthGuard → OrganizationContextGuard →
 *   OrganizationLockGuard → PermissionGuard）。
 *
 * 锁守卫两套：
 * - PersonalAccountLockGuard：全局 APP_GUARD（AppModule 引用类注册），
 *   只看本人名下 PERSONAL DELETION，绝不锁同组织其他成员；
 * - OrganizationLockGuard：按端点显式挂载（在组织上下文守卫之后、权限守卫之前），
 *   只看当前组织的 ORGANIZATION CLEAR / DELETION——守卫与契约在 authorization/
 *   （横切能力：audit 等模块也须挂载，且禁止引入业务记账模块），真实判定实现在
 *   本模块（DataRequestOrganizationLockResolver），经全局模块导出后注入。
 *
 * @Global：与 AuditModule 同理——@UseGuards 按类引用时守卫在**控制器所在模块**
 * 实例化（各业务模块），其锁解析器依赖须全局可解析；否则未 import 本模块的
 * 业务模块会在启动时报「Nest can't resolve dependencies of the
 * OrganizationLockGuard」。业务模块无需逐个 import。
 */
@Global()
@Module({
	imports: [PrismaModule, AuthModule, AuthorizationModule],
	controllers: [DataRequestController, OrganizationDataRequestController],
	providers: [
		DataRequestService,
		PersonalAccountLockGuard,
		DataRequestOrganizationLockResolver,
		{
			provide: ORGANIZATION_LOCK_RESOLVER,
			useExisting: DataRequestOrganizationLockResolver,
		},
	],
	exports: [DataRequestService, ORGANIZATION_LOCK_RESOLVER],
})
export class DataRequestModule {}
