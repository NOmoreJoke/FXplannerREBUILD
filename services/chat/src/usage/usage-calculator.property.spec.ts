/**
 * consumeLotsInFifoOrder 共享内核属性测试（MVP-F0-3 / DEBT-02 抽取的防回归锁定）。
 *
 * 依据 AGENTS.md「属性测试」约定与 docs/VERIFY.md L1，覆盖四类不变量：
 * - 数量守恒（Round-trip）：Σ slices + shortfall === need；
 * - 非负不变量（Invariants）：shortfall ≥ 0、每片 quantity > 0、Σ remaining 递减；
 * - 幂等/确定性（Idempotency）：同输入两次执行结果逐片一致；
 * - 等价性（Equivalence）：与抽取前的朴素参考实现（逐批 min 消耗）逐片等价。
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Prisma } from "@prisma/client";
import {
	consumeLotsInFifoOrder,
	type FifoConsumptionLot,
} from "./usage-calculator";

/** 生成一批次：剩余量（0~1,000，3 位小数粒度）、单位成本（0~100，5 位小数粒度）；
 * id 由数组索引唯一化（重复 id 会让测试的 unitCost 回查歧义，内核本身无此约束） */
const fcLot: fc.Arbitrary<Omit<FifoConsumptionLot, "id">> = fc
	.record({
		remaining: fc.nat({ max: 1_000_000 }),
		costDigits: fc.nat({ max: 10_000_000 }),
	})
	.map(({ remaining, costDigits }) => ({
		remainingQty: new Prisma.Decimal(remaining).div(1000),
		unitCost: new Prisma.Decimal(costDigits).div(100_000),
	}));

const fcLots: fc.Arbitrary<FifoConsumptionLot[]> = fc
	.array(fcLot, { minLength: 0, maxLength: 8 })
	.map((lots) => lots.map((lot, index) => ({ ...lot, id: `lot-${index}` })));

/** 需求量（0~3,000，3 位小数粒度） */
const fcNeed: fc.Arbitrary<Prisma.Decimal> = fc
	.nat({ max: 3_000_000 })
	.map((n) => new Prisma.Decimal(n).div(1000));

describe("consumeLotsInFifoOrder 属性", () => {
	it("数量守恒：Σ slices + shortfall === need（Half-up 4 位逐片）", () => {
		const property = fc.property(fcLots, fcNeed, (lots, need) => {
			const result = consumeLotsInFifoOrder(lots, need);
			const consumed = result.slices.reduce(
				(sum, slice) => sum.add(slice.quantity),
				new Prisma.Decimal(0),
			);
			expect(consumed.add(result.shortfall).eq(need)).toBe(true);
		});
		fc.assert(property, { numRuns: 300 });
	});

	it("非负不变量：shortfall ≥ 0、每片 quantity > 0、totalCost = Σ sliceCost", () => {
		const property = fc.property(fcLots, fcNeed, (lots, need) => {
			const result = consumeLotsInFifoOrder(lots, need);
			expect(result.shortfall.isNegative()).toBe(false);
			for (const slice of result.slices) {
				expect(slice.quantity.gt(0)).toBe(true);
				expect(
					slice.cost.eq(
						slice.quantity
							.mul(
								lots.find((lot) => lot.id === slice.lotId)!.unitCost,
							)
							.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP),
					),
				).toBe(true);
			}
			expect(
				result.totalCost.eq(
					result.slices.reduce(
						(sum, slice) => sum.add(slice.cost),
						new Prisma.Decimal(0),
					),
				),
			).toBe(true);
		});
		fc.assert(property, { numRuns: 300 });
	});

	it("确定性（幂等）：同输入两次执行结果逐片一致", () => {
		const property = fc.property(fcLots, fcNeed, (lots, need) => {
			const first = consumeLotsInFifoOrder(lots, need);
			const second = consumeLotsInFifoOrder(lots, need);
			expect(second.slices).toEqual(first.slices);
			expect(second.totalCost.eq(first.totalCost)).toBe(true);
			expect(second.shortfall.eq(first.shortfall)).toBe(true);
		});
		fc.assert(property, { numRuns: 300 });
	});

	it("等价性：与抽取前朴素参考实现（逐批 min 消耗）逐片等价", () => {
		// 抽取前的参考实现（原 ledger-replay / allocateLotsFifo 内联循环的逐字复刻）：
		// 顺序遍历批次、跳过 ≤ 0、min 消耗、4 位 HALF_UP——与共享内核必须逐片等价。
		const reference = (
			lots: FifoConsumptionLot[],
			need: Prisma.Decimal,
		): {
			slices: Array<{ lotId: string; quantity: Prisma.Decimal; cost: Prisma.Decimal }>;
			totalCost: Prisma.Decimal;
			shortfall: Prisma.Decimal;
		} => {
			const slices: Array<{
				lotId: string;
				quantity: Prisma.Decimal;
				cost: Prisma.Decimal;
			}> = [];
			let totalCost = new Prisma.Decimal(0);
			let remaining = need;
			for (const lot of lots) {
				if (remaining.lte(0)) break;
				if (lot.remainingQty.lte(0)) continue;
				const take = Prisma.Decimal.min(lot.remainingQty, remaining);
				const lotCost = take
					.mul(lot.unitCost)
					.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
				slices.push({ lotId: lot.id, quantity: take, cost: lotCost });
				totalCost = totalCost.add(lotCost);
				remaining = remaining.sub(take);
			}
			return {
				slices,
				totalCost,
				shortfall: remaining.gt(0) ? remaining : new Prisma.Decimal(0),
			};
		};
		const property = fc.property(fcLots, fcNeed, (lots, need) => {
			const impl = consumeLotsInFifoOrder(lots, need);
			const oracle = reference(lots, need);
			expect(impl.slices).toEqual(oracle.slices);
			expect(impl.totalCost.eq(oracle.totalCost)).toBe(true);
			expect(impl.shortfall.eq(oracle.shortfall)).toBe(true);
		});
		fc.assert(property, { numRuns: 300 });
	});
});
