import { describe, expect, it } from "vitest";
import { cnDate, cnTimestamp } from "./time.js";

describe("中国时区时间工具", () => {
	it("cnTimestamp 输出 UTC+8 时间", () => {
		// UTC 2025-01-01 16:00:00 = 北京时间 2025-01-02 00:00:00
		expect(cnTimestamp(new Date("2025-01-01T16:00:00.000Z"))).toBe(
			"2025-01-02 00:00:00.000",
		);
	});

	it("cnTimestamp 毫秒保留且不跨日时正常", () => {
		expect(cnTimestamp(new Date("2025-01-01T15:59:59.999Z"))).toBe(
			"2025-01-01 23:59:59.999",
		);
	});

	it("cnDate 按 UTC+8 取日期（跨日边界）", () => {
		expect(cnDate(new Date("2025-01-01T16:00:00Z"))).toBe("2025-01-02");
		expect(cnDate(new Date("2025-01-01T15:59:59Z"))).toBe("2025-01-01");
	});
});
