import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../authorization/authorization.module";
import { TransactionController } from "./transaction.controller";
import { TransactionService } from "./transaction.service";

/**
 * 买入交易模块（transaction-entry）。
 * PrismaModule 为全局模块，无需重复导入；transaction-calculator 为模块内纯函数，不进 providers。
 */
@Module({
	imports: [AuthorizationModule],
	controllers: [TransactionController],
	providers: [TransactionService],
	exports: [TransactionService],
})
export class TransactionModule {}
