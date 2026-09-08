import { z } from "zod";
import { config as dotenvConfig } from "dotenv";
import { join } from "path";

/**
 * 两层本地配置：根目录 .env.local 放跨服务共享变量，当前目录 .env.local 放后端专属变量。
 * 系统环境变量优先；服务专属文件仅补充未设置的变量。
 */
const root = join(process.cwd(), "../.."); // monorepo 根目录

dotenvConfig({ path: join(root, ".env.local") });
dotenvConfig({ path: ".env.local" });

const optionalEnv = () =>
	z.preprocess(
		(value) => (value === "" ? undefined : value),
		z.string().min(1).optional(),
	);
const optionalEmailEnv = () =>
	z.preprocess(
		(value) => (value === "" ? undefined : value),
		z.string().email().optional(),
	);
const optionalUrlEnv = () =>
	z.preprocess(
		(value) => (value === "" ? undefined : value),
		z.string().url().optional(),
	);

const schema = z
	.object({
		// ── 运行时模式 ──
		NODE_ENV: z
			.enum(["development", "test", "production"])
			.default("development"),

		// ── 服务基础（必填，12-Factor 严格模式）──
		API_PORT: z.coerce.number().int().positive(),
		CORS_ORIGIN: z.string().url(),

		// ── 数据库（Prisma 连接串）──
		DATABASE_URL: z.string().min(1),

		// ── JWT 密钥（必填，生产强制 32+ 字符）──
		JWT_SECRET: z.string().min(32),

		// ── OTP（必填；与 JWT_SECRET 分离，用于验证码 HMAC）──
		OTP_CODE_SECRET: z.string().min(32),

		// ── OTP 三方供应商（仅在启用对应 Channel 时必填）──
		RESEND_API_KEY: optionalEnv(),
		RESEND_FROM_EMAIL: optionalEmailEnv(),
		RESEND_API_URL: optionalUrlEnv(),
		ALIYUN_ACCESS_KEY_ID: optionalEnv(),
		ALIYUN_ACCESS_KEY_SECRET: optionalEnv(),
		ALIYUN_SMS_SIGN_NAME: optionalEnv(),
		ALIYUN_SMS_TEMPLATE_CODE: optionalEnv(),
		ALIYUN_SMS_ENDPOINT: optionalUrlEnv(),
	})
	.refine((values) => values.OTP_CODE_SECRET !== values.JWT_SECRET, {
		message: "OTP_CODE_SECRET 不得复用 JWT_SECRET",
		path: ["OTP_CODE_SECRET"],
	});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
	console.error(
		"[chat] 环境变量校验失败：",
		parsed.error.flatten().fieldErrors,
	);
	console.error("提示：复制 .env.local.example 为 .env.local 并填入真实值");
	process.exit(1);
}

export const env = parsed.data;

export const isDev = () => env.NODE_ENV === "development";
export const isProd = () => env.NODE_ENV === "production";
export const isTest = () => env.NODE_ENV === "test";
