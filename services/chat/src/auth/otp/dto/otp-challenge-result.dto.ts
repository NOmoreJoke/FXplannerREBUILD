import { ApiProperty } from "@nestjs/swagger";

/**
 * OTP 发码出参 DTO：OpenAPI 契约唯一来源，前端类型由生成管线产出。
 */
export class OtpChallengeResultDto {
	@ApiProperty({
		description: "本次验证码挑战 ID，otp/login 时回传",
		example: "clz9x8y2w0000abcd",
		type: String,
	})
	challengeId!: string;

	@ApiProperty({
		description: "验证码过期时间（ISO 8601，5 分钟后）",
		example: "2025-01-01T00:05:00.000Z",
		type: Date,
	})
	expiresAt!: Date;
}
