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
import { OrganizationContextGuard } from "../authorization/guards/organization-context.guard";
import { PermissionGuard } from "../authorization/guards/permission.guard";
import { RequiresPermission } from "../authorization/decorators/requires-permission.decorator";
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
import { OrganizationLockGuard } from "../authorization/guards/organization-lock.guard";

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
	@UseGuards(OrganizationContextGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("plan.read")
	async list(
		@CurrentUser() user: User,
		@CurrentActor() actor: ActorContext,
	) {
		const data = await this.reminderService.list(actor);
		return { success: true, data, message: "提醒列表获取成功" };
	}

	@Post(":id/read")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "单条已读（幂等，成员级）",
		description:
			"将**当前成员**的一条提醒标记为已读：已读态只写入成员级 ReminderRead(reminderId, userId)（提醒行本身不再承载任何共享已读态，一名成员标已读不影响同组织其他成员的未读态）。目标提醒按当前组织作用域校验：不存在或跨组织一律 404 REMINDER_NOT_FOUND（不泄露存在性）；未受邀或已被移除（DISABLED）的成员由守卫统一返回 404。重复调用幂等返回既有 readAt。",
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
		description: "提醒不存在或不属于当前组织（REMINDER_NOT_FOUND）",
		type: ReminderErrorDto,
	})
	@UseGuards(OrganizationContextGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("plan.read")
	async markRead(
		@CurrentActor() actor: ActorContext,
		@Param("id") id: string,
	) {
		const data = await this.reminderService.markRead(actor, id);
		return { success: true, data, message: "提醒已标为已读" };
	}

	@Post("read-all")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "全部已读（幂等，成员级）",
		description:
			"将当前组织作用域内、**当前成员尚未读过**的提醒全部标记为已读：只写当前成员自己的 ReminderRead（事务内批量插入、并发去重），不修改任何共享读态。返回本次新增的成员级已读行数；重复调用 updatedCount = 0，天然幂等。",
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
	@UseGuards(OrganizationContextGuard, OrganizationLockGuard, PermissionGuard)
	@RequiresPermission("plan.read")
	async markAllRead(@CurrentActor() actor: ActorContext) {
		const data = await this.reminderService.markAllRead(actor);
		return { success: true, data, message: "全部提醒已标为已读" };
	}
}
