import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { DataRequestController } from "./data-request.controller";
import { DataRequestService } from "./data-request.service";
import { DataRequestLockGuard } from "./data-request-lock.guard";

/**
 * 数据权利请求模块（account-data 技术方案 §9）。
 *
 * import AuthModule 复用 OtpService（验证凭证链路）与 JwtService（锁守卫验签）；
 * 锁守卫实例在本模块 providers 提供，AppModule 以 APP_GUARD 引用类注册为全局。
 */
@Module({
	// JwtModule 注册（verify 显式传 secret，register 配置无副作用）：
	// AuthModule 未导出 JwtModule，锁守卫在本模块上下文解析 JwtService 需自行导入
	imports: [PrismaModule, AuthModule, JwtModule.register({})],
	controllers: [DataRequestController],
	providers: [DataRequestService, DataRequestLockGuard],
	exports: [DataRequestService],
})
export class DataRequestModule {}
