import { ApiProperty } from "@nestjs/swagger";
import {
	IsInt,
	IsOptional,
	IsString,
	Matches,
	MaxLength,
	Max,
	Min,
} from "class-validator";
import { Type } from "class-transformer";
import {
	AllocatableCapsDto,
	PlanInstallmentDto,
} from "../../plan/dto/plan.dto";
import { PACE_PREFERENCES, type PacePreference } from "../../plan/schedule-builder";

/**
 * AI 模块 DTO（ai-assistant 技术方案 §4/§5.1）。
 * content 的 1~2000 + trim 非空校验在 AiService 以 { code, message } 抛出
 * （400 AI_MESSAGE_EMPTY，§8.2 用例预期统一错误码）；DTO 仅保证类型与 OpenAPI 契约描述。
 * 流式端点响应为 text/event-stream，帧协议不进 OpenAPI（§4，前端手写类型）。
 */
export class SendMessageDto {
	@ApiProperty({
		description:
			"消息内容（trim 后 1~2000 字符；空白或超长返回 400 AI_MESSAGE_EMPTY）",
		example: "现在美元兑日元是多少？",
		minLength: 1,
		maxLength: 2000,
		// 显式声明类型：避免 swagger 依赖 design:type 元数据在 bun 下推断失败导致误报循环依赖
		type: String,
	})
	@IsString({ message: "content 必须是字符串" })
	content!: string;

	@ApiProperty({
		description:
			"模型白名单 key（可选；缺省回退服务端默认模型；非法 key 返回 400 AI_MODEL_UNKNOWN）",
		example: "gpt-4.1-mini",
		required: false,
		maxLength: 64,
		pattern: "^[a-zA-Z0-9._-]+$",
		type: String,
	})
	@IsOptional()
	@IsString({ message: "modelKey 必须是字符串" })
	@MaxLength(64, { message: "modelKey 最长 64 字符" })
	// 白名单字符集：防换行/控制符伪造日志行（ai-model-whitelist 技术方案 §4.2）
	@Matches(/^[a-zA-Z0-9._-]+$/, { message: "modelKey 含非法字符" })
	modelKey?: string;
}

export class ListConversationsQueryDto {
	@ApiProperty({
		description: "条数上限（1~100）",
		default: 50,
		required: false,
		minimum: 1,
		maximum: 100,
		// 显式声明类型：避免 swagger 从 @Type(() => Number) 推断时误报循环依赖
		type: Number,
	})
	@IsOptional()
	@Type(() => Number)
	@IsInt({ message: "limit 必须是整数" })
	@Min(1, { message: "limit 最小为 1" })
	@Max(100, { message: "limit 最大为 100" })
	limit: number = 50;
}

export class ListMessagesQueryDto {
	@ApiProperty({
		description: "条数上限（1~500），按创建时间升序",
		default: 200,
		required: false,
		minimum: 1,
		maximum: 500,
		// 显式声明类型：避免 swagger 从 @Type(() => Number) 推断时误报循环依赖
		type: Number,
	})
	@IsOptional()
	@Type(() => Number)
	@IsInt({ message: "limit 必须是整数" })
	@Min(1, { message: "limit 最小为 1" })
	@Max(500, { message: "limit 最大为 500" })
	limit: number = 200;
}

/** GET /api/ai/conversations 单项（F2-1 / DEBT-05 OpenAPI 唯一来源） */
export class AiConversationSummaryDto {
	@ApiProperty({ description: "会话 ID（cuid）", type: String })
	id!: string;

	@ApiProperty({ description: "会话标题（首条消息前 20 字）", type: String })
	title!: string;

	@ApiProperty({
		description: "最近消息时间（ISO 8601 UTC）",
		example: "2026-11-20T08:00:00.000Z",
		type: String,
	})
	lastMessageAt!: string;

	@ApiProperty({ description: "消息条数", example: 2, type: Number })
	messageCount!: number;
}

export class AiConversationListDto {
	@ApiProperty({
		description: "会话列表（lastMessageAt 倒序）",
		type: [AiConversationSummaryDto],
	})
	items!: AiConversationSummaryDto[];
}

/** AI 计划草稿（ToB R2 P8：复用排期预览与可分配上限，未保存，需经人工确认保存） */
export class AiPlanDraftDto {
	@ApiProperty({
		description: "关联的 Agent 运行 ID（确认保存时透传给 POST /api/plans 写入审计）",
		example: "fd82b1c0-1234-4567-89ab-cdef01234567",
		type: String,
	})
	agentRunId!: string;

	@ApiProperty({
		description: "建议的计划名称（可为空）",
		example: "12月广告费换汇",
		type: String,
		nullable: true,
	})
	name!: string | null;

	@ApiProperty({ description: "目标币种（ISO 4217）", example: "USD", type: String })
	targetCurrency!: string;

	@ApiProperty({ description: "目标净到账金额（字符串）", example: "10000", type: String })
	targetAmount!: string;

	@ApiProperty({
		description: "期望用汇日（ISO 8601 UTC）",
		example: "2027-12-10T00:00:00.000Z",
		type: String,
	})
	expectUseDate!: string;

	@ApiProperty({ description: "提前准备天数（1~30）", example: 3, type: Number })
	prepLeadDays!: number;

	@ApiProperty({
		description: "建议准备节奏",
		example: "balanced",
		enum: [...PACE_PREFERENCES],
		type: String,
	})
	pacePreference!: PacePreference;

	@ApiProperty({
		description: "建议计入已有外币金额（4 位小数字符串）",
		example: "0.0000",
		type: String,
	})
	allocatedAmount!: string;

	@ApiProperty({
		description: "最晚准备日（ISO 8601 UTC）",
		example: "2027-12-07T00:00:00.000Z",
		type: String,
	})
	latestPrepDate!: string;

	@ApiProperty({
		description: "建议分批排期预览（确认页会按最新余额实时重算）",
		type: [PlanInstallmentDto],
	})
	installments!: PlanInstallmentDto[];

	@ApiProperty({
		description: "草稿生成时刻的可分配余额上限信息",
		type: AllocatableCapsDto,
	})
	caps!: AllocatableCapsDto;
}

export class AiMessageDto {
	@ApiProperty({ description: "消息 ID（cuid）", type: String })
	id!: string;

	@ApiProperty({
		description: "消息角色",
		enum: ["user", "assistant"],
		type: String,
	})
	role!: "user" | "assistant";

	@ApiProperty({ description: "消息正文", type: String })
	content!: string;

	@ApiProperty({
		description: "创建时间（ISO 8601 UTC）",
		example: "2026-11-20T08:00:00.000Z",
		type: String,
	})
	createdAt!: string;

	@ApiProperty({
		description: "助手消息实际使用的白名单模型 key；用户消息或存量数据为 null",
		example: "gpt-4.1-mini",
		type: String,
		required: false,
		nullable: true,
	})
	model?: string | null;

	@ApiProperty({
		description: "助手消息关联的换汇计划草稿（未保存，需人工确认）",
		type: AiPlanDraftDto,
		required: false,
		nullable: true,
	})
	planDraft?: AiPlanDraftDto | null;
}

export class AiMessageListDto {
	@ApiProperty({
		description: "会话消息列表（createdAt 升序）",
		type: [AiMessageDto],
	})
	items!: AiMessageDto[];
}

export class ChatModelSummaryDto {
	@ApiProperty({ description: "对外白名单 key", example: "gpt-4.1-mini", type: String })
	key!: string;

	@ApiProperty({ description: "展示名称", example: "GPT-4.1 mini", type: String })
	displayName!: string;

	@ApiProperty({ description: "提供商标识", example: "openai", type: String })
	provider!: string;

	@ApiProperty({
		description: "模型能力集合",
		example: ["chat"],
		type: [String],
	})
	capabilities!: string[];

	@ApiProperty({ description: "成本档位 1~5（升序）", example: 1, type: Number })
	costTier!: number;

	@ApiProperty({ description: "展示图标", example: "⚡", type: String })
	icon!: string;

	@ApiProperty({ description: "模型说明", type: String })
	description!: string;
}

export class ChatModelListDto {
	@ApiProperty({
		description: "可选模型白名单（按 costTier 升序）",
		type: [ChatModelSummaryDto],
	})
	items!: ChatModelSummaryDto[];

	@ApiProperty({
		description: "组织业务工具总开关是否开启（false 时仅可用公共汇率查询）",
		example: true,
		type: Boolean,
	})
	orgToolsEnabled!: boolean;
}
