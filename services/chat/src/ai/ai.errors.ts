import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * AI 模块错误族（ai-assistant 技术方案 §4 错误码）。
 * 错误体统一 { code, message }；AI_UPSTREAM_FAILED（502）不走 HttpException，
 * 由 controller 以 SSE error 帧下发（固定文案，上游细节只进日志，§4 错误信息纪律）。
 */

/** modelKey 非白名单成员（400，ai-model-whitelist 技术方案 §4.4；非法即拒，不静默回退烧 token） */
export class AiModelUnknownException extends HttpException {
	constructor() {
		super(
			{ code: "AI_MODEL_UNKNOWN", message: "该模型不可用，请重新选择" },
			HttpStatus.BAD_REQUEST,
		);
	}
}

/** content 空白 / trim 后超 2000 字符（400） */
export class AiMessageEmptyException extends HttpException {
	constructor(message = "消息内容不能为空且不超过 2000 字符") {
		super({ code: "AI_MESSAGE_EMPTY", message }, HttpStatus.BAD_REQUEST);
	}
}

/** 会话不存在或不属于本人（404，统一防枚举，§4） */
export class AiConversationNotFoundException extends HttpException {
	constructor() {
		super(
			{ code: "AI_CONVERSATION_NOT_FOUND", message: "会话不存在" },
			HttpStatus.NOT_FOUND,
		);
	}
}

/** 同会话流进行中再发 / 流进行中删除（409） */
export class AiConversationBusyException extends HttpException {
	constructor(message = "该会话正在回复中，请稍候") {
		super({ code: "AI_CONVERSATION_BUSY", message }, HttpStatus.CONFLICT);
	}
}

/** 系统流式并发满（429，进程内信号量；快速失败不排队，§1.2） */
export class AiBusyException extends HttpException {
	constructor() {
		super(
			{ code: "AI_BUSY", message: "当前使用人数较多，请稍后再试" },
			HttpStatus.TOO_MANY_REQUESTS,
		);
	}
}

/** 用户级日配额超（429，防刷防破产，§1.2） */
export class AiQuotaExceededException extends HttpException {
	constructor() {
		super(
			{
				code: "AI_QUOTA_EXCEEDED",
				message: "今日使用次数已达上限，请明天再来",
			},
			HttpStatus.TOO_MANY_REQUESTS,
		);
	}
}

/** 总开关关闭（503，紧急止血 AI_CHAT_ENABLED=false） */
export class AiDisabledException extends HttpException {
	constructor() {
		super(
			{ code: "AI_DISABLED", message: "AI 助手功能暂未开放" },
			HttpStatus.SERVICE_UNAVAILABLE,
		);
	}
}

/** 未配置 LLM key（503，降级阶梯①：不影响既有部署启动） */
export class AiNotConfiguredException extends HttpException {
	constructor() {
		super(
			{ code: "AI_NOT_CONFIGURED", message: "AI 助手暂未配置，请联系管理员" },
			HttpStatus.SERVICE_UNAVAILABLE,
		);
	}
}
