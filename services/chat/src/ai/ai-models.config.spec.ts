import { describe, expect, it, vi, afterEach } from "vitest";
import {
	CHAT_MODELS,
	listChatModels,
	resolveChatModelConfig,
	resolveDefaultChatModelKey,
	resolveProviderApiKey,
} from "./ai-models.config";
import { AiModelUnknownException } from "./ai.errors";

/**
 * 白名单配置单测（ai-model-whitelist 技术方案 §8.1）：
 * 测白名单不变量（封闭集合、专用密钥绑定、投影纪律、fail-closed、启动断言），
 * 不测条目数值本身（costTier/temperature 等在 config 文件内自明）。
 */

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("CHAT_MODELS 白名单不变量（§8.1 ①~④）", () => {
	it("① 白名单恰为 5 个 key，与 LingJi 逐一对应", () => {
		expect(Object.keys(CHAT_MODELS).sort()).toEqual(
			[
				"gpt-4.1",
				"gpt-4.1-mini",
				"gpt-5.5",
				"claude-sonnet-4-6",
				"gemini-3-flash-preview",
			].sort(),
		);
	});

	it("② key 唯一（Record 结构保证）、displayName 唯一", () => {
		const displayNames = Object.values(CHAT_MODELS).map(
			(config) => config.displayName,
		);
		expect(new Set(displayNames).size).toBe(displayNames.length);
	});

	it("③ claude/gemini 分别绑定 ANTHROPIC/GEMINI 专用 apiKeyEnvName（LingJi 同款断言）", () => {
		expect(CHAT_MODELS["claude-sonnet-4-6"].apiKeyEnvName).toBe(
			"AI_PROVIDER_AIGYSD_ANTHROPIC_API_KEY",
		);
		expect(CHAT_MODELS["gemini-3-flash-preview"].apiKeyEnvName).toBe(
			"AI_PROVIDER_AIGYSD_GEMINI_API_KEY",
		);
		// 三个 GPT 模型共用主渠道密钥
		expect(CHAT_MODELS["gpt-4.1"].apiKeyEnvName).toBe(
			"AI_PROVIDER_AIGYSD_API_KEY",
		);
		expect(CHAT_MODELS["gpt-4.1-mini"].apiKeyEnvName).toBe(
			"AI_PROVIDER_AIGYSD_API_KEY",
		);
		expect(CHAT_MODELS["gpt-5.5"].apiKeyEnvName).toBe(
			"AI_PROVIDER_AIGYSD_API_KEY",
		);
	});

	it("④ 全部条目 costTier ∈ 1..5 且经 zod 校验通过（模块加载期已 parse）", () => {
		for (const config of Object.values(CHAT_MODELS)) {
			expect(config.costTier).toBeGreaterThanOrEqual(1);
			expect(config.costTier).toBeLessThanOrEqual(5);
		}
	});
});

describe("resolveChatModelConfig（§8.1 ⑤ fail-closed）", () => {
	it("合法 key 返回带 key 的完整配置；非法/变形 key（大小写、空白、近似、中文）一律抛 AiModelUnknownException", () => {
		const resolved = resolveChatModelConfig("gpt-4.1-mini");
		expect(resolved.key).toBe("gpt-4.1-mini");
		expect(resolved.model).toBe("gpt-4.1-mini");

		for (const bad of [
			"GPT-4.1-MINI", // 大小写变形
			" gpt-4.1-mini", // 前导空白
			"gpt-4.1-mini ", // 尾随空白
			"gpt-41-mini", // 近似 key
			"gpt-4o", // 已下线模型
			"模型", // 中文
		]) {
			expect(() => resolveChatModelConfig(bad)).toThrow(
				AiModelUnknownException,
			);
		}
	});
});

describe("listChatModels 投影纪律（§8.1 ⑥）", () => {
	it("按 costTier 升序；序列化结果不含 apiKeyEnvName/model/temperature/maxTokens 字样", () => {
		const items = listChatModels();
		expect(items.map((item) => item.costTier)).toEqual(
			[...items.map((item) => item.costTier)].sort((a, b) => a - b),
		);

		const serialized = JSON.stringify(items);
		expect(serialized).not.toContain("apiKeyEnvName");
		expect(serialized).not.toContain("temperature");
		expect(serialized).not.toContain("maxTokens");
		// 上游真实名不外泄（gpt-5.5 的 key ≠ gpt-5.6-luna）
		expect(serialized).not.toContain("gpt-5.6-luna");

		// 展示字段齐全
		expect(items.map((item) => item.key)).toContain("gemini-3-flash-preview");
		for (const item of items) {
			expect(item).toHaveProperty("displayName");
			expect(item).toHaveProperty("provider");
			expect(item).toHaveProperty("capabilities");
			expect(item).toHaveProperty("icon");
			expect(item).toHaveProperty("description");
		}
	});
});

describe("resolveProviderApiKey（§8.1 ⑦）", () => {
	it("空串归 undefined；未定义归 undefined；非空原样返回", () => {
		expect(
			resolveProviderApiKey("AI_PROVIDER_AIGYSD_API_KEY", {
				AI_PROVIDER_AIGYSD_API_KEY: "",
			} as NodeJS.ProcessEnv),
		).toBeUndefined();
		expect(
			resolveProviderApiKey("AI_PROVIDER_AIGYSD_API_KEY", {
				AI_PROVIDER_AIGYSD_API_KEY: undefined,
			} as NodeJS.ProcessEnv),
		).toBeUndefined();
		expect(
			resolveProviderApiKey("AI_PROVIDER_AIGYSD_API_KEY", {
				AI_PROVIDER_AIGYSD_API_KEY: "sk-test",
			} as NodeJS.ProcessEnv),
		).toBe("sk-test");
	});
});

describe("默认模型启动断言（§8.1 ⑧，vi.resetModules + 动态 import）", () => {
	it("AI_DEFAULT_CHAT_MODEL 指向不存在 key：模块加载期 throw（fail-fast，防 env 与白名单漂移）", async () => {
		vi.stubEnv("AI_DEFAULT_CHAT_MODEL", "gpt-4o");
		vi.resetModules();
		await expect(import("./ai-models.config")).rejects.toThrow(
			/AI_DEFAULT_CHAT_MODEL=gpt-4o/,
		);
	});

	it("AI_DEFAULT_CHAT_MODEL 合法覆盖：加载成功且默认锚点生效", async () => {
		vi.stubEnv("AI_DEFAULT_CHAT_MODEL", "gpt-4.1");
		vi.resetModules();
		const mod = await import("./ai-models.config");
		expect(mod.resolveDefaultChatModelKey()).toBe("gpt-4.1");
	});

	it("未设置 AI_DEFAULT_CHAT_MODEL：兜底 gpt-4.1-mini（与 config/env.ts 默认值双处同步）", () => {
		vi.stubEnv("AI_DEFAULT_CHAT_MODEL", undefined);
		expect(resolveDefaultChatModelKey()).toBe("gpt-4.1-mini");
	});
});
