import { IsIn, IsNotEmpty, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export type OtpChannelType = "email" | "phone";

export class SendOtpCodeDto {
	@ApiProperty({
		description: "登录验证码发送渠道",
		enum: ["email", "phone"],
		example: "email",
	})
	@IsIn(["email", "phone"], { message: "OTP channel 必须是 email 或 phone" })
	channel!: OtpChannelType;

	@ApiProperty({
		description: "接收登录验证码的邮箱或 E.164 手机号",
		example: "user@example.com",
		type: String,
	})
	@IsString({ message: "OTP 目标必须是字符串" })
	@IsNotEmpty({ message: "OTP 目标不能为空" })
	target!: string;
}
