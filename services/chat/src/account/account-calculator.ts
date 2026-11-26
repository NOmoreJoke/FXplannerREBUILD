/**
 * 外汇账户模块纯函数层（account-module 技术方案 §3.3/§3.4/§3.6）：
 * 已分配汇总、成本批次构造、剩余成本计算、流水合并排序。
 * 无 IO、无框架状态，AccountService 只做编排（与 transaction-calculator / plan-calculator 分层先例一致）。
 *
 * 口径（§3.3，account-calculator.spec.ts 单测锁定）：
 * - 已分配 allocatedAmount(c) = Σ_p (amount − usedAmount)，**全部计划不过滤状态**
 *   （CANCELLED 已释放 amount=used 计 0；COMPLETED 受完成校验剩余恒 0）；
 * - 未分配余额 unallocatedAmount(c) = balance − allocatedAmount，**不 clamp**：
 *   本模块是事实展示语义，负数即数据破坏信号，必须如实暴露并 warn（§7）——
 *   与 plan-calculator.computeCaps 的 max(0)（分配上限语义）刻意不同，勿"对齐"；
 * - 剩余已记录成本 = Σ_lot (remainingQty × unitCost)，空批次 → null；
 * - 平均单位成本 = 剩余成本 ÷ Σ remainingQty，Σ remainingQty = 0（余额 0 或全部消耗）→ null
 *   （doc 04：余额为 0 时不计算单位平均成本）。
 * 序列化口径：金额 toFixed(4)、单位成本 toFixed(8) 一律在 service DTO 层做，本层返回 Decimal。
 */
import { Prisma, type Transaction as TransactionModel } from "@prisma/client";
import { TransactionInvalidParamsException } from "../transaction/transaction-calculator";

/**
 * unitCost 容量上限：unitCost 列为 Decimal(20, 10)，整数位仅 10 位（必须 < 1e10）。
 * 合法录入域可达 unitCost = 1e11（本金 1e9 ÷ 数量 0.01），溢出时 Prisma 抛 P2000 变 500，
 * 故构造前预校验（方案 §3.4），400 INVALID_TRANSACTION_PARAMS 在事务前拦截。
 */
export const UNIT_COST_UPPER_LIMIT = 1e10;

/** 已分配明细（内存形态）：Plan.targetCurrency + PlanAllocation.amount/usedAmount 的字段拷贝 */
export interface AllocatedItem {
	currencyCode: string;
	/** 分配总额（amount） */
	amount: Prisma.Decimal;
	/** 累计已使用（usedAmount） */
	usedAmount: Prisma.Decimal;
}

/**
 * 按币种汇总剩余分配（§3.3 已分配口径唯一实现）：每币种 Σ(amount − usedAmount)。
 * 全部计划不过滤状态；可为负（超用，usedAmount > amount 时产生负贡献），禁止 clamp。
 * 无分配的币种不出现在结果 Map 中（调用方以 ?? 0 兜底）。
 */
export function sumAllocatedByCurrency(
	items: AllocatedItem[],
): Map<string, Prisma.Decimal> {
	const byCurrency = new Map<string, Prisma.Decimal>();
	for (const item of items) {
		const remaining = item.amount.sub(item.usedAmount);
		const prev = byCurrency.get(item.currencyCode) ?? new Prisma.Decimal(0);
		byCurrency.set(item.currencyCode, prev.add(remaining));
	}
	return byCurrency;
}

/**
 * unitCost 容量预校验（方案 §3.4）：unitCost = (principal + (fee ?? 0)) ÷ quantity ≥ 1e10
 * 时按 transaction-calculator 先例抛 400 INVALID_TRANSACTION_PARAMS（实时录入在事务前调用、
 * 回填脚本在构造前调用，两处共用本函数，杜绝口径漂移）。
 */
export function assertUnitCostInRange(
	principal: Prisma.Decimal,
	fee: Prisma.Decimal | null,
	quantity: Prisma.Decimal,
): void {
	const totalCost = principal.add(fee ?? 0);
	const unitCost = totalCost.div(quantity);
	if (unitCost.gte(UNIT_COST_UPPER_LIMIT)) {
		throw new TransactionInvalidParamsException(
			`单位成本超出系统上限，请核对本金与到账数量（${totalCost.toFixed(4)} ÷ ${quantity.toFixed(4)}）`,
		);
	}
}

/**
 * 交易行 → CostLot 批次构造（§3.4，实时录入第④步与存量回填 §3.5 共用，含容量预校验）。
 * - totalCost = principal + (fee ?? 0)；unitCost = totalCost ÷ quantity（Decimal 完整精度，
 *   Decimal(20,10) 列容量由 assertUnitCostInRange 保证）；
 * - remainingQty = quantity（新批次未消耗）；acquiredAt = transactedAt（同日顺序由 createdAt 保留，doc 09）；
 * - id/createdAt/updatedAt 由 Prisma 生成，不在入参内。
 */
export function buildPurchaseLot(
	transaction: TransactionModel,
): Prisma.CostLotCreateInput {
	assertUnitCostInRange(
		transaction.principalAmount,
		transaction.feeAmount,
		transaction.quantity,
	);
	const totalCost = transaction.principalAmount.add(transaction.feeAmount ?? 0);
	return {
		user: { connect: { id: transaction.userId } },
		...(transaction.organizationId != null
			? { organizationId: transaction.organizationId }
			: {}),
		currencyCode: transaction.currencyCode,
		sourceType: "PURCHASE",
		sourceId: transaction.id,
		quantity: transaction.quantity,
		remainingQty: transaction.quantity,
		unitCost: totalCost.div(transaction.quantity),
		totalCost,
		acquiredAt: transaction.transactedAt,
	};
}

/** 成本批次金额形态（内存形态；来自 CostLot 行的字段拷贝，不含模型实例与 IO） */
export interface CostLotAmounts {
	remainingQty: Prisma.Decimal;
	unitCost: Prisma.Decimal;
}

/** 剩余成本计算结果（Decimal；序列化 toFixed(4)/toFixed(8) 由 service DTO 层负责） */
export interface RemainingCostResult {
	/** Σ_lot (remainingQty × unitCost)；无批次（理论上仅清空后）→ null */
	remainingTotalCost: Prisma.Decimal | null;
	/** 剩余成本 ÷ Σ remainingQty；Σ remainingQty = 0（余额 0 或全部消耗）→ null（doc 04） */
	averageUnitCost: Prisma.Decimal | null;
}

/** 剩余已记录成本与平均单位成本（§3.3 口径唯一实现，详情接口专用） */
export function computeRemainingCost(
	lots: CostLotAmounts[],
): RemainingCostResult {
	if (lots.length === 0) {
		return { remainingTotalCost: null, averageUnitCost: null };
	}
	let remainingTotalCost = new Prisma.Decimal(0);
	let remainingQty = new Prisma.Decimal(0);
	for (const lot of lots) {
		remainingTotalCost = remainingTotalCost.add(
			lot.remainingQty.mul(lot.unitCost),
		);
		remainingQty = remainingQty.add(lot.remainingQty);
	}
	if (remainingQty.eq(0)) {
		return { remainingTotalCost, averageUnitCost: null };
	}
	return {
		remainingTotalCost,
		averageUnitCost: remainingTotalCost.div(remainingQty),
	};
}

/** 流水条目排序键（展示字段由泛型保留；occurredAt 为业务时间、createdAt 为同刻次序键） */
export interface LedgerSortable {
	occurredAt: Date;
	createdAt: Date;
}

/**
 * 跨源流水合并（§3.6）：PURCHASE 与 USAGE 与 INITIAL 行合并后按
 * occurredAt 倒序、同刻按 createdAt 倒序稳定排列。
 * ⚠️ 展示顺序不是 FIFO 成本计算顺序（doc 02 的重算顺序仅用于成本核算，页面不承担该语义）。
 * 排序键剥离由调用方完成（service 映射出参时去掉 createdAt）；空输入返回空数组。
 * initials 为可选第三参（M8 起流水含初始持仓行，方案 §7「账户流水初始持仓行更正入口」）：
 * 缺省空数组，既有调用与排序语义零变化。
 */
export function mergeLedgerItems<T extends LedgerSortable>(
	purchases: T[],
	usages: T[],
	initials: T[] = [],
): T[] {
	return [...purchases, ...usages, ...initials].sort((a, b) => {
		const byOccurred = b.occurredAt.getTime() - a.occurredAt.getTime();
		if (byOccurred !== 0) {
			return byOccurred;
		}
		return b.createdAt.getTime() - a.createdAt.getTime();
	});
}
