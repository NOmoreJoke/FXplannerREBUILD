import fs from "fs";

/**
 * 无依赖读取 KEY=VALUE 环境文件（dotenv 语义子集，仅裸 KEY=VALUE 行）。
 *
 * 不 import dotenv：Bun isolated linker 下 e2e/ 与根目录均未声明该依赖无法解析；
 * 顶层安装 dotenv 又会以其自带 bin 顶掉 dotenv-cli 的同名命令（`bun run dev`
 * 的 `dotenv -e` 依赖后者）。使用方：playwright.config.ts、data-request-db.ts。
 */
export function readEnvFile(absolutePath: string): Record<string, string> {
	try {
		const out: Record<string, string> = {};
		for (const line of fs.readFileSync(absolutePath, "utf8").split("\n")) {
			const kv = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
			if (kv) {
				// dotenv 语义：剥掉包裹引号（单/双）
				const raw = kv[2];
				out[kv[1]] =
					raw.length >= 2 &&
					((raw.startsWith('"') && raw.endsWith('"')) ||
						(raw.startsWith("'") && raw.endsWith("'")))
						? raw.slice(1, -1)
						: raw;
			}
		}
		return out;
	} catch {
		return {};
	}
}
