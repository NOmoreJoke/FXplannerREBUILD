import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, UseGuards } from "@nestjs/common";
import {
	ApiBearerAuth,
	ApiConflictResponse,
	ApiExtraModels,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from "@nestjs/swagger";
import type { User } from "@prisma/client";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentActor } from "../authorization/decorators/current-actor.decorator";
import { BusinessOrgScopeGuard } from "../authorization/guards/business-org-scope.guard";
import type { ActorContext } from "../authorization/authorization.types";
import {
	ReminderErrorDto,
	ReminderItemDto,
	ReminderMatterDto,
	ReminderReadAllResultDto,
	ReminderReadResultDto,
	RemindersViewDto,
} from "./dto/reminder.dto";
import { ReminderService } from "./reminder.service";

/**
 * 站内提醒（reminders 技术方案 §7）：3 个功能入口，全部需登录。
 * GET /reminders 内置读时懒生成（§4.2）：首页铃铛/今日提醒区与提醒中心页共用本接口
 * （前端 react-query 同 key 共享缓存），首页打开即触发生成，不引入定时任务设施。
 */
@ApiTags("Reminder")
@ApiBearerAuth()
// 手动 $ref 的响应模型需显式注册进 components（内嵌 matters 子模型一并注册）
@ApiExtraModels(
	RemindersViewDto,
	ReminderItemDto,
	ReminderMatterDto,
	ReminderReadResultDto,
	ReminderReadAllResultDto,
	ReminderErrorDto,
)
@Controller("reminders")
@UseGuards(JwtAuthGuard)
export class ReminderController {
	constructor(
		@Inject(ReminderService)
		private readonly reminderService: ReminderService,
	) {}

	@Get()
	@ApiOperation({
		summary: "提醒列表（内置懒生成：先幂等生成今日应存在的提醒行再返回）",
		description:
			"入口先按 R1~R4 规则幂等生成「业务今天（UTC+8）」应存在的提醒行（同计划同日合并，唯一键防重；开关关闭跳过生成），再返回未读全量 + 已读近 30 天（scheduledFor 倒序，上限 100）。行内容（matters）按计划最新状态读时派生：非 ACTIVE 计划行与事项已消失的行不返回。错误：409 ONBOARDING_NOT_COMPLETED（未完成首次设置）。",
	})
	@ApiOkResponse({
		description: "获取成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/RemindersViewDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiConflictResponse({
		description: "尚未完成首次设置（ONBOARDING_NOT_COMPLETED）",
		type: ReminderErrorDto,
	})
	@UseGuards(BusinessOrgScopeGuard)
	async list(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
	) {
		const data = await this.reminderService.list({
			userId: actor.userId,
			organizationId: actor.organizationId,
		});
		return { success: true, data, message: "提醒列表获取成功" };
	}

	@Post(":id/read")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "单条已读（幂等）",
		description:
			"将本人一条提醒标记为已读（userId 双保险防越权）。行不存在或非本人 → 404 REMINDER_NOT_FOUND（不泄露存在性）；重复调用幂等返回既有 readAt，不报错。",
	})
	@ApiOkResponse({
		description: "标记成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/ReminderReadResultDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiNotFoundResponse({
		description: "提醒不存在或不属于本人（REMINDER_NOT_FOUND）",
		type: ReminderErrorDto,
	})
	async markRead(@CurrentUser() user: User, @Param("id") id: string) {
		const data = await this.reminderService.markRead(user.id, id);
		return { success: true, data, message: "提醒已标为已读" };
	}

	@Post("read-all")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "全部已读（幂等）",
		description:
			"将当前用户全部未读提醒标记为已读（仅更新 readAt 为 null 的行），返回本次更新的行数；重复调用 updatedCount = 0，天然幂等。",
	})
	@ApiOkResponse({
		description: "标记成功，响应体为 { success, data, message } 包装",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/ReminderReadAllResultDto" },
				message: { type: "string" },
			},
		},
	})
	async markAllRead(@CurrentUser() user: User) {
		const data = await this.reminderService.markAllRead(user.id);
		return { success: true, data, message: "全部提醒已标为已读" };
	}
}
