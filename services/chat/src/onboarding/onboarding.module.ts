import { Logger, Module } from "@nestjs/common";
import { AuthorizationModule } from "../authorization/authorization.module";
import { RateModule } from "../rate/rate.module";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";

/**
 * 首次设置模块（M1.1，onboarding-rework 扩展初始持仓与补录）。
 * PrismaModule 为全局模块，无需重复导入；RateModule 提供初始持仓取价；
 * AuthorizationModule 提供 GET /status 的组织作用域与权限守卫（评审 I-10）。
 * Logger 由 Nest 内置 @Injectable 提供，显式注册供 OnboardingService 注入（可观测性 §7）。
 */
@Module({
	imports: [RateModule, AuthorizationModule],
	controllers: [OnboardingController],
	providers: [OnboardingService, Logger],
})
export class OnboardingModule {}
