/**
 * 账本全量重放引擎单测（corrections 技术方案 §8.1）。
 * 断言锚定：docs/14_业务逻辑清单.md 例 10-12 数值表与 doc 15「先进先出的例子」
 * （两笔买入成本 7,800/8,000 → 使用 1,200 成本 9,400、剩余 6,400）。
 * 排序断言用显式 createdAt 序列注入，禁止依赖真实时间（方案 §8 时钟隔离约定）。
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { replayCurrencyLedger, type LedgerEvent } from "./ledger-replay";

const d = (value: string | number) => new Prisma.Decimal(value);

/** PURCHASE 事件工厂（happenedAt/createdAt 显式注入，fee 缺省 0 = 无手续费） */
function purchase(
	id: string,
	happenedAt: string,
	createdAt: string,
	quantity: string,
	principal: string,
	fee: string | null = "0",
): LedgerEvent {
	return {
		type: "PURCHASE",
		id,
		happenedAt: new Date(happenedAt),
		createdAt: new Date(createdAt),
		quantity: d(quantity),
		principalAmount: d(principal),
		feeAmount: fee === null ? null : d(fee),
	};
}

/** USAGE 事件工厂 */
function usage(
	id: string,
	happenedAt: string,
	createdAt: string,
	quantity: string,
): LedgerEvent {
	return {
		type: "USAGE",
		id,
		happenedAt: new Date(happenedAt),
		createdAt: new Date(createdAt),
		quantity: d(quantity),
	};
}

/** INITIAL 事件工厂 */
function initial(
	id: string,
	happenedAt: string,
	createdAt: string,
	quantity: string,
	rate: string,
	cost: string,
): LedgerEvent {
	return {
		type: "INITIAL",
		id,
		happenedAt: new Date(happenedAt),
		createdAt: new Date(createdAt),
		quantity: d(quantity),
		unitCost: d(rate),
		totalCost: d(cost),
	};
}

describe("replayCurrencyLedger 排序规则（doc 09:55-62）", () => {
	it("同日内：初始持仓 → 买入 → 使用；同类按 createdAt 首录顺序", () => {
		// 同日发生时刻与类型、首录顺序相反。重放应先入账初始持仓和首录买入。
		const result = replayCurrencyLedger([
			usage("u1", "2026-09-01T00:00:00Z", "2026-09-01T10:00:00Z", "300"),
			purchase(
				"p2",
				"2026-09-01T01:00:00Z",
				"2026-09-01T09:00:00Z",
				"500",
				"4000",
			),
			purchase(
				"p1",
				"2026-09-01T02:00:00Z",
				"2026-09-01T08:00:00Z",
				"500",
				"3000",
			),
			initial(
				"i1",
				"2026-09-01T04:00:00Z",
				"2026-09-01T07:00:00Z",
				"200",
				"6",
				"1200",
			),
		]);

		// 使用 300 先耗初始持仓 200，再耗首录批次 p1 的 100。
		expect(result.usageAllocations).toEqual([
			{
				usageId: "u1",
				lotSourceId: "i1",
				quantity: d("200"),
				cost: d("1200"),
			},
			{
				usageId: "u1",
				lotSourceId: "p1",
				quantity: d("100"),
				cost: d("600"),
			},
		]);
		expect(result.finalBalance.eq(d("900"))).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it("跨日：买入按 UTC+8 日界升序；更正不改 createdAt ⇒ 修改后的记录落回新日期位置", () => {
		// p2 日期更晚但 createdAt 更早：排序按 happenedAt 的 UTC+8 日界
		const result = replayCurrencyLedger([
			purchase(
				"p2",
				"2026-09-02T10:00:00Z",
				"2026-09-01T08:00:00Z",
				"400",
				"3200",
			),
			purchase(
				"p1",
				"2026-09-01T10:00:00Z",
				"2026-09-02T08:00:00Z",
				"400",
				"3600",
			),
			usage("u1", "2026-09-03T02:00:00Z", "2026-09-03T08:00:00Z", "500"),
		]);

		// FIFO：9/1 的 p1（unit 9）先耗尽 400，再消耗 9/2 的 p2（unit 8）100
		expect(result.usageCosts.get("u1")!.eq(d("4400"))).toBe(true);
		expect(result.lots.map((lot) => lot.sourceId)).toEqual(["p1", "p2"]);
		expect(result.lots[0].remainingQty.eq(0)).toBe(true);
		expect(result.lots[1].remainingQty.eq(d("300"))).toBe(true);
	});
});

describe("replayCurrencyLedger FIFO 成本（doc 15 例 + 例 10 改日期）", () => {
	/** doc 15 场景：两笔买入各 1,000（成本 7,800 与 8,000）+ 9/4 使用 1,200 */
	function doc15Events(firstTradeAt: string): LedgerEvent[] {
		return [
			purchase("p1", firstTradeAt, "2026-09-01T08:00:00Z", "1000", "7800"),
			purchase(
				"p2",
				"2026-09-02T02:00:00Z",
				"2026-09-02T08:00:00Z",
				"1000",
				"8000",
			),
			usage("u1", "2026-09-04T02:00:00Z", "2026-09-04T08:00:00Z", "1200"),
		];
	}

	it("doc 15：使用 1,200 的 FIFO 成本 = 9,400，剩余批次成本 6,400", () => {
		const result = replayCurrencyLedger(doc15Events("2026-09-01T02:00:00Z"));

		// 先耗 p1（1,000 × 7.8 = 7,800）再耗 p2（200 × 8.0 = 1,600）
		expect(result.usageCosts.get("u1")!.eq(d("9400"))).toBe(true);
		expect(result.usageAllocations).toEqual([
			{
				usageId: "u1",
				lotSourceId: "p1",
				quantity: d("1000"),
				cost: d("7800"),
			},
			{ usageId: "u1", lotSourceId: "p2", quantity: d("200"), cost: d("1600") },
		]);
		// 不变式：Σ使用成本 = Σ分摊成本；finalBalance = 流入 − 使用
		const allocationSum = result.usageAllocations.reduce(
			(sum, allocation) => sum.add(allocation.cost),
			new Prisma.Decimal(0),
		);
		expect(allocationSum.eq(result.usageCosts.get("u1")!)).toBe(true);
		expect(result.finalBalance.eq(d("800"))).toBe(true);
		expect(result.lots[1].remainingQty.eq(d("800"))).toBe(true);
	});

	it("例 10：第一笔日期改到第二笔之后、仍早于使用日 → 使用成本重算 9,560、剩余 6,240", () => {
		// p1 改到 9/3（仍早于 9/4 使用）：排序变为 p2(9/2, unit 8.0) → p1(9/3, unit 7.8) → u1(9/4)
		const result = replayCurrencyLedger(doc15Events("2026-09-03T02:00:00Z"));

		expect(result.usageCosts.get("u1")!.eq(d("9560"))).toBe(true);
		expect(result.usageAllocations).toEqual([
			{
				usageId: "u1",
				lotSourceId: "p2",
				quantity: d("1000"),
				cost: d("8000"),
			},
			{ usageId: "u1", lotSourceId: "p1", quantity: d("200"), cost: d("1560") },
		]);
		expect(result.finalBalance.eq(d("800"))).toBe(true);
		expect(
			result.lots
				.find((lot) => lot.sourceId === "p1")!
				.remainingQty.eq(d("800")),
		).toBe(true);
	});
});

describe("replayCurrencyLedger 手续费未知（doc 14 例 12）", () => {
	it("fee=null 批次按已录金额计算单位成本，并保留费用未完整标注", () => {
		const result = replayCurrencyLedger([
			// 1,000 / 本金 7,800 / 手续费未知 → unit = 7.8（≠ 按 0 完整口径的差别仅在于标注）
			purchase(
				"p1",
				"2026-09-01T02:00:00Z",
				"2026-09-01T08:00:00Z",
				"1000",
				"7800",
				null,
			),
			purchase(
				"p2",
				"2026-09-01T03:00:00Z",
				"2026-09-01T09:00:00Z",
				"1000",
				"7820",
				"20",
			),
			usage("u1", "2026-09-02T02:00:00Z", "2026-09-02T08:00:00Z", "1500"),
		]);

		expect(result.hasUnknownFeeLot).toBe(true);
		// FIFO 消耗 p1 全部（7.8 × 1000）+ p2 的 500（(7820+20)/1000 = 7.84 × 500）
		expect(result.usageCosts.get("u1")!.eq(d("11720"))).toBe(true);
		expect(result.lots[0].unitCost.eq(d("7.8"))).toBe(true);
		expect(result.lots[1].unitCost.eq(d("7.84"))).toBe(true);
	});

	it("全部批次费用明确时 hasUnknownFeeLot = false", () => {
		const result = replayCurrencyLedger([
			purchase(
				"p1",
				"2026-09-01T02:00:00Z",
				"2026-09-01T08:00:00Z",
				"1000",
				"7800",
				"0",
			),
		]);
		expect(result.hasUnknownFeeLot).toBe(false);
	});
});

describe("replayCurrencyLedger 时点充足性（V3，doc 14 例 11#2）", () => {
	it("买入日期改到使用之后 → 记录使用时点的缺口 { usedAt, shortfall }", () => {
		// 9/1 买 1,000、9/2 用 400；买入日期改 9/3 → 9/2 使用发生时流入 0
		const result = replayCurrencyLedger([
			purchase(
				"p1",
				"2026-09-03T02:00:00Z",
				"2026-09-01T08:00:00Z",
				"1000",
				"7800",
			),
			usage("u1", "2026-09-02T02:00:00Z", "2026-09-02T08:00:00Z", "400"),
		]);

		expect(result.violations).toEqual([
			{
				usageId: "u1",
				usedAt: new Date("2026-09-02T02:00:00Z"),
				shortfall: d("400"),
			},
		]);
		// 使用发生在买入批次之前：不借未来买入补过去使用（doc 09:64-70），无批次可消耗
		expect(result.usageCosts.get("u1")!.eq(0)).toBe(true);
		expect(result.lots[0].remainingQty.eq(d("1000"))).toBe(true);
		// 终态余额仍为流入 − 使用（负向时点问题由 V3 拦截，终态由 V1 拦截）
		expect(result.finalBalance.eq(d("600"))).toBe(true);
	});

	it("先前缺口用尽后续流入时，下一笔使用仍有累计缺口", () => {
		const firstUsedAt = "2026-09-02T02:00:00Z";
		const secondUsedAt = "2026-09-04T02:00:00Z";
		const firstPurchaseAt = "2026-09-01T02:00:00Z";
		const middlePurchaseAt = "2026-09-03T02:00:00Z";
		const lastPurchaseAt = "2026-09-05T02:00:00Z";
		const result = replayCurrencyLedger([
			purchase("p1", firstPurchaseAt, firstPurchaseAt, "100", "700"),
			usage("u1", firstUsedAt, firstUsedAt, "150"),
			purchase("p2", middlePurchaseAt, middlePurchaseAt, "50", "400"),
			usage("u2", secondUsedAt, secondUsedAt, "20"),
			purchase("p3", lastPurchaseAt, lastPurchaseAt, "100", "900"),
		]);

		expect(result.violations).toEqual([
			{ usageId: "u1", usedAt: new Date(firstUsedAt), shortfall: d("50") },
			{ usageId: "u2", usedAt: new Date(secondUsedAt), shortfall: d("20") },
		]);
		expect(result.usageAllocations).toEqual([
			{
				usageId: "u1",
				lotSourceId: "p1",
				quantity: d("100"),
				cost: d("700"),
			},
			{
				usageId: "u2",
				lotSourceId: "p2",
				quantity: d("20"),
				cost: d("160"),
			},
		]);
		expect(result.usageCosts).toEqual(
			new Map([["u1", d("700")], ["u2", d("160")]]),
		);
		expect(result.lots.map((lot) => lot.remainingQty)).toEqual([
			d("0"), d("30"), d("100"),
		]);
		expect(result.finalBalance).toEqual(d("80"));
	});

	it("时点足够但有其他批次顺序变化 → 无违规", () => {
		const result = replayCurrencyLedger([
			purchase(
				"p1",
				"2026-09-01T02:00:00Z",
				"2026-09-01T08:00:00Z",
				"1000",
				"7800",
			),
			usage("u1", "2026-09-02T02:00:00Z", "2026-09-02T08:00:00Z", "400"),
		]);
		expect(result.violations).toHaveLength(0);
		expect(result.finalBalance.eq(d("600"))).toBe(true);
	});
});

describe("replayCurrencyLedger 边界", () => {
	it("空账本：零批次、零余额、零违规", () => {
		const result = replayCurrencyLedger([]);
		expect(result.lots).toHaveLength(0);
		expect(result.usageAllocations).toHaveLength(0);
		expect(result.usageCosts.size).toBe(0);
		expect(result.finalBalance.eq(0)).toBe(true);
		expect(result.violations).toHaveLength(0);
		expect(result.hasUnknownFeeLot).toBe(false);
	});

	it("单批次完全消耗后 remainingQty = 0、余额 = 0", () => {
		const result = replayCurrencyLedger([
			purchase(
				"p1",
				"2026-09-01T02:00:00Z",
				"2026-09-01T08:00:00Z",
				"100",
				"800",
			),
			usage("u1", "2026-09-02T02:00:00Z", "2026-09-02T08:00:00Z", "100"),
		]);
		expect(result.finalBalance.eq(0)).toBe(true);
		expect(result.lots[0].remainingQty.eq(0)).toBe(true);
	});

	it("使用超过流入：缺口 = 使用额 − 可用量，余额为负交由上层 V1 拦截", () => {
		const result = replayCurrencyLedger([
			purchase(
				"p1",
				"2026-09-01T02:00:00Z",
				"2026-09-01T08:00:00Z",
				"600",
				"4800",
			),
			usage("u1", "2026-09-02T02:00:00Z", "2026-09-02T08:00:00Z", "1000"),
		]);
		expect(result.violations[0].shortfall.eq(d("400"))).toBe(true);
		expect(result.finalBalance.eq(d("-400"))).toBe(true);
	});

	it("INITIAL 批次：unitCost/totalCost 沿用持仓行的采用汇率与折算成本", () => {
		const result = replayCurrencyLedger([
			initial(
				"i1",
				"2026-09-01T00:00:00Z",
				"2026-09-01T00:00:00Z",
				"1200",
				"7.248",
				"8697.6",
			),
		]);
		expect(result.lots).toEqual([
			{
				sourceType: "INITIAL",
				sourceId: "i1",
				quantity: d("1200"),
				remainingQty: d("1200"),
				unitCost: d("7.248"),
				totalCost: d("8697.6"),
				acquiredAt: new Date("2026-09-01T00:00:00Z"),
			},
		]);
		expect(result.finalBalance.eq(d("1200"))).toBe(true);
	});

	it("INITIAL 改 0（数量 0）不生成空批次，仅余额归 0（验收场景 13 无使用路径）", () => {
		const result = replayCurrencyLedger([
			initial(
				"i1",
				"2026-09-01T00:00:00Z",
				"2026-09-01T00:00:00Z",
				"0",
				"7.248",
				"0",
			),
		]);
		expect(result.lots).toHaveLength(0);
		expect(result.finalBalance.eq(0)).toBe(true);
		expect(result.violations).toHaveLength(0);
	});
});
