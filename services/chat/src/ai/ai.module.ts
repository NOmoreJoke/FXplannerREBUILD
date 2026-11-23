import { Logger, Module } from "@nestjs/common";
import { RateModule } from "../rate/rate.module";
import { AuthorizationModule } from "../authorization/authorization.module";
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
 * AI 助手模块（ai-assistant 技术方案 §5.1）：ReAct agent 对话 + 会话/消息持久化。
 * 依赖 RateModule（唯一工具 query_exchange_rate 包装 RateService）；
 * 在 app.module.ts 唯一注册。AI_RUNTIME_CONFIG 在模块 compile 时从 process.env
 * 解析（而非加载期固化的 env 常量），使集成测试可按 app 实例注入阈值（§8.2 装配③）。
 */
@Module({
	imports: [RateModule, AuthorizationModule],
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
