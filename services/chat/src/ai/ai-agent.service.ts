import { Injectable, Inject, Logger } from "@nestjs/common";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import {
	AIMessage,
	HumanMessage,
	type BaseMessage,
} from "@langchain/core/messages";
import type { AIMessageChunk } from "@langchain/core/messages";
import { RateService } from "../rate/rate.service";
import { AI_SYSTEM_PROMPT } from "./prompts/system-prompt";
import { createRateTool } from "./tools/rate-tool";
import { AI_LLM_FACTORY, type AiLlmFactory } from "./llm/llm-factory";

/** 组装进 agent 的历史消息（DB 行的内存形态） */
export interface AiHistoryMessage {
	role: string;
	content: string;
}

export type AgentFrame =
	| { type: "tool"; name: string; state: "start" | "end" }
	| { type: "token"; delta: string }
	| {
			type: "done";
			content: string;
			usage: { inputTokens: number; outputTokens: number };
			/** 本条回复实际使用的白名单 key（服务端 resolve 权威值，ai-model-whitelist §4.2） */
			model: string;
	  };

export interface StreamReplyParams {
	history: AiHistoryMessage[];
	userContent: string;
	signal: AbortSignal;
	/** 白名单 key（prepareChat 已 resolve，工厂内兑底再查一次） */
	modelKey: string;
}

/** ReAct 工具环步数上限（单工具场景默认 25 绰绰有余，防御模型循环调用） */
const AGENT_RECURSION_LIMIT = 25;

/**
 * ReAct agent 服务（ai-assistant 技术方案 §3.1 ai-agent.service.ts）：
 * createReactAgent 组装 + streamEvents v2 → 帧 AsyncGenerator；abort 信号透传
 * （客户端断连/120s 硬超时终止流，防止无人消费仍烧 token，§6）。
 *
 * token 帧只转发非空 content chunk：tool_call 阶段的 chunk 无文本（JSON 在
 * tool_call_chunks 里），天然过滤；usage 从带 usage_metadata 的 chunk 累加
 * （ReAct 多轮模型调用逐次累加）。上游/内部异常向上抛，由 controller 转 error 帧。
 */
@Injectable()
export class AiAgentService {
	private readonly logger = new Logger(AiAgentService.name);

	constructor(
		@Inject(AI_LLM_FACTORY) private readonly llmFactory: AiLlmFactory,
		@Inject(RateService) private readonly rateService: RateService,
	) {}

	async *streamReply(
		params: StreamReplyParams,
	): AsyncGenerator<AgentFrame, void, undefined> {
		const llm = this.llmFactory(params.modelKey);
		const agent = createReactAgent({
			llm,
			tools: [createRateTool(this.rateService)],
			prompt: AI_SYSTEM_PROMPT,
		});

		const messages: BaseMessage[] = [
			...params.history.map((message) =>
				message.role === "assistant"
					? new AIMessage({ content: message.content })
					: new HumanMessage({ content: message.content }),
			),
			new HumanMessage({ content: params.userContent }),
		];

		let full = "";
		const usage = { inputTokens: 0, outputTokens: 0 };
		const eventStream = await agent.streamEvents(
			{ messages },
			{
				version: "v2",
				signal: params.signal,
				recursionLimit: AGENT_RECURSION_LIMIT,
			},
		);

		for await (const event of eventStream) {
			if (params.signal.aborted) return;
			switch (event.event) {
				case "on_chat_model_stream": {
					const chunk = (event.data as { chunk?: AIMessageChunk }).chunk;
					const text =
						chunk && typeof chunk.content === "string" ? chunk.content : "";
					if (text) {
						full += text;
						yield { type: "token", delta: text };
					}
					const usageMetadata = chunk?.usage_metadata;
					if (usageMetadata) {
						usage.inputTokens += usageMetadata.input_tokens;
						usage.outputTokens += usageMetadata.output_tokens;
					}
					break;
				}
				case "on_tool_start":
					yield { type: "tool", name: String(event.name), state: "start" };
					break;
				case "on_tool_end":
					yield { type: "tool", name: String(event.name), state: "end" };
					break;
				default:
					break;
			}
		}
		this.logger.log(
			`AI 流结束：model=${params.modelKey} inputTokens=${usage.inputTokens} outputTokens=${usage.outputTokens}`,
		);
		yield { type: "done", content: full, usage, model: params.modelKey };
	}
}
