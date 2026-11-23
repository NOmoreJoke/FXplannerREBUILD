import { Inject, Injectable, Logger, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "@prisma/client";
import type { ReadScope } from "../authorization/organization-scope";
import { ConcurrencySemaphore } from "./ai-concurrency-semaphore";
import {
	AiBusyException,
	AiConversationBusyException,
	AiConversationNotFoundException,
	AiDisabledException,
	AiMessageEmptyException,
	AiModelUnknownException,
	AiNotConfiguredException,
	AiQuotaExceededException,
} from "./ai.errors";
import {
	resolveChatModelConfig,
	resolveDefaultChatModelKey,
	type ResolvedChatModelConfig,
} from "./ai-models.config";
import type { AiHistoryMessage } from "./ai-agent.service";
import { AI_RUNTIME_CONFIG, type AiRuntimeConfig } from "./llm/ai-runtime-config";

/** 消息长度上限（§4：1~2000 字符，trim 后非空） */
export const AI_MESSAGE_MAX_LENGTH = 2000;
/** 会话标题 = 首条消息前 20 字（§2 辅助决策，不额外调 LLM） */
export const AI_TITLE_MAX_LENGTH = 20;
/** 列表查询 limit 上限（§4：会话列表 1~100、消息列表 1~500） */
export const AI_LIST_LIMIT_CAPS = { conversations: 100, messages: 500 } as const;

/** modelKey DTO 形状规则（ai-model-whitelist 技术方案 §4.2，与 SendMessageDto 装饰器同步） */
const MODEL_KEY_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MODEL_KEY_MAX_LENGTH = 64;

interface PreparedChat {
	conversation: { id: string; title: string };
	userMessageId: string;
	history: AiHistoryMessage[];
	/** 服务端 resolve 后的模型配置（落库/done 帧以 key 为权威值，非客户端原值） */
	modelConfig: ResolvedChatModelConfig;
}

/**
 * AI 会话/消息服务（ai-assistant 技术方案 §5.1 ai.service.ts）：
 * 事务边界在此——落用户消息/落助手消息/删会话；日配额计数在此；
 * 忙碌标记（每会话同一时刻仅 1 个进行中的流，进程内 Set）与信号量持有在此编排。
 *
 * 发送侧统一走 prepareChat，gate 顺序（§4/§5.1 + ai-model-whitelist §4.2）：
 * 开关与配置 → 白名单校验 → 密钥可用性预检（快照）→ 内容 → 归属校验（仅追问）→
 * 日配额 → 系统并发 → 会话忙碌 → 建会话（仅并建）→ 落用户消息。
 * 模型相关两道闸位于配额之前：配置类失败以 JSON 真状态码返回，
 * 不消耗配额、不占信号量、不落消息（§3.1 审核修订）。
 * 所有 gate 均在任何写操作之前（并建 429/409 不留空会话痕迹）；
 * 忙碌标记先于落用户消息（先标忙碌再落库，杜绝并发窗口，§2/§4）。
 */
@Injectable()
export class AiService {
	private readonly logger = new Logger(AiService.name);
	/** 每会话同一时刻仅允许 1 个进行中的流（内存 Set，进程消亡自动释放） */
	private readonly busyConversations = new Set<string>();
	/** 日配额计数：key = `${userId}:${YYYY-MM-DD}`（UTC；进程内，重启清零可接受） */
	private readonly dailyCounts = new Map<string, number>();

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(ConcurrencySemaphore) private readonly semaphore: ConcurrencySemaphore,
		@Inject(AI_RUNTIME_CONFIG) private readonly config: AiRuntimeConfig,
	) {}

	/** limit 边界野蛮校验：ValidationPipe 在 esbuild 转译的测试环境不生效（无参数类型
	 * 元数据），既有测试约定由 service 兜底 400；生产 tsc 下 DTO 与本层双保险（§4） */
	private assertListLimit(limit: number, cap: number): void {
		if (!Number.isInteger(limit) || limit < 1 || limit > cap) {
			throw new BadRequestException(`limit 必须是 1~${cap} 之间的整数`);
		}
	}

	/** 降级阶梯①②（§6 + ai-model-whitelist §3.4 三档）：全部模型密钥未配 →
	 * AI_NOT_CONFIGURED；开关关闭 → AI_DISABLED。全部 AI 端点适用 */
	assertChatAvailable(): void {
		if (!this.config.hasConfiguredModel) throw new AiNotConfiguredException();
		if (!this.config.chatEnabled) throw new AiDisabledException();
	}

	/**
	 * 越权与不存在统一 404（防枚举，§4）；scope 可选：读路径传入时叠加组织隔离
	 * （会话个人所有 + 组织绑定，技术方案 §8.4），写路径不传保持原语义。
	 *
	 * 兼容窗口（Goal #3B W25 之前）——这里的 `organizationId IS NULL` 分支**有意不**
	 * 锚定默认组织（区别于 compatReadWhere，评审 I-08）：建会话/追问/删除的写路径
	 * 尚未接入组织作用域，新会话一律落 NULL。若读侧单独锚定，用户在非默认组织里
	 * 发出的会话会在该组织中不可见、也无法打开消息。因此在 W25 完成「全部 /ai/*
	 * 端点按 (id, userId, organizationId) 校验 + 建会话写入 organizationId」之前，
	 * AI 会话是**个人级**资源：仅本人可见（userId 隔离不变），但不按组织分区。
	 */
	async assertOwned(
		conversationId: string,
		userId: string,
		scope?: ReadScope,
	): Promise<{ id: string; title: string }> {
		const conversation = await this.prisma.aiConversation.findFirst({
			where: {
				id: conversationId,
				userId,
				...(scope
					? {
							OR: [
								{ organizationId: scope.organizationId },
								{ organizationId: null },
							],
						}
					: {}),
			},
			select: { id: true, title: true },
		});
		if (!conversation) throw new AiConversationNotFoundException();
		return conversation;
	}

	async listConversations(scope: ReadScope, limit?: number) {
		const effective = limit ?? 50;
		this.assertListLimit(effective, AI_LIST_LIMIT_CAPS.conversations);
		const rows = await this.prisma.aiConversation.findMany({
			where: {
				userId: scope.userId,
				OR: [
					{ organizationId: scope.organizationId },
					{ organizationId: null },
				],
			},
			orderBy: { lastMessageAt: "desc" },
			take: effective,
			include: { _count: { select: { messages: true } } },
		});
		return {
			items: rows.map((row) => ({
				id: row.id,
				title: row.title,
				lastMessageAt: row.lastMessageAt.toISOString(),
				messageCount: row._count.messages,
			})),
		};
	}

	async listMessages(
		conversationId: string,
		scope: ReadScope,
		limit?: number,
	) {
		// 归属校验（404 防枚举）先行于参数校验（§8.2 行 8 顺序）；叠加组织隔离
		await this.assertOwned(conversationId, scope.userId, scope);
		// DTO 默认值在 esbuild 转译的测试环境不生效，service 层兜底默认值
		const effective = limit ?? 200;
		this.assertListLimit(effective, AI_LIST_LIMIT_CAPS.messages);
		const rows = await this.prisma.aiMessage.findMany({
			where: { conversationId },
			orderBy: { createdAt: "asc" },
			take: effective,
		});
		return {
			items: rows.map((row) => ({
				id: row.id,
				role: row.role,
				content: row.content,
				model: row.model,
				createdAt: row.createdAt.toISOString(),
			})),
		};
	}

	/** 物理删除（规格：删除后所有入口不可见）；流进行中 409 拒绝（§4） */
	async deleteConversation(conversationId: string, userId: string): Promise<void> {
		await this.assertOwned(conversationId, userId);
		if (this.busyConversations.has(conversationId)) {
			throw new AiConversationBusyException("会话正在回复中，请稍后再删除");
		}
		await this.prisma.aiConversation.delete({ where: { id: conversationId } });
	}

	/**
	 * 模型相关两道闸（ai-model-whitelist §4.2，位于内容/配额之前）：
	 * ① 白名单精确查找：非法/变形 key → 400 AI_MODEL_UNKNOWN（fail-closed，不静默回退）；
	 * ② 快照密钥预检：该模型密钥未配 → 503 AI_NOT_CONFIGURED，其余模型不受影响（分模型降级）。
	 * 缺省 modelKey 回退服务端默认模型（AI_DEFAULT_CHAT_MODEL，加载期已断言在白名单内）。
	 */
	private resolveModelConfig(modelKey?: string): ResolvedChatModelConfig {
		// DTO @Matches/MaxLength 在 esbuild 转译的测试环境不生效（无参数类型元数据），
		// service 兑底同规则形状校验（先例 assertListLimit）；JSON.stringify 防日志伪造
		if (
			modelKey !== undefined &&
			(!MODEL_KEY_PATTERN.test(modelKey) || modelKey.length > MODEL_KEY_MAX_LENGTH)
		) {
			this.logger.warn(
				`AI 模型白名单校验失败（modelKey=${JSON.stringify(modelKey)}）`,
			);
			throw new AiModelUnknownException();
		}
		const modelConfig = resolveChatModelConfig(
			modelKey ?? resolveDefaultChatModelKey(),
		);
		if (!this.config.modelKeyAvailability[modelConfig.key]) {
			this.logger.warn(
				`AI 模型密钥未配置（modelKey=${modelConfig.key} env=${modelConfig.apiKeyEnvName}）`,
			);
			throw new AiNotConfiguredException();
		}
		return modelConfig;
	}

	/**
	 * 发送前置编排（gate 顺序见类注释）：通过后即持有信号量 + 忙碌标记，
	 * 调用方必须在流结束后调 finishStream() 释放（含异常路径）。
	 */
	async prepareChat(params: {
		userId: string;
		content: string;
		conversationId?: string;
		modelKey?: string;
	}): Promise<PreparedChat> {
		this.assertChatAvailable();
		// 模型两闸在配额之前（失败不消耗配额/信号量/不落消息，§3.1）
		const modelConfig = this.resolveModelConfig(params.modelKey);

		if (
			typeof params.content !== "string" ||
			params.content.trim().length === 0 ||
			params.content.trim().length > AI_MESSAGE_MAX_LENGTH
		) {
			throw new AiMessageEmptyException();
		}
		const content = params.content.trim();

		// 追问：归属校验先行（404 不消耗配额/并发额度）
		const existing = params.conversationId
			? await this.assertOwned(params.conversationId, params.userId)
			: undefined;

		this.checkAndIncrQuota(params.userId);
		if (!this.semaphore.tryAcquire()) throw new AiBusyException();

		// 先标忙碌再落用户消息（无并发窗口；重复发送 409）
		if (existing) {
			if (this.busyConversations.has(existing.id)) {
				this.semaphore.release();
				throw new AiConversationBusyException();
			}
			this.busyConversations.add(existing.id);
		}

		// 窗口取自「本次消息之前」的历史（不含新消息，由 agent 组装时追加）
		const history = existing
			? await this.getHistoryWindow(existing.id)
			: [];

		try {
			let conversation: { id: string; title: string };
			if (existing) {
				conversation = existing;
			} else {
				// 会话由服务端创建：title = content 前 20 字（§2 辅助决策）
				conversation = await this.prisma.aiConversation.create({
					data: {
						userId: params.userId,
						title: content.slice(0, AI_TITLE_MAX_LENGTH),
					},
					select: { id: true, title: true },
				});
				this.busyConversations.add(conversation.id);
			}

			const userMessage = await this.prisma.aiMessage.create({
				data: { conversationId: conversation.id, role: "user", content },
			});
			await this.prisma.aiConversation.update({
				where: { id: conversation.id },
				data: { lastMessageAt: userMessage.createdAt },
			});

			return {
				conversation,
				userMessageId: userMessage.id,
				history,
				modelConfig,
			};
		} catch (error) {
			// 落库失败：释放本次已占用的忙碌标记与信号量（不残留僵尸忙碌态）
			const conversationId = existing?.id;
			if (conversationId) this.busyConversations.delete(conversationId);
			this.semaphore.release();
			throw error;
		}
	}

	/** 流终态清理：释放信号量与忙碌标记（controller finally 必调） */
	finishStream(conversationId: string): void {
		this.semaphore.release();
		this.busyConversations.delete(conversationId);
	}

	/**
	 * 助手消息只在流式成功后落库（§3.2 一致性规则，无 status 列）。
	 * model 取 prepareChat resolve 后的服务端权威 key（非客户端原值，审核意见 #9）。
	 * 流式中会话被删 → update 抛 P2025 → 返回 null，controller 以 error 帧
	 * AI_CONVERSATION_NOT_FOUND 静默收尾（§6 中断与竞态一致性）。
	 */
	async saveAssistantMessage(
		conversationId: string,
		content: string,
		model: string,
	): Promise<{
		id: string;
		role: string;
		content: string;
		model: string | null;
		createdAt: Date;
	} | null> {
		try {
			return await this.prisma.$transaction(async (tx) => {
				await tx.aiConversation.update({
					where: { id: conversationId },
					data: { lastMessageAt: new Date() },
				});
				return tx.aiMessage.create({
					data: { conversationId, role: "assistant", content, model },
				});
			});
		} catch (error) {
			if (
				error instanceof Prisma.PrismaClientKnownRequestError &&
				error.code === "P2025"
			) {
				this.logger.warn(
					`助手消息落库时会话已消失（conversationId=${conversationId}），按 404 收尾`,
				);
				return null;
			}
			throw error;
		}
	}

	/** 用户级日配额（进程内计数；超 → 429 AI_QUOTA_EXCEEDED，§1.2 成本上界） */
	private checkAndIncrQuota(userId: string): void {
		const key = `${userId}:${new Date().toISOString().slice(0, 10)}`;
		const current = this.dailyCounts.get(key) ?? 0;
		if (current >= this.config.dailyQuota) throw new AiQuotaExceededException();
		this.dailyCounts.set(key, current + 1);
		this.pruneExpiredQuotaKeys();
	}

	/** 顺手清理跨天残留 key，防长驻进程内存缓涨 */
	private pruneExpiredQuotaKeys(): void {
		if (this.dailyCounts.size < 2) return;
		const today = new Date().toISOString().slice(0, 10);
		for (const key of this.dailyCounts.keys()) {
			if (!key.endsWith(today)) this.dailyCounts.delete(key);
		}
	}

	/** 自管消息历史 + 窗口裁剪：最近 N 条（§2 上下文窗口策略），升序返回 */
	private async getHistoryWindow(conversationId: string): Promise<AiHistoryMessage[]> {
		const rows = await this.prisma.aiMessage.findMany({
			where: { conversationId },
			orderBy: { createdAt: "desc" },
			take: this.config.historyWindow,
		});
		return rows
			.reverse()
			.map((row) => ({ role: row.role, content: row.content }));
	}
}
