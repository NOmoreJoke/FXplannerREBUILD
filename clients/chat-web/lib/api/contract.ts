/**
 * 前端契约类型薄别名层。
 *
 * 唯一来源是后端 DTO 经 OpenAPI 生成产物 schema.gen.ts（禁止手改）。
 * 本文件只做「生成名 → 业务可读名」的映射，禁止在此新写结构；
 * 后端契约变化后执行 `bun run generate:api` 重新生成，别名随之更新。
 * 若生成名与业务名一致且语义清晰，可直接从 schema.gen 导入，不必经过此层。
 */
import type { components } from "@/lib/api/schema.gen";

type Schemas = components["schemas"];

/** 当前用户公开信息（后端 UserDto，/auth/me 的 data） */
export type AuthUser = Schemas["UserDto"];

/** 登录/注册/OTP 登录接口的 data：用户 + JWT（后端 AuthResponseDto） */
export type AuthResponse = Schemas["AuthResponseDto"];

/** OTP 登录渠道（后端 SendOtpCodeDto.channel 的枚举取值） */
export type OtpChannel = Schemas["SendOtpCodeDto"]["channel"];

/** 发送验证码接口的 data：挑战 ID 与过期时间（后端 OtpChallengeResultDto） */
export type OtpChallengeResult = Schemas["OtpChallengeResultDto"];

/** 密码注册入参（后端 RegisterDto；前端确认密码由表单校验，不上送 confirmPassword） */
export type PasswordRegisterInput = Pick<
	Schemas["RegisterDto"],
	"email" | "password"
>;

/** 密码登录入参（后端 LoginDto） */
export type PasswordLoginInput = Schemas["LoginDto"];
