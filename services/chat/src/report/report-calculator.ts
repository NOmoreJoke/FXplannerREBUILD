/**
 * 报告模块纯函数层（reports 技术方案 §3.1/§4）：成本摘要聚合。
 *
 * 零 IO、无框架状态，ReportService 只做编排（与 account-calculator /
 * plan-calculator / transaction-calculator 分层先例一致）。
 *
 * 核心口径（§4，方案锁定，单测 report-calculator.spec.ts 逐一覆盖）：
 * - **不重跑 FIFO**：使用成本直接读 M7/M8 落库的 UsageLotAllocation 分摊事实，
 *   与账户流水（USAGE 行 totalCost）同源，杜绝第二份 FIFO 实现漂移（§4.2 决策 1）；
 * - 已使用数量 = Σ UsageRecord.amount（当前版本；M8 上线前全部行即当前版本）；
 * - 已使用成本 = Σ UsageLotAllocation.cost，全精度加总；无分摊 → null
 *   （缺成本不按零，需求 5.3 条 3，前端显示「暂无法计算」）；
 * - 使用均价 = 已使用成本 ÷ 已使用数量，全精度相除后 roundRateTo8；
 *   无使用或无成本 → null（从未使用不显示均价，需求 5.2 条 3）；
 * - 来源拆分：分摊明细按 CostLot.sourceType（INITIAL / PURCHASE）分组求 quantity/cost；
 * - hasUnknownFee = ∃ 分摊批次：sourceType=PURCHASE ∧ 来源交易 feeAmount=null
 *   （前端据此显示「部分交易费用未明确」固定说明，需求 5.2 条 5）；
 * - 计划差额 remainingToUseAmount = max(0, target − used)（完成后调小场景，需求 5.2 条 6）；
 * - 收益区块本期不出数值（算法待确认，方案 §12）：纯初始持仓 →
 *   INITIAL_ONLY_NO_COMPARISON（「不计算收益比较」，绝不显示 0%）；含买入来源 →
 *   NOT_SUPPORTED_YET（「收益比较将在后续版本提供」）；
 * - updatedAt（展示口径，非审计，§4.2 口径 3）= max(该计划全部 UsageRecord.updatedAt,
 *   USAGE 更正 createdAt, 该计划关联交易（planId=planId）的 TRANSACTION 更正 createdAt)；
 *   全空 → null。跨账户共享批次被间接更正的传播不追踪，审计以修改记录入口为准。
 *
 * 序列化约定（与 account-calculator 文件头一致）：金额 toFixed(4)、单位成本
 * toFixed(8) 一律在 service DTO 层做，本层返回 Decimal；币种展示舍入
 * （JPY/KRW 0 位、其余 2 位，待确认点 11 的「展示单次舍入」）由
 * roundForCurrencyDisplay 提供，前端复用 money 包同规则渲染。
 */
import { Prisma } from "@prisma/client";
import {
	getCurrency,
	roundRateTo8,
	roundToCurrency,
} from "@fxplanner-new/money";

/** 收益区块展示类型（§5.2 yieldSection.displayType，算法定稿前仅占位枚举） */
export type YieldDisplayType =
	| "INITIAL_ONLY_NO_COMPARISON"
	| "NOT_SUPPORTED_YET";

/** 使用记录行内存形态（UsageRecord 字段拷贝，不含模型实例与 IO） */
export interface ReportUsageRecordRow {
	id: string;
	amount: Prisma.Decimal;
	updatedAt: Date;
}

/**
 * 分摊明细行内存形态：UsageLotAllocation × CostLot.sourceType × 来源交易 feeAmount。
 * service 层完成 join（分摊 → 批次 → 交易），本层只认拷贝字段。
 */
export interface ReportAllocationRow {
	/** 所属使用记录 ID */
	usageId: string;
	quantity: Prisma.Decimal;
	/** FIFO 消耗成本（买入批次含手续费；全精度 Decimal(20,4)） */
	cost: Prisma.Decimal;
	/** CostLot.sourceType：INITIAL / PURCHASE */
	sourceType: string;
	/** PURCHASE 来源交易的手续费（null = 未明确）；INITIAL 来源恒 null */
	feeAmount: Prisma.Decimal | null;
}

/** 单计划使用聚合结果（Decimal 全精度；null 语义见文件头口径） */
export interface PlanUsageAggregate {
	/** Σ UsageRecord.amount（当前版本） */
	usedQuantity: Prisma.Decimal;
	/** Σ 分摊 cost；无任何分摊 → null（缺成本不按零） */
	usedTotalCost: Prisma.Decimal | null;
	/** 已使用成本 ÷ 已使用数量；无使用或无成本 → null */
	usedUnitCost: Prisma.Decimal | null;
	/** 初始持仓来源已使用数量/成本（无则 0） */
	initialQuantity: Prisma.Decimal;
	initialCost: Prisma.Decimal;
	/** 后续买入来源已使用数量/成本（无则 0） */
	purchaseQuantity: Prisma.Decimal;
	purchaseCost: Prisma.Decimal;
	/** 是否涉及手续费未明确的买入（前端显示固定说明文案） */
	hasUnknownFee: boolean;
	/** usedQuantity > 0（列表前端据此决定下载入口显隐） */
	hasUsage: boolean;
}

/**
 * 单计划使用聚合（§4.1 口径唯一实现）：使用记录求和 + 分摊求和/分组。
 * 数量与成本各自独立累加（分摊行理论覆盖全部使用；若历史数据缺失导致
 * 成本空集，usedTotalCost/usedUnitCost 为 null，绝不补 0）。
 */
export function aggregatePlanUsage(
	records: ReportUsageRecordRow[],
	allocations: ReportAllocationRow[],
): PlanUsageAggregate {
	let usedQuantity = new Prisma.Decimal(0);
	for (const record of records) {
		usedQuantity = usedQuantity.add(record.amount);
	}

	if (allocations.length === 0) {
		return {
			usedQuantity,
			usedTotalCost: null,
			usedUnitCost: null,
			initialQuantity: new Prisma.Decimal(0),
			initialCost: new Prisma.Decimal(0),
			purchaseQuantity: new Prisma.Decimal(0),
			purchaseCost: new Prisma.Decimal(0),
			hasUnknownFee: false,
			hasUsage: usedQuantity.gt(0),
		};
	}

	let usedTotalCost = new Prisma.Decimal(0);
	let initialQuantity = new Prisma.Decimal(0);
	let initialCost = new Prisma.Decimal(0);
	let purchaseQuantity = new Prisma.Decimal(0);
	let purchaseCost = new Prisma.Decimal(0);
	let hasUnknownFee = false;
	for (const allocation of allocations) {
		usedTotalCost = usedTotalCost.add(allocation.cost);
		if (allocation.sourceType === "INITIAL") {
			initialQuantity = initialQuantity.add(allocation.quantity);
			initialCost = initialCost.add(allocation.cost);
		} else {
			purchaseQuantity = purchaseQuantity.add(allocation.quantity);
			purchaseCost = purchaseCost.add(allocation.cost);
			if (allocation.feeAmount === null) {
				hasUnknownFee = true;
			}
		}
	}

	return {
		usedQuantity,
		usedTotalCost,
		usedUnitCost: usedQuantity.gt(0) ? usedTotalCost.div(usedQuantity) : null,
		initialQuantity,
		initialCost,
		purchaseQuantity,
		purchaseCost,
		hasUnknownFee,
		hasUsage: usedQuantity.gt(0),
	};
}

/** 收益区块展示类型判定（§5.2：初始持仓不参与收益比较，为 doc 11/12 已定稿规则） */
export function resolveYieldDisplayType(
	aggregate: PlanUsageAggregate,
): YieldDisplayType {
	const hasPurchaseSource = aggregate.purchaseQuantity.gt(0);
	return hasPurchaseSource ? "NOT_SUPPORTED_YET" : "INITIAL_ONLY_NO_COMPARISON";
}

/** 计划差额（§5.2）：max(0, 目标 − 已使用)，完成后调小场景的「差额」展示 */
export function computeRemainingToUse(
	targetAmount: Prisma.Decimal,
	usedQuantity: Prisma.Decimal,
): Prisma.Decimal {
	const remaining = targetAmount.sub(usedQuantity);
	return remaining.gt(0) ? remaining : new Prisma.Decimal(0);
}

/**
 * 信息更新时间（§4.2 口径 3，展示口径非审计）：多来源取 max，全空 → null。
 * 入参为该计划收集到的全部候选时间（UsageRecord.updatedAt、USAGE/TRANSACTION 更正 createdAt）。
 */
export function computeReportUpdatedAt(
	times: (Date | null | undefined)[],
): Date | null {
	let max: Date | null = null;
	for (const time of times) {
		if (time && (max === null || time.getTime() > max.getTime())) {
			max = time;
		}
	}
	return max;
}

/**
 * 币种展示舍入（待确认点 11 默认口径）：按 money 包规则单次舍入——
 * JPY/KRW 0 位、其余 2 位，ROUND_HALF_UP。数量与成本展示共用；
 * 与逐项舍入值之和可能有 ≤1 最小单位显示差，报告页脚注明（§4.2 口径 2）。
 * 未知币种抛错（15 币种清单由 DTO 层前置校验，理论不可达，防御性兜底）。
 */
export function roundForCurrencyDisplay(
	value: Prisma.Decimal | number | string,
	currencyCode: string,
): Prisma.Decimal {
	const currency = getCurrency(currencyCode);
	if (!currency) {
		throw new Error(`未知币种：${currencyCode}`);
	}
	return roundToCurrency(value, currency.decimalPlaces);
}

/** 使用均价序列化（§4.1）：全精度 Decimal → roundRateTo8 → toFixed(8) 字符串 */
export function formatUnitCost(unitCost: Prisma.Decimal): string {
	return roundRateTo8(unitCost).toFixed(8);
}
