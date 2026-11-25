import { Logger, Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { RateModule } from "../rate/rate.module";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";

/**
 * 首次设置模块（M1.1，onboarding-rework 扩展初始持仓与补录；ToB R1 W22 组织独立建账）。
 * PrismaModule 为全局模块，无需重复导入；RateModule 提供初始持仓取价；
 * AuditModule 提供建账/补录同事务审计；AuthorizationModule 提供组织作用域与权限守卫。
 * Logger 由 Nest 内置 @Injectable 提供，显式注册供 OnboardingService 注入（可观测性 §7）。
 */
@Module({
	imports: [RateModule, AuthorizationModule, AuditModule],
	controllers: [OnboardingController],
	providers: [OnboardingService, Logger],
})
export class OnboardingModule {}
