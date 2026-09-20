import { Module } from "@nestjs/common";
import { ReminderController } from "./reminder.controller";
import { ReminderService } from "./reminder.service";

/**
 * 站内提醒模块（reminders 技术方案 §9）：M9 功能 24 唯一注册点在 app.module.ts。
 * 依赖 PrismaModule（全局）与 plan 模块的 plan-calculator 纯函数（零模块耦合，不引 PlanModule）。
 */
@Module({
	controllers: [ReminderController],
	providers: [ReminderService],
	exports: [ReminderService],
})
export class ReminderModule {}
