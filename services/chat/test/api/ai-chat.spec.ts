import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { AIMessageChunk } from "@langchain/core/messages";
import {
	BaseChatModel,
	type BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	bearer,
	cleanupUser,
	createTestApp,
	createTestUser,
	type TestContext,
	type TestUser,
} from "../helpers/test-app";
import { localTestFetch } from "../helpers/local-test-fetch";

// 关闭全局接口限流（先例：transaction.spec/plan.spec——APP_GUARD token 被 scanner 改写，只能 mock 类）
vi.mock("@nestjs/throttler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nestjs/throttler")>();
	class NoopThrottlerGuard {
		async canActivate() {
			return true;
		}
	}
	return { ...actual, ThrottlerGuard: NoopThrottlerGuard };
});

import { AI_LLM_FACTORY } from "../../src/ai/llm/llm-factory";
import type { PrismaService } from "../../src/prisma/prisma.service";
import { RateProvider } from "../../src/rate/rate.provider";

// ────────────────────────── 脚本队列假模型（§8.2 装配①）──────────────────────────
// 官方 FakeStreamingChatModel 的 responses 固定取 [0]，无法编排「tool_call 后再作答 /
// 挂起 / 中途抛错」多轮脚本；此处以官方模型同款骨架实现脚本队列（bindTools + 流式 chunk），
// 事件序列经实测对齐 streamEvents v2（on_chat_model_stream / on_tool_start / on_tool_end）。

interface ScriptStep {
	message?: AIMessage;
	/** 等待放行（挂起档：以落库为确定性门槛制造进行中的流） */
	gate?: { promise: Promise<void> };
	/** 该步模型调用直接抛错（中途抛错档） */
	throwError?: Error;
}

interface ScriptShared {
	i: number;
	/** 每次 LLM 调用收到的完整输入（含 system prompt），供窗口/上文断言 */
	captured: BaseMessage[][];
	/** 模型流式循环中观察到 abort 信号（断连用例的确定性证据） */
	sawAbort: boolean;
	/** 每次工厂调用收到的 modelKey（ai-model-whitelist §8.2 装配①） */
	modelKeys: string[];
}

const newShared = (): ScriptShared => ({
	i: 0,
	captured: [],
	sawAbort: false,
	modelKeys: [],
});

class ScriptedChatModel extends BaseChatModel {
	private readonly steps: ScriptStep[];
	private readonly shared: ScriptShared;

	constructor(steps: ScriptStep[], shared: ScriptShared) {
		super({});
		this.steps = steps;
		this.shared = shared;
	}

	_llmType(): string {
		return "scripted";
	}

	bindTools(tools: unknown, _kwargs?: unknown): this {
		// agent 装配入口：返回共享同一脚本游标的新实例（探针验证的装配方式）
		const next = new ScriptedChatModel(this.steps, this.shared);
		void tools;
		return next as this;
	}

	async _generate(
		messages: BaseMessage[],
		_options: BaseChatModelCallOptions,
		_rm?: CallbackManagerForLLMRun,
	): Promise<ChatResult> {
		const step = this.steps[this.shared.i++];
		this.shared.captured.push([...messages]);
		if (step?.throwError) throw step.throwError;
		const message = step?.message ?? new AIMessage("");
		return { generations: [{ text: String(message.content ?? ""), message }] };
	}

	async *_streamResponseChunks(
		messages: BaseMessage[],
		options: BaseChatModelCallOptions,
		rm?: CallbackManagerForLLMRun,
	): AsyncGenerator<ChatGenerationChunk> {
		const step = this.steps[this.shared.i++];
		this.shared.captured.push([...messages]);
		if (step?.gate) await step.gate.promise;
		if (step?.throwError) throw step.throwError;
		if (options?.signal?.aborted) {
			this.shared.sawAbort = true;
			return;
		}

		const message = step?.message ?? new AIMessage("");
		const text = typeof message.content === "string" ? message.content : "";
		for (const ch of text) {
			if (options?.signal?.aborted) {
				this.shared.sawAbort = true;
				return;
			}
			const chunk = new AIMessageChunk({ content: ch });
			const cg = new ChatGenerationChunk({ message: chunk, text: ch });
			yield cg;
			await rm?.handleLLMNewToken(
				ch,
				undefined,
				undefined,
				undefined,
				undefined,
				{
					chunk: cg,
				},
			);
		}
		// 收尾 chunk：tool_calls / usage_metadata / id 随唯一尾块整体下发
		const tailChunk = new AIMessageChunk({
			content: "",
			...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
			...(message.usage_metadata
				? { usage_metadata: message.usage_metadata }
				: {}),
			...(message.id ? { id: message.id } : {}),
		});
		if (options?.signal?.aborted) {
			this.shared.sawAbort = true;
			return;
		}
		const tailCg = new ChatGenerationChunk({ message: tailChunk, text: "" });
		yield tailCg;
		await rm?.handleLLMNewToken(
			"",
			undefined,
			undefined,
			undefined,
			undefined,
			{
				chunk: tailCg,
			},
		);
	}
}

/** 脚本持有者：工厂闭包按引用取当前脚本，用例间重置（app 单例、脚本多态） */
const scriptHolder: { steps: ScriptStep[]; shared: ScriptShared } = {
	steps: [],
	shared: newShared(),
};
// 新签名 (modelKey) => BaseChatModel：记录收到的 modelKey 供断言（§8.2 装配①）
const scriptedFactory = (modelKey: string) => {
	scriptHolder.shared.modelKeys.push(modelKey);
	return new ScriptedChatModel(scriptHolder.steps, scriptHolder.shared);
};

const textReply = (
	content: string,
	usage?: { input: number; output: number },
): ScriptStep => ({
	message: new AIMessage({
		content,
		...(usage
			? {
					usage_metadata: {
						input_tokens: usage.input,
						output_tokens: usage.output,
						total_tokens: usage.input + usage.output,
					},
				}
			: {}),
	}),
});

// ────────────────────────── SSE 解析（§8.2 断言手法）──────────────────────────

interface SseFrame {
	event: string;
	data: Record<string, unknown>;
}

const parseSse = (raw: string): SseFrame[] =>
	raw
		.split("\n\n")
		.filter((block) => block.trim().length > 0)
		.map((block) => {
			const lines = block.split("\n");
			const event =
				lines
					.find((line) => line.startsWith("event:"))
					?.slice("event:".length)
					.trim() ?? "";
			const dataLine =
				lines
					.find((line) => line.startsWith("data:"))
					?.slice("data:".length)
					.trim() ?? "";
			return { event, data: JSON.parse(dataLine) as Record<string, unknown> };
		});

const waitUntil = async (
	condition: () => Promise<boolean>,
	timeoutMs = 10_000,
): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("waitUntil: condition not met within timeout");
};

// ────────────────────────── env 注入 app 构建（§8.2 装配③）──────────────────────────

/** 测试夹具假密钥（占位形态，非真实凭据；三渠道共用不同后缀便于日志区分） */
const FAKE_LLM_KEYS = {
	main: "test-fixture-key-main-not-real",
	anthropic: "test-fixture-key-anthropic-not-real",
	gemini: "test-fixture-key-gemini-not-real",
} as const;

const buildAiApp = async (
	overrides: Record<string, string | undefined> = {},
): Promise<TestContext> => {
	// 测试 .env.local 无 aigysd 密钥（gate 快照会判全未配 503）：除显式注入 undefined
	// 的场景外，默认补齐三个渠道的夹具 key（主渠道 + claude/gemini 专用，白名单 5 模型
	// 全可用，「追问带 modelKey=claude」用例依赖 claude 快照可用；保存/恢复机制不变，
	// §8.2 装配③）；AI_DEFAULT_CHAT_MODEL 固定默认值，隔离本地 .env.local 的个性化设置
	const merged = {
		AI_PROVIDER_AIGYSD_API_KEY: FAKE_LLM_KEYS.main,
		AI_PROVIDER_AIGYSD_ANTHROPIC_API_KEY: FAKE_LLM_KEYS.anthropic,
		AI_PROVIDER_AIGYSD_GEMINI_API_KEY: FAKE_LLM_KEYS.gemini,
		AI_DEFAULT_CHAT_MODEL: "gpt-4.1-mini",
		RATE_SOURCE: "multi",
		...overrides,
	};
	const saved: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(merged)) {
		saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await createTestApp((builder) =>
			builder.overrideProvider(AI_LLM_FACTORY).useValue(scriptedFactory),
		);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
};

// ────────────────────────── 测试 ───────────────────────────

describe("AiController（接口，ai-assistant 技术方案 §8.2）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let prisma: PrismaService;
	let user: TestUser;
	let other: TestUser;
	const userIds: string[] = [];

	// 每用例重置脚本（app 单例、脚本多态）
	beforeEach(() => {
		scriptHolder.steps = [];
		scriptHolder.shared = newShared();
	});
	beforeAll(async () => {
		ctx = await buildAiApp();
		app = ctx.app;
		prisma = ctx.prisma;
		user = await createTestUser(app, "ai-main");
		other = await createTestUser(app, "ai-other");
		userIds.push(user.userId, other.userId);
	});

	afterAll(async () => {
		for (const id of userIds) await cleanupUser(prisma, id);
		await app.close();
	});

	// ── 鉴权 ──

	it("POST /api/ai/conversations 未登录：401（§8.2 行 1）", async () => {
		await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.send({ content: "你好" })
			.expect(401);
	});

	// ── 首条消息并建会话（SSE 帧序 + 落库 + title）──

	it("POST /api/ai/conversations 正常首条消息：meta→token*→done；会话与两条消息落库；title=前 20 字；所有帧 data 合法 JSON 且换行 delta 被整包转义（§8.2 行 2）", async () => {
		const longContent =
			"请介绍一下美元兑人民币的近况，这条消息超过二十个字用于验证标题截断";
		const reply = "第一行回复\n第二行回复";
		scriptHolder.steps = [textReply(reply, { input: 12, output: 8 })];

		const res = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: longContent })
			.expect(200);

		const frames = parseSse(res.text);
		const events = frames.map((frame) => frame.event);
		expect(events[0]).toBe("meta");
		expect(events.at(-1)).toBe("done");
		// meta 与 done 之间全部为 token 帧
		expect(events.slice(1, -1).every((event) => event === "token")).toBe(true);

		const meta = frames[0].data as {
			conversationId: string;
			userMessageId: string;
			title: string;
		};
		expect(meta.title).toBe(longContent.slice(0, 20));
		expect(meta.conversationId).toBeTruthy();

		const done = frames.at(-1)!.data as {
			assistantMessage: { id: string; role: string; content: string };
			usage: { inputTokens: number; outputTokens: number };
		};
		expect(done.assistantMessage.role).toBe("assistant");
		expect(done.assistantMessage.content).toBe(reply);
		expect(done.usage).toMatchObject({ inputTokens: 12, outputTokens: 8 });

		const deltas = frames
			.slice(1, -1)
			.map((frame) => frame.data.delta as string);
		expect(deltas.join("")).toBe(reply);

		// 会话与两条消息落库
		const conversation = await prisma.aiConversation.findUnique({
			where: { id: meta.conversationId },
			include: { messages: true },
		});
		expect(conversation?.userId).toBe(user.userId);
		expect(conversation?.title).toBe(longContent.slice(0, 20));
		expect(conversation?.messages).toHaveLength(2);
		expect(
			conversation?.messages.map((message) => message.role).sort(),
		).toEqual(["assistant", "user"]);
	});

	// ── 追问：模型能看到上文 ──

	it("POST /api/ai/conversations/:id/messages 追问：假模型收到的窗口含首轮 human+ai 消息（§8.2 行 3）", async () => {
		scriptHolder.steps = [textReply("首轮回答")];
		const first = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "第一轮问题" })
			.expect(200);
		const conversationId = (
			parseSse(first.text)[0].data as { conversationId: string }
		).conversationId;

		scriptHolder.steps = [textReply("第二轮回答")];
		const second = await request(app.getHttpServer())
			.post(`/api/ai/conversations/${conversationId}/messages`)
			.set(bearer(user.accessToken))
			.send({ content: "第二轮问题" })
			.expect(200);
		expect(parseSse(second.text).at(-1)?.event).toBe("done");

		// 用例内 shared 未重置：captured[0] 为首轮调用，at(-1) 为本轮（第二轮）调用输入
		// = system + 首轮 human/ai + 本轮 human
		const captured = scriptHolder.shared.captured.at(-1)!;
		const roles = captured.map((message) => message.getType());
		expect(roles[0]).toBe("system");
		expect(roles.filter((role) => role === "human")).toHaveLength(2);
		expect(roles).toContain("ai");
		const contents = captured.map((message) => String(message.content));
		expect(contents).toContain("第一轮问题");
		expect(contents).toContain("首轮回答");
	});

	// ── 模型列表接口（ai-model-whitelist §8.2）──

	it("GET /api/ai/models 未登录：401", async () => {
		await request(app.getHttpServer()).get("/api/ai/models").expect(401);
	});

	it("GET /api/ai/models 正常：200，items 恰 5 项按 costTier 升序；序列化不含敏感字段字样", async () => {
		const res = await request(app.getHttpServer())
			.get("/api/ai/models")
			.set(bearer(user.accessToken))
			.expect(200);
		const items = res.body.data.items as {
			key: string;
			costTier: number;
		}[];
		expect(items).toHaveLength(5);
		const tiers = items.map((item) => item.costTier);
		expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
		expect(items.map((item) => item.key)).toContain("gpt-4.1-mini");

		// 密钥纪律：响应体不含密钥变量名/网关地址/上游真实名/采样参数（§4.1）
		const serialized = JSON.stringify(res.body);
		expect(serialized).not.toContain("apiKeyEnvName");
		expect(serialized).not.toContain("baseURL");
		expect(serialized).not.toContain('"model"');
		expect(serialized).not.toContain("temperature");
		expect(serialized).not.toContain("maxTokens");
		expect(serialized).not.toContain("gpt-5.6-luna");
	});

	// ── 发消息带 modelKey：全链路贯通（§8.2）──

	it("POST /api/ai/conversations 带 modelKey=gpt-5.5：工厂收到该 key；done 帧 model=gpt-5.5；助手消息落库 model=gpt-5.5", async () => {
		scriptHolder.steps = [textReply("五点五回复")];
		const res = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "用 GPT-5.5 回答", modelKey: "gpt-5.5" })
			.expect(200);

		const frames = parseSse(res.text);
		expect(scriptHolder.shared.modelKeys).toEqual(["gpt-5.5"]);
		const done = frames.at(-1)!;
		expect(done.event).toBe("done");
		expect(done.data.model).toBe("gpt-5.5");

		const conversationId = (frames[0].data as { conversationId: string })
			.conversationId;
		const assistant = await prisma.aiMessage.findFirst({
			where: { conversationId, role: "assistant" },
		});
		expect(assistant?.model).toBe("gpt-5.5");
	});

	it("POST /api/ai/conversations 不带 modelKey：工厂收到默认模型（AI_DEFAULT_CHAT_MODEL），done 帧与落库同", async () => {
		scriptHolder.steps = [textReply("默认模型回复")];
		const res = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "用默认模型回答" })
			.expect(200);

		const defaultKey =
			process.env.AI_DEFAULT_CHAT_MODEL ?? "gpt-4.1-mini";
		expect(scriptHolder.shared.modelKeys).toEqual([defaultKey]);
		expect(
			(parseSse(res.text).at(-1)!.data as { model: string }).model,
		).toBe(defaultKey);
	});

	it("POST /api/ai/conversations modelKey 超长（>64）：400（DTO 形状层 @MaxLength 拦截，全局错误体格式）", async () => {
		// 分层契约（ai-model-whitelist §4.2）：形状错误由全局 ValidationPipe 拦截，
		// 响应体为全局既有格式 { message: string[], statusCode }（与其他模块 DTO 校验一致）；
		// 白名单语义层 400 才是 { code: "AI_MODEL_UNKNOWN" }（service 兜底兜「合法字符但非白名单」）
		const res = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "超长 key", modelKey: "a".repeat(65) })
			.expect(400);
		expect(JSON.stringify(res.body.message)).toContain("modelKey 最长 64 字符");
	});

	it("POST /api/ai/conversations/:id/messages 追问带 modelKey：合法透传工厂/done 帧；非法 400 AI_MODEL_UNKNOWN", async () => {
		scriptHolder.steps = [textReply("首轮")];
		const first = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "首轮问题" })
			.expect(200);
		const conversationId = (
			parseSse(first.text)[0].data as { conversationId: string }
		).conversationId;

		// 合法：透传工厂、done 帧 model 正确
		scriptHolder.steps = [textReply("claude 回复")];
		const ok = await request(app.getHttpServer())
			.post(`/api/ai/conversations/${conversationId}/messages`)
			.set(bearer(user.accessToken))
			.send({ content: "追问", modelKey: "claude-sonnet-4-6" })
			.expect(200);
		expect(scriptHolder.shared.modelKeys.at(-1)).toBe("claude-sonnet-4-6");
		expect(
			(parseSse(ok.text).at(-1)!.data as { model: string }).model,
		).toBe("claude-sonnet-4-6");

		// 非法：400（追问端点同闸），不落消息
		const before = await prisma.aiMessage.count({
			where: { conversationId },
		});
		const bad = await request(app.getHttpServer())
			.post(`/api/ai/conversations/${conversationId}/messages`)
			.set(bearer(user.accessToken))
			.send({ content: "非法追问", modelKey: "claude-3-opus" })
			.expect(400);
		expect(bad.body.code).toBe("AI_MODEL_UNKNOWN");
		const after = await prisma.aiMessage.count({
			where: { conversationId },
		});
		expect(after).toBe(before);
	});

	it("GET /ai/conversations/:id/messages 混合存量（model=null）与新消息：items 含 model，存量 null", async () => {
		scriptHolder.steps = [textReply("新回复")];
		const res = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "混合存量用例" })
			.expect(200);
		const frames = parseSse(res.text);
		const conversationId = (frames[0].data as { conversationId: string })
			.conversationId;

		// 模拟存量：将本轮 user 消息与新 assistant 消息之外的另一条置 NULL 不够直观，
		// 直接直插一条 model=NULL 的存量 assistant 消息（迁移后存量行形态）
		await prisma.aiMessage.create({
			data: {
				conversationId,
				role: "assistant",
				content: "存量回复（无模型标记）",
			},
		});

		const list = await request(app.getHttpServer())
			.get(`/api/ai/conversations/${conversationId}/messages`)
			.set(bearer(user.accessToken))
			.expect(200);
		const items = list.body.data.items as {
			role: string;
			model: string | null;
		}[];
		// user 消息恒 null；新 assistant 消息带默认模型；直插存量 assistant 为 null
		expect(items[0]).toMatchObject({ role: "user", model: null });
		expect(items[1]).toMatchObject({
			role: "assistant",
			model: "gpt-4.1-mini",
		});
		expect(items[2]).toMatchObject({
			role: "assistant",
			model: null,
		});
	});

	// ── 工具环：RateService 被调、tool 帧出现、查询结果回喂（§8.2 行 5）──

	it("假模型发起 tool_call：RateService 被调、tool 帧 start/end 出现、ToolMessage 含查询结果、最终回复 done（§8.2 行 5）", async () => {
		// 预置刚经 latest 确认的报价，让工具命中缓存。
		await prisma.exchangeRate.deleteMany({
			where: { base: "CNY", quote: "USD" },
		});
		const now = new Date();
		await prisma.exchangeRate.create({
			data: {
				base: "CNY",
				quote: "USD",
				rate: "7.1200000000",
				source: "er-api",
				observedAt: now,
				latestConfirmedAt: now,
			},
		});

		scriptHolder.steps = [
			{
				message: new AIMessage({
					content: "",
					tool_calls: [
						{
							id: "call_1",
							name: "query_exchange_rate",
							args: { mode: "latest", base: "CNY", targets: ["USD"] },
						},
					],
				}),
			},
			textReply("USD 兑 CNY 最新价为 7.12（数据已查询）。"),
		];

		const res = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "现在美元兑人民币多少？" })
			.expect(200);

		const frames = parseSse(res.text);
		const toolFrames = frames.filter((frame) => frame.event === "tool");
		expect(toolFrames.map((frame) => frame.data.state)).toEqual([
			"start",
			"end",
		]);
		expect(toolFrames[0].data.name).toBe("query_exchange_rate");
		expect(frames.at(-1)?.event).toBe("done");

		// 第二次模型调用收到 ToolMessage，内容来自真实 RateService 查询（预置行 7.12）
		const secondCall = scriptHolder.shared.captured[1];
		const toolMessage = secondCall.find(
			(message) => message.getType() === "tool",
		);
		expect(String(toolMessage?.content)).toContain("7.12");

		await prisma.exchangeRate.deleteMany({
			where: { base: "CNY", quote: "USD" },
		});
	});

	it("行情工具把混合序列中起点、终点及两个独立极值的来源回喂模型", async () => {
		const today = new Date();
		today.setUTCHours(0, 0, 0, 0);
		const daysAgo = (days: number) => new Date(today.getTime() - days * 86_400_000);
		const start = daysAgo(6);
		const high = daysAgo(4);
		const low = daysAgo(2);
		const end = daysAgo(1);
		const day = (date: Date) => date.toISOString().slice(0, 10);
		const pair = { base: "CAD", quote: "TWD" };
		const localPoints = [
			{ ...pair, observedAt: start, rate: "0.22", source: "er-api" },
			{ ...pair, observedAt: low, rate: "0.2", source: "er-api" },
		];
		await prisma.exchangeRate.createMany({ data: localPoints });
		const reference = vi.spyOn(app.get(RateProvider), "fetchReferenceSeries")
			.mockResolvedValue([
				{ observedAt: high, rate: "0.25" },
				{ observedAt: end, rate: "0.21" },
			]);
		try {
			scriptHolder.steps = [
				{
					message: new AIMessage({
						content: "",
						tool_calls: [{
							id: "call_history_sources",
							name: "query_exchange_rate",
							args: { mode: "history", base: "CAD", target: "TWD", period: 7 },
						}],
					}),
				},
				textReply("已查询七天内的汇率走势。"),
			];
			const res = await request(app.getHttpServer())
				.post("/api/ai/conversations")
				.set(bearer(user.accessToken))
				.send({ content: "查询加元兑台币最近七天的汇率走势" })
				.expect(200);
			expect(parseSse(res.text).at(-1)?.event).toBe("done");
			expect(reference).toHaveBeenCalledExactlyOnceWith(
				"CAD", "TWD", expect.any(String), expect.any(String),
			);

			const toolMessage = scriptHolder.shared.captured[1]?.find(
				(message) => message.getType() === "tool",
			);
			const summary = String(toolMessage?.content);
			expect(summary).toContain("CAD/TWD 近 7 天历史走势（4 个数据点，其中 2 个数据点为参考价");
			expect(summary).toContain(`起点 ${day(start)} = 0.22（原来源报价：er-api）`);
			expect(summary).toContain(`终点 ${day(end)} = 0.21（参考价：frankfurter v2 参考序列）`);
			expect(summary).toContain(`区间最高 ${day(high)} = 0.25（参考价：frankfurter v2 参考序列）`);
			expect(summary).toContain(`区间最低 ${day(low)} = 0.2（原来源报价：er-api）`);
		} finally {
			reference.mockRestore();
			await prisma.exchangeRate.deleteMany({
				where: { ...pair, observedAt: { in: [start, low] } },
			});
		}
	});

	// ── 参数校验 ──

	it("content 空白 / 超 2000 字：400 AI_MESSAGE_EMPTY（§8.2 行 6）", async () => {
		for (const content of ["   ", "a".repeat(2001)]) {
			const res = await request(app.getHttpServer())
				.post("/api/ai/conversations")
				.set(bearer(user.accessToken))
				.send({ content })
				.expect(400);
			expect(res.body.code).toBe("AI_MESSAGE_EMPTY");
		}
	});

	// ── 404 防枚举 ──

	it("追问 他人会话 id / 不存在 id：统一 404 AI_CONVERSATION_NOT_FOUND（§8.2 行 7）", async () => {
		scriptHolder.steps = [textReply("他人在用")];
		const otherRes = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(other.accessToken))
			.send({ content: "他人的会话" })
			.expect(200);
		const otherConversationId = (
			parseSse(otherRes.text)[0].data as { conversationId: string }
		).conversationId;

		for (const id of [otherConversationId, "nonexistent-id"]) {
			const res = await request(app.getHttpServer())
				.post(`/api/ai/conversations/${id}/messages`)
				.set(bearer(user.accessToken))
				.send({ content: "越权追问" })
				.expect(404);
			expect(res.body.code).toBe("AI_CONVERSATION_NOT_FOUND");
		}
	});

	it("GET /api/ai/conversations/:id/messages 他人/不存在 → 404；limit=0/501 → 400（§8.2 行 8）", async () => {
		scriptHolder.steps = [textReply("消息列表")];
		const created = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "列表用例会话" })
			.expect(200);
		const conversationId = (
			parseSse(created.text)[0].data as { conversationId: string }
		).conversationId;

		const otherMessages = await request(app.getHttpServer())
			.get(`/api/ai/conversations/${conversationId}/messages`)
			.set(bearer(other.accessToken))
			.expect(404);
		expect(otherMessages.body.code).toBe("AI_CONVERSATION_NOT_FOUND");

		await request(app.getHttpServer())
			.get("/api/ai/conversations/nonexistent-id/messages")
			.set(bearer(user.accessToken))
			.expect(404);

		await request(app.getHttpServer())
			.get(`/api/ai/conversations/${conversationId}/messages?limit=0`)
			.set(bearer(user.accessToken))
			.expect(400);
		await request(app.getHttpServer())
			.get(`/api/ai/conversations/${conversationId}/messages?limit=501`)
			.set(bearer(user.accessToken))
			.expect(400);

		// 合法 limit：本人可读、升序
		const ok = await request(app.getHttpServer())
			.get(`/api/ai/conversations/${conversationId}/messages`)
			.set(bearer(user.accessToken))
			.expect(200);
		expect(ok.body.data.items).toHaveLength(2);
		expect(
			ok.body.data.items.map((item: { role: string }) => item.role),
		).toEqual(["user", "assistant"]);
	});

	// ── 409 busy：挂起档 + 落库门槛（§8.2 行 9）──

	it("同会话流进行中并发第二发：409 AI_CONVERSATION_BUSY（落库为确定性门槛，不赌时序）", async () => {
		const gate = { promise: Promise.resolve() };
		let release!: () => void;
		gate.promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		scriptHolder.steps = [{ gate }];

		// supertest Test 对象为 thenable：不 await 不会发起请求；
		// 挂起档以 .then() 触发 fire-and-forget（返回原生 Promise，后文 await 语义不变）
		const firstPromise: Promise<{ status: number }> = request(
			app.getHttpServer(),
		)
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "挂起的首发" })
			.then((res) => ({ status: res.status }));

		// 确定性门槛：用户消息已落库（替代 sleep 赌时序），并取得会话 id
		let conversationId = "";
		await waitUntil(async () => {
			const row = await prisma.aiConversation.findFirst({
				where: { userId: user.userId, title: "挂起的首发" },
			});
			conversationId = row?.id ?? "";
			return conversationId !== "";
		});

		// 同会话流进行中再发 → 409（§4：追问端点命中忙碌标记）
		const second = await request(app.getHttpServer())
			.post(`/api/ai/conversations/${conversationId}/messages`)
			.set(bearer(user.accessToken))
			.send({ content: "并发的第二发" })
			.expect(409);
		expect(second.body.code).toBe("AI_CONVERSATION_BUSY");

		release();
		const first = await firstPromise;
		expect(first.status).toBe(200);
	});

	// ── DELETE：流进行中 409；结束后 200 且级联消失（§8.2 行 10）──

	it("DELETE 流进行中删除 → 409；流结束后删除 → 200 且消息级联消失", async () => {
		const gate = { promise: Promise.resolve() };
		let release!: () => void;
		gate.promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		scriptHolder.steps = [{ gate }];

		const streamPromise: Promise<{ status: number; text: string }> = request(
			app.getHttpServer(),
		)
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "删除时序用例" })
			.then((res) => ({ status: res.status, text: res.text }));

		let conversationId = "";
		await waitUntil(async () => {
			const row = await prisma.aiConversation.findFirst({
				where: { userId: user.userId, title: "删除时序用例" },
			});
			conversationId = row?.id ?? "";
			return conversationId !== "";
		});

		await request(app.getHttpServer())
			.delete(`/api/ai/conversations/${conversationId}`)
			.set(bearer(user.accessToken))
			.expect(409);

		release();
		const streamRes = await streamPromise;
		expect(streamRes.status).toBe(200);

		await request(app.getHttpServer())
			.delete(`/api/ai/conversations/${conversationId}`)
			.set(bearer(user.accessToken))
			.expect(200);

		const remaining = await prisma.aiMessage.count({
			where: { conversationId },
		});
		expect(remaining).toBe(0);
	});

	// ── 上游失败：error 帧 + 一致性（§8.2 行 11）──

	it("假模型中途抛错：error 帧 AI_UPSTREAM_FAILED（固定文案）；助手消息未落库、用户消息在", async () => {
		scriptHolder.steps = [{ throwError: new Error("upstream boom") }];

		const res = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "会失败的消息" })
			.expect(200);

		const frames = parseSse(res.text);
		const errorFrame = frames.at(-1)!;
		expect(errorFrame.event).toBe("error");
		expect(errorFrame.data).toEqual({
			code: "AI_UPSTREAM_FAILED",
			message: "回复生成失败，请稍后重试",
		});

		const conversationId = (frames[0].data as { conversationId: string })
			.conversationId;
		const messages = await prisma.aiMessage.findMany({
			where: { conversationId },
		});
		expect(messages.map((message) => message.role)).toEqual(["user"]);
	});

	// ── 流式中会话被删：P2025 → error 帧 404 收尾（§8.2 行 12）──

	it("流式中删除会话（prisma 直删竞态 + 放行）：error 帧 AI_CONVERSATION_NOT_FOUND，助手消息不落库，无未处理异常", async () => {
		const gate = { promise: Promise.resolve() };
		let release!: () => void;
		gate.promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		scriptHolder.steps = [{ gate }];

		const streamPromise: Promise<{ status: number; text: string }> = request(
			app.getHttpServer(),
		)
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "流中被删的会话" })
			.then((res) => ({ status: res.status, text: res.text }));

		let conversationId = "";
		await waitUntil(async () => {
			const row = await prisma.aiConversation.findFirst({
				where: { userId: user.userId, title: "流中被删的会话" },
			});
			conversationId = row?.id ?? "";
			return conversationId !== "";
		});

		// 绕过 DELETE 端点的 409 保护，直删模拟「流式中会话消失」竞态（P2025 路径）
		await prisma.aiConversation.delete({ where: { id: conversationId } });

		release();
		const res = await streamPromise;
		expect(res.status).toBe(200);

		const frames = parseSse(res.text);
		const errorFrame = frames.at(-1)!;
		expect(errorFrame.event).toBe("error");
		expect(errorFrame.data).toEqual({
			code: "AI_CONVERSATION_NOT_FOUND",
			message: "会话不存在或已被删除",
		});

		const messages = await prisma.aiMessage.count({
			where: { conversationId },
		});
		expect(messages).toBe(0);
	});

	// ── 客户端中途 abort（§8.2 行 13）──

	it("客户端中途 abort：服务端终止流；助手消息不落库；abort 信号透传到模型层", async () => {
		const gate = { promise: Promise.resolve() };
		let release!: () => void;
		gate.promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		scriptHolder.steps = [{ gate }];

		await prisma.aiConversation.deleteMany({
			where: { userId: user.userId, title: "断连用例" },
		});

		// supertest 无法中途 abort，用原生 fetch + AbortSignal（Node 18+）；
		// supertest 模式下 server 未监听，手动 listen(0) 取临时端口
		const server = app.getHttpServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, () => resolve());
		});
		const address = server.address();
		if (typeof address !== "object" || address === null) {
			throw new Error("http server not listening");
		}
		const clientAbort = new AbortController();
		// 动态端口 URL 必须经 localTestFetch 的同函数回环校验（裸模板串 fetch 会被
		// 静态污点分析判 SSRF；127.0.0.1 临时端口是测试基建唯一目标）
		const fetchPromise = localTestFetch(
			`http://127.0.0.1:${address.port}/api/ai/conversations`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${user.accessToken}`,
				},
				body: JSON.stringify({ content: "断连用例" }),
				signal: clientAbort.signal,
			},
		);

		let conversationId = "";
		await waitUntil(async () => {
			const row = await prisma.aiConversation.findFirst({
				where: { userId: user.userId, title: "断连用例" },
			});
			conversationId = row?.id ?? "";
			return conversationId !== "";
		});

		clientAbort.abort();
		// 略等连接关闭传播到服务端（res 'close' → abort.abort()），再放行模型，
		// 确保「模型观察到 abort 信号」的断言确定成立
		await new Promise((resolve) => setTimeout(resolve, 100));
		release();

		// fetch 在响应头到达（meta 帧 flush）时即 resolve；abort 作用于 body 流——
		// 读取应中断（AbortError）或提前终止（助手消息不落库即为行为证据）
		const response = await fetchPromise;
		const reader = response.body!.getReader();
		clientAbort.abort();
		release();
		try {
			await reader.read();
		} catch {
			// AbortError：预期路径
		}
		// 等待流终态清理完成
		await waitUntil(async () => {
			const count = await prisma.aiMessage.count({
				where: { conversationId },
			});
			return count === 1; // 仅用户消息
		});
		expect(scriptHolder.shared.sawAbort).toBe(true);
	});

	// ── 会话列表：倒序 + 仅本人（§8.2 行 18）──

	it("GET /api/ai/conversations：按 lastMessageAt 倒序、仅本人数据、含 messageCount", async () => {
		const mine = ["列表甲", "列表乙"];
		for (const content of mine) {
			scriptHolder.steps = [textReply("列表回复")];
			await request(app.getHttpServer())
				.post("/api/ai/conversations")
				.set(bearer(user.accessToken))
				.send({ content })
				.expect(200);
		}

		const res = await request(app.getHttpServer())
			.get("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.expect(200);

		const items = res.body.data.items as {
			id: string;
			title: string;
			messageCount: number;
		}[];
		expect(items.length).toBeGreaterThanOrEqual(2);
		const titles = items.map((item) => item.title);
		// 甲在乙之前创建 → 倒序后乙在前
		expect(titles.indexOf("列表乙")).toBeLessThan(titles.indexOf("列表甲"));
		// 仅断言本用例创建的会话（前序用例可能遗留 1 条消息的失败路径会话）
		for (const title of mine) {
			const item = items.find((entry) => entry.title === title);
			expect(item?.messageCount).toBe(2);
		}
	});
});

// ────────────────────────── env 注入场景（独立 app 实例）──────────────────────────

describe("AiController env 场景（§8.2 行 4/14/15/16/17）", () => {
	let ctx: TestContext;
	let app: INestApplication;
	let prisma: PrismaService;
	let user: TestUser;
	const userIds: string[] = [];

	// 每用例一个独立 env 的 app；用例开头关闭前一个，避免全量跑下
	// 多个 Prisma 连接池同时打开拖慢新 app 编译与轮询
	beforeEach(() => {
		scriptHolder.steps = [];
		scriptHolder.shared = newShared();
	});

	const closePreviousApp = async (): Promise<void> => {
		if (app) {
			await app.close();
			app = undefined as unknown as INestApplication;
		}
	};

	afterAll(async () => {
		for (const id of userIds) await cleanupUser(prisma, id);
		if (app) await app.close();
	});

	it("窗口裁剪：AI_CHAT_HISTORY_WINDOW=3、预置 5 条历史 → 模型收到的非 system 消息 = 3 条历史 + 1 条新消息，不含最旧一条（§8.2 行 4）", {
		timeout: 30_000,
	}, async () => {
		await closePreviousApp();
		ctx = await buildAiApp({ AI_CHAT_HISTORY_WINDOW: "3" });
		app = ctx.app;
		prisma = ctx.prisma;
		user = await createTestUser(app, "ai-window");
		userIds.push(user.userId);

		const conversation = await prisma.aiConversation.create({
			data: { userId: user.userId, title: "窗口用例" },
		});
		// 显式递增 createdAt：同批 createMany 的 default(now()) 完全相同，
		// orderBy createdAt desc 无 tiebreaker 会取错「最近 3 条」
		const base = Date.now() - 60_000;
		const history = Array.from({ length: 5 }, (_, index) => ({
			conversationId: conversation.id,
			role: index % 2 === 0 ? "user" : "assistant",
			content: `历史消息${index + 1}`,
			createdAt: new Date(base + index * 1000),
		}));
		await prisma.aiMessage.createMany({ data: history });

		scriptHolder.steps = [textReply("窗口回复")];
		const res = await request(app.getHttpServer())
			.post(`/api/ai/conversations/${conversation.id}/messages`)
			.set(bearer(user.accessToken))
			.send({ content: "最新一条问题" })
			.expect(200);
		expect(parseSse(res.text).at(-1)?.event).toBe("done");

		const captured = scriptHolder.shared.captured[0];
		const nonSystem = captured.filter(
			(message) => message.getType() !== "system",
		);
		expect(nonSystem).toHaveLength(4); // window=3 历史 + 本次 1 条
		const contents = nonSystem.map((message) => String(message.content));
		expect(contents).not.toContain("历史消息1"); // 最旧被裁剪
		expect(contents).toContain("历史消息5"); // 含最近一条历史
		expect(contents).toContain("最新一条问题"); // 含本次消息
	});

	it("并发上限 1 + 挂起流占满：新请求 429 AI_BUSY（§8.2 行 14）", {
		timeout: 30_000,
	}, async () => {
		await closePreviousApp();
		ctx = await buildAiApp({ AI_CHAT_MAX_CONCURRENCY: "1" });
		app = ctx.app;
		prisma = ctx.prisma;
		user = await createTestUser(app, "ai-busy");
		userIds.push(user.userId);

		const gate = { promise: Promise.resolve() };
		let release!: () => void;
		gate.promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		scriptHolder.steps = [{ gate }];

		const firstPromise: Promise<{ status: number }> = request(
			app.getHttpServer(),
		)
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "占满并发的首发" })
			.then((res) => ({ status: res.status }));

		await waitUntil(async () => {
			const row = await prisma.aiConversation.findFirst({
				where: { userId: user.userId, title: "占满并发的首发" },
			});
			return row?.id != null;
		});

		const second = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "被拒的第二发" })
			.expect(429);
		expect(second.body.code).toBe("AI_BUSY");

		release();
		expect((await firstPromise).status).toBe(200);
	});

	it("日配额=2：第 3 条消息 429 AI_QUOTA_EXCEEDED（§8.2 行 15）", {
		timeout: 30_000,
	}, async () => {
		await closePreviousApp();
		ctx = await buildAiApp({ AI_DAILY_MESSAGE_QUOTA: "2" });
		app = ctx.app;
		prisma = ctx.prisma;
		user = await createTestUser(app, "ai-quota");
		userIds.push(user.userId);

		for (const content of ["配额第一条", "配额第二条"]) {
			scriptHolder.steps = [textReply("配额回复")];
			await request(app.getHttpServer())
				.post("/api/ai/conversations")
				.set(bearer(user.accessToken))
				.send({ content })
				.expect(200);
		}

		scriptHolder.steps = [textReply("配额回复")];
		const third = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "配额第三条" })
			.expect(429);
		expect(third.body.code).toBe("AI_QUOTA_EXCEEDED");

		// 429 不留空会话痕迹
		const count = await prisma.aiConversation.count({
			where: { userId: user.userId },
		});
		expect(count).toBe(2);
	});

	it("POST /api/ai/conversations modelKey=gpt-4o 非白名单：400 AI_MODEL_UNKNOWN；配额/信号量/落库零消耗（gate 最前）", {
		timeout: 30_000,
	}, async () => {
		// 独立 app：并发=1（信号量被占则后发全 429）+ 配额=2（非法请求烧配额则成功次数变少）
		await closePreviousApp();
		ctx = await buildAiApp({
			AI_CHAT_MAX_CONCURRENCY: "1",
			AI_DAILY_MESSAGE_QUOTA: "2",
		});
		app = ctx.app;
		prisma = ctx.prisma;
		user = await createTestUser(app, "ai-model-unknown");
		userIds.push(user.userId);

		for (const modelKey of ["gpt-4o", "GPT-4.1-MINI"]) {
			// 大小写变形（pattern 合法）穿透形状层，由白名单语义层兜底
			const res = await request(app.getHttpServer())
				.post("/api/ai/conversations")
				.set(bearer(user.accessToken))
				.send({ content: "非法模型", modelKey })
				.expect(400);
		console.log("[DEBUG-RESP2] status:", res.status, "body:", JSON.stringify(res.body), "modelKey:", JSON.stringify(modelKey));
			expect(res.body.code).toBe("AI_MODEL_UNKNOWN");
		}
		expect(scriptHolder.shared.modelKeys).toEqual([]); // 工厂从未被调

		// 含空格（形状层非法字符）：全局 ValidationPipe @Matches 拦截，400 全局错误体格式
		const resSp = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "非法模型", modelKey: "gpt 4.1-mini" })
			.expect(400);
		expect(JSON.stringify(resSp.body.message)).toContain("modelKey 含非法字符");

		// 配额与信号量零消耗：后续两次合法发送仍 200（配额=2 恰好用完）
		for (const content of ["合法一", "合法二"]) {
			scriptHolder.steps = [textReply("正常回复")];
			await request(app.getHttpServer())
				.post("/api/ai/conversations")
				.set(bearer(user.accessToken))
				.send({ content })
				.expect(200);
		}
		// 无空会话痕迹（400 时未建会话）
		const count = await prisma.aiConversation.count({
			where: { userId: user.userId },
		});
		expect(count).toBe(2);
	});

	it("全部模型密钥未配（显式 delete 四个 aigysd 变量防本地 .env.local 假绿）：503 AI_NOT_CONFIGURED", {
		timeout: 30_000,
	}, async () => {
		await closePreviousApp();
		ctx = await buildAiApp({
			AI_PROVIDER_AIGYSD_API_KEY: undefined,
			AI_PROVIDER_AIGYSD_BASE_URL: undefined,
			AI_PROVIDER_AIGYSD_ANTHROPIC_API_KEY: undefined,
			AI_PROVIDER_AIGYSD_GEMINI_API_KEY: undefined,
		});
		app = ctx.app;
		prisma = ctx.prisma;
		user = await createTestUser(app, "ai-nokey");
		userIds.push(user.userId);

		const res = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "你好" })
			.expect(503);
		expect(res.body.code).toBe("AI_NOT_CONFIGURED");

		// 列表接口是白名单投影，不受密钥影响：仍 200 全量（§4.1）
		const models = await request(app.getHttpServer())
			.get("/api/ai/models")
			.set(bearer(user.accessToken))
			.expect(200);
		expect(models.body.data.items).toHaveLength(5);
	});

	it("单模型密钥未配（仅删 ANTHROPIC key）：该模型 503 且不烧配额，改发 gpt-4.1-mini 仍成功（分模型降级）", {
		timeout: 30_000,
	}, async () => {
		await closePreviousApp();
		// 配额=1：503 若误烧配额，后续合法发送会 429（防假绿）
		ctx = await buildAiApp({
			AI_PROVIDER_AIGYSD_ANTHROPIC_API_KEY: undefined,
			AI_DAILY_MESSAGE_QUOTA: "1",
		});
		app = ctx.app;
		prisma = ctx.prisma;
		user = await createTestUser(app, "ai-partial-key");
		userIds.push(user.userId);

		const blocked = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "用 Claude 回答", modelKey: "claude-sonnet-4-6" })
			.expect(503);
		expect(blocked.body.code).toBe("AI_NOT_CONFIGURED");

		// 分模型降级：其余模型不受影响，且配额未被 503 消耗
		scriptHolder.steps = [textReply("mini 回复")];
		const ok = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "用 mini 回答", modelKey: "gpt-4.1-mini" })
			.expect(200);
		expect(parseSse(ok.text).at(-1)?.event).toBe("done");
	});

	it("AI_CHAT_ENABLED=false：503 AI_DISABLED（§8.2 行 17）", {
		timeout: 30_000,
	}, async () => {
		await closePreviousApp();
		ctx = await buildAiApp({ AI_CHAT_ENABLED: "false" });
		app = ctx.app;
		prisma = ctx.prisma;
		user = await createTestUser(app, "ai-disabled");
		userIds.push(user.userId);

		const res = await request(app.getHttpServer())
			.post("/api/ai/conversations")
			.set(bearer(user.accessToken))
			.send({ content: "你好" })
			.expect(503);
		expect(res.body.code).toBe("AI_DISABLED");
	});
});
