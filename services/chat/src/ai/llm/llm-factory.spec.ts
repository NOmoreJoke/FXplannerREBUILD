import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { AiModelUnknownException, AiNotConfiguredException } from "../ai.errors";
import {
	AI_LLM_FIRST_TOKEN_TIMEOUT_MS,
	type AiRuntimeConfig,
} from "./ai-runtime-config";
import {
	E2E_FAKE_REPLY,
	E2eFakeAgentChatModel,
	createLlmFactory,
} from "./llm-factory";

/**
 * LLM 工厂单测（ai-model-whitelist 技术方案 §8.1 + ToB R2 §14.3）：
 * 工厂按 modelKey 查白名单构造 ChatOpenAI，并在 AI_E2E_FAKE_STREAM=true 时切换
 * E2eFakeAgentChatModel（兼容 14-ai-chat 固定回复，并支持 [R2-E2E] 真实 ReAct 工具调用）。
 */

afterEach(() => {
	vi.unstubAllEnvs();
});

const baseConfig = (overrides: Partial<AiRuntimeConfig> = {}): AiRuntimeConfig => ({
	aigysdBaseUrl: "https://aigysd.com/v1",
	modelKeyAvailability: {},
	hasConfiguredModel: true,
	chatEnabled: true,
	orgToolsEnabled: true,
	historyWindow: 20,
	maxConcurrency: 40,
	dailyQuota: 100,
	e2eFakeStream: false,
	e2eFakeIntervalMs: 1,
	...overrides,
});

describe("createLlmFactory（§8.1 ①~⑦ + R2 Fake ReAct）", () => {
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
		expect(
			(withoutUrl("gpt-4.1") as ChatOpenAI).clientConfig.baseURL,
		).toBeUndefined();
	});

	it("④ 密钥从条目 apiKeyEnvName 对应变量读取（claude 走 ANTHROPIC 专用变量）", () => {
		vi.stubEnv("AI_PROVIDER_AIGYSD_ANTHROPIC_API_KEY", "sk-claude");
		const factory = createLlmFactory(baseConfig());
		expect((factory("claude-sonnet-4-6") as ChatOpenAI).apiKey).toBe("sk-claude");
	});

	it("⑤ 非法 key 抛 AiModelUnknownException（fail-closed）", () => {
		vi.stubEnv("AI_PROVIDER_AIGYSD_API_KEY", "sk-test");
		const factory = createLlmFactory(baseConfig());
		expect(() => factory("gpt-4o")).toThrow(AiModelUnknownException);
	});

	it("⑥ 白名单 key 但密钥缺失抛 AiNotConfiguredException（TOCTOU 兜底路径）", () => {
		vi.stubEnv("AI_PROVIDER_AIGYSD_GEMINI_API_KEY", undefined);
		const factory = createLlmFactory(baseConfig());
		expect(() => factory("gemini-3-flash-preview")).toThrow(
			AiNotConfiguredException,
		);
	});

	it("⑦ fake 分支无视 modelKey 返回 E2eFakeAgentChatModel，普通提问保持 E2E_FAKE_REPLY 原语义", async () => {
		const factory = createLlmFactory(
			baseConfig({ e2eFakeStream: true, e2eFakeIntervalMs: 1 }),
		);
		for (const modelKey of ["gpt-4.1", "claude-sonnet-4-6", "gpt-4o"]) {
			expect(factory(modelKey)).toBeInstanceOf(E2eFakeAgentChatModel);
		}
		const llm = factory("gpt-4.1-mini");
		const result = await llm._generate([new HumanMessage("你好")], {});
		expect(result.generations[0]?.text).toBe(E2E_FAKE_REPLY);
	});

	it("⑧ E2eFakeAgentChatModel 对 [R2-E2E] 触发真实 ReAct 工具环并忠实汇总 ToolMessage", async () => {
		const llm = new E2eFakeAgentChatModel(1);
		const accountTool = tool(
			async () =>
				JSON.stringify({
					kind: "organization_fact",
					source: "account_summary",
					empty: false,
					accounts: [
						{
							currencyCode: "USD",
							balance: "10000.0000",
							allocatedAmount: "2000.0000",
							unallocatedAmount: "8000.0000",
						},
					],
				}),
			{
				name: "get_account_summary",
				description: "mock account summary",
				schema: z.object({}).strict(),
			},
		);

		const agent = createReactAgent({ llm, tools: [accountTool] });
		const events = await agent.streamEvents(
			{ messages: [new HumanMessage("[R2-E2E] 查询当前账户持仓")] },
			{ version: "v2" },
		);

		let full = "";
		let sawToolStart = false;
		for await (const event of events) {
			if (event.event === "on_tool_start" && event.name === "get_account_summary") {
				sawToolStart = true;
			}
			if (event.event === "on_chat_model_stream") {
				const text = (event.data as { chunk?: { content?: unknown } }).chunk
					?.content;
				if (typeof text === "string") full += text;
			}
		}
		expect(sawToolStart).toBe(true);
		expect(full).toContain("USD 余额 10000.0000");

		// 拒绝消息同样透传 error code
		const denied = await llm._generate(
			[
				new HumanMessage("[R2-E2E] 起草换汇计划草稿"),
				new ToolMessage({
					tool_call_id: "call_1",
					content: JSON.stringify({
						error: "PERMISSION_DENIED",
						message: "当前角色无权起草",
					}),
				}),
			],
			{},
		);
		expect(denied.generations[0]?.text).toContain("PERMISSION_DENIED");
	});
});
