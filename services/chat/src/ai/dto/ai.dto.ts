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
