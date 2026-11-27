import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../authorization/authorization.module";
import { ReportController } from "./report.controller";
import { ReportService } from "./report.service";

/**
 * 成本摘要与报告模块（reports 技术方案 §3）：纯只读聚合层。
 * 0 张新表、0 个迁移；不重跑 FIFO，直接读 M7/M8 落库的
 * UsageLotAllocation 分摊事实（M7 未上线时空集 → 全链路「尚未使用」）。
 * 在 app.module.ts 注册一次（模块唯一注册点）。
 */
@Module({
	imports: [AuthorizationModule],
	controllers: [ReportController],
	providers: [ReportService],
	exports: [ReportService],
})
export class ReportModule {}
