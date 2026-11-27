import { setTimeout as delay } from "node:timers/promises";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
	BaseChatModel,
	type BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models";
import {
	AIMessage,
	AIMessageChunk,
	type BaseMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { ChatOpenAI } from "@langchain/openai";
import {
	resolveChatModelConfig,
	resolveProviderApiKey,
} from "../ai-models.config";
import { AiNotConfiguredException } from "../ai.errors";
import {
	AI_LLM_FIRST_TOKEN_TIMEOUT_MS,
	type AiRuntimeConfig,
} from "./ai-runtime-config";

/**
 * LLM 工厂（ai-assistant 技术方案 §5.1 + ai-model-whitelist 技术方案 §3.5 + ToB R2 §14.3）：
 *
 * DI token AI_LLM_FACTORY 是集成测试的 override 点（§8.2 装配约定①）：
 * 真实现按 modelKey 查白名单构造 ChatOpenAI；AI_E2E_FAKE_STREAM=true 时无视 modelKey
 * 切换本地假流式 ReAct 模型 `E2eFakeAgentChatModel`，不外呼 LLM 网关：
 * - 普通对话沿用固定回复 `E2E_FAKE_REPLY` 逐字符慢速流式（保障 14-ai-chat 既有语义与停止窗口）；
 * - 含 `[R2-E2E]` 标记的请求自动识别工具意图 → 发出真实 `tool_calls` → 走真实后端 Service/DB/Guard/AuditLog →
 *   基于真实 `ToolMessage` 输出结构化回复并流式下发（供 16-agent-organization 覆盖真实全链路）。
 */

export const AI_LLM_FACTORY = Symbol("AI_LLM_FACTORY");

export type AiLlmFactory = (modelKey: string) => BaseChatModel;

/** E2E 假流式模型的固定回复（含换行，供流式帧协议验证） */
export const E2E_FAKE_REPLY =
	"这是来自 FXPlanner 假流式模型的测试回复。\n第二行内容用于验证多行流式输出。";

const R2_E2E_MARKER = "[R2-E2E]";

function extractMessageText(message: BaseMessage | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.map((part) =>
				typeof part === "string"
					? part
					: typeof part === "object" &&
							part !== null &&
							"text" in part &&
							typeof part.text === "string"
						? part.text
						: "",
			)
			.join("");
	}
	return "";
}

function findLastHumanPrompt(messages: readonly BaseMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.getType() === "human") {
			return extractMessageText(message);
		}
	}
	return "";
}

function defaultFutureDate(daysAhead = 60): string {
	return new Date(Date.now() + daysAhead * 86_400_000)
		.toISOString()
		.slice(0, 10);
}

function buildR2ToolCall(prompt: string): AIMessage {
	if (prompt.includes("草稿") || prompt.includes("起草")) {
		const currencyMatch = prompt.match(/币种=([A-Z]{3})/);
		const targetMatch = prompt.match(/目标=(\d+(?:\.\d+)?)/);
		const allocMatch = prompt.match(/分配=(\d+(?:\.\d+)?)/);
		const dateMatch = prompt.match(/日期=(\d{4}-\d{2}-\d{2})/);
		const nameMatch = prompt.match(/名称=([^\s]+)/);
		return new AIMessage({
			content: "",
			tool_calls: [
				{
					id: "call_r2_e2e_draft",
					name: "draft_fx_plan",
					args: {
						targetCurrency: currencyMatch?.[1] ?? "USD",
						targetAmount: targetMatch?.[1] ?? "10000",
						expectUseDate: dateMatch?.[1] ?? defaultFutureDate(),
						name: nameMatch?.[1] ?? "R2测试换汇草稿",
						...(allocMatch ? { allocatedAmount: allocMatch[1] } : {}),
					},
				},
			],
		});
	}
	if (prompt.includes("持仓") || prompt.includes("余额") || prompt.includes("账户")) {
		return new AIMessage({
			content: "",
			tool_calls: [
				{
					id: "call_r2_e2e_account",
					name: "get_account_summary",
					args: {},
				},
			],
		});
	}
	if (prompt.includes("敞口") || prompt.includes("缺口")) {
		return new AIMessage({
			content: "",
			tool_calls: [
				{
					id: "call_r2_e2e_exposure",
					name: "list_plan_exposure",
					args: {},
				},
			],
		});
	}
	if (prompt.includes("成本") || prompt.includes("手续费")) {
		return new AIMessage({
			content: "",
			tool_calls: [
				{
					id: "call_r2_e2e_cost",
					name: "get_plan_cost_summary",
					args: {},
				},
			],
		});
	}
	if (prompt.includes("待办") || prompt.includes("提醒")) {
		return new AIMessage({
			content: "",
			tool_calls: [
				{
					id: "call_r2_e2e_upcoming",
					name: "list_upcoming_actions",
					args: { withinDays: 90 },
				},
			],
		});
	}
	return new AIMessage({
		content: "",
		tool_calls: [
			{
				id: "call_r2_e2e_rate",
				name: "query_exchange_rate",
				args: { mode: "latest", base: "CNY", targets: ["USD"] },
			},
		],
	});
}

function summarizeToolResult(rawContent: string): string {
	let parsed: Record<string, unknown> | null = null;
	try {
		const value: unknown = JSON.parse(rawContent);
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			parsed = value as Record<string, unknown>;
		}
	} catch {
		parsed = null;
	}

	if (!parsed) {
		return `公共汇率查询结果：${rawContent}`;
	}
	if (typeof parsed.error === "string") {
		const message = typeof parsed.message === "string" ? parsed.message : "";
		return `无法执行工具操作（${parsed.error}）：${message}`;
	}
	if (parsed.kind === "plan_draft") {
		const draft = (parsed.draft ?? {}) as Record<string, unknown>;
		return `已为您生成换汇计划草稿（尚未保存）：目标 ${String(draft.targetAmount ?? "")} ${String(draft.targetCurrency ?? "")}，计入已有外币 ${String(draft.allocatedAmount ?? "0.0000")}。请点击下方草稿卡片前往确认页复核保存。`;
	}
	if (parsed.kind === "plan_draft_blocked") {
		return `暂无法生成计划草稿（${String(parsed.code ?? "")}）：${String(parsed.message ?? "")}`;
	}
	if (parsed.empty === true) {
		return `当前组织暂无相关记录（empty=true）：${String(parsed.note ?? "")}`;
	}

	if (parsed.source === "account_summary" && Array.isArray(parsed.accounts)) {
		const lines = (parsed.accounts as Array<Record<string, unknown>>).map(
			(acc) =>
				`${String(acc.currencyCode)} 余额 ${String(acc.balance)}（已分配 ${String(acc.allocatedAmount)}，未分配 ${String(acc.unallocatedAmount)}）`,
		);
		return `当前组织账户持仓摘要：\n${lines.join("\n")}`;
	}
	if (parsed.source === "plan_exposure" && Array.isArray(parsed.plans)) {
		const lines = (parsed.plans as Array<Record<string, unknown>>).map(
			(plan) =>
				`${String(plan.untrustedPlanName ?? "未命名计划")}（${String(plan.targetCurrency)} 目标 ${String(plan.targetAmount)}，缺口 ${String(plan.gapAmount)}）`,
		);
		return `当前组织计划敞口与缺口：\n${lines.join("\n")}`;
	}
	if (parsed.source === "plan_cost_summary" && Array.isArray(parsed.plans)) {
		const lines = (parsed.plans as Array<Record<string, unknown>>).map(
			(plan) =>
				`${String(plan.untrustedPlanName ?? "未命名计划")}（已用 ${String(plan.usedQuantity)}，总成本 ${plan.usedTotalCost === null || plan.usedTotalCost === undefined ? "尚未使用" : String(plan.usedTotalCost)}，hasUnknownFee=${String(plan.hasUnknownFee)}）`,
		);
		const feeNotice =
			typeof parsed.feeNotice === "string" && parsed.feeNotice.length > 0
				? `\n${parsed.feeNotice}`
				: "";
		return `当前组织计划成本摘要：\n${lines.join("\n")}${feeNotice}`;
	}
	if (parsed.source === "upcoming_actions") {
		const reminders = Array.isArray(parsed.reminders)
			? parsed.reminders.length
			: 0;
		const plans = Array.isArray(parsed.upcomingPlans)
			? parsed.upcomingPlans.length
			: 0;
		return `近期到期事项：待办提醒 ${reminders} 项，近期准备计划 ${plans} 项。`;
	}
	return rawContent;
}

export class E2eFakeAgentChatModel extends BaseChatModel {
	constructor(private readonly intervalMs: number) {
		super({});
	}

	_llmType(): string {
		return "e2e-fake-agent";
	}

	bindTools(_tools: unknown, _kwargs?: unknown): this {
		return new E2eFakeAgentChatModel(this.intervalMs) as this;
	}

	private resolveNextReply(messages: BaseMessage[]): {
		message: AIMessage;
		chunkSize: number;
		intervalMs: number;
	} {
		const lastMessage = messages.at(-1);
		const lastHuman = findLastHumanPrompt(messages);

		if (!lastHuman.includes(R2_E2E_MARKER)) {
			return {
				message: new AIMessage(E2E_FAKE_REPLY),
				chunkSize: 1,
				intervalMs: this.intervalMs,
			};
		}

		if (lastMessage?.getType() === "tool") {
			return {
				message: new AIMessage(
					summarizeToolResult(extractMessageText(lastMessage)),
				),
				chunkSize: 6,
				intervalMs: Math.min(this.intervalMs, 20),
			};
		}

		return {
			message: buildR2ToolCall(lastHuman),
			chunkSize: 1,
			intervalMs: 0,
		};
	}

	async _generate(
		messages: BaseMessage[],
		_options: BaseChatModelCallOptions,
	): Promise<ChatResult> {
		const { message } = this.resolveNextReply(messages);
		return {
			generations: [{ text: extractMessageText(message), message }],
		};
	}

	async *_streamResponseChunks(
		messages: BaseMessage[],
		options: BaseChatModelCallOptions,
		rm?: CallbackManagerForLLMRun,
	): AsyncGenerator<ChatGenerationChunk> {
		const { message, chunkSize, intervalMs } = this.resolveNextReply(messages);
		if (options?.signal?.aborted) return;

		const text = extractMessageText(message);
		for (let offset = 0; offset < text.length; offset += chunkSize) {
			if (options?.signal?.aborted) return;
			const slice = text.slice(offset, offset + chunkSize);
			const chunk = new AIMessageChunk({ content: slice });
			const cg = new ChatGenerationChunk({ message: chunk, text: slice });
			yield cg;
			await rm?.handleLLMNewToken(slice, undefined, undefined, undefined, undefined, {
				chunk: cg,
			});
			if (intervalMs > 0) {
				try {
					await delay(intervalMs, undefined, { signal: options?.signal });
				} catch {
					return;
				}
			}
		}

		if (options?.signal?.aborted) return;
		const tail = new AIMessageChunk({
			content: "",
			...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
		});
		const tailCg = new ChatGenerationChunk({ message: tail, text: "" });
		yield tailCg;
		await rm?.handleLLMNewToken("", undefined, undefined, undefined, undefined, {
			chunk: tailCg,
		});
	}
}

export function createLlmFactory(config: AiRuntimeConfig): AiLlmFactory {
	if (config.e2eFakeStream) {
		return () => new E2eFakeAgentChatModel(config.e2eFakeIntervalMs);
	}
	return (modelKey: string) => {
		const modelConfig = resolveChatModelConfig(modelKey);
		const apiKey = resolveProviderApiKey(modelConfig.apiKeyEnvName);
		if (!apiKey) {
			// 兜底路径：gate 快照预检后密钥被回收等极小窗口（§3.5），按未配置降级
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
