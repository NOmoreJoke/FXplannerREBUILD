import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { DataRequestController } from "./data-request.controller";
import { DataRequestService } from "./data-request.service";
import { DataRequestLockGuard } from "./data-request-lock.guard";

/**
 * 数据权利请求模块（account-data 技术方案 §9）。
 *
 * 复用 @Global AuthModule 提供的 OtpService 与 RequestAuthService 单例；
 * 锁守卫实例在本模块 providers 提供，AppModule 以 APP_GUARD 引用类注册为全局。
 */
@Module({
	imports: [PrismaModule, AuthModule],
	controllers: [DataRequestController],
	providers: [DataRequestService, DataRequestLockGuard],
	exports: [DataRequestService],
})
export class DataRequestModule {}
