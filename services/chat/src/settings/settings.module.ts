import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";

/**
 * 用户与组织设置模块（onboarding-rework 技术方案 §2.3/§5.1；ToB R1 W22 个人/组织分离）：
 * PrismaModule 为全局模块，无需重复导入；AuditModule 提供组织偏好修改同事务审计与越权拒绝审计。
 */
@Module({
	imports: [AuditModule, AuthorizationModule],
	controllers: [SettingsController],
	providers: [SettingsService],
})
export class SettingsModule {}
