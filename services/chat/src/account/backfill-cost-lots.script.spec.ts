/**
 * 存量交易成本批次回填脚本测试（account-module 技术方案 §8.1 回填五行）。
 * 直连数据库（dotenv 加载对齐 vitest.config.ts：根 .env.local → services/chat/.env.local），
 * 造数用独立测试组织，afterAll 按组织清理子表后删组织。
 * 断言对象为 runBackfill 结构化结果（CLI 退出码语义：duplicates/invariantViolations
 * 非空即非零退出，acquiredLock=false 报「另一实例运行中」——均由返回结构承载，测试直接断言）。
 */
import path from "path";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: path.resolve(__dirname, "../../../..", ".env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../..", ".env.local") });

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { runBackfill } from "./backfill-cost-lots.script";

const prisma = new PrismaClient();

/** 直插交易行（不走 DTO 校验，回填只读 id/quantity/principal/fee/transactedAt） */
function txData(
	organizationId: string,
	currencyCode: string,
	fields: {
		quantity: string;
		principalAmount: string;
		feeAmount?: string | null;
		transactedAt: Date;
	},
) {
	return {
		organizationId,
		currencyCode,
		quantity: fields.quantity,
		principalAmount: fields.principalAmount,
		feeAmount: fields.feeAmount ?? null,
		exchangeRate: "1",
		rateSource: "MANUAL",
		rateObservedAt: fields.transactedAt,
		transactedAt: fields.transactedAt,
	};
}

describe("backfill-cost-lots（存量回填，§8.1）", () => {
	let organizationId: string;
	let t1 = ""; // CAD 10600 + fee 20 ÷ 10620（unitCost 1）
	let t2 = ""; // CAD 7800 ÷ 7800（fee 未知，unitCost 1）
	let t3 = ""; // USD 10000 ÷ 10000
	let t4 = ""; // EUR 溢出脏数据：1e9 ÷ 0.01 = 1e11 ≥ 1e10

	beforeAll(async () => {
		const org = await prisma.organization.create({
			data: {
				name: `backfill-org-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			},
		});
		organizationId = org.id;

		const jan1 = new Date("2026-01-01T00:00:00.000Z");
		const jan2 = new Date("2026-01-02T00:00:00.000Z");
		const jan3 = new Date("2026-01-03T00:00:00.000Z");
		const jan4 = new Date("2026-01-04T00:00:00.000Z");
		t1 = (
			await prisma.transaction.create({
				data: txData(organizationId, "CAD", {
					quantity: "10620",
					principalAmount: "10600",
					feeAmount: "20",
					transactedAt: jan1,
				}),
			})
		).id;
		t2 = (
			await prisma.transaction.create({
				data: txData(organizationId, "CAD", {
					quantity: "7800",
					principalAmount: "7800",
					feeAmount: null,
					transactedAt: jan2,
				}),
			})
		).id;
		t3 = (
			await prisma.transaction.create({
				data: txData(organizationId, "USD", {
					quantity: "10000",
					principalAmount: "10000",
					feeAmount: "0",
					transactedAt: jan3,
				}),
			})
		).id;
		t4 = (
			await prisma.transaction.create({
				data: txData(organizationId, "EUR", {
					// 存量脏数据：unitCost = 1e9 ÷ 0.01 = 1e11 溢出 Decimal(20,10)
					quantity: "0.01",
					principalAmount: "1000000000",
					feeAmount: "0",
					transactedAt: jan4,
				}),
			})
		).id;

		// 账户 balance 与 Σ remainingQty 平衡（CAD 10620+7800、USD 10000），
		// 不给 EUR 建账户（溢出条目被跳过后不会误触不变式违规）
		await prisma.account.create({
			data: { organizationId, currencyCode: "CAD", balance: "18420" },
		});
		await prisma.account.create({
			data: { organizationId, currencyCode: "USD", balance: "10000" },
		});
	});

	afterAll(async () => {
		await prisma.costLot.deleteMany({ where: { organizationId } }).catch(() => undefined);
		await prisma.transaction.deleteMany({ where: { organizationId } }).catch(() => undefined);
		await prisma.account.deleteMany({ where: { organizationId } }).catch(() => undefined);
		await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
		await prisma.$disconnect();
	});

	it("缺失批次补齐：本组织 3 条（溢出条目跳过），字段与实时写入 §3.4 公式一致", async () => {
		// runBackfill 为全量脚本（库内可能有其他组织的历史数据/并行测试数据），
		// 全局计数（processedOrganizations/createdLots）仅作下界断言，本组织语义按 organizationId 过滤验证
		const result = await runBackfill(prisma);

		expect(result.acquiredLock).toBe(true);
		expect(result.processedOrganizations).toBeGreaterThanOrEqual(1);
		expect(result.createdLots).toBeGreaterThanOrEqual(3); // CAD 2 + USD 1，EUR 溢出条目不计
		expect(
			result.duplicates.filter((d) => d.organizationId === organizationId),
		).toHaveLength(0);

		const ownLots = await prisma.costLot.findMany({
			where: { organizationId, sourceType: "PURCHASE" },
		});
		expect(ownLots).toHaveLength(3); // CAD 2 + USD 1
		// USD 组（t3）也已补齐
		expect(
			ownLots.find((lot) => lot.sourceId === t3)?.totalCost.toFixed(4),
		).toBe("10000.0000");

		const lot1 = await prisma.costLot.findFirst({
			where: { sourceType: "PURCHASE", sourceId: t1 },
		});
		expect(lot1).not.toBeNull();
		expect(lot1?.organizationId).toBe(organizationId);
		expect(lot1?.currencyCode).toBe("CAD");
		expect(lot1?.quantity.toFixed(4)).toBe("10620.0000");
		expect(lot1?.remainingQty.toFixed(4)).toBe("10620.0000"); // 新批次未消耗
		expect(lot1?.totalCost.toFixed(4)).toBe("10620.0000"); // 10600 + 20
		expect(lot1?.unitCost.toFixed(8)).toBe("1.00000000");
		expect(lot1?.acquiredAt.getTime()).toBe(
			new Date("2026-01-01T00:00:00.000Z").getTime(),
		);

		// fee 未知（null）以本金口径（与实时录入 buildPurchaseLot 同一实现）
		const lot2 = await prisma.costLot.findFirst({
			where: { sourceType: "PURCHASE", sourceId: t2 },
		});
		expect(lot2?.totalCost.toFixed(4)).toBe("7800.0000");
		expect(lot2?.unitCost.toFixed(8)).toBe("1.00000000");
	});

	it("已有批次跳过（幂等）：重跑 createdLots=0、批次总数不变", async () => {
		const before = await prisma.costLot.count({ where: { organizationId } });
		const result = await runBackfill(prisma);

		expect(result.acquiredLock).toBe(true);
		expect(result.skipped.filter((s) => s.sourceId === t4)).toHaveLength(1); // 溢出条目每次都计入明细
		const after = await prisma.costLot.count({ where: { organizationId } });
		expect(after).toBe(before);
		expect(after).toBe(3);
	});

	it("实时写入与回填交错（第④步已先行插入）：不产生重复批次", async () => {
		// 新交易 + 预先手工插入对应批次（模拟实时录入第④步先于回填完成）
		const t5 = await prisma.transaction.create({
			data: txData(organizationId, "USD", {
				quantity: "500",
				principalAmount: "500",
				feeAmount: null,
				transactedAt: new Date("2026-01-05T00:00:00.000Z"),
			}),
		});
		await prisma.costLot.create({
			data: {
				organizationId,
				currencyCode: "USD",
				sourceType: "PURCHASE",
				sourceId: t5.id,
				quantity: "500",
				remainingQty: "500",
				unitCost: "1",
				totalCost: "500",
				acquiredAt: t5.transactedAt,
			},
		});
		// 同步账户余额（模拟第②步），保持不变式平衡
		await prisma.account.updateMany({
			where: { organizationId, currencyCode: "USD" },
			data: { balance: "10500" },
		});

		// 回填跑完后再查：预插批次使组内复检命中，不产生第二行
		await runBackfill(prisma);
		const t5Lots = await prisma.costLot.count({
			where: {
				organizationId,
				currencyCode: "USD",
				sourceType: "PURCHASE",
				sourceId: t5.id,
			},
		});
		expect(t5Lots).toBe(1); // 组内复检命中已先行插入的批次，无重复
	});

	it("单组失败跳过：溢出脏数据计入 skipped 明细，其他分组补写不受中断", async () => {
		const result = await runBackfill(prisma);

		expect(result.skipped.filter((s) => s.sourceId === t4)).toHaveLength(1);
		expect(result.skipped[0]?.reason).toContain("单位成本超出系统上限");
		// 溢出条目所在 EUR 组无批次
		expect(
			await prisma.costLot.count({
				where: { organizationId, currencyCode: "EUR", sourceType: "PURCHASE" },
			}),
		).toBe(0);
		// 同库其他分组批次完好（CAD 2 + USD 2）
		expect(
			await prisma.costLot.count({
				where: { organizationId, currencyCode: "CAD", sourceType: "PURCHASE" },
			}),
		).toBe(2);
		expect(
			await prisma.costLot.count({
				where: { organizationId, currencyCode: "USD", sourceType: "PURCHASE" },
			}),
		).toBe(2);
	});

	it("不变式违反（balance ≠ Σ remainingQty）：invariantViolations 非空（CLI 据此非零退出）", async () => {
		// 直插余额与批次不符的账户（500 无批次），不静默修复语义
		await prisma.account.create({
			data: { organizationId, currencyCode: "GBP", balance: "500" },
		});

		const result = await runBackfill(prisma);
		// 全库扫描下仅断言本测试组织的违规行（库内历史数据不归本次修复，不静默处理）
		const ownViolations = result.invariantViolations.filter(
			(violation) => violation.organizationId === organizationId,
		);
		expect(ownViolations).toHaveLength(1);
		const violation = ownViolations[0];
		expect(violation?.currencyCode).toBe("GBP");
		expect(violation?.balance).toBe("500.0000");
		expect(violation?.lotRemainingQty).toBe("0.0000");
		expect(
			result.duplicates.filter((d) => d.organizationId === organizationId),
		).toHaveLength(0);
	});
});
