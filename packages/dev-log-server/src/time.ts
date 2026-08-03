/**
 * 中国时区（UTC+8）时间工具。
 * 中国无夏令时，固定 +8 偏移即可，与机器本地时区无关。
 */
const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 时间戳：2026-08-03 10:16:22.508 */
export function cnTimestamp(date = new Date()): string {
	return new Date(date.getTime() + CN_OFFSET_MS)
		.toISOString()
		.slice(0, 23)
		.replace("T", " ");
}

/** 日期：2026-08-03（用于按日切割的文件名与查询参数） */
export function cnDate(date = new Date()): string {
	return new Date(date.getTime() + CN_OFFSET_MS).toISOString().slice(0, 10);
}
