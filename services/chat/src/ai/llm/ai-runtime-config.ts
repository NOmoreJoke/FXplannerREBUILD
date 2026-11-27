import { CHAT_MODELS, resolveProviderApiKey } from "../ai-models.config";

/**
 * AI 运行时配置（ai-assistant 技术方案 §3.3 + ai-model-whitelist 技术方案 §3.4）。
 *
 * 为什么不用 config/env 的 env 常量：env 在模块加载期解析并固化，集成测试需要
 * 按 app 实例注入不同阈值（并发 1 / 配额 2 / 无 key / 开关关，§8.2 装配约定③）；
 * 本模块的 DI provider（AI_RUNTIME_CONFIG）在模块 compile 时才执行 resolve，
 * 读 process.env 即可被测试的「注入 → 建 app → 恢复」手法覆盖
 * （先例：rate.constants resolveRateSourceMode 同款「便于测试按实例注入」设计）。
 *
 * zod schema（config/env.ts）仍是启动期 fail-fast 校验的唯一权威；
 * 两处默认值必须保持一致（env.ts 注释已同步标注）。
 */
export interface AiRuntimeConfig {
	/** 统一网关地址（aigysd OpenAI 兼容端点；未配时 ChatOpenAI 走官方默认端点） */
	aigysdBaseUrl?: string;
	/**
	 * 各模型密钥可用性快照（resolve 期遍历白名单逐模型解析）。快照而非请求期惰性
	 * 读取：集成测试在 beforeAll 建 app 后即恢复 env，请求期读 process.env 会失真；
	 * 快照手法与原 assertChatAvailable 读 config.llmApiKey 同源。
	 */
	modelKeyAvailability: Record<string, boolean>;
	/** 派生：任一模型密钥可用（全部未配 → 全部端点 503 AI_NOT_CONFIGURED） */
	hasConfiguredModel: boolean;
	chatEnabled: boolean;
	/** 组织 Agent 工具独立降级开关（false 时禁用组织只读与草稿工具，保留公共汇率查询） */
	orgToolsEnabled: boolean;
	historyWindow: number;
	maxConcurrency: number;
	dailyQuota: number;
	e2eFakeStream: boolean;
	e2eFakeIntervalMs: number;
}

/** AI_LLM_FACTORY 真实现的 LLM 首字超时（§6：LLM 首字 30s） */
export const AI_LLM_FIRST_TOKEN_TIMEOUT_MS = 30_000;

const orUndefined = (value: string | undefined): string | undefined =>
	value === "" || value === undefined ? undefined : value;

const positiveInt = (value: string | undefined, fallback: number): number => {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const nonNegativeInt = (
	value: string | undefined,
	fallback: number,
): number => {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

export const AI_RUNTIME_CONFIG = Symbol("AI_RUNTIME_CONFIG");

export function resolveAiRuntimeConfig(
	source: NodeJS.ProcessEnv = process.env,
): AiRuntimeConfig {
	// 密钥可用性快照：遍历白名单，逐模型按 apiKeyEnvName 解析（ai-model-whitelist §3.4）
	const modelKeyAvailability: Record<string, boolean> = Object.fromEntries(
		Object.entries(CHAT_MODELS).map(([key, config]) => [
			key,
			resolveProviderApiKey(config.apiKeyEnvName, source) !== undefined,
		]),
	);
	return {
		aigysdBaseUrl: orUndefined(source.AI_PROVIDER_AIGYSD_BASE_URL),
		modelKeyAvailability,
		hasConfiguredModel: Object.values(modelKeyAvailability).some(Boolean),
		chatEnabled: source.AI_CHAT_ENABLED !== "false",
		orgToolsEnabled: source.AI_ORG_TOOLS_ENABLED !== "false",
		historyWindow: positiveInt(source.AI_CHAT_HISTORY_WINDOW, 20),
		maxConcurrency: positiveInt(source.AI_CHAT_MAX_CONCURRENCY, 40),
		dailyQuota: positiveInt(source.AI_DAILY_MESSAGE_QUOTA, 100),
		e2eFakeStream: source.AI_E2E_FAKE_STREAM === "true",
		e2eFakeIntervalMs: nonNegativeInt(source.AI_E2E_FAKE_INTERVAL_MS, 30),
	};
}
