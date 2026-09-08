import { ApiProperty } from "@nestjs/swagger";

/**
 * 认证出参 DTO：OpenAPI 契约唯一来源，前端类型由生成管线产出。
 * 每个 @ApiProperty 必须显式标注 type，不得依赖转译器元数据推断。
 */
export class UserDto {
	@ApiProperty({
		description: "用户 ID",
		example: "clz9x8y2w0000abcd",
		type: String,
	})
	id!: string;

	@ApiProperty({
		description: "邮箱（OTP 独立账号可能为空）",
		example: "user@example.com",
		type: String,
		nullable: true,
	})
	email!: string | null;

	@ApiProperty({
		description: "昵称",
		example: "阿员",
		type: String,
		nullable: true,
	})
	name!: string | null;

	@ApiProperty({ description: "头像 URL", type: String, nullable: true })
	avatar!: string | null;

	@ApiProperty({
		description: "注册时间（ISO 8601）",
		example: "2025-01-01T00:00:00.000Z",
		type: Date,
	})
	createdAt!: Date;
}

export class AuthIdentityDto {
	@ApiProperty({
		description: "身份渠道",
		enum: ["email", "phone"],
		example: "email",
	})
	channel!: string;

	@ApiProperty({
		description: "渠道标识（邮箱或 E.164 手机号）",
		example: "user@example.com",
		type: String,
	})
	target!: string;
}

export class AuthResponseDto {
	@ApiProperty({ description: "当前用户公开信息", type: UserDto })
	user!: UserDto;

	@ApiProperty({
		description: "JWT 访问令牌",
		example: "eyJhbGciOiJIUzI1NiIs...",
		type: String,
	})
	accessToken!: string;

	@ApiProperty({
		description: "OTP 登录时返回的绑定身份；密码登录不返回",
		type: AuthIdentityDto,
		nullable: true,
		required: false,
	})
	identity?: AuthIdentityDto;
}
