import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, MinLength, Matches } from "class-validator";

export class RegisterDto {
	@ApiProperty({
		description: "注册邮箱",
		example: "user@example.com",
		format: "email",
		type: String,
	})
	@IsEmail({}, { message: "邮箱格式不正确" })
	email!: string;

	@ApiProperty({
		description: "密码，至少 8 位且包含大小写字母和数字",
		example: "StrongPass123",
		format: "password",
		minLength: 8,
		type: String,
	})
	@IsString({ message: "密码必须是字符串" })
	@MinLength(8, { message: "密码长度至少为 8 位" })
	@Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
		message: "密码必须包含大小写字母和数字",
	})
	password!: string;
}
