/**
 * account-calculator 纯函数单测（account-module 技术方案 §8.1，无 IO）。
 * 锁定 §3.3 口径：分配汇总全状态不过滤、负数不 clamp（与 plan-calculator computeCaps
 * 刻意不同）、余额 0 不计算平均成本、金额/单位成本序列化在 DTO 层（本层返回 Decimal）。
 */
import { describe, expect, it } from "vitest";
import { Prisma, type Transaction as TransactionModel } from "@prisma/client";
import { TransactionInvalidParamsException } from "../transaction/transaction-calculator";
import {
	assertUnitCostInRange,
	buildPurchaseLot,
	computeRemainingCost,
	mergeLedgerItems,
	sumAllocatedByCurrency,
} from "./account-calculator";

/** 交易行内存形态（calculator 只读 id/userId/currencyCode/quantity/principal/fee/transactedAt） */
function fakeTx(overrides: Partial<TransactionModel> = {}): TransactionModel {
	return {
		id: "tx-1",
		userId: "user-1",
		currencyCode: "CAD",
		quantity: new Prisma.Decimal("10620"),
		principalAmount: new Prisma.Decimal("10600"),
		feeAmount: new Prisma.Decimal("20"),
		exchangeRate: new Prisma.Decimal("0.99811751"),
		rateSource: "MANUAL",
		rateObservedAt: new Date("2026-01-01T00:00:00.000Z"),
		planId: null,
		transactedAt: new Date("2026-01-01T00:00:00.000Z"),
		version: 1,
		createdAt: new Date("2026-01-01T00:00:01.000Z"),
		updatedAt: new Date("2026-01-01T00:00:01.000Z"),
		...overrides,
	} as TransactionModel;
}

describe("sumAllocatedByCurrency", () => {
	it("多计划多币种分组求和：Σ(amount − usedAmount)", () => {
		const result = sumAllocatedByCurrency([
			{ currencyCode: "CAD", amount: new Prisma.Decimal("6000"), usedAmount: new Prisma.Decimal("1000") },
			{ currencyCode: "CAD", amount: new Prisma.Decimal("500"), usedAmount: new Prisma.Decimal("0") },
			{ currencyCode: "USD", amount: new Prisma.Decimal("300"), usedAmount: new Prisma.Decimal("100") },
		]);
		expect(result.size).toBe(2);
		expect(result.get("CAD")?.toFixed(4)).toBe("5500.0000"); // 5000 + 500
		expect(result.get("USD")?.toFixed(4)).toBe("200.0000");
	});

	it("CANCELLED 计划（amount = used，已释放）计 0：全状态不过滤", () => {
		const result = sumAllocatedByCurrency([
			// 取消时 amount → max(used, 0)（plan.service cancel），差额恒 0
			{ currencyCode: "CAD", amount: new Prisma.Decimal("4000"), usedAmount: new Prisma.Decimal("4000") },
			{ currencyCode: "CAD", amount: new Prisma.Decimal("6000"), usedAmount: new Prisma.Decimal("0") },
		]);
		expect(result.get("CAD")?.toFixed(4)).toBe("6000.0000");
	});

	it("usedAmount > 0 部分使用：按差额计入（M7 超用口径回归网）", () => {
		const result = sumAllocatedByCurrency([
			{ currencyCode: "JPY", amount: new Prisma.Decimal("100000"), usedAmount: new Prisma.Decimal("40000") },
		]);
		expect(result.get("JPY")?.toFixed(4)).toBe("60000.0000");
	});

	it("空输入返回空 Map（无分配账户由调用方 ?? 0 兜底）", () => {
		const result = sumAllocatedByCurrency([]);
		expect(result.size).toBe(0);
		expect(result.get("CAD")).toBeUndefined();
	});

	it("超用（used > amount）产生负贡献、合计为负：不 clamp（锁定与 computeCaps 的口径差异）", () => {
		const result = sumAllocatedByCurrency([
			// 超用 2000：M7 后可能触发（超用计划存续，完成时才拒绝，§3.3）
			{ currencyCode: "CAD", amount: new Prisma.Decimal("3000"), usedAmount: new Prisma.Decimal("5000") },
			{ currencyCode: "CAD", amount: new Prisma.Decimal("1000"), usedAmount: new Prisma.Decimal("0") },
		]);
		expect(result.get("CAD")?.toFixed(4)).toBe("-1000.0000");
		expect(result.get("CAD")?.isNegative()).toBe(true); // 负数原样保留，禁止 max(0)
	});
});

describe("buildPurchaseLot", () => {
	it("fee = 20：totalCost = 10620、unitCost = 1（方案 §8.1 例，可复算）", () => {
		const lot = buildPurchaseLot(
			fakeTx({
				principalAmount: new Prisma.Decimal("10600"),
				feeAmount: new Prisma.Decimal("20"),
				quantity: new Prisma.Decimal("10620"),
			}),
		);
		expect(lot.sourceType).toBe("PURCHASE");
		expect(lot.sourceId).toBe("tx-1");
		expect((lot.quantity as Prisma.Decimal).toFixed(4)).toBe("10620.0000");
		expect((lot.remainingQty as Prisma.Decimal).toFixed(4)).toBe("10620.0000");
		expect((lot.totalCost as Prisma.Decimal).toFixed(4)).toBe("10620.0000");
		expect((lot.unitCost as Prisma.Decimal).toFixed(8)).toBe("1.00000000");
		expect((lot.acquiredAt as Date).getTime()).toBe(
			new Date("2026-01-01T00:00:00.000Z").getTime(),
		); // acquiredAt = transactedAt
	});

	it("fee = 0（无手续费）：totalCost = 本金", () => {
		const lot = buildPurchaseLot(
			fakeTx({
				principalAmount: new Prisma.Decimal("5000"),
				feeAmount: new Prisma.Decimal("0"),
				quantity: new Prisma.Decimal("10000"),
			}),
		);
		expect((lot.totalCost as Prisma.Decimal).toFixed(4)).toBe("5000.0000");
		expect((lot.unitCost as Prisma.Decimal).toFixed(8)).toBe("0.50000000");
	});

	it("fee = null（未知）：以本金口径计算成本", () => {
		const lot = buildPurchaseLot(
			fakeTx({
				principalAmount: new Prisma.Decimal("7800"),
				feeAmount: null,
				quantity: new Prisma.Decimal("7800"),
			}),
		);
		expect((lot.totalCost as Prisma.Decimal).toFixed(4)).toBe("7800.0000");
		expect((lot.unitCost as Prisma.Decimal).toFixed(8)).toBe("1.00000000");
	});

	it("unitCost 溢出 Decimal(20,10)（1e9 ÷ 0.01 = 1e11 ≥ 1e10）：400 INVALID_TRANSACTION_PARAMS", () => {
		try {
			buildPurchaseLot(
				fakeTx({
					principalAmount: new Prisma.Decimal("1000000000"),
					feeAmount: new Prisma.Decimal("0"),
					quantity: new Prisma.Decimal("0.01"),
				}),
			);
			expect.unreachable("应当抛出");
		} catch (error) {
			expect(error).toBeInstanceOf(TransactionInvalidParamsException);
			const response = (error as TransactionInvalidParamsException).getResponse() as {
				code: string;
				message: string;
			};
			expect(response.code).toBe("INVALID_TRANSACTION_PARAMS");
			expect(response.message).toContain("单位成本超出系统上限");
		}
	});

	it("assertUnitCostInRange 边界：恰为 1e10 抛出；略小于 1e10 通过（gte 判定）", () => {
		expect(() =>
			assertUnitCostInRange(
				new Prisma.Decimal("10000000000"), // unitCost = 1e10（开区间上界）
				new Prisma.Decimal("0"),
				new Prisma.Decimal("1"),
			),
		).toThrow(TransactionInvalidParamsException);
		expect(() =>
			assertUnitCostInRange(
				new Prisma.Decimal("9999999999"), // unitCost 略小于 1e10
				new Prisma.Decimal("0"),
				new Prisma.Decimal("1"),
			),
		).not.toThrow();
	});
});

describe("computeRemainingCost", () => {
	it("正常批次求和：Σ(remainingQty × unitCost)", () => {
		const result = computeRemainingCost([
			{ remainingQty: new Prisma.Decimal("10000"), unitCost: new Prisma.Decimal("1") },
			{ remainingQty: new Prisma.Decimal("500"), unitCost: new Prisma.Decimal("2") },
		]);
		expect(result.remainingTotalCost?.toFixed(4)).toBe("11000.0000");
		expect(result.averageUnitCost?.toFixed(8)).toBe("1.04761905"); // 11000 ÷ 10500
	});

	it("部分消耗（remainingQty < quantity）：按剩余量计算", () => {
		const result = computeRemainingCost([
			{ remainingQty: new Prisma.Decimal("30"), unitCost: new Prisma.Decimal("2") }, // quantity 100 已耗 70
		]);
		expect(result.remainingTotalCost?.toFixed(4)).toBe("60.0000");
		expect(result.averageUnitCost?.toFixed(8)).toBe("2.00000000");
	});

	it("多批次混合：剩余成本与平均单位成本同时正确", () => {
		const result = computeRemainingCost([
			{ remainingQty: new Prisma.Decimal("10"), unitCost: new Prisma.Decimal("1") },
			{ remainingQty: new Prisma.Decimal("20"), unitCost: new Prisma.Decimal("3") },
		]);
		expect(result.remainingTotalCost?.toFixed(4)).toBe("70.0000");
		expect(result.averageUnitCost?.toFixed(8)).toBe("2.33333333"); // 70 ÷ 30
	});

	it("全消耗（Σ remainingQty = 0）：averageUnitCost = null，余额 0 不计算（doc 04）", () => {
		const result = computeRemainingCost([
			{ remainingQty: new Prisma.Decimal("0"), unitCost: new Prisma.Decimal("2") },
		]);
		expect(result.remainingTotalCost?.toFixed(4)).toBe("0.0000");
		expect(result.averageUnitCost).toBeNull();
	});

	it("空数组：两值均 null（无批次，旧数据未回填）", () => {
		const result = computeRemainingCost([]);
		expect(result.remainingTotalCost).toBeNull();
		expect(result.averageUnitCost).toBeNull();
	});

	it("8 位四舍五入：1/3 舍去、2/3 第 9 位进位（toFixed(8) 断言）", () => {
		const one = computeRemainingCost([
			{ remainingQty: new Prisma.Decimal("1"), unitCost: new Prisma.Decimal("1") },
			{ remainingQty: new Prisma.Decimal("2"), unitCost: new Prisma.Decimal("0") },
		]); // 1 ÷ 3
		expect(one.averageUnitCost?.toFixed(8)).toBe("0.33333333");

		const two = computeRemainingCost([
			{ remainingQty: new Prisma.Decimal("1"), unitCost: new Prisma.Decimal("2") },
			{ remainingQty: new Prisma.Decimal("2"), unitCost: new Prisma.Decimal("0") },
		]); // 2 ÷ 3 → 第 9 位 6 进位
		expect(two.averageUnitCost?.toFixed(8)).toBe("0.66666667");
	});
});

describe("mergeLedgerItems", () => {
	const occurred = (iso: string) => new Date(iso);

	it("PURCHASE + USAGE 合并后按 occurredAt 倒序", () => {
		const merged = mergeLedgerItems(
			[
				{ id: "p1", occurredAt: occurred("2026-01-03T00:00:00.000Z"), createdAt: occurred("2026-01-03T10:00:00.000Z") },
				{ id: "p2", occurredAt: occurred("2026-01-01T00:00:00.000Z"), createdAt: occurred("2026-01-01T10:00:00.000Z") },
			],
			[{ id: "u1", occurredAt: occurred("2026-01-02T00:00:00.000Z"), createdAt: occurred("2026-01-02T10:00:00.000Z") }],
		);
		expect(merged.map((item) => item.id)).toEqual(["p1", "u1", "p2"]);
	});

	it("同刻按 createdAt 倒序稳定排列（后录入在前）", () => {
		const at = occurred("2026-01-02T00:00:00.000Z");
		const merged = mergeLedgerItems(
			[
				{ id: "p-early", occurredAt: at, createdAt: occurred("2026-01-02T08:00:00.000Z") },
				{ id: "p-late", occurredAt: at, createdAt: occurred("2026-01-02T12:00:00.000Z") },
			],
			[{ id: "u-same", occurredAt: at, createdAt: occurred("2026-01-02T10:00:00.000Z") }],
		);
		expect(merged.map((item) => item.id)).toEqual(["p-late", "u-same", "p-early"]);
	});

	it("空输入返回空数组", () => {
		expect(mergeLedgerItems([], [])).toEqual([]);
	});
});
