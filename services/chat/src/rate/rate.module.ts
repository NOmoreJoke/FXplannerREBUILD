import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { env } from "../config/env";
import { RateCronService, RATE_CRON_ENABLED_TOKEN } from "./rate-cron.service";
import { RateController } from "./rate.controller";
import {
	DEFAULT_RATE_PROVIDER_TIMEOUT_MS,
	RATE_PROVIDER_TIMEOUT_TOKEN,
	RateProvider,
} from "./rate.provider";
import { RateService } from "./rate.service";

@Module({
	imports: [PrismaModule],
	controllers: [RateController],
	providers: [
		RateService,
		RateProvider,
		{
			provide: RATE_PROVIDER_TIMEOUT_TOKEN,
			useValue: DEFAULT_RATE_PROVIDER_TIMEOUT_MS,
		},
		// 汇率定时刷新开关（rate-refresh-cron 技术方案 §3.2）：未设置 = 开启；
		// vitest test.env 注入 "false" 防测试环境真实调度（vitest.config.ts）
		{
			provide: RATE_CRON_ENABLED_TOKEN,
			useValue: env.RATE_CRON_ENABLED !== "false",
		},
		RateCronService,
	],
	exports: [RateService],
})
export class RateModule {}
