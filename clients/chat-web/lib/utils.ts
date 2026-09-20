import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 一天毫秒数与 UTC+8 固定偏移（与后端 reminder-rules 同公式，业务日口径一致） */
const DAY_MS = 86_400_000;
const UTC8_OFFSET_MS = 8 * 3_600_000;

/**
 * 截取为 UTC+8 日历天 0 点对应的 UTC 时刻（提醒「今天」口径，对齐后端
 * services/chat/src/reminder/reminder-rules.ts 的 utcPlus8Midnight）。
 * 用于判断提醒行的 scheduledFor 是否属于「今天」。
 */
export function utcPlus8DayStart(instant: Date): Date {
	const shifted = instant.getTime() + UTC8_OFFSET_MS;
	return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - UTC8_OFFSET_MS);
}
