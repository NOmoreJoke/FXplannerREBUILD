import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { NextConfig } from "next";
import { codeInspectorPlugin } from "code-inspector-plugin";

// 根目录 .env.local 提供跨服务共享变量；客户端自己的 .env.local 由 Next.js 自动加载。
// 已由 CI 或 Docker 注入的环境变量优先，不被本地文件覆盖。
const rootEnvPath = path.resolve(process.cwd(), "../../", ".env.local");
if (fs.existsSync(rootEnvPath)) {
	const lines = fs.readFileSync(rootEnvPath, "utf-8").split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		const value = trimmed.slice(eqIdx + 1).trim();
		if (!process.env[key]) {
			process.env[key] = value;
		}
	}
}

// zod 校验：必填项无默认值，缺失则 fail-fast
const schema = z.object({
	NEXT_PUBLIC_API_BASE_URL: z.string().url(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
	console.error(
		"[chat-web] 环境变量校验失败：",
		parsed.error.flatten().fieldErrors,
	);
	console.error("提示：确保根目录 .env.local 中包含 NEXT_PUBLIC_API_BASE_URL");
	process.exit(1);
}

const nextConfig: NextConfig = {
	output: "standalone",
	outputFileTracingRoot: path.join(process.cwd(), "../../"),
	env: {
		NEXT_PUBLIC_API_BASE_URL: parsed.data.NEXT_PUBLIC_API_BASE_URL,
	},
	// Next.js 16 使用 Turbopack，配置 code-inspector-plugin
	turbopack: {
		rules: codeInspectorPlugin({
			bundler: "turbopack",
		}),
	},
};

export default nextConfig;
