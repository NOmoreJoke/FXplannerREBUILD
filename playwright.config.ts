import { defineConfig, devices } from "@playwright/test";
import path from "path";
import { readEnvFile } from "./e2e/helpers/env-local";

/**
 * Playwright E2E 测试配置
 *
 * 重点配置：
 * - trace: 'retain-on-failure' - 失败时保留 trace
 * - video: 'retain-on-failure' - 失败时保留视频
 * - 使用真实 API（不 mock）
 *
 * ⚠️ 运行前必读：
 * E2E 测试依赖前后端服务预先启动，本配置不自动拉起服务。
 * 运行前请手动启动：
 *   - Docker Compose: cd infra/compose && docker compose up
 *   - 或手动启动: bun run dev（根目录）
 *
 * 端口与地址：优先读已设置的环境变量；未设置时读根 .env.local
 * （与 `bun run dev` 的 dotenv -e 同源），最后才回落历史默认值
 * 前端 3001 / 后端 4001。spec 内的 process.env.API_URL / CORS_ORIGIN
 * 由 run-e2e-tests.sh 注入，勿在各 spec 重复解析 .env.local。
 */
/** 根 .env.local 读取（无依赖方案，原因见 e2e/helpers/env-local.ts 注释）。 */
const rootEnv = readEnvFile(path.resolve(__dirname, ".env.local"));

// 造数/断言直连后端地址：spec 默认值兜底为 4001，这里从 API_PORT 对齐真实服务
process.env.API_URL ??= `http://localhost:${process.env.API_PORT ?? rootEnv.API_PORT ?? "4001"}`;

// 前端地址（spec 内 BASE_URL 消费）：run-e2e-tests.sh 会显式注入；
// 直接 bun run test:e2e 时回落根 .env.local 的 CORS_ORIGIN，自定义端口不回归（对抗审 M3）
process.env.CORS_ORIGIN ??= rootEnv.CORS_ORIGIN || `http://localhost:${process.env.WEB_PORT ?? rootEnv.WEB_PORT ?? "3001"}`;

const WEB_PORT = Number(process.env.WEB_PORT ?? rootEnv.WEB_PORT ?? 3001);

export default defineConfig({
	testDir: "./e2e",

	// 输出目录（所有产物统一收敛到 e2e/ 下，根目录禁止出现测试输出）
	outputDir: "e2e/test-results/playwright-output",

	// 测试超时设置（真实 AI 调用需要更长时间）
	timeout: 120000, // 单个测试 2 分钟
	expect: {
		timeout: 10000, // 断言超时 10 秒
	},

	// 失败重试（真实 API 可能偶尔不稳定）
	retries: process.env.CI ? 2 : 1,

	// 并行测试（真实 API 调用建议串行，避免限流）
	workers: 1,

	// Reporter 配置
	reporter: [
		["html", { outputFolder: "e2e/test-results/playwright-report" }],
		["list"],
		["json", { outputFile: "e2e/test-results/test-results.json" }],
	],

	use: {
		// 基础 URL
		baseURL: `http://localhost:${WEB_PORT}`,

		// Trace 配置（记录所有操作，用于查看执行过程）
		trace: "on",

		// 视频配置（始终录制，用于演示）
		video: "on",

		// 截图配置（每个测试结束时截图）
		screenshot: "on",

		// 浏览器配置
		viewport: { width: 1920, height: 1080 },
		ignoreHTTPSErrors: true,
	},

	// 项目配置
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],

	// 注意：webServer 已移除
	// E2E 测试依赖真实前后端服务（包括 AI 调用），必须由人工预启动
	// 自动拉起 bun run dev 会导致端口冲突和环境变量不一致问题
});
