import { Module } from "@nestjs/common";
import { PlanController } from "./plan.controller";
import { PlanService } from "./plan.service";

/**
 * 换汇计划模块（plan-creation + plan-management）：
 * - 排期（schedule-builder）与计划计算（plan-calculator，§3.4 公式 + 5 条拦截）均为模块内纯函数，
 *   不进 providers；plan_change_logs 走裸外键无 relation，service 按 planId 直查，无新 provider。
 * - PrismaModule 为全局模块，无需重复导入。
 */
@Module({
	controllers: [PlanController],
	providers: [PlanService],
})
export class PlanModule {}
