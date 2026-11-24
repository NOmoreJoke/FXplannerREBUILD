import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { AuditController } from "./audit.controller";
import { AuditService } from "./audit.service";

/**
 * 审计模块（技术方案 §5.1 / §13.1；Goal #3A W16）。
 *
 * 边界（AGENTS.md + eslint 后端模块护栏）：
 * - 只写只读：recordInTx/recordStandalone 写入、listAuditLogs 只读分页，
 *   严禁提供 update/delete 接口（AUDIT-03.3）；
 * - 不引入业务模块与 ai；业务模块单向消费 AuditService；
 * - detail 一律经 audit-sanitizer 脱敏（AUDIT-02）。
 *
 * @Global：审计是与 Prisma/Auth 同类的横切能力——PermissionGuard（DENIED 审计）
 * 经 @UseGuards 按类引用时在**控制器所在模块**实例化，其 AuditService 依赖须全局
 * 可解析；业务模块的写路径同事务审计（Goal #3B）同样直接注入，无需逐模块 import。
 */
@Global()
@Module({
	imports: [PrismaModule, AuthModule],
	controllers: [AuditController],
	providers: [AuditService],
	exports: [AuditService],
})
export class AuditModule {}
