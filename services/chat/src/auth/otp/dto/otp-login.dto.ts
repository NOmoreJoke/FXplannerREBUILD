import { IsNotEmpty, IsString, Matches } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class OtpLoginDto {
	@ApiProperty({
		description: "发送验证码接口返回的 challengeId",
		example: "clz123challenge",
		type: String,
	})
	@IsString({ message: "challengeId 必须是字符串" })
	@IsNotEmpty({ message: "challengeId 不能为空" })
	challengeId!: string;

	@ApiProperty({
		description: "收到的 6 位登录验证码",
		example: "123456",
		minLength: 6,
		maxLength: 6,
		type: String,
	})
	@IsString({ message: "验证码必须是字符串" })
	@Matches(/^\d{6}$/, { message: "验证码必须是 6 位数字" })
	code!: string;
}
