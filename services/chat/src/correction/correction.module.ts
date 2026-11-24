import { Logger, Module } from "@nestjs/common";
import { RateModule } from "../rate/rate.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { CorrectionController } from "./correction.controller";
import { CorrectionService } from "./correction.service";

/**
 * 更正与日志模块（corrections，M8）：对换汇记录 / 初始持仓（使用记录随 M7 接线）
 * 提供「原因必填 → 影响预览 → 确认 → 事务内复核 → 新版本 + 留痕」的通用更正能力。
 * 账本全量重放引擎（ledger-replay）为纯内存计算，preview 与 apply 共用（所见即所存）。
 * 依赖 RateModule（原时点取价 findQuoteAt）；在 app.module.ts 唯一注册。
 */
@Module({
	imports: [RateModule, AuthorizationModule],
	controllers: [CorrectionController],
	// Logger 由 Nest 内置 @Injectable 提供，显式注册供 CorrectionService 注入（onboarding.module 先例）
	providers: [CorrectionService, Logger],
	exports: [],
})
export class CorrectionModule {}
