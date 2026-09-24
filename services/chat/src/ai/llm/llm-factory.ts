import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { ChatOpenAI } from "@langchain/openai";
import {
	AI_LLM_FIRST_TOKEN_TIMEOUT_MS,
	type AiRuntimeConfig,
} from "./ai-runtime-config";
import {
	resolveChatModelConfig,
	resolveProviderApiKey,
} from "../ai-models.config";
import { AiNotConfiguredException } from "../ai.errors";

/**
 * LLM 工厂（ai-assistant 技术方案 §5.1 + ai-model-whitelist 技术方案 §3.5）。
 *
 * DI token AI_LLM_FACTORY 是集成测试的 override 点（§8.2 装配约定①）：
 * 真实现按 modelKey 查白名单构造 ChatOpenAI（temperature/maxTokens/密钥变量随模型配置，
 * 统一网关地址取 runtime config.aigysdBaseUrl）；AI_E2E_FAKE_STREAM=true 时无视
 * modelKey 切换官方 FakeStreamingChatModel 假流式模型，不外呼（E2E 场景专用，
 * production 由 env refine 强制关闭）。
 *
 * 密钥解析在此仅为兜底（TOCTOU 极小窗口）：gate 预检已挡住未配场景（prepareChat
 * 快照 modelKeyAvailability），此处失败由 controller 的 SSE 异常路径以 error 帧
 * AI_UPSTREAM_FAILED 固定文案收尾，不泄配置细节。
 * 工厂每次 create 返回新实例（agent 每请求组装，无跨请求状态）。
 */

export const AI_LLM_FACTORY = Symbol("AI_LLM_FACTORY");

export type AiLlmFactory = (modelKey: string) => BaseChatModel;

/** E2E 假流式模型的固定回复（含换行，供流式帧协议验证） */
export const E2E_FAKE_REPLY =
	"这是来自 FXPlanner 假流式模型的测试回复。\n第二行内容用于验证多行流式输出。";

export function createLlmFactory(config: AiRuntimeConfig): AiLlmFactory {
	if (config.e2eFakeStream) {
		return () =>
			new FakeStreamingChatModel({
				sleep: config.e2eFakeIntervalMs,
				responses: [new AIMessage(E2E_FAKE_REPLY)] as BaseMessage[],
			});
	}
	return (modelKey: string) => {
		const modelConfig = resolveChatModelConfig(modelKey);
		const apiKey = resolveProviderApiKey(modelConfig.apiKeyEnvName);
		if (!apiKey) {
			// 兑底路径：gate 快照预检后密钥被回收等极小窗口（§3.5），按未配置降级
			throw new AiNotConfiguredException();
		}
		return new ChatOpenAI({
			model: modelConfig.model,
			apiKey,
			temperature: modelConfig.temperature,
			maxTokens: modelConfig.maxTokens,
			configuration: config.aigysdBaseUrl
				? { baseURL: config.aigysdBaseUrl }
				: undefined,
			maxRetries: 1,
			timeout: AI_LLM_FIRST_TOKEN_TIMEOUT_MS,
			streaming: true,
		});
	};
}
