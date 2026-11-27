import { Logger, Module } from "@nestjs/common";
import { AccountModule } from "../account/account.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { PlanModule } from "../plan/plan.module";
import { RateModule } from "../rate/rate.module";
import { ReminderModule } from "../reminder/reminder.module";
import { ReportModule } from "../report/report.module";
import { AiAgentService } from "./ai-agent.service";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";
import { ConcurrencySemaphore } from "./ai-concurrency-semaphore";
import {
	resolveAiRuntimeConfig,
	AI_RUNTIME_CONFIG,
} from "./llm/ai-runtime-config";
import { AI_LLM_FACTORY, createLlmFactory } from "./llm/llm-factory";

/**
 * AI 助手模块（ai-assistant 技术方案 §5.1 + ToB R2 §8）：
 * ReAct agent 对话 + 会话/消息持久化 + 公共汇率与组织只读/计划草稿工具；
 * 在 app.module.ts 唯一注册。单向依赖 Account/Plan/Report/Reminder/Rate/Authorization，
 * 业务模块严禁反向依赖 ai/（eslint 护栏强制）。
 */
@Module({
	imports: [
		RateModule,
		AuthorizationModule,
		AccountModule,
		PlanModule,
		ReportModule,
		ReminderModule,
	],
	controllers: [AiController],
	providers: [
		AiService,
		AiAgentService,
		// Logger 由 Nest 内置 @Injectable 提供，显式注册供 Service 注入（correction.module 先例）
		Logger,
		{
			provide: AI_RUNTIME_CONFIG,
			useFactory: () => resolveAiRuntimeConfig(),
		},
		{
			provide: ConcurrencySemaphore,
			useFactory: (config: ReturnType<typeof resolveAiRuntimeConfig>) =>
				new ConcurrencySemaphore(config.maxConcurrency),
			inject: [AI_RUNTIME_CONFIG],
		},
		{
			provide: AI_LLM_FACTORY,
			useFactory: (config: ReturnType<typeof resolveAiRuntimeConfig>) =>
				createLlmFactory(config),
			inject: [AI_RUNTIME_CONFIG],
		},
	],
	exports: [],
})
export class AiModule {}
