import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cli = join(__dirname, "migrate.ts");

function runCli(args: string[]) {
	return spawnSync("bun", ["run", cli, ...args], {
		encoding: "utf8",
		env: { ...process.env, DATABASE_URL: "disabled" },
		input: "此输入并非冻结清单",
	});
}

describe.each(["invert", "rollback"])("%s 写入旗标", (command) => {
	it.each([
		["--apply", "false", "--confirm-backup-target"],
		["--apply=false", "--confirm-backup-target"],
		["--apply", "--confirm-backup-target", "true"],
		["--apply", "--confirm-backup-target=true"],
		["--aply", "--confirm-backup-target"],
		["--apply", "--confirm-backup-targt"],
		["--apply", "--apply", "--confirm-backup-target"],
		["--apply", "--confirm-backup-target", "rollback"],
	])("在读取清单前拒绝非法参数 %j", (...flags) => {
		const result = runCli([command, ...flags]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("参数无效");
		expect(result.stdout).toBe("");
	});

	it("只有 --apply 时要求显式确认备份目标", () => {
		const result = runCli([command, "--apply"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("--apply 需要显式携带 --confirm-backup-target");
		expect(result.stdout).toBe("");
	});
});
