import { Injectable, Inject, Logger } from "@nestjs/common";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import {
	AIMessage,
	HumanMessage,
	type BaseMessage,
} from "@langchain/core/messages";
import type { AIMessageChunk } from "@langchain/core/messages";
import { AccountService } from "../account/account.service";
import { AuditService } from "../audit/audit.service";
import type { ActorContext } from "../authorization/authorization.types";
import {
	ORGANIZATION_LOCK_RESOLVER,
	type OrganizationLockResolver,
} from "../authorization/guards/organization-lock.guard";
import { PlanService } from "../plan/plan.service";
import { PrismaService } from "../prisma/prisma.service";
import { RateService } from "../rate/rate.service";
import { ReminderService } from "../reminder/reminder.service";
import { ReportService } from "../report/report.service";
import type { AiPlanDraftDto } from "./dto/ai.dto";
import { AI_RUNTIME_CONFIG, type AiRuntimeConfig } from "./llm/ai-runtime-config";
import { AI_LLM_FACTORY, type AiLlmFactory } from "./llm/llm-factory";
import { AI_SYSTEM_PROMPT } from "./prompts/system-prompt";
import { createAccountSummaryTool } from "./tools/account-summary-tool";
import { createDraftPlanTool } from "./tools/draft-plan-tool";
import { createPlanCostTool } from "./tools/plan-cost-tool";
import { createPlanExposureTool } from "./tools/plan-exposure-tool";
import { createRateTool } from "./tools/rate-tool";
import { createToolGuardRunner } from "./tools/tool-guard";
import { createUpcomingActionsTool } from "./tools/upcoming-actions-tool";

/** 组装进 agent 的历史消息（DB 行的内存形态） */
export interface AiHistoryMessage {
	role: string;
	content: string;
}

export type AgentFrame =
	| { type: "tool"; name: string; state: "start" | "end" }
	| { type: "draft"; draft: AiPlanDraftDto }
	| { type: "token"; delta: string }
	| {
			type: "done";
			content: string;
			usage: { inputTokens: number; outputTokens: number };
			/** 本条回复实际使用的白名单 key（服务端 resolve 权威值，ai-model-whitelist §4.2） */
			model: string;
			/** 本轮由 draft_fx_plan 生成的未保存计划草稿（无草稿为 null） */
			planDraft?: AiPlanDraftDto | null;
	  };

export interface StreamReplyParams {
	actor: ActorContext;
	conversationId: string;
	agentRunId: string;
	requestId: string | null;
	history: AiHistoryMessage[];
	userContent: string;
	signal: AbortSignal;
	/** 白名单 key（prepareChat 已 resolve，工厂内兑底再查一次） */
	modelKey: string;
}

/** ReAct 工具环步数上限（多工具场景 25 步绰绰有余，防御模型循环调用） */
const AGENT_RECURSION_LIMIT = 25;

/**
 * ReAct agent 服务（ai-assistant 技术方案 §3.1 + ToB R2 技术方案 §8）：
 * createReactAgent 组装 + streamEvents v2 → 帧 AsyncGenerator；
 * 工具闭包绑定请求入口 ActorContext / conversationId / agentRunId，每次工具调用经
 * tool-guard 实时重查双锁、Membership、组织工具开关、集中权限策略并写 AuditLog。
 */
@Injectable()
export class AiAgentService {
	private readonly logger = new Logger(AiAgentService.name);

	constructor(
		@Inject(AI_LLM_FACTORY) private readonly llmFactory: AiLlmFactory,
		@Inject(AI_RUNTIME_CONFIG) private readonly config: AiRuntimeConfig,
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(AuditService) private readonly auditService: AuditService,
		@Inject(ORGANIZATION_LOCK_RESOLVER)
		private readonly lockResolver: OrganizationLockResolver,
		@Inject(RateService) private readonly rateService: RateService,
		@Inject(AccountService) private readonly accountService: AccountService,
		@Inject(PlanService) private readonly planService: PlanService,
		@Inject(ReportService) private readonly reportService: ReportService,
		@Inject(ReminderService) private readonly reminderService: ReminderService,
	) {}

	async *streamReply(
		params: StreamReplyParams,
	): AsyncGenerator<AgentFrame, void, undefined> {
		const llm = this.llmFactory(params.modelKey);
		const guard = createToolGuardRunner(
			{
				prisma: this.prisma,
				auditService: this.auditService,
				lockResolver: this.lockResolver,
				orgToolsEnabled: this.config.orgToolsEnabled,
				logger: this.logger,
			},
			{
				actor: params.actor,
				conversationId: params.conversationId,
				agentRunId: params.agentRunId,
				requestId: params.requestId,
			},
		);

		let latestDraft: AiPlanDraftDto | null = null;
		const pendingDrafts: AiPlanDraftDto[] = [];
		const tools = [
			createRateTool(this.rateService, guard),
			createAccountSummaryTool(this.accountService, guard),
			createPlanExposureTool(this.planService, guard),
			createPlanCostTool(this.reportService, guard),
			createUpcomingActionsTool(this.planService, this.reminderService, guard),
			createDraftPlanTool({
				planService: this.planService,
				prisma: this.prisma,
				guard,
				agentRunId: params.agentRunId,
				onDraft: (draft) => {
					latestDraft = draft;
					pendingDrafts.push(draft);
				},
			}),
		];

		const agent = createReactAgent({
			llm,
			tools,
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
					while (pendingDrafts.length > 0) {
						const draft = pendingDrafts.shift();
						if (draft) yield { type: "draft", draft };
					}
					break;
				default:
					break;
			}
		}
		if (params.signal.aborted) return;
		while (pendingDrafts.length > 0) {
			const draft = pendingDrafts.shift();
			if (draft) yield { type: "draft", draft };
		}
		this.logger.log(
			`AI 流结束：model=${params.modelKey} agentRunId=${params.agentRunId} inputTokens=${usage.inputTokens} outputTokens=${usage.outputTokens}`,
		);
		yield {
			type: "done",
			content: full,
			usage,
			model: params.modelKey,
			planDraft: latestDraft,
		};
	}
}
