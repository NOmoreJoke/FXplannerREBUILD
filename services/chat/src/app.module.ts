import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { ScheduleModule } from "@nestjs/schedule";
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
import { ReminderModule } from "./reminder/reminder.module";
import { ReportModule } from "./report/report.module";
import { UsageModule } from "./usage/usage.module";
import { CorrectionModule } from "./correction/correction.module";
import { DataRequestModule } from "./data-request/data-request.module";
import { DataRequestLockGuard } from "./data-request/data-request-lock.guard";
import { AiModule } from "./ai/ai.module";
import { AuditModule } from "./audit/audit.module";
import { AuthorizationModule } from "./authorization/authorization.module";
import { OrganizationModule } from "./organization/organization.module";

@Module({
	imports: [
		ThrottlerModule.forRoot([
			{
				ttl: 60000,
				limit: GLOBAL_THROTTLE_LIMIT,
			},
		]),
		// 定时调度（rate-refresh-cron 技术方案 §3.1）：RateModule 内 RateCronService 整点/半点刷新汇率；
		// 测试环境经 vitest test.env 注入 RATE_CRON_ENABLED=false 防真实外呼（vitest.config.ts）
		ScheduleModule.forRoot(),
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
		ReminderModule,
		ReportModule,
		UsageModule,
		CorrectionModule,
		DataRequestModule,
		// 审计（ToB R1 §13.1）：业务写同事务审计与只读分页，唯一注册点
		AuditModule,
		// ToB R1（技术方案 §4.3）：组织上下文/权限 Guard 与组织 CRUD，唯一注册点
		AuthorizationModule,
		OrganizationModule,
		// AI 助手（ai-assistant 技术方案 §5.1）：ReAct agent 对话，唯一注册点
		AiModule,
	],
	controllers: [AppController],
	providers: [
		{
			provide: APP_GUARD,
			useClass: ThrottlerGuard,
		},
		// 数据请求锁全局守卫（account-data §3.3）：先于控制器守卫执行，
		// 读时惰性推进到期请求并拦截注销/清空期间的端点访问
		{
			provide: APP_GUARD,
			useClass: DataRequestLockGuard,
		},
	],
})
export class AppModule {}
