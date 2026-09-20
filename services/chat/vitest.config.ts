import { defineConfig } from "vitest/config";
import path from "path";
import { config as dotenvConfig } from "dotenv";

// 在模块加载前加载共享配置和服务专属配置。
const root = path.resolve(__dirname, "../..");

dotenvConfig({ path: path.join(root, ".env.local") });
dotenvConfig({ path: path.join(__dirname, ".env.local") });

// E2E 限流放大值只服务 Playwright 造数（services/chat/.env.local 的 OTP_*_MAX_*），
// 不许泄漏进 vitest：限流用例按代码常量断言（发送 5/24h 20、target 1 次/ip 5 次），
// 否则 429 用例静默失效（fx-checkup/test-coverage.md ①A）。
// 仅主进程 delete 不够：Bun 启动的 worker 会自动重加载 .env.local；
// 故再用 test.env 注入与 src 常量一致的显式值（优先级高于文件加载，覆盖自动加载值）。
// ⚠️ 不可置空串：Number("") === 0 会被 isFinite 放行为 0 阈值，全量 429。
for (const key of [
	"OTP_SEND_MAX_PER_HOUR",
	"OTP_SEND_MAX_PER_DAY",
	"OTP_TARGET_MAX_REQUESTS",
	"OTP_IP_MAX_REQUESTS",
]) {
	delete process.env[key];
}
process.env.OTP_CODE_SECRET ??=
	"test-otp-code-secret-with-at-least-32-characters";

export default defineConfig({
	test: {
		globals: true, // 启用全局测试 API (describe, it, expect 等)
		environment: "node",
		passWithNoTests: false, // 强制要求至少有一个测试文件
		include: ["**/*.spec.ts", "**/*.e2e-spec.ts"], // Colocation: 测试文件和源码放一起，包含E2E测试
		// 文件串行执行：多个 spec 共享同一数据库（home.spec 全表清空 exchange_rates、
		// backfill 造数用户、rate 各组 deleteMany 币对），并行时序竞争导致偶发
		// FK 违反 / 行丢失（onboarding-rework 实施期间复现频率过高，串行为最小侵入根治）
		fileParallelism: false,
		// 与 src/auth/otp/otp.service.ts 常量保持一致；改常量须同步这里
		env: {
			OTP_SEND_MAX_PER_HOUR: "5",
			OTP_SEND_MAX_PER_DAY: "20",
			OTP_TARGET_MAX_REQUESTS: "1",
			OTP_IP_MAX_REQUESTS: "5",
			// 汇率定时刷新关闭（rate-refresh-cron 技术方案 §6.0，高危前置项）：
			// ScheduleModule 注册于 AppModule，test/api 经 createTestApp 启动真实 AppModule，
			// 串行长跑跨 :00/:30 边界会真实外呼+落库污染 rate 断言；与 rate.module.ts
			// 读取逻辑保持一致（≠"false" 即开启），改这里须同步 rate-cron.service.ts 注释
			RATE_CRON_ENABLED: "false",
		},
		server: {
			deps: {
				inline: ["@fxplanner-new/money"],
			},
		},
	},
});
