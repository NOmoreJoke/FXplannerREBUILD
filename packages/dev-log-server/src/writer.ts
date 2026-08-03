import fs from "node:fs";
import path from "node:path";
import { cnDate } from "./time.js";

export interface LogWriterOptions {
	/** 日志目录（不存在会自动创建） */
	dir: string;
	/** 单文件最大字节数，超出则轮转分卷，默认 10MB */
	maxBytes?: number;
	/** 最多保留的分卷数量（不含当前文件），默认 5 */
	maxVolumes?: number;
}

/**
 * 本地日志写入器：
 * - 按日切割：frontend-error-YYYY-MM-DD.log
 * - 单文件超 maxBytes 轮转：.1 .2 ... 最多保留 maxVolumes 卷
 */
export class LogWriter {
	private readonly dir: string;
	private readonly maxBytes: number;
	private readonly maxVolumes: number;

	constructor(options: LogWriterOptions) {
		this.dir = options.dir;
		this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
		this.maxVolumes = options.maxVolumes ?? 5;
		fs.mkdirSync(this.dir, { recursive: true });
	}

	/** 当前日期（中国时区）对应的日志文件路径（按日切割） */
	currentFile(now = new Date()): string {
		return path.join(this.dir, `frontend-error-${cnDate(now)}.log`);
	}

	write(line: string, now = new Date()): void {
		const file = this.currentFile(now);
		this.rotateIfNeeded(file, Buffer.byteLength(line) + 1);
		fs.appendFileSync(file, `${line}\n`);
	}

	/**
	 * 读取指定日期（默认今天）的最近 maxLines 条日志，按时间正序返回。
	 * 文件不存在时返回空数组。
	 */
	readRecent(maxLines: number, date = cnDate()): string[] {
		const file = path.join(this.dir, `frontend-error-${date}.log`);
		if (!fs.existsSync(file)) return [];
		const lines = fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
		return lines.slice(-maxLines);
	}

	private rotateIfNeeded(file: string, incomingBytes: number): void {
		if (!fs.existsSync(file)) return;
		const { size } = fs.statSync(file);
		if (size + incomingBytes <= this.maxBytes) return;

		// 最老的分卷直接丢弃，其余顺移：file.(n-1) -> file.n，file -> file.1
		const oldest = `${file}.${this.maxVolumes}`;
		if (fs.existsSync(oldest)) fs.rmSync(oldest);
		for (let i = this.maxVolumes - 1; i >= 1; i--) {
			const from = `${file}.${i}`;
			if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
		}
		fs.renameSync(file, `${file}.1`);
	}
}
