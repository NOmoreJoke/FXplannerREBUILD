import { defineConfig } from "vitest/config";
import path from "path";
import { config as dotenvConfig } from "dotenv";

// 在模块加载前加载共享配置和服务专属配置。
const root = path.resolve(__dirname, "../..");

dotenvConfig({ path: path.join(root, ".env.local") });
dotenvConfig({ path: path.join(__dirname, ".env.local") });
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
		server: {
			deps: {
				inline: ["@fxplanner-new/money"],
			},
		},
	},
});
