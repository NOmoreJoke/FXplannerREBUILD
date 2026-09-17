import { Module } from "@nestjs/common";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";

/**
 * 用户设置模块（onboarding-rework 技术方案 §2.3/§5.1）：常驻偏好读写。
 * PrismaModule 为全局模块，无需重复导入；本模块无外部模块依赖。
 */
@Module({
	controllers: [SettingsController],
	providers: [SettingsService],
})
export class SettingsModule {}
