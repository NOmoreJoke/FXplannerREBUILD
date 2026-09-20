import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { PrismaModule } from "../prisma/prisma.module";
import { env } from "../config/env";
import { EmailOtpChannel } from "./otp/email-otp.channel";
import { OtpService } from "./otp/otp.service";
import { OTP_CHANNELS, OTP_OPTIONS } from "./otp/otp-channel";
import { SmsOtpChannel } from "./otp/sms-otp.channel";

@Module({
	imports: [
		PrismaModule,
		PassportModule,
		JwtModule.register({
			secret: env.JWT_SECRET,
			signOptions: {
				expiresIn: "7d",
			},
		}),
	],
	controllers: [AuthController],
	providers: [
		AuthService,
		JwtStrategy,
		OtpService,
		EmailOtpChannel,
		SmsOtpChannel,
		{
			provide: OTP_CHANNELS,
			useFactory: (email: EmailOtpChannel, sms: SmsOtpChannel) => [email, sms],
			inject: [EmailOtpChannel, SmsOtpChannel],
		},
		// 注册默认选项（与 OtpService 内置默认值一致），使测试可通过 overrideProvider(OTP_OPTIONS) 调整频控
		{
			provide: OTP_OPTIONS,
			useValue: {},
		},
	],
	// OtpService 导出供 data-request 模块复用验证凭证链路（account-data 技术方案 §3.4）；
	// JwtModule 导出供锁守卫（DataRequestLockGuard）验签 JWT
	exports: [AuthService, OtpService, JwtModule],
})
export class AuthModule {}
