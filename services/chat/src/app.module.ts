import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { AppController } from "./app.controller";
import { PrismaModule } from "./prisma/prisma.module";
import { RateModule } from "./rate/rate.module";
import { CurrencyModule } from "./currency/currency.module";
import { AuthModule } from "./auth/auth.module";
import { HomeModule } from "./home/home.module";
// 全局限流（次/分钟）：默认 10；E2E 集中造数经 THROTTLE_GLOBAL_LIMIT 放大
const GLOBAL_THROTTLE_LIMIT = Number(process.env.THROTTLE_GLOBAL_LIMIT ?? 10);

import { OnboardingModule } from "./onboarding/onboarding.module";
import { PlanModule } from "./plan/plan.module";
import { TransactionModule } from "./transaction/transaction.module";
import { AccountModule } from "./account/account.module";
import { SettingsModule } from "./settings/settings.module";

@Module({
	imports: [
		ThrottlerModule.forRoot([
			{
				ttl: 60000,
				limit: GLOBAL_THROTTLE_LIMIT,
			},
		]),
		PrismaModule,
		AuthModule,
		OnboardingModule,
		HomeModule,
		PlanModule,
		RateModule,
		CurrencyModule,
		TransactionModule,
		AccountModule,
		SettingsModule,
	],
	controllers: [AppController],
	providers: [
		{
			provide: APP_GUARD,
			useClass: ThrottlerGuard,
		},
	],
})
export class AppModule {}
