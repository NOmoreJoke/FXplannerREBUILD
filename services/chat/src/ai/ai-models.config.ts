import { z } from "zod";
import { AiModelUnknownException } from "./ai.errors";

/**
 * 聊天模型白名单（ai-model-whitelist 技术方案 §3.3）：模块级唯一事实源。
 * 与 LingJi ai-models.config.ts 同构（模型 key、上游真实名、密钥变量、costTier 逐项对齐，
 * 裁剪生图模型与 baseURL 字段）；与 LingJi 的两处有意识差异（§2.2 #3）：
 * - 非法 modelKey 不静默回退，resolveChatModelConfig 精确查找 fail-closed 抛 400；
 * - 条目不含 baseURL——五模型共用一个网关地址，由 AI_RUNTIME_CONFIG.aigysdBaseUrl
 *   统一供给（避免模块加载期固化 env 常量，违反「测试按实例注入」装配纪律）。
 *
 * 密钥纪律：apiKeyEnvName / model（上游真实名）/ temperature / maxTokens 只在本模块
 * 与工厂内部使用，listChatModels() 投影绝不外泄（§1.3）。
 */

/** 单模型配置（zod 校验后的形状；key 为对外白名单 key，与 CHAT_MODELS 的键一致） */
export interface ChatModelConfig {
	provider: "openai";
	/** 上游真实模型名（可与 key 解耦，如 gpt-5.5 → gpt-5.6-luna） */
	model: string;
	capabilities: "chat"[];
	/** 密钥所在 env 变量名（按上游模型分变量） */
	apiKeyEnvName: string;
	temperature: number;
	maxTokens: number;
	/** 成本档位 1（最省）~5（最贵），列表接口按此升序 */
	costTier: number;
	displayName: string;
	description: string;
	icon: string;
}

/** 带白名单 key 的完整配置（resolveChatModelConfig 返回；key 为服务端权威值，落库/done 帧以此为准） */
export type ResolvedChatModelConfig = ChatModelConfig & { key: string };

/** 列表接口响应子集（§4.1：不含 apiKeyEnvName/model/temperature/maxTokens） */
export interface ChatModelSummary {
	key: string;
	displayName: string;
	provider: string;
	capabilities: string[];
	costTier: number;
	icon: string;
	description: string;
}

/** 条目 schema（LingJi ChatModelConfigSchema 裁剪版；模块加载期逐条 parse，fail-fast） */
const ChatModelConfigSchema = z.object({
	provider: z.literal("openai"),
	model: z.string().min(1),
	capabilities: z.array(z.literal("chat")).min(1),
	apiKeyEnvName: z.string().min(1),
	temperature: z.number().min(0).max(2),
	maxTokens: z.number().int().positive(),
	costTier: z.number().int().min(1).max(5),
	displayName: z.string().min(1),
	description: z.string().min(1),
	icon: z.string().min(1),
});

/** 白名单（封闭集合，新增模型 = 加一个条目；密钥按上游模型分变量） */
const CHAT_MODEL_ENTRIES: Record<string, ChatModelConfig> = {
	"gpt-4.1": {
		provider: "openai",
		model: "gpt-4.1",
		capabilities: ["chat"],
		apiKeyEnvName: "AI_PROVIDER_AIGYSD_API_KEY",
		temperature: 0.7,
		maxTokens: 8000,
		costTier: 3,
		displayName: "GPT-4.1",
		description: "标准旗舰模型，适合复杂推理",
		icon: "🧠",
	},
	"gpt-4.1-mini": {
		provider: "openai",
		model: "gpt-4.1-mini",
		capabilities: ["chat"],
		apiKeyEnvName: "AI_PROVIDER_AIGYSD_API_KEY",
		temperature: 0.7,
		maxTokens: 4000,
		costTier: 1,
		displayName: "GPT-4.1 Mini",
		description: "快速经济模型，日常问答首选",
		icon: "⚡",
	},
	"gpt-5.5": {
		provider: "openai",
		model: "gpt-5.6-luna",
		capabilities: ["chat"],
		apiKeyEnvName: "AI_PROVIDER_AIGYSD_API_KEY",
		temperature: 0.7,
		maxTokens: 8000,
		costTier: 4,
		displayName: "GPT-5.5",
		description: "高级模型，能力最强",
		icon: "🚀",
	},
	"claude-sonnet-4-6": {
		provider: "openai", // aigysd 网关暴露 OpenAI 兼容接口，复用 ChatOpenAI 通道
		model: "claude-sonnet-4-6",
		capabilities: ["chat"],
		apiKeyEnvName: "AI_PROVIDER_AIGYSD_ANTHROPIC_API_KEY",
		temperature: 0.7,
		maxTokens: 8000,
		costTier: 4,
		displayName: "Claude Sonnet 4.6",
		description: "Anthropic Claude 模型",
		icon: "🎭",
	},
	"gemini-3-flash-preview": {
		provider: "openai", // aigysd 网关暴露 OpenAI 兼容接口，复用 ChatOpenAI 通道
		model: "gemini-3-flash-preview",
		capabilities: ["chat"],
		apiKeyEnvName: "AI_PROVIDER_AIGYSD_GEMINI_API_KEY",
		temperature: 0.7,
		maxTokens: 8000,
		costTier: 2,
		displayName: "Gemini 3 Flash",
		description: "Google Gemini 快速模型",
		icon: "✨",
	},
};

/** 白名单唯一出口：条目经 zod 校验（加载期 fail-fast，防配置漂移） */
export const CHAT_MODELS: Record<string, ChatModelConfig> = Object.fromEntries(
	Object.entries(CHAT_MODEL_ENTRIES).map(([key, entry]) => [
		key,
		ChatModelConfigSchema.parse(entry) as ChatModelConfig,
	]),
);

/**
 * 默认模型 key：请求缺省 modelKey 时的回退锚点（§4.2）。
 * 读 process.env 而非 env.ts 固化常量（同 ai-runtime-config 纪律：测试按实例注入）；
 * 兜底值与 config/env.ts 的 AI_DEFAULT_CHAT_MODEL default 保持一致（双处同步注释）。
 */
export const resolveDefaultChatModelKey = (): string =>
	process.env.AI_DEFAULT_CHAT_MODEL?.trim() || "gpt-4.1-mini";

/** 模块加载期断言：默认模型必须在白名单内（fail-fast，防 env 与白名单漂移；§3.3） */
const defaultModelKey = resolveDefaultChatModelKey();
if (!CHAT_MODELS[defaultModelKey]) {
	throw new Error(
		`AI_DEFAULT_CHAT_MODEL=${defaultModelKey} 不在聊天模型白名单（合法值：${Object.keys(CHAT_MODELS).join("、")}）`,
	);
}

/** 白名单精确查找（无归一化，变形 key 一律 fail-closed；§2.2 #3） */
export function resolveChatModelConfig(
	modelKey: string,
): ResolvedChatModelConfig {
	const config = CHAT_MODELS[modelKey];
	if (!config) throw new AiModelUnknownException();
	return { ...config, key: modelKey };
}

/** 列表接口投影（§4.1）：按 costTier 升序；绝不包含 apiKeyEnvName/model/temperature/maxTokens */
export function listChatModels(): ChatModelSummary[] {
	return Object.entries(CHAT_MODELS)
		.map(([key, config]) => ({
			key,
			displayName: config.displayName,
			provider: config.provider,
			capabilities: [...config.capabilities],
			costTier: config.costTier,
			icon: config.icon,
			description: config.description,
		}))
		.sort((a, b) => a.costTier - b.costTier);
}

/**
 * 按变量名解析密钥（空串归 undefined，沿用 ai-runtime-config 的 orUndefined 手法）。
 * 仅两处调用：resolve 期快照可用性（ai-runtime-config）、工厂运行时兜底（llm-factory）。
 */
export function resolveProviderApiKey(
	envName: string,
	source: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const value = source[envName];
	return value === "" || value === undefined ? undefined : value;
}
