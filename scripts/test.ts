/**
 * 统一测试入口（替代分散的 test 命令）
 *
 * 用法：
 *   bun run test                  # 交互式多选（空格选择，回车确认，a=全量）
 *   bun run test all              # 全量
 *   bun run test api e2e          # 指定套件（可多选，免交互）
 *
 * 套件与目录约定一一对应：
 *   unit         后端单元      services/chat/src/**\/*.spec.ts
 *   api          后端接口      services/chat/test/api/
 *   integration  后端集成      services/chat/test/integration/
 *   infra        后端基础设施  services/chat/test/prisma.spec.ts
 *   web          前端单元      clients/chat-web（vitest）
 *   money        精度计算包    packages/money（vitest，含 fast-check 属性测试）
 *   dev-log      日志服务包    packages/dev-log-server（vitest）
 *   e2e          端到端        e2e/modules/（Playwright）
 *   scripts      工具链        scripts/__tests__/（bun:test）
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import readline from "readline";

// 标准等价写法替代 Bun 专有的 import.meta.dir（类型安全，bun/node 双运行时可用）
const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Suite {
	key: string;
	label: string;
	cmd: string[];
	cwd: string;
}

const SUITES: Suite[] = [
	{
		key: "unit",
		label: "后端单元（src/*.spec.ts）",
		cmd: ["bunx", "vitest", "run", "src/"],
		cwd: "services/chat",
	},
	{
		key: "api",
		label: "后端接口（test/api）",
		cmd: ["bunx", "vitest", "run", "test/api/"],
		cwd: "services/chat",
	},
	{
		key: "integration",
		label: "后端集成（test/integration）",
		cmd: ["bunx", "vitest", "run", "test/integration/"],
		cwd: "services/chat",
	},
	{
		key: "infra",
		label: "后端基础设施（prisma.spec）",
		cmd: ["bunx", "vitest", "run", "test/prisma.spec.ts"],
		cwd: "services/chat",
	},
	{
		key: "web",
		label: "前端单元（chat-web）",
		cmd: ["bun", "run", "test"],
		cwd: "clients/chat-web",
	},
	{
		key: "money",
		label: "精度计算包（packages/money，属性测试）",
		cmd: ["bunx", "vitest", "run"],
		cwd: "packages/money",
	},
	{
		key: "dev-log",
		label: "开发日志服务包（packages/dev-log-server）",
		cmd: ["bunx", "vitest", "run"],
		cwd: "packages/dev-log-server",
	},
	{
		key: "e2e",
		label: "E2E（Playwright）",
		cmd: ["bunx", "playwright", "test", "e2e/modules", "--reporter=line"],
		cwd: ".",
	},
	{
		key: "scripts",
		label: "工具链（scripts/__tests__）",
		cmd: ["bun", "test", "scripts/__tests__/"],
		cwd: ".",
	},
];

/** 套件结果：pass 执行通过 / skip 空套件明确跳过 / fail 执行失败 */
type SuiteResult = "pass" | "skip" | "fail";

function runSuite(s: Suite): SuiteResult {
	console.log(`\n━━━ ${s.label} ━━━`);
	// 空套件防假绿：目标路径无测试文件时明确 SKIP，而不是空跑退出 0 显示 ✅
	// （bun test 对无匹配过滤器退出 0，曾导致 scripts 套件假绿，见 fx-checkup/test-coverage.md ①C）
	const target = s.cmd[s.cmd.length - 1];
	const isTestTarget = /__tests__|\.spec\.ts$/.test(target);
	if (isTestTarget && !existsSync(join(ROOT, s.cwd, target))) {
		console.log(
			`⏭️  SKIP：${target} 不存在（无工具链测试）；补充测试后此套件自动恢复执行`,
		);
		return "skip";
	}
	const r = spawnSync(s.cmd[0], s.cmd.slice(1), {
		cwd: join(ROOT, s.cwd),
		stdio: "inherit",
		env: { ...process.env, NODE_ENV: "test" },
	});
	return r.status === 0 ? "pass" : "fail";
}

/** 交互式多选：数字/逗号选择，a=全量，回车确认 */
async function pickSuites(): Promise<Suite[]> {
	console.log("🧪 选择要跑的测试套件（多选，逗号分隔；a=全量）：\n");
	SUITES.forEach((s, i) => console.log(`  ${i + 1}. ${s.label}`));
	console.log("  a. 全量\n");

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	const answer = await new Promise<string>((resolve) =>
		rl.question("输入选择 [a]：", (ans) => resolve(ans.trim() || "a")),
	);
	rl.close();

	if (answer === "a" || answer === "all") return SUITES;

	const indexes = answer
		.split(/[,，\s]+/)
		.map((s) => Number(s) - 1)
		.filter((i) => i >= 0 && i < SUITES.length);

	if (indexes.length === 0) {
		console.error("❌ 无效选择");
		process.exit(1);
	}
	return [...new Set(indexes)].map((i) => SUITES[i]);
}

async function main() {
	const args = process.argv.slice(2);
	let selected: Suite[];

	if (args.length === 0) {
		// 无参数：TTY 下交互多选；非 TTY（CI）默认全量
		selected = process.stdin.isTTY ? await pickSuites() : SUITES;
	} else if (args.includes("all")) {
		selected = SUITES;
	} else {
		const unknown = args.filter((a) => !SUITES.some((s) => s.key === a));
		if (unknown.length > 0) {
			console.error(
				`❌ 未知套件: ${unknown.join(", ")}（可选：${SUITES.map((s) => s.key).join(" / ")} / all）`,
			);
			process.exit(1);
		}
		selected = SUITES.filter((s) => args.includes(s.key));
	}

	console.log(
		`\n将执行 ${selected.length} 个套件: ${selected.map((s) => s.key).join(", ")}`,
	);

	const results: Array<{ key: string; result: SuiteResult }> = [];
	for (const s of selected) {
		results.push({ key: s.key, result: runSuite(s) });
	}

	console.log("\n━━━ 汇总 ━━━");
	for (const r of results) {
		const mark = r.result === "pass" ? "✅" : r.result === "skip" ? "⏭️ " : "❌";
		console.log(
			`${mark} ${r.key}${r.result === "skip" ? "（跳过：无测试文件）" : ""}`,
		);
	}

	const failed = results.filter((r) => r.result === "fail");
	if (failed.length > 0) {
		console.error(`\n❌ ${failed.length} 个套件失败`);
		process.exit(1);
	}
	console.log("\n🎉 全部通过");
}

main();
