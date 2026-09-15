import { Module } from "@nestjs/common";
import { AccountController } from "./account.controller";
import { AccountService } from "./account.service";

/**
 * 外汇账户模块（account-module）：三个只读端点 + 只读编排 service；
 * 计算口径唯一实现在 account-calculator 纯函数（不进 providers，plan.module 先例）；
 * 回填脚本（backfill-cost-lots.script.ts）为 CLI，不经 Nest 容器，不注册 provider。
 * PrismaModule 为全局模块，无需重复导入。
 */
@Module({
	controllers: [AccountController],
	providers: [AccountService],
})
export class AccountModule {}
