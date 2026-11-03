import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { assertTransactedAtInRange } from "../transaction/transaction-calculator";
import {
	assertUsedAtInRange,
	allocateLotsFifo,
	compareLedgerEntries,
	compareLots,
	computeFundStatus,
	utc8DayStart,
	UsageCalcError,
	UsageLotShortageError,
	type FifoLotInput,
} from "./usage-calculator";

/**
 * 资金使用纯函数单测（技术方案 §8.1）：FIFO 排序/顺序分摊/成本计算/不足拦截/
 * 日期校验/资金状态/与 transaction 侧一致性（镜像用例）。
 * 锚定算例：15_专业术语清单.md:64（1,000@7,800 + 1,000@8,000，用 1,200 → 成本 9,400）。
 */

const D = (value: string) => new Prisma.Decimal(value);
const TS = (iso: string) => new Date(iso);

/** 批次构造器（缺省 PURCHASE、remainingQty 100、unitCost 1，按需覆盖） */
function lot(overrides: Partial<FifoLotInput> & { id: string }): FifoLotInput {
	return {
		sourceType: "PURCHASE",
		remainingQty: D("100"),
		unitCost: D("1"),
		acquiredAt: TS("2026-09-01T00:00:00.000Z"),
		createdAt: TS("2026-09-01T01:00:00.000Z"),
		...overrides,
	};
}

function throwsOf(run: () => unknown): boolean {
	try {
		run();
		return false;
	} catch {
		return true;
	}
}

describe("compareLots（FIFO 排序键）", () => {
	it("acquiredAt 升序：早买先耗", () => {
		const early = lot({ id: "a", acquiredAt: TS("2026-09-01T00:00:00.000Z") });
		const late = lot({ id: "b", acquiredAt: TS("2026-09-02T00:00:00.000Z") });
		expect(compareLots(early, late)).toBeLessThan(0);
		expect(compareLots(late, early)).toBeGreaterThan(0);
	});

	it("同日 INITIAL（初始持仓）先于 PURCHASE（普通买入）", () => {
		const initial = lot({
			id: "a",
			sourceType: "INITIAL",
			acquiredAt: TS("2026-09-01T00:00:00.000Z"),
		});
		const purchase = lot({
			id: "b",
			sourceType: "PURCHASE",
			acquiredAt: TS("2026-09-01T00:00:00.000Z"),
		});
		expect(compareLots(initial, purchase)).toBeLessThan(0);
	});

	it("同日同类按 createdAt（首次录入顺序）", () => {
		const first = lot({
			id: "a",
			createdAt: TS("2026-09-01T01:00:00.000Z"),
		});
		const second = lot({
			id: "b",
			createdAt: TS("2026-09-01T02:00:00.000Z"),
		});
		expect(compareLots(first, second)).toBeLessThan(0);
	});

	it("全键相同按 id 升序兜底（稳定排序）", () => {
		const a = lot({ id: "a" });
		const b = lot({ id: "b" });
		expect(compareLots(a, b)).toBeLessThan(0);
		expect(compareLots(b, a)).toBeGreaterThan(0);
		expect(compareLots(a, { ...a })).toBe(0);
	});
});

/**
 * 权威共享比较器（BE-01 口径统一）：增量 compareLots 与重放
 * ledger-replay.compareEvents 均委托本函数（禁止第二份实现）。
 * 上述 compareLots 用例经委托路径已覆盖四层键；此处补齐
 * USAGE 层与「精确时刻（非日界）」语义——重放侧独有行为。
 */
describe("compareLedgerEntries（增量/重放共享权威比较器）", () => {
	const entry = (over: {
		id: string;
		happenedAt: Date;
		type?: string;
		createdAt?: Date;
	}) => ({
		id: over.id,
		happenedAt: over.happenedAt,
		type: over.type ?? "PURCHASE",
		createdAt: over.createdAt ?? TS("2026-09-01T00:00:00.000Z"),
	});

	it("同日不同时刻按精确时刻排（非日界粗粒度）：10:00 先于 14:00", () => {
		const morning = entry({
			id: "a",
			happenedAt: TS("2026-09-01T02:00:00.000Z"),
		});
		const afternoon = entry({
			id: "b",
			happenedAt: TS("2026-09-01T06:00:00.000Z"),
		});
		expect(compareLedgerEntries(morning, afternoon)).toBeLessThan(0);
	});

	it("同刻时 INITIAL（批次）先于 USAGE（使用事件）——type 层含重放三型", () => {
		const initial = entry({
			id: "a",
			happenedAt: TS("2026-09-01T02:00:00.000Z"),
			type: "INITIAL",
		});
		const usage = entry({
			id: "b",
			happenedAt: TS("2026-09-01T02:00:00.000Z"),
			type: "USAGE",
		});
		expect(compareLedgerEntries(initial, usage)).toBeLessThan(0);
		expect(compareLedgerEntries(usage, initial)).toBeGreaterThan(0);
	});

	it("同刻同型按 createdAt → id 兜底（与 compareLots 全序一致）", () => {
		const first = entry({
			id: "a",
			happenedAt: TS("2026-09-01T02:00:00.000Z"),
			createdAt: TS("2026-09-01T01:00:00.000Z"),
		});
		const second = entry({
			id: "b",
			happenedAt: TS("2026-09-01T02:00:00.000Z"),
			createdAt: TS("2026-09-01T01:00:00.000Z"),
		});
		expect(compareLedgerEntries(first, second)).toBeLessThan(0);
		expect(compareLedgerEntries(second, first)).toBeGreaterThan(0);
	});
});

describe("allocateLotsFifo（顺序分摊）", () => {
	it("跨批次：先尽最早批次（15 术语清单 :64 算例 1,200 → 9,400）", () => {
		const result = allocateLotsFifo(
			[
				lot({
					id: "lot-2",
					remainingQty: D("1000"),
					unitCost: D("8"),
					acquiredAt: TS("2026-09-02T00:00:00.000Z"),
				}),
				lot({
					id: "lot-1",
					remainingQty: D("1000"),
					unitCost: D("7.8"),
					acquiredAt: TS("2026-09-01T00:00:00.000Z"),
				}),
			],
			D("1200"),
			2,
		);
		expect(result.slices).toHaveLength(2);
		expect(result.slices[0]).toEqual({
			lotId: "lot-1",
			quantity: D("1000"),
			cost: D("7800.0000"),
		});
		expect(result.slices[1]).toEqual({
			lotId: "lot-2",
			quantity: D("200"),
			cost: D("1600.0000"),
		});
		expect(result.totalCost.toFixed(4)).toBe("9400.0000");
	});

	it("单批次整耗：恰好耗尽清零", () => {
		const result = allocateLotsFifo(
			[lot({ id: "lot-1", remainingQty: D("500"), unitCost: D("2") })],
			D("500"),
			2,
		);
		expect(result.slices).toHaveLength(1);
		expect(result.slices[0].quantity.toFixed(4)).toBe("500.0000");
		expect(result.totalCost.toFixed(4)).toBe("1000.0000");
	});

	it("末批次部分消耗：只取需求量，不动剩余量（递减由调用方按 slice 执行）", () => {
		const result = allocateLotsFifo(
			[
				lot({ id: "lot-1", remainingQty: D("300"), unitCost: D("1") }),
				lot({ id: "lot-2", remainingQty: D("700"), unitCost: D("2") }),
			],
			D("500"),
			2,
		);
		expect(result.slices[1].quantity.toFixed(4)).toBe("200.0000");
		expect(result.slices[1].cost.toFixed(4)).toBe("400.0000");
	});

	it("同日排序生效：分摊顺序 = INITIAL 先于同日 PURCHASE", () => {
		const result = allocateLotsFifo(
			[
				lot({
					id: "purchase",
					sourceType: "PURCHASE",
					remainingQty: D("1000"),
					unitCost: D("9"),
				}),
				lot({
					id: "initial",
					sourceType: "INITIAL",
					remainingQty: D("1000"),
					unitCost: D("5"),
				}),
			],
			D("800"),
			2,
		);
		expect(result.slices).toHaveLength(1);
		expect(result.slices[0].lotId).toBe("initial");
		expect(result.totalCost.toFixed(4)).toBe("4000.0000");
	});

	it("成本计算：每片按 4 位 HALF_UP 舍一次（0.01 × 3.45675 = 0.0345675 → 0.0346）", () => {
		const result = allocateLotsFifo(
			[lot({ id: "lot-1", remainingQty: D("1"), unitCost: D("3.45675") })],
			D("0.01"),
			2,
		);
		expect(result.slices[0].cost.toFixed(4)).toBe("0.0346");
		expect(result.totalCost.toFixed(4)).toBe("0.0346");
	});

	it("成本计算：总成本 = Σ片成本（各片独立舍入后求和，不二次舍入）", () => {
		const result = allocateLotsFifo(
			[
				lot({ id: "lot-1", remainingQty: D("0.01"), unitCost: D("3.45675") }),
				lot({ id: "lot-2", remainingQty: D("0.01"), unitCost: D("3.45675") }),
			],
			D("0.02"),
			2,
		);
		expect(result.slices.map((slice) => slice.cost.toFixed(4))).toEqual([
			"0.0346",
			"0.0346",
		]);
		expect(result.totalCost.toFixed(4)).toBe("0.0692");
	});

	it("日元（0 位精度币种）：整数需求可分摊，成本仍按 4 位金额精度", () => {
		const result = allocateLotsFifo(
			[
				lot({
					id: "jpy-lot",
					remainingQty: D("100000"),
					unitCost: D("0.00731"),
				}),
			],
			D("300"),
			0,
		);
		expect(result.slices[0].quantity.toFixed(4)).toBe("300.0000");
		expect(result.totalCost.toFixed(4)).toBe("2.1930");
	});

	it("不足拦截：ΣremainingQty < 需求量抛 UsageLotShortageError，不产出部分分摊", () => {
		const run = () =>
			allocateLotsFifo(
				[
					lot({ id: "lot-1", remainingQty: D("300"), unitCost: D("1") }),
					lot({ id: "lot-2", remainingQty: D("200"), unitCost: D("1") }),
				],
				D("600"),
				2,
			);
		expect(throwsOf(run)).toBe(true);
		expect(() => run()).toThrow(UsageLotShortageError);
		try {
			run();
		} catch (error) {
			expect((error as UsageLotShortageError).code).toBe("USAGE_LOT_SHORTAGE");
			expect(
				(
					(error as UsageLotShortageError).data?.lotRemaining as Prisma.Decimal
				).toFixed(4),
			).toBe("500.0000");
		}
	});

	it("非法入参：need ≤ 0 / 非有限 / 超币种精度 → UsageCalcError INVALID_USAGE_PARAMS", () => {
		const lots = [lot({ id: "lot-1" })];
		expect(() => allocateLotsFifo(lots, D("0"), 2)).toThrow(UsageCalcError);
		expect(() => allocateLotsFifo(lots, D("-1"), 2)).toThrow(UsageCalcError);
		expect(() => allocateLotsFifo(lots, D("0.01"), 0)).toThrow(/整数币种/);
		expect(() => allocateLotsFifo(lots, D("0.001"), 2)).toThrow(/2 位小数/);
	});
});

describe("assertUsedAtInRange（使用日期上下界）", () => {
	// 固定 now：2026-09-20T08:00Z → UTC+8 当日 0 点 = 2026-09-19T16:00Z
	const now = TS("2026-09-20T08:00:00.000Z");
	const ledgerStart = TS("2026-09-10T00:00:00.000Z");

	it("晚于今天（UTC+8 口径）拒：次日 0 点即越界，message 可区分", () => {
		expect(() =>
			assertUsedAtInRange(TS("2026-09-21T00:00:00.000Z"), now, null),
		).toThrow(/不能晚于今天/);
		// UTC+8 的明天从 2026-09-20T16:00Z 开始
		expect(() =>
			assertUsedAtInRange(TS("2026-09-20T16:00:00.000Z"), now, null),
		).toThrow(/不能晚于今天/);
	});

	it("今天（UTC+8 当日 0 点起）放行", () => {
		expect(() =>
			assertUsedAtInRange(TS("2026-09-19T16:00:00.000Z"), now, null),
		).not.toThrow();
	});

	it("早于账本起点所在日（UTC+8）拒；起点当日任意时刻放行；起点为 null 跳过下界", () => {
		// 起点日界：起点 09-10T00:00Z（UTC+8 当日 = 09-10，该日 0 点 = 09-09T16:00Z）
		expect(() =>
			assertUsedAtInRange(TS("2026-09-09T15:59:59.000Z"), now, ledgerStart),
		).toThrow(/不能早于记账起点/);
		expect(() =>
			assertUsedAtInRange(TS("2026-09-09T23:59:59.000Z"), now, ledgerStart),
		).not.toThrow(); // 起点当日 0-8 点窗口（UTC+8 日内任意时刻可补录）
		expect(() =>
			assertUsedAtInRange(TS("2026-09-10T00:00:00.000Z"), now, ledgerStart),
		).not.toThrow();
		expect(() =>
			assertUsedAtInRange(TS("2020-01-01T00:00:00.000Z"), now, null),
		).not.toThrow();
	});

	it("与 transaction 侧 assertTransactedAtInRange 同输入同判定（互为镜像）", () => {
		const cases: [Date, Date, Date | null][] = [
			[TS("2026-09-21T00:00:00.000Z"), now, null], // 明天：双拒
			[TS("2026-09-20T16:00:00.000Z"), now, null], // UTC+8 明天 0 点：双拒
			[TS("2026-09-19T16:00:00.000Z"), now, null], // 今天 0 点：双过
			[TS("2026-09-09T15:59:59.000Z"), now, ledgerStart], // 起点前一日最后一刻：双拒
			[TS("2026-09-09T23:59:59.000Z"), now, ledgerStart], // 起点当日早窗：双过（日粒度下界）
			[TS("2026-09-10T00:00:00.000Z"), now, ledgerStart], // 起点当日：双过
			[TS("2020-01-01T00:00:00.000Z"), now, null], // 无起点：双过
		];
		for (const [usedAt, at, start] of cases) {
			expect(throwsOf(() => assertUsedAtInRange(usedAt, at, start))).toBe(
				throwsOf(() => assertTransactedAtInRange(usedAt, at, start)),
			);
		}
	});

	it("utc8DayStart 与 transaction-calculator 导出同值（复制语义不漂移）", () => {
		expect(utc8DayStart(now).toISOString()).toBe("2026-09-19T16:00:00.000Z");
	});
});

describe("computeFundStatus（资金状态映射）", () => {
	it("三态映射：PREPARING / READY / USED_UP", () => {
		expect(
			computeFundStatus({
				stillNeeded: D("4000"),
				gap: D("4000"),
				remainingAllocation: D("0"),
			}),
		).toBe("PREPARING");
		expect(
			computeFundStatus({
				stillNeeded: D("6000"),
				gap: D("0"),
				remainingAllocation: D("6000"),
			}),
		).toBe("READY");
		expect(
			computeFundStatus({
				stillNeeded: D("0"),
				gap: D("0"),
				remainingAllocation: D("0"),
			}),
		).toBe("USED_UP");
	});

	it("防御态：stillNeeded = 0 且剩余分配 > 0 不判 USED_UP，归 PREPARING", () => {
		expect(
			computeFundStatus({
				stillNeeded: D("0"),
				gap: D("0"),
				remainingAllocation: D("1000"),
			}),
		).toBe("PREPARING");
	});
});
