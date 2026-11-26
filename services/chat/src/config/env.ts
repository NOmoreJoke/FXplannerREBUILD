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

		// ── OTP 邮件通道：阿里云邮件推送 DirectMail SMTP（仅在启用 email Channel 时必填）──
		SMTP_HOST: optionalEnv(), // 阿里云邮件推送：smtpdm.aliyun.com
		SMTP_PORT: z.coerce.number().int().positive().optional(), // 默认 465（SSL）
		SMTP_USER: optionalEnv(), // 发信地址（控制台创建，如 noreply@example.com）
		SMTP_PASS: optionalEnv(), // 发信地址的 SMTP 密码
		SMTP_FROM_NAME: optionalEnv(), // 发件人显示名，默认 FXPlanner
		// ── OTP 邮件 mock 开关（未接入真实邮件服务时本地联调用）──
		// true 强制 mock；false 强制走真实 SMTP；未设置时：非生产 && 未配置 SMTP → 自动 mock，生产永不 mock
		OTP_EMAIL_MOCK: z.enum(["true", "false"]).optional(),

		// ── 汇率定时刷新开关（rate-refresh-cron 技术方案 §3.2）──
		// false 关闭定时轮（vitest test.env 注入 false 防测试环境真实调度）；未设置 = 开启。
		// ⚠️ 取值拼写错误会在此处 safeParse 失败 → 整个服务拒绝启动，而非静默停用
		RATE_CRON_ENABLED: z.enum(["true", "false"]).optional(),

		// ── 认证接口限流上限（次/分钟，auth.controller Throttle）──
		// 默认 5/10；E2E 集中造数时由测试脚本放大，生产不设置即维持默认
		AUTH_THROTTLE_LIMIT: z.coerce.number().int().positive().optional(),
		AUTH_OTP_THROTTLE_LIMIT: z.coerce.number().int().positive().optional(),
		THROTTLE_GLOBAL_LIMIT: z.coerce.number().int().positive().optional(),
		// ── 数据导出目录（account-data 技术方案 §3.1 决策二）──
		// 导出 ZIP 落盘位置；未设置时回退 services/chat/data-exports（运行产物，已 gitignore）
		DATA_EXPORT_DIR: optionalEnv(),
		ALIYUN_ACCESS_KEY_ID: optionalEnv(),
		ALIYUN_ACCESS_KEY_SECRET: optionalEnv(),
		ALIYUN_SMS_SIGN_NAME: optionalEnv(),
		ALIYUN_SMS_TEMPLATE_CODE: optionalEnv(),
		ALIYUN_SMS_ENDPOINT: optionalUrlEnv(),

		// ── AI 助手（ai-model-whitelist 技术方案 §3.4；模块 src/ai 运行时另经 resolveAiRuntimeConfig
		// 读取 process.env 以支持测试按 app 实例注入，两处默认值必须保持一致）──
		// aigysd.com OpenAI 兼容网关（同一网关，按上游模型区分密钥变量）：
		// 主渠道密钥（gpt-4.1 / gpt-4.1-mini / gpt-5.5 共用）
		AI_PROVIDER_AIGYSD_API_KEY: optionalEnv(),
		// 网关地址（如 https://aigysd.com/v1；未配时 ChatOpenAI 走官方默认端点）
		AI_PROVIDER_AIGYSD_BASE_URL: optionalUrlEnv(),
		// claude-sonnet-4-6 专用密钥
		AI_PROVIDER_AIGYSD_ANTHROPIC_API_KEY: optionalEnv(),
		// gemini-3-flash-preview 专用密钥
		AI_PROVIDER_AIGYSD_GEMINI_API_KEY: optionalEnv(),
		// 缺省模型 key（请求缺省 modelKey 时的回退锚点，必须在白名单内——
		// ai-models.config.ts 模块加载期断言把关，漂移直接拒绝启动；
		// 默认值与 ai-models.config.ts resolveDefaultChatModelKey 兑底值双处同步）
		AI_DEFAULT_CHAT_MODEL: z.preprocess(
			(value) => (value === "" ? undefined : value),
			z.string().min(1).default("gpt-4.1-mini"),
		),
		// 全部模型密钥缺失 → 全部 AI 端点 503 AI_NOT_CONFIGURED（运行时快照检查，不 fail-fast）
		// 总开关：false → 端点 503 AI_DISABLED（紧急止血一键关停整模块）
		AI_CHAT_ENABLED: z.enum(["true", "false"]).default("true"),
		// 组织 Agent 工具独立降级开关：false → 仅禁用组织账本/草稿工具，保留公共汇率对话与账本正常读写（技术方案 §15.4）
		AI_ORG_TOOLS_ENABLED: z.enum(["true", "false"]).default("true"),
		// 发消息限流上限（次/分钟/IP，ai.controller @Throttle；默认 5，E2E 运行时放大）
		AI_SEND_THROTTLE_LIMIT: z.coerce.number().int().positive().optional(),
		// 上下文窗口条数（最近 N 条历史 + 本次消息组装进 agent 输入）
		AI_CHAT_HISTORY_WINDOW: z.coerce.number().int().positive().default(20),
		// 进程内流式并发上限（超 → 429 AI_BUSY；集成测试设 1 以复现）
		AI_CHAT_MAX_CONCURRENCY: z.coerce.number().int().positive().default(40),
		// 用户级日配额（进程内计数，重启清零——可接受，防刷为主）
		AI_DAILY_MESSAGE_QUOTA: z.coerce.number().int().positive().default(100),
		// 仅 E2E：假流式模型，不外呼；production 必须为 false（下方 refine 强制）
		AI_E2E_FAKE_STREAM: z.enum(["true", "false"]).default("false"),
		// 假流式帧间隔（ms），供 E2E 流式断言采样
		AI_E2E_FAKE_INTERVAL_MS: z.coerce.number().int().nonnegative().default(30),
	})
	.refine((values) => values.OTP_CODE_SECRET !== values.JWT_SECRET, {
		message: "OTP_CODE_SECRET 不得复用 JWT_SECRET",
		path: ["OTP_CODE_SECRET"],
	})
	.refine(
		(values) =>
			!(
				values.NODE_ENV === "production" && values.AI_E2E_FAKE_STREAM === "true"
			),
		{
			message: "生产环境禁止开启 AI_E2E_FAKE_STREAM（假流式模型仅限 E2E 测试）",
			path: ["AI_E2E_FAKE_STREAM"],
		},
	);

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
