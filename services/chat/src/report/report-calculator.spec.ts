/**
 * report-calculator 纯函数单测（reports 技术方案 §10.1，无 IO）。
 * 锁定 §4 口径：不重跑 FIFO（只做 Σ 分摊）、缺成本不按零（null）、
 * 来源拆分、hasUnknownFee、均价 roundRateTo8、币种展示舍入（JPY/KRW 0 位、
 * 其余 2 位 ROUND_HALF_UP）、差额 clamp、updatedAt 取 max、收益占位枚举。
 * §4.3 口径自检示例（doc 11 成本例 / doc 15 FIFO 例）作为用例数值锁定。
 */
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
	aggregatePlanUsage,
	computeRemainingToUse,
	computeReportUpdatedAt,
	roundForCurrencyDisplay,
	resolveYieldDisplayType,
	type ReportAllocationRow,
	type ReportUsageRecordRow,
} from "./report-calculator";

const D = (value: string) => new Prisma.Decimal(value);

/** 使用记录行构造（updatedAt 缺省锚定，断言不依赖真实时钟） */
function usage(
	id: string,
	amount: string,
	updatedAt = "2026-01-01T00:00:00.000Z",
): ReportUsageRecordRow {
	return { id, amount: D(amount), updatedAt: new Date(updatedAt) };
}

/**
 * 分摊行构造。
 * - `fee`：PURCHASE 来源交易的手续费（string = 明确 / null = 未明确；INITIAL 传 undefined → null）；
 * - `sourceType` 缺省 PURCHASE（INITIAL 显式传）。
 */
function alloc(
	usageId: string,
	quantity: string,
	cost: string,
	opts: { sourceType?: "INITIAL" | "PURCHASE"; fee?: string | null } = {},
): ReportAllocationRow {
	const sourceType = opts.sourceType ?? "PURCHASE";
	return {
		usageId,
		quantity: D(quantity),
		cost: D(cost),
		sourceType,
		feeAmount:
			sourceType === "INITIAL"
				? null
				: (opts.fee ?? null) === null
					? null
					: D(opts.fee as string),
	};
}

describe("aggregatePlanUsage（§4.1 口径唯一实现）", () => {
	it("① 无使用（空记录 + 空分摊）→ 成本/均价 null、hasUsage=false，数量为 0", () => {
		const result = aggregatePlanUsage([], []);
		expect(result.usedQuantity.toFixed(4)).toBe("0.0000");
		expect(result.usedTotalCost).toBeNull();
		expect(result.usedUnitCost).toBeNull();
		expect(result.hasUsage).toBe(false);
		expect(result.hasUnknownFee).toBe(false);
		// 来源拆分缺省 0（不出现 null 串位）
		expect(result.initialQuantity.toFixed(4)).toBe("0.0000");
		expect(result.purchaseCost.toFixed(4)).toBe("0.0000");
	});

	it("①' 有记录但分摊缺失（M7 半写）→ 数量如实累加、成本 null（缺成本不按零）、均价 null", () => {
		const result = aggregatePlanUsage([usage("u1", "400")], []);
		expect(result.usedQuantity.toFixed(4)).toBe("400.0000");
		expect(result.usedTotalCost).toBeNull();
		expect(result.usedUnitCost).toBeNull();
		expect(result.hasUsage).toBe(true);
	});

	it("② 单批次消耗 → 成本 = Σ分摊 cost（买入批次口径含手续费：7000 本金 + 100 手续费）", () => {
		// doc 11 成本示例：7,100 买 1,000（单位成本 7.10），使用 400 → 成本 2,840
		const result = aggregatePlanUsage(
			[usage("u1", "400")],
			[alloc("u1", "400", "2840", { fee: "40" })],
		);
		expect(result.usedTotalCost?.toFixed(4)).toBe("2840.0000");
		expect(result.usedUnitCost?.toFixed(8)).toBe("7.10000000");
		expect(result.hasUsage).toBe(true);
	});

	it("③ doc 15 FIFO 例：1,000@7,800 + 1,000@8,000 用 1,200 → 已使用成本 9,400", () => {
		// FIFO 结果由写侧（M7）固化为分摊行：批 1 消耗 1,000×7.8=7,800、批 2 消耗 200×8=1,600
		const result = aggregatePlanUsage(
			[usage("u1", "1200")],
			[
				alloc("u1", "1000", "7800", { fee: "0" }),
				alloc("u1", "200", "1600", { fee: "0" }),
			],
		);
		expect(result.usedQuantity.toFixed(4)).toBe("1200.0000");
		expect(result.usedTotalCost?.toFixed(4)).toBe("9400.0000");
		expect(result.usedUnitCost?.toFixed(8)).toBe("7.83333333"); // 9400/1200 全精度相除后 roundRateTo8
	});

	it("④ 来源拆分：INITIAL 与 PURCHASE 各自 quantity/cost 独立正确（跨多条使用）", () => {
		const result = aggregatePlanUsage(
			[usage("u1", "250"), usage("u2", "150")],
			[
				alloc("u1", "100", "700", { sourceType: "INITIAL" }),
				alloc("u1", "150", "1065", { fee: "15" }),
				alloc("u2", "150", "1065", { fee: "15" }),
			],
		);
		expect(result.initialQuantity.toFixed(4)).toBe("100.0000");
		expect(result.initialCost.toFixed(4)).toBe("700.0000");
		expect(result.purchaseQuantity.toFixed(4)).toBe("300.0000");
		expect(result.purchaseCost.toFixed(4)).toBe("2130.0000");
		expect(result.usedTotalCost?.toFixed(4)).toBe("2830.0000"); // 全精度加总后一次舍入口径
	});

	it("⑤ hasUnknownFee：涉未知手续费买入 → true；全明确 → false；纯初始持仓 → false", () => {
		const unknownFee = aggregatePlanUsage(
			[usage("u1", "100")],
			[alloc("u1", "100", "800", { fee: null })],
		);
		expect(unknownFee.hasUnknownFee).toBe(true);

		const knownFee = aggregatePlanUsage(
			[usage("u1", "100")],
			[alloc("u1", "100", "800", { fee: "0" })],
		);
		expect(knownFee.hasUnknownFee).toBe(false);

		const initialOnly = aggregatePlanUsage(
			[usage("u1", "100")],
			[alloc("u1", "100", "800", { sourceType: "INITIAL" })],
		);
		expect(initialOnly.hasUnknownFee).toBe(false);
	});

	it("⑥' 使用均价全精度相除后 roundRateTo8（8 位固定，ROUND_HALF_UP 不逢双进位）", () => {
		// 1 / 3 = 0.3333333333... → roundRateTo8 → 0.33333333
		const result = aggregatePlanUsage(
			[usage("u1", "3")],
			[alloc("u1", "3", "1", { fee: "0" })],
		);
		expect(result.usedUnitCost?.toFixed(8)).toBe("0.33333333");
	});
});

describe("resolveYieldDisplayType（收益占位，§5.2）", () => {
	it("⑩ 纯初始持仓 → INITIAL_ONLY_NO_COMPARISON（绝不显示 0%）", () => {
		const aggregate = aggregatePlanUsage(
			[usage("u1", "100")],
			[alloc("u1", "100", "800", { sourceType: "INITIAL" })],
		);
		expect(resolveYieldDisplayType(aggregate)).toBe(
			"INITIAL_ONLY_NO_COMPARISON",
		);
	});

	it("⑩' 含买入来源（混合或纯买入）→ NOT_SUPPORTED_YET（算法待确认）", () => {
		const mixed = aggregatePlanUsage(
			[usage("u1", "400")],
			[
				alloc("u1", "100", "700", { sourceType: "INITIAL" }),
				alloc("u1", "300", "2130", { fee: "30" }),
			],
		);
		expect(resolveYieldDisplayType(mixed)).toBe("NOT_SUPPORTED_YET");

		const purchaseOnly = aggregatePlanUsage(
			[usage("u1", "400")],
			[alloc("u1", "400", "2840", { fee: "40" })],
		);
		expect(resolveYieldDisplayType(purchaseOnly)).toBe("NOT_SUPPORTED_YET");

		// 无任何使用（无买入来源）→ 同纯初始持仓口径，不比较
		const noUsage = aggregatePlanUsage([], []);
		expect(resolveYieldDisplayType(noUsage)).toBe("INITIAL_ONLY_NO_COMPARISON");
	});
});

describe("computeRemainingToUse（计划差额，需求 5.2 条 6）", () => {
	it("⑧ 目标 − 已使用，正数原值返回", () => {
		expect(computeRemainingToUse(D("10000"), D("400")).toFixed(4)).toBe(
			"9600.0000",
		);
	});

	it("⑧' 完成后调小（已使用 > 目标）→ clamp 0，不出负数", () => {
		expect(computeRemainingToUse(D("400"), D("500")).toFixed(4)).toBe("0.0000");
		expect(computeRemainingToUse(D("0"), D("0")).toFixed(4)).toBe("0.0000");
	});
});

describe("computeReportUpdatedAt（§4.2 口径 3）", () => {
	it("⑨ 多来源取 max", () => {
		const result = computeReportUpdatedAt([
			new Date("2026-01-01T00:00:00.000Z"),
			new Date("2026-03-01T00:00:00.000Z"),
			new Date("2026-02-01T00:00:00.000Z"),
		]);
		expect(result?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
	});

	it("⑨' 全空（含 null/undefined 混入）→ null", () => {
		expect(computeReportUpdatedAt([])).toBeNull();
		expect(computeReportUpdatedAt([null, undefined])).toBeNull();
	});
});

describe("roundForCurrencyDisplay（币种展示舍入，待确认点 11 默认口径）", () => {
	it("⑥ 2 位币种 ROUND_HALF_UP：2.845 → 2.85（不逢双进位）", () => {
		expect(roundForCurrencyDisplay("2.845", "USD").toFixed(2)).toBe("2.85");
		expect(roundForCurrencyDisplay("2.844", "CNY").toFixed(2)).toBe("2.84");
	});

	it("⑦ JPY/KRW 舍入到 0 位；USD/CNY 2 位", () => {
		// doc 11 例：已使用 123,456.7 JPY 成本 89,000.5 → 123,457 / 89,001
		expect(roundForCurrencyDisplay("123456.7", "JPY").toFixed(0)).toBe(
			"123457",
		);
		expect(roundForCurrencyDisplay("89000.5", "KRW").toFixed(0)).toBe("89001");
		expect(roundForCurrencyDisplay("2840.005", "USD").toFixed(2)).toBe(
			"2840.01",
		);
	});

	it("⑦' 未知币种防御性抛错（DTO 层已前置 15 币种校验，理论不可达）", () => {
		expect(() => roundForCurrencyDisplay("1", "XYZ")).toThrow();
	});
});

describe("序列化边界（⑪ service DTO 层 toFixed 位数固定）", () => {
	it("formatUnitCost 输出 8 位固定小数（roundRateTo8 后 toFixed(8)）", () => {
		// 通过聚合结果验证：Decimal(20,4) 成本 ÷ Decimal(20,4) 数量的均价位数
		const result = aggregatePlanUsage(
			[usage("u1", "400")],
			[alloc("u1", "400", "2840", { fee: "40" })],
		);
		// service 层序列化使用 formatUnitCost；此处验证全精度相除后 8 位口径
		expect(result.usedUnitCost ? result.usedUnitCost.toFixed(8) : "").toBe(
			"7.10000000",
		);
	});

	it("null 字段不串写为 '0.0000'（无分摊 → null 原样，不产生 '0.0000' 成本）", () => {
		const result = aggregatePlanUsage([], []);
		// DTO 序列化以 === null 分支，null 永不进入 toFixed 路径
		expect(result.usedTotalCost).toBeNull();
		expect(
			result.usedTotalCost === null ? null : result.usedTotalCost.toFixed(4),
		).toBeNull();
	});
});
