import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * benchmark-p6 安全闸门的黑盒测试（先例：rate-cache-migration/migrate.spec.ts）。
 *
 * CLI 在模块加载时即执行 main()，无法被 import，故一律以子进程方式调用。
 * 全部「应拒绝」用例都必须在连接数据库之前被拦下，所以：
 * - 主机类用例指向不可路由的 TEST-NET 地址，其余用例指向回环主机上不存在的端口——
 *   即使闸门失效也连不上任何真实库；
 * - 每条断言退出码 1、stderr 含对应的拦截原因（而不是连接失败等别的报错）、stdout 为空。
 */
const cli = join(__dirname, "benchmark-p6.ts");

/** RFC 5737 TEST-NET-1：不可路由，闸门若放行只会等到超时 */
const UNROUTABLE_URL = "postgresql://bench:bench@192.0.2.1:5432/fxplanner_w30_perf_test";
/** 回环主机 + 不存在的端口：能通过主机校验，用来隔离库名 / 参数类的拦截 */
const localUrl = (database: string, query = ""): string =>
	`postgresql://bench:bench@localhost:1/${database}${query}`;

interface CliResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

function runCli(
	args: readonly string[],
	env: Record<string, string> = {},
): CliResult {
	// 每个用例都显式给出 DATABASE_URL，不让 Bun 自动加载的 .env.local 把真实测试库带进子进程
	const result = spawnSync("bun", ["run", cli, ...args], {
		encoding: "utf8",
		env: { ...process.env, NODE_ENV: "test", ...env },
		timeout: 30_000,
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function expectRejected(result: CliResult, reason: string): void {
	expect(result.status).toBe(1);
	expect(result.stderr).toContain(reason);
	expect(result.stdout).toBe("");
}

describe("benchmark-p6 安全闸门（连接数据库之前拒绝）", () => {
	it("NODE_ENV=production 下一律拒绝", () => {
		expectRejected(
			runCli([], {
				DATABASE_URL: localUrl("fxplanner_w30_perf_test"),
				NODE_ENV: "production",
			}),
			"NODE_ENV=production",
		);
	});

	it("只接受 postgresql 协议", () => {
		expectRejected(
			runCli([], {
				DATABASE_URL: "mysql://bench:bench@localhost:1/fxplanner_w30_perf_test",
			}),
			"仅支持 postgresql",
		);
	});

	it("连接串无法解析", () => {
		expectRejected(
			runCli([], { DATABASE_URL: "not-a-connection-string" }),
			"格式非法",
		);
	});

	it("非回环主机", () => {
		expectRejected(
			runCli([], { DATABASE_URL: UNROUTABLE_URL }),
			"仅允许回环主机",
		);
	});

	it.each(["host=192.0.2.1", "Host=192.0.2.1"])(
		"?%s 覆写目标主机（键名大小写不敏感）",
		(query) => {
			expectRejected(
				runCli([], {
					DATABASE_URL: localUrl("fxplanner_w30_perf_test", `?${query}`),
				}),
				"?host=",
			);
		},
	);

	it.each(["fxplanner_prod", "FXPLANNER_PROD_BAK"])(
		"生产库名 %s（大小写不敏感）",
		(database) => {
			expectRejected(
				runCli([], { DATABASE_URL: localUrl(database) }),
				"拒绝生产库",
			);
		},
	);

	it("空库名", () => {
		expectRejected(
			runCli([], { DATABASE_URL: localUrl("") }),
			"空库名",
		);
	});

	it.each([
		"fxplanner_w30_perf",
		"fxplanner_new_db_local",
		"fxplanner_new_db_migbak",
	])("库名 %s 不以 _test 结尾", (database) => {
		expectRejected(
			runCli([], { DATABASE_URL: localUrl(database) }),
			"仅允许以 _test 结尾",
		);
	});

	it("环境变量不能放宽库名闸门", () => {
		expectRejected(
			runCli([], {
				DATABASE_URL: localUrl("fxplanner_new_db_migbak"),
				FXPLANNER_BENCH_DATABASE: "fxplanner_new_db_migbak",
			}),
			"仅允许以 _test 结尾",
		);
	});
});

describe("benchmark-p6 参数校验（连接数据库之前拒绝）", () => {
	it.each([
		["--iterations", "99"],
		["--iterations", "abc"],
		["--orgs", "104"],
		["--rows-per-org", "9"],
		["--warmup", "9"],
	])("%s %s 低于下限或不是整数", (flag, value) => {
		expectRejected(
			runCli([flag, value], { DATABASE_URL: localUrl("fxplanner_w30_perf_test") }),
			flag,
		);
	});

	it("未知参数", () => {
		expectRejected(
			runCli(["--unknown", "1"], {
				DATABASE_URL: localUrl("fxplanner_w30_perf_test"),
			}),
			"未知参数",
		);
	});

	it("--out 缺少取值", () => {
		expectRejected(
			runCli(["--out"], { DATABASE_URL: localUrl("fxplanner_w30_perf_test") }),
			"缺少参数值",
		);
	});
});

describe("benchmark-p6 输出路径", () => {
	it("--out 指向仓库目录内时拒绝，且不落任何文件", () => {
		const insideRepo = join(__dirname, "w30-perf-must-not-exist.json");
		expectRejected(
			runCli(["--out", insideRepo], {
				DATABASE_URL: localUrl("fxplanner_w30_perf_test"),
			}),
			"禁止将基准输出写入仓库目录内",
		);
		expect(existsSync(insideRepo)).toBe(false);
	});

	it("--out 位于仓库之外时通过路径校验，继续走到数据库闸门", () => {
		const result = runCli(
			["--out", join("/tmp", "w30-perf-spec-probe.json")],
			{ DATABASE_URL: UNROUTABLE_URL },
		);
		// 路径校验先于数据库闸门：出现主机拦截即说明 --out 已被放行
		expectRejected(result, "仅允许回环主机");
	});
});
