/**
 * 一次性导出后端 OpenAPI JSON（不监听端口、不启动长驻服务）。
 *
 * 产出：
 *   1. clients/chat-web/lib/api/openapi.json —— 契约快照（提交入库，供 review diff）
 *
 * 用法（根目录）：
 *   bun run export:openapi
 *
 * 实现说明：
 *   - 复用 main.ts 的 SwaggerModule + createSwaggerConfig（零复制，配置漂移不可能发生）；
 *   - 不调用 app.listen()，createDocument 后立即 close，进程自然退出；
 *   - src/config/env.ts 在模块加载时按 process.cwd() 定位两层 .env.local，
 *     因此必须先 chdir 到 services/chat 再动态 import 后端模块（静态 import
 *     会被提升到 chdir 之前执行，导致 env 校验读到错误路径）。
 */
import "reflect-metadata"; // Nest 装饰器元数据 polyfill，必须先于 AppModule 加载
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const chatDir = path.resolve(scriptDir, "../services/chat");
const outPath = path.resolve(
	scriptDir,
	"../clients/chat-web/lib/api/openapi.json",
);

async function main() {
	process.chdir(chatDir); // env.ts 依赖 cwd 定位 .env.local，与 nest start 行为一致

	// Bun isolated linker 下本脚本（scripts/）的裸导入无法解析 services/chat 的依赖闭包，
	// 经 createRequire 锚定 chat package.json 取运行时包（先例 e2e/helpers/data-request-db.ts）；
	// AppModule 等 TS 模块仍走相对路径动态 import（Bun 实时转译，且其内部裸导入从
	// services/chat/src 解析，天然落在 chat 依赖闭包内，与 CJS 实例同一物理文件不重复加载）。
	const chatRequire = createRequire(path.resolve(chatDir, "package.json"));
	const { NestFactory } = chatRequire("@nestjs/core");
	const { SwaggerModule } = chatRequire("@nestjs/swagger");
	const { AppModule } = await import("../services/chat/src/app.module");
	const { createSwaggerConfig } = await import(
		"../services/chat/src/config/swagger"
	);

	const app = await NestFactory.create(AppModule, {
		logger: ["error", "warn"],
	});
	app.setGlobalPrefix("api"); // 与 main.ts 一致，保证 paths 携带 /api 前缀
	const document = SwaggerModule.createDocument(app, createSwaggerConfig());
	await app.close();

	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n", "utf-8");
	console.log(
		`[export-openapi] 已写入 ${path.relative(process.cwd(), outPath)}`,
	);
}

main().catch((error) => {
	console.error("[export-openapi] 导出失败：", error);
	process.exit(1);
});
