import { IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export type OtpChannelType = "email" | "phone";

/** 验证码用途（account-data 技术方案 §3.4）：登录/导出/清空/注销分别验证，互相不能顶用 */
export const OTP_PURPOSES = ["LOGIN", "EXPORT", "CLEAR", "DELETION"] as const;
export type OtpPurposeType = (typeof OTP_PURPOSES)[number];

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

	@ApiProperty({
		description:
			"验证码用途（可选，默认 LOGIN）：登录/导出/清空/注销分别验证，互相不能顶用；频控按目标邮箱合计不受用途影响",
		enum: OTP_PURPOSES,
		required: false,
		default: "LOGIN",
	})
	@IsOptional()
	@IsIn(OTP_PURPOSES, {
		message: "OTP purpose 必须是 LOGIN、EXPORT、CLEAR 或 DELETION",
	})
	purpose?: OtpPurposeType;
}
