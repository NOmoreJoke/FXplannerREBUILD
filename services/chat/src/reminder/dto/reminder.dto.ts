import { ApiProperty } from "@nestjs/swagger";
import { REMINDER_TYPES } from "../reminder-rules";

/**
 * 提醒模块 DTO（reminders 技术方案 §7）：OpenAPI 契约唯一来源，
 * 前端类型由 generate:api 产出。金额一律字符串固定 4 位小数；
 * 日期一律 ISO 8601 UTC。文案由前端组装，后端只回结构化事实。
 */

/** 单条提醒事项（读时派生；同一行可并列多条——同计划同日合并，§4.5） */
export class ReminderMatterDto {
	@ApiProperty({
		description:
			"事项类型：PREP_DUE（今日准备节点）/ PREP_OVERDUE（准备逾期）/ USE_DUE（今日为预计使用日）/ COMPLETE_READY（可确认完成）",
		enum: [...REMINDER_TYPES],
	})
	kind!: (typeof REMINDER_TYPES)[number];

	@ApiProperty({
		description:
			"仅 PREP_DUE：本次准备节点的金额合计（4 位小数字符串）；其余 null",
		type: String,
		nullable: true,
		example: "3000.0000",
	})
	installmentAmount!: string | null;

	@ApiProperty({
		description:
			"当前资金缺口 = max(0, 目标 − 已使用 − 剩余分配)；0 即钱已备齐",
		type: String,
		example: "7000.0000",
	})
	gapAmount!: string;

	@ApiProperty({
		description: "钱是否已备齐（gapAmount == 0）",
		type: Boolean,
		example: false,
	})
	isFundsReady!: boolean;

	@ApiProperty({
		description: "仅 PREP_OVERDUE：已逾期天数（逾期首日为 1）；其余 null",
		type: Number,
		nullable: true,
		example: 1,
	})
	daysOverdue!: number | null;
}

/** 提醒列表项（行承载「何时该提醒 + 是否已读」，内容读时派生） */
export class ReminderItemDto {
	@ApiProperty({ description: "提醒行 id", type: String })
	id!: string;

	@ApiProperty({ description: "关联计划 id", type: String })
	planId!: string;

	@ApiProperty({
		description: "计划名（null 时前端回退「{币种} 换汇计划」）",
		type: String,
		nullable: true,
	})
	planName!: string | null;

	@ApiProperty({ description: "目标币种", type: String, example: "USD" })
	targetCurrency!: string;

	@ApiProperty({
		description: "业务日（ISO 8601，该日 UTC+8 0 点对应的 UTC 时刻）",
		type: String,
		example: "2026-09-17T00:00:00.000Z",
	})
	scheduledFor!: string;

	@ApiProperty({
		description: "已读时间（null = 未读）",
		type: String,
		nullable: true,
	})
	readAt!: string | null;

	@ApiProperty({
		description: "首写类型（诊断用途；展示以 matters 为准）",
		enum: [...REMINDER_TYPES],
	})
	recordedType!: (typeof REMINDER_TYPES)[number];

	@ApiProperty({
		description: "当前成立的事项数组（读时按计划最新状态派生，可并列多条）",
		type: [ReminderMatterDto],
	})
	matters!: ReminderMatterDto[];
}

/** GET /api/reminders 的 data（items 已过滤：非 ACTIVE 计划行与 matters 为空的行不返回） */
export class RemindersViewDto {
	@ApiProperty({
		description: "未读全量 + 已读近 30 天，按 scheduledFor 倒序，上限 100 条",
		type: [ReminderItemDto],
	})
	items!: ReminderItemDto[];

	@ApiProperty({
		description: "未读数（= items 中 readAt 为 null 的行数）",
		type: Number,
		example: 1,
	})
	unreadCount!: number;
}

/** POST /api/reminders/:id/read 的 data（幂等：重复调用返回既有 readAt） */
export class ReminderReadResultDto {
	@ApiProperty({ description: "提醒行 id", type: String })
	id!: string;

	@ApiProperty({ description: "已读时间", type: String })
	readAt!: string;
}

/** POST /api/reminders/read-all 的 data（仅更新当前用户未读行，天然幂等） */
export class ReminderReadAllResultDto {
	@ApiProperty({ description: "本次标为已读的行数", type: Number, example: 3 })
	updatedCount!: number;
}

/** 错误响应（REMINDER_NOT_FOUND / ONBOARDING_NOT_COMPLETED） */
export class ReminderErrorDto {
	@ApiProperty({
		description: "错误码",
		type: String,
		example: "REMINDER_NOT_FOUND",
	})
	code!: string;

	@ApiProperty({ description: "错误信息", type: String })
	message!: string;
}
