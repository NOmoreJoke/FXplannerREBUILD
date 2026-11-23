import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../authorization/authorization.module";
import { UsageController } from "./usage.controller";
import { UsageService } from "./usage.service";

/**
 * 资金使用模块（usage-recording M7）：
 * - FIFO 分摊/日期校验/资金状态派生为模块内纯函数（usage-calculator），
 *   不进 providers；M8 使用更正将复用同一分摊实现（首记与更正口径一致）。
 * - 派生量（stillNeeded/remainingAllocation/gap）与 canComplete 复用
 *   plan-calculator 纯函数级 import，禁止另行实现公式。
 * - PrismaModule 为全局模块，无需重复导入。
 */
@Module({
	imports: [AuthorizationModule],
	controllers: [UsageController],
	providers: [UsageService],
})
export class UsageModule {}
