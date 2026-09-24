import { describe, expect, it, vi, afterEach } from "vitest";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { ChatOpenAI } from "@langchain/openai";
import {
	AI_LLM_FIRST_TOKEN_TIMEOUT_MS,
	type AiRuntimeConfig,
} from "./ai-runtime-config";
import { createLlmFactory } from "./llm-factory";
import { AiModelUnknownException } from "../ai.errors";
import { AiNotConfiguredException } from "../ai.errors";

/**
 * LLM 工厂单测（ai-model-whitelist 技术方案 §8.1）：
 * 工厂按 modelKey 查白名单构造 ChatOpenAI（key≠上游真实名的解耦、参数随配置、
 * 网关地址取注入的 runtime config、密钥按模型分变量读取、fail-closed、fake 分支）。
 */

afterEach(() => {
	vi.unstubAllEnvs();
});

const baseConfig = (overrides: Partial<AiRuntimeConfig> = {}): AiRuntimeConfig => ({
	aigysdBaseUrl: "https://aigysd.com/v1",
	modelKeyAvailability: {},
	hasConfiguredModel: true,
	chatEnabled: true,
	historyWindow: 20,
	maxConcurrency: 40,
	dailyQuota: 100,
	e2eFakeStream: false,
	e2eFakeIntervalMs: 30,
	...overrides,
});

describe("createLlmFactory（§8.1 ①~⑦）", () => {
	it("① factory(\"gpt-5.5\") 返回 ChatOpenAI 且 model=gpt-5.6-luna（key≠上游名的解耦）", () => {
		vi.stubEnv("AI_PROVIDER_AIGYSD_API_KEY", "sk-test");
		const factory = createLlmFactory(baseConfig());
		const llm = factory("gpt-5.5");
		expect(llm).toBeInstanceOf(ChatOpenAI);
		expect((llm as ChatOpenAI).model).toBe("gpt-5.6-luna");
	});

	it("② temperature/maxTokens 随白名单配置（gpt-5.5 → 0.7 / 8000；gpt-4.1-mini → 4000）", () => {
		vi.stubEnv("AI_PROVIDER_AIGYSD_API_KEY", "sk-test");
		const factory = createLlmFactory(baseConfig());
		const gpt55 = factory("gpt-5.5") as ChatOpenAI;
		expect(gpt55.temperature).toBe(0.7);
		expect(gpt55.maxTokens).toBe(8000);
		const mini = factory("gpt-4.1-mini") as ChatOpenAI;
		expect(mini.maxTokens).toBe(4000);
		// 首字超时与流式开关沿既有约定
		expect(gpt55.timeout).toBe(AI_LLM_FIRST_TOKEN_TIMEOUT_MS);
		expect(gpt55.streaming).toBe(true);
	});

	it("③ baseURL 来自注入的 runtime config.aigysdBaseUrl；未配时不传 configuration", () => {
		vi.stubEnv("AI_PROVIDER_AIGYSD_API_KEY", "sk-test");
		const withUrl = createLlmFactory(
			baseConfig({ aigysdBaseUrl: "https://gateway.example.com/v1" }),
		);
		expect((withUrl("gpt-4.1") as ChatOpenAI).clientConfig.baseURL).toBe(
			"https://gateway.example.com/v1",
		);

		const withoutUrl = createLlmFactory(baseConfig({ aigysdBaseUrl: undefined }));
		expect((withoutUrl("gpt-4.1") as ChatOpenAI).clientConfig.baseURL).toBeUndefined();
	});

	it("④ 密钥从条目 apiKeyEnvName 对应变量读取（claude 走 ANTHROPIC 专用变量）", () => {
		vi.stubEnv("AI_PROVIDER_AIGYSD_ANTHROPIC_API_KEY", "sk-claude");
		const factory = createLlmFactory(baseConfig());
		expect((factory("claude-sonnet-4-6") as ChatOpenAI).apiKey).toBe("sk-claude");
	});

	it("⑤ 非法 key 抛 AiModelUnknownException（fail-closed，工厂兜底同 gate 规则）", () => {
		vi.stubEnv("AI_PROVIDER_AIGYSD_API_KEY", "sk-test");
		const factory = createLlmFactory(baseConfig());
		expect(() => factory("gpt-4o")).toThrow(AiModelUnknownException);
	});

	it("⑥ 白名单 key 但密钥缺失抛 AiNotConfiguredException（TOCTOU 兑底路径）", () => {
		vi.stubEnv("AI_PROVIDER_AIGYSD_GEMINI_API_KEY", undefined);
		const factory = createLlmFactory(baseConfig());
		expect(() => factory("gemini-3-flash-preview")).toThrow(
			AiNotConfiguredException,
		);
	});

	it("⑦ fake 分支无视 modelKey 返回 FakeStreamingChatModel（E2E 不外呼语义不变）", () => {
		const factory = createLlmFactory(baseConfig({ e2eFakeStream: true }));
		for (const modelKey of ["gpt-4.1", "claude-sonnet-4-6", "gpt-4o"]) {
			expect(factory(modelKey)).toBeInstanceOf(FakeStreamingChatModel);
		}
	});
});
