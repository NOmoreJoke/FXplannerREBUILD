import {
	Body,
	Controller,
	Delete,
	Get,
	Inject,
	Param,
	Post,
	Query,
	Req,
	Res,
	HttpStatus,
	Logger,
	UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
	ApiBearerAuth,
	ApiBody,
	ApiExtraModels,
	ApiOperation,
	ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
import type { User } from "@prisma/client";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AiService } from "./ai.service";
import { AiAgentService, type StreamReplyParams } from "./ai-agent.service";
import { listChatModels } from "./ai-models.config";
// DTO 必须运行时 import（emitDecoratorMetadata 需要 runtime 引用）：
// import type 会被完全擦除 → design:paramtypes emit 成全局 Function →
// ValidationPipe 收到 metatype=Function → plainToInstance(Function, body)
// 返回匿名函数 → dto.content 恒 undefined → 400 AI_MESSAGE_EMPTY（E2E 根因）。
// 下方的 @ApiExtraModels/@ApiBody 是运行时引用（兼 swagger 契约完备），
// 两者缺一不可：仅类型用途的符号才用 inline type 修饰符（如 StreamReplyParams）。
import {
	ListConversationsQueryDto,
	ListMessagesQueryDto,
	SendMessageDto,
} from "./dto/ai.dto";

/** 发消息端点的 IP 级限流：路由级 @Throttle 覆盖全局配置（§4，throttler「覆盖」语义） */
const AI_SEND_THROTTLE = { default: { limit: 5, ttl: 60_000 } } as const;

/** 整流硬上限（§6：超时终止并落 error 帧） */
const AI_STREAM_HARD_TIMEOUT_MS = 120_000;

/** SSE error 帧固定文案（§4 错误信息纪律：上游/内部细节只进日志） */
const AI_UPSTREAM_FAILED_MESSAGE = "回复生成失败，请稍后重试";
const AI_CONVERSATION_GONE_MESSAGE = "会话不存在或已被删除";

interface StreamWriteParams {
	conversationId: string;
	userMessageId: string;
	title: string;
	history: StreamReplyParams["history"];
	userContent: string;
	/** 服务端 resolve 后的白名单 key（非客户端原值，ai-model-whitelist §4.2） */
	modelKey: string;
}

/**
 * AI 助手接口（ai-assistant 技术方案 §4）：4 JSON + 1 SSE 流式（5 端点），全部需登录。
 * 流式端点持有 res 直写（绕过全局 JSON 包装；先例：app.controller 探针不走包装），
 * done/error 帧写出后必须 res.end()（否则前端 reader 与集成测试挂起，§4 终止保证）。
 * SSE 帧协议：每帧 `event: <type>\ndata: <JSON 整包>\n\n`——data 行必须
 * JSON.stringify(完整载荷对象)，禁止字符串模板直拼（delta 含换行时整体转义）。
 */
@ApiTags("Ai")
// DTO 运行时引用：保障 design:paramtypes 可 emit 类引用（见 import 处注释，transaction 模块同款先例）
@ApiExtraModels(ListConversationsQueryDto, ListMessagesQueryDto, SendMessageDto)
@ApiBearerAuth()
@Controller("ai")
@UseGuards(JwtAuthGuard)
export class AiController {
	private readonly logger = new Logger(AiController.name);

	constructor(
		@Inject(AiService) private readonly aiService: AiService,
		@Inject(AiAgentService) private readonly aiAgentService: AiAgentService,
	) {}

	@Get("conversations")
	@ApiOperation({
		summary: "会话列表",
		description:
			"仅返回本人会话，按 lastMessageAt 倒序；幂等只读。未配 LLM key 或总开关关闭时 503 整体降级。",
	})
	async listConversations(
		@CurrentUser() user: User,
		@Query() query: ListConversationsQueryDto,
	) {
		this.aiService.assertChatAvailable();
		const data = await this.aiService.listConversations(user.id, query.limit);
		return { success: true, data, message: "会话列表获取成功" };
	}

	@Get("models")
	@ApiOperation({
		summary: "聊天模型白名单列表",
		description:
			"返回可选聊天模型（按 costTier 升序）；幂等只读。仅展示字段（key/displayName/provider/capabilities/costTier/icon/description），不含密钥变量与上游模型名；密钥全未配时仍返回全量列表（可用性在发消息时判定）。",
	})
	async listModels() {
		const data = { items: listChatModels() };
		return { success: true, data, message: "模型列表获取成功" };
	}

	@Post("conversations")
	@Throttle(AI_SEND_THROTTLE)
	@ApiBody({ type: SendMessageDto })
	@ApiOperation({
		summary: "首条消息并建会话（SSE 流式回复）",
		description:
			"以首条消息创建会话（标题=消息前 20 字）后立即开始流式回复；body 可选 modelKey 指定模型（缺省用服务端默认，非法 key 400 AI_MODEL_UNKNOWN）。响应为 text/event-stream（帧协议 meta/tool/token/done/error），不走统一 JSON 包装。发消息 5/min/IP；用户级日配额超限 429 AI_QUOTA_EXCEEDED；系统并发满 429 AI_BUSY。",
	})
	async createWithMessage(
		@Req() req: Request,
		@Res() res: Response,
		@CurrentUser() user: User,
		@Body() dto: SendMessageDto,
	) {
		const prepared = await this.aiService.prepareChat({
			userId: user.id,
			content: dto.content,
			modelKey: dto.modelKey,
		});
		await this.streamReply(req, res, {
			conversationId: prepared.conversation.id,
			userMessageId: prepared.userMessageId,
			title: prepared.conversation.title,
			history: prepared.history,
			userContent: dto.content.trim(),
			modelKey: prepared.modelConfig.key,
		});
	}

	@Post("conversations/:id/messages")
	@Throttle(AI_SEND_THROTTLE)
	@ApiBody({ type: SendMessageDto })
	@ApiOperation({
		summary: "追问（SSE 流式回复）",
		description:
			"向既有会话追加消息并流式回复；body 可选 modelKey 指定模型（缺省用服务端默认，非法 key 400 AI_MODEL_UNKNOWN）。会话归属校验：非本人/不存在统一 404（防枚举）；同会话流进行中再发 409 AI_CONVERSATION_BUSY（先标忙碌再落用户消息，无并发窗口）。",
	})
	async sendMessage(
		@Req() req: Request,
		@Res() res: Response,
		@CurrentUser() user: User,
		@Param("id") conversationId: string,
		@Body() dto: SendMessageDto,
	) {
		const prepared = await this.aiService.prepareChat({
			userId: user.id,
			content: dto.content,
			conversationId,
			modelKey: dto.modelKey,
		});
		await this.streamReply(req, res, {
			conversationId,
			userMessageId: prepared.userMessageId,
			title: prepared.conversation.title,
			history: prepared.history,
			userContent: dto.content.trim(),
			modelKey: prepared.modelConfig.key,
		});
	}

	@Get("conversations/:id/messages")
	@ApiOperation({
		summary: "会话消息列表",
		description:
			"按 createdAt 升序返回本人会话消息；非本人/不存在统一 404（防枚举）；幂等只读。",
	})
	async listMessages(
		@CurrentUser() user: User,
		@Param("id") conversationId: string,
		@Query() query: ListMessagesQueryDto,
	) {
		this.aiService.assertChatAvailable();
		const data = await this.aiService.listMessages(
			conversationId,
			user.id,
			query.limit,
		);
		return { success: true, data, message: "消息列表获取成功" };
	}

	@Delete("conversations/:id")
	@ApiOperation({
		summary: "删除会话（物理删除，消息级联）",
		description:
			"物理删除本人会话及其全部消息；流进行中 409 拒绝删除；非本人/不存在统一 404（防枚举）。",
	})
	async deleteConversation(
		@CurrentUser() user: User,
		@Param("id") conversationId: string,
	) {
		this.aiService.assertChatAvailable();
		await this.aiService.deleteConversation(conversationId, user.id);
		return { success: true, message: "会话已删除" };
	}

	/**
	 * SSE 流式回复（§3.1/§4）：meta → tool/token* → done/error；异常路径同样 end。
	 * - 客户端断连与 120s 硬超时共用一个 AbortSignal 透传给 agent 与上游；
	 * - abort 后静默终止（不落助手消息、不写 error 帧——连接已断）；
	 * - 上游失败 → error 帧 AI_UPSTREAM_FAILED（固定文案），助手消息不落库；
	 * - 流式中会话被删（P2025）→ error 帧 AI_CONVERSATION_NOT_FOUND 收尾；
	 * - finally 必释放信号量与忙碌标记（finishStream）。
	 */
	private async streamReply(
		req: Request,
		res: Response,
		params: StreamWriteParams,
	): Promise<void>  {
		res.status(HttpStatus.OK);
		res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
		res.setHeader("Cache-Control", "no-cache, no-transform");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("X-Accel-Buffering", "no");
		res.flushHeaders();

		const abort = new AbortController();
		// 客户端断连信号必须挂 res（Node ≥16 的 req 'close' 在请求体读完即触发，
		// 会把正常请求误 abort）；res 'close' 时以 writableEnded 区分「提前断连」与正常收尾
		res.on("close", () => {
			if (!res.writableEnded) abort.abort();
		});
		const hardTimeout = setTimeout(() => abort.abort(), AI_STREAM_HARD_TIMEOUT_MS);

		const writeFrame = (event: string, payload: unknown): void => {
			res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
		};

		this.logger.log(
			`AI 流开始：conversationId=${params.conversationId} userMessageId=${params.userMessageId} contentLen=${params.userContent.length}`,
		);
		writeFrame("meta", {
			conversationId: params.conversationId,
			userMessageId: params.userMessageId,
			title: params.title,
		});

		try {
			for await (const frame of this.aiAgentService.streamReply({
				history: params.history,
				userContent: params.userContent,
				signal: abort.signal,
				modelKey: params.modelKey,
			})) {
				if (frame.type === "token") {
					writeFrame("token", { delta: frame.delta });
				} else if (frame.type === "tool") {
					writeFrame("tool", { name: frame.name, state: frame.state });
				} else if (frame.type === "done") {
					const saved = await this.aiService.saveAssistantMessage(
						params.conversationId,
						frame.content,
						params.modelKey,
					);
					if (!saved) {
						writeFrame("error", {
							code: "AI_CONVERSATION_NOT_FOUND",
							message: AI_CONVERSATION_GONE_MESSAGE,
						});
					} else {
						writeFrame("done", {
							assistantMessage: {
								id: saved.id,
								role: saved.role,
								content: saved.content,
								model: saved.model,
								createdAt: saved.createdAt.toISOString(),
							},
							usage: frame.usage,
							model: frame.model,
						});
					}
				}
			}
			// 硬超时终止（客户端仍在）：补 error 帧收尾；客户端断连无需任何帧
			if (abort.signal.aborted && !req.destroyed) {
				writeFrame("error", {
					code: "AI_UPSTREAM_FAILED",
					message: AI_UPSTREAM_FAILED_MESSAGE,
				});
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.logger.warn(
				`AI 流失败（stage=llm）：conversationId=${params.conversationId} detail=${detail}`,
			);
			if (!abort.signal.aborted) {
				writeFrame("error", {
					code: "AI_UPSTREAM_FAILED",
					message: AI_UPSTREAM_FAILED_MESSAGE,
				});
			}
		} finally {
			clearTimeout(hardTimeout);
			this.aiService.finishStream(params.conversationId);
			res.end();
		}
	}
}
