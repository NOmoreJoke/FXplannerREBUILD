import { Module } from "@nestjs/common";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";

/**
 * 首次设置模块（M1.1）。
 * PrismaModule 为全局模块，无需重复导入。
 */
@Module({
	controllers: [OnboardingController],
	providers: [OnboardingService],
})
export class OnboardingModule {}
