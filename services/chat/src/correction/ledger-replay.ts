/**
 * 账本全量重放引擎（corrections 技术方案 §5.1，本次 M8 的核心算法）。
 *
 * 对单个币种按固定规则重排并重算全部成本与余额，纯内存计算、无 IO：
 * - 排序（BE-01 口径统一，fx-checkup 波次 2）：与 usage-calculator.compareLedgerEntries
 *   同一权威比较器（共享导出，禁止复制第二份）：happenedAt 精确时刻升序 →
 *   typeRank（INITIAL < PURCHASE < USAGE，同刻时批次先于使用）→ createdAt 升序 → id 兜底；
 * - INITIAL/PURCHASE → 生成 CostLot：PURCHASE 的 unitCost = (principal + (fee ?? 0)) / quantity，
 *   fee=null 时按已录金额计算（doc 14 例 12：费用未完整 ≠ 按 0 完整）；INITIAL 沿用
 *   InitialHolding 的采用汇率/折算成本（与 onboarding 写入口径一致）；
 * - USAGE → FIFO 消耗 remainingQty > 0 的批次，生成 UsageLotAllocation 明细与该笔使用成本；
 *   消耗前校验「时点充足性」：累计流入(初始+买入) − 累计使用 ≥ 本次使用额，
 *   不足则记违规 { usageId, usedAt, shortfall }（doc 09:64-70「过去的钱是否够用」）。
 *
 * preview（只读）与 apply（事务内复核）共用本函数——所见即所存（方案 §3 结论）。
 * 量级预估（方案 §2）：单币种重放事件量千级以内，毫秒级完成。
 */
import { Prisma } from "@prisma/client";
import { compareLedgerEntries } from "../usage/usage-calculator";

export type LedgerEventType = "INITIAL" | "PURCHASE" | "USAGE";

/** 重放输入事件（内存形态，字段拷贝自 DB 行并应用拟变更，Decimal 全精度） */
export interface LedgerEvent {
	type: LedgerEventType;
	/** 来源行 id（Transaction.id / InitialHolding.id / UsageRecord.id） */
	id: string;
	/**
	 * 业务发生时间：INITIAL = 账本起点（批次 acquiredAt 口径，缺账本起点兜底 confirmedAt）、
	 * PURCHASE = transactedAt、USAGE = usedAt。重放排序与重建批次 acquiredAt 均以此为准。
	 */
	happenedAt: Date;
	/** 首录顺序（createdAt；更正永不修改，方案假设 1） */
	createdAt: Date;
	/** 流入/消耗数量：INITIAL.amount / PURCHASE.quantity / USAGE.amount */
	quantity: Prisma.Decimal;
	/** INITIAL 批次单位成本（= InitialHolding.rate 采用汇率） */
	unitCost?: Prisma.Decimal;
	/** INITIAL 批次总成本（= InitialHolding.cost 折算成本，保持原写入口径） */
	totalCost?: Prisma.Decimal;
	/** PURCHASE：本金（unitCost = (principal + (fee ?? 0)) / quantity） */
	principalAmount?: Prisma.Decimal;
	/** PURCHASE：手续费（null = 未知，按 0 计入成本并保留「费用未完整」标注） */
	feeAmount?: Prisma.Decimal | null;
}

/** 历史时点缺口（V3 校验输入；doc 14 例 11：过去某笔使用发生时同币种资金不足） */
export interface ReplayViolation {
	usageId: string;
	usedAt: Date;
	/** 缺口数量（外币） */
	shortfall: Prisma.Decimal;
}

/** 重放产出的成本批次（与 CostLot 行字段一一对应；id/时间戳由 Prisma 生成） */
export interface ReplayLot {
	sourceType: "INITIAL" | "PURCHASE";
	sourceId: string;
	quantity: Prisma.Decimal;
	remainingQty: Prisma.Decimal;
	unitCost: Prisma.Decimal;
	totalCost: Prisma.Decimal;
	acquiredAt: Date;
}

/** 重放产出的使用分摊明细（lotId 以 sourceId 表达，落库时映射为新建批次 id） */
export interface ReplayUsageAllocation {
	usageId: string;
	lotSourceId: string;
	quantity: Prisma.Decimal;
	/** 本笔分摊成本（本位币，已按金额列精度 HALF_UP 4 位舍入，与增量口径一致） */
	cost: Prisma.Decimal;
}

/** 重放结果（方案 §5.1 ④：lots、usageAllocations、每笔使用成本、finalBalance、violations） */
export interface ReplayResult {
	lots: ReplayLot[];
	usageAllocations: ReplayUsageAllocation[];
	/** 每笔使用的总成本（usageId → 本位币成本） */
	usageCosts: Map<string, Prisma.Decimal>;
	/** 重放终态余额 = 累计流入(初始+买入) − 累计使用 */
	finalBalance: Prisma.Decimal;
	/** 历史时点缺口清单（非空 = V3 违反） */
	violations: ReplayViolation[];
	/** 是否存在手续费未明确的买入批次（fee=null；warnings 提示「成本说明继续保留」） */
	hasUnknownFeeLot: boolean;
}

/**
 * 单币种账本重放（方案 §5.1 ①~④）。输入为该币种的 InitialHolding + Transaction +
 * UsageRecord 全集（拟更正内容由调用方在构造事件时应用——preview 与 apply 共用）。
 */
export function replayCurrencyLedger(events: LedgerEvent[]): ReplayResult {
	// 排序：与增量记账共享同一权威比较器（BE-01 统一；同刻 createdAt 并列由 id 兜底）
	const sorted = [...events].sort(compareLedgerEntries);
	const lots: ReplayLot[] = [];
	const usageAllocations: ReplayUsageAllocation[] = [];
	const usageCosts = new Map<string, Prisma.Decimal>();
	const violations: ReplayViolation[] = [];
	let inflow = new Prisma.Decimal(0);
	let used = new Prisma.Decimal(0);
	let hasUnknownFeeLot = false;

	for (const event of sorted) {
		if (event.type === "USAGE") {
			// 时点充足性校验（过去的钱是否够用，doc 09:64-70）：
			// 不借未来买入补过去使用；不足即记违规（不阻断重放，剩余缺口进 violations）
			const available = inflow.sub(used);
			if (available.lt(event.quantity)) {
				violations.push({
					usageId: event.id,
					usedAt: event.happenedAt,
					shortfall: event.quantity.sub(available),
				});
			}
			// FIFO 消耗：按排序后批次顺序消耗 remainingQty > 0 的批次。
			// 每片成本按金额列精度 HALF_UP 舍一次——与增量 allocateLotsFifo 同一口径
			// （docs/15:64「每片成本 = quantity × unitCost 按金额列精度 4 位舍一次」），
			// 镜像测试（fifo-mirror.spec）锁定逐片相等。
			let remaining = event.quantity;
			let cost = new Prisma.Decimal(0);
			for (const lot of lots) {
				if (remaining.lte(0)) break;
				if (lot.remainingQty.lte(0)) continue;
				const take = Prisma.Decimal.min(lot.remainingQty, remaining);
				const lotCost = take.mul(lot.unitCost).toDecimalPlaces(
					4,
					Prisma.Decimal.ROUND_HALF_UP,
				);
				cost = cost.add(lotCost);
				lot.remainingQty = lot.remainingQty.sub(take);
				usageAllocations.push({
					usageId: event.id,
					lotSourceId: lot.sourceId,
					quantity: take,
					cost: lotCost,
				});
				remaining = remaining.sub(take);
			}
			usageCosts.set(event.id, cost);
			used = used.add(event.quantity);
			continue;
		}

		// INITIAL / PURCHASE → 生成成本批次
		const isInitial = event.type === "INITIAL";
		const fee = event.feeAmount ?? null;
		const unitCost = isInitial
			? event.unitCost!
			: event.principalAmount!.add(fee ?? 0).div(event.quantity);
		const totalCost = isInitial
			? event.totalCost!
			: event.principalAmount!.add(fee ?? 0);
		if (!isInitial && fee === null) {
			hasUnknownFeeLot = true;
		}
		// 数量为 0 的流入（初始持仓改 0 且无历史使用，验收场景 13）不生成空批次
		if (event.quantity.gt(0)) {
			lots.push({
				sourceType: isInitial ? "INITIAL" : "PURCHASE",
				sourceId: event.id,
				quantity: event.quantity,
				remainingQty: event.quantity,
				unitCost,
				totalCost,
				acquiredAt: event.happenedAt,
			});
		}
		inflow = inflow.add(event.quantity);
	}

	return {
		lots,
		usageAllocations,
		usageCosts,
		finalBalance: inflow.sub(used),
		violations,
		hasUnknownFeeLot,
	};
}

