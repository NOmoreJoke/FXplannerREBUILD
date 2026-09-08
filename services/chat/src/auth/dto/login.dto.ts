import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, MinLength } from "class-validator";

export class LoginDto {
	@ApiProperty({
		description: "登录邮箱",
		example: "user@example.com",
		format: "email",
		type: String,
	})
	@IsEmail({}, { message: "邮箱格式不正确" })
	email!: string;

	@ApiProperty({
		description: "登录密码",
		example: "StrongPass123",
		format: "password",
		type: String,
	})
	@IsString({ message: "密码必须是字符串" })
	@MinLength(1, { message: "密码不能为空" })
	password!: string;
}
