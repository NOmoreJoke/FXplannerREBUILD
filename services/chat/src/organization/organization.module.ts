import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { AuditModule } from "../audit/audit.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { OrganizationController } from "./organization.controller";
import { OrganizationService } from "./organization.service";

/**
 * 组织模块（技术方案 §4.1/§7.2；Goal #3A W17）：
 * 组织、成员、邀请、组织切换视图与默认组织回填逻辑的唯一归属。
 * W17 交付组织 CRUD 与当前组织视图；成员/邀请/审计端点见 W19/audit 模块。
 */
@Module({
	imports: [PrismaModule, AuthModule, AuditModule, AuthorizationModule],
	controllers: [OrganizationController],
	providers: [OrganizationService],
	exports: [OrganizationService],
})
export class OrganizationModule {}
