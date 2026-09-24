import { describe, expect, it } from "vitest";
import { mergeSeries } from "./merge-series";

/** 快捷构造单币种序列 */
const series = (currency: string, points: [string, string][]) => ({
	currency,
	points: points.map(([date, rate]) => ({ date, rate })),
});

describe("mergeSeries", () => {
	it("多序列按 date 并集对齐：各币种列各就各位，共有的日期都有值", () => {
		const rows = mergeSeries([
			series("USD", [
				["2026-02-10", "0.13910462"],
				["2026-02-11", "0.13950000"],
			]),
			series("EUR", [
				["2026-02-10", "0.92100000"],
				["2026-02-11", "0.92500000"],
			]),
		]);

		expect(rows).toEqual([
			{ date: "2026-02-10", USD: 0.13910462, EUR: 0.921 },
			{ date: "2026-02-11", USD: 0.1395, EUR: 0.925 },
		]);
	});

	it("缺口 → null（不补 0）：并集中某币种缺失的日期取 null", () => {
		const rows = mergeSeries([
			series("USD", [
				["2026-02-10", "0.139"],
				["2026-02-11", "0.140"],
				["2026-02-12", "0.141"],
			]),
			// EUR 只有 10 日与 12 日（11 日缺口）
			series("EUR", [
				["2026-02-10", "0.921"],
				["2026-02-12", "0.925"],
			]),
		]);

		expect(rows).toHaveLength(3);
		expect(rows[1]).toEqual({ date: "2026-02-11", USD: 0.14, EUR: null });
		// 明确不出现补 0
		expect(rows[1].EUR).not.toBe(0);
	});

	it("乱序输入输出升序；同币种重复日期取最后一项", () => {
		const rows = mergeSeries([
			series("USD", [
				["2026-02-12", "0.141"],
				["2026-02-10", "0.139"],
				["2026-02-11", "0.140"],
				["2026-02-11", "0.14099"],
			]),
		]);

		expect(rows.map((row) => row.date)).toEqual([
			"2026-02-10",
			"2026-02-11",
			"2026-02-12",
		]);
		// 重复日期：后到覆盖
		expect(rows[1].USD).toBe(0.14099);
	});

	it("单序列退化：行结构与日期数一致，缺列不产生", () => {
		const rows = mergeSeries([series("JPY", [["2026-02-10", "20.51234567"]])]);

		expect(rows).toEqual([{ date: "2026-02-10", JPY: 20.51234567 }]);
		expect(Object.keys(rows[0])).toEqual(["date", "JPY"]);
	});

	it("rate 字符串转 number；非法 rate 按缺口 null 处理", () => {
		const rows = mergeSeries([
			series("USD", [
				["2026-02-10", "0.13910462"],
				["2026-02-11", "not-a-number"],
			]),
		]);

		expect(rows[0].USD).toBe(0.13910462);
		expect(rows[1].USD).toBeNull();
	});

	it("空输入返回空数组；某序列无点不产生日期", () => {
		expect(mergeSeries([])).toEqual([]);
		expect(mergeSeries([series("USD", [])])).toEqual([]);
	});
});
