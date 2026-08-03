import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LogWriter } from "./writer.js";

describe("LogWriter", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-log-server-"));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("自动创建日志目录", () => {
		const nested = path.join(dir, "a/b");
		new LogWriter({ dir: nested });
		expect(fs.existsSync(nested)).toBe(true);
	});

	it("按日切割写入当天文件", () => {
		const writer = new LogWriter({ dir });
		const now = new Date("2025-01-02T03:04:05Z");
		writer.write('{"msg":"hello"}', now);

		const file = path.join(dir, "frontend-error-2025-01-02.log");
		expect(fs.readFileSync(file, "utf8")).toBe('{"msg":"hello"}\n');
	});

	it("超过 maxBytes 轮转分卷，当前文件重新计数", () => {
		const writer = new LogWriter({ dir, maxBytes: 10, maxVolumes: 2 });
		const now = new Date("2025-01-02T00:00:00Z");
		const file = writer.currentFile(now);

		writer.write("1234567890", now); // 11 字节，直接写满
		writer.write("abc", now); // 触发轮转，旧内容进 .1

		expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("1234567890\n");
		expect(fs.readFileSync(file, "utf8")).toBe("abc\n");
	});

	it("分卷数量超过 maxVolumes 时丢弃最老分卷", () => {
		const writer = new LogWriter({ dir, maxBytes: 1, maxVolumes: 2 });
		const now = new Date("2025-01-02T00:00:00Z");
		const file = writer.currentFile(now);

		writer.write("v1", now);
		writer.write("v2", now);
		writer.write("v3", now);
		writer.write("v4", now);

		expect(fs.readFileSync(file, "utf8")).toBe("v4\n");
		expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("v3\n");
		expect(fs.readFileSync(`${file}.2`, "utf8")).toBe("v2\n");
		expect(fs.existsSync(`${file}.3`)).toBe(false);
	});

	it("readRecent 返回最近 N 条，文件不存在返回空数组", () => {
		const writer = new LogWriter({ dir });
		const now = new Date("2025-01-02T00:00:00Z");

		expect(writer.readRecent(10, "2025-01-02")).toEqual([]);

		writer.write("l1", now);
		writer.write("l2", now);
		writer.write("l3", now);

		expect(writer.readRecent(2, "2025-01-02")).toEqual(["l2", "l3"]);
		expect(writer.readRecent(10, "2025-01-02")).toEqual(["l1", "l2", "l3"]);
	});
});
