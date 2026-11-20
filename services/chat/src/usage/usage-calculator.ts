import { Prisma } from "@prisma/client";

/**
 * 资金使用纯函数层（usage-recording 技术方案 §3.3/§3.4）：FIFO 成本分摊、
 * 使用日期上下界校验、资金状态派生。无 IO、无框架依赖（对齐 plan-calculator
 * 范式：禁止 import @nestjs/common，错误以领域错误类抛出，由 UsageService
 * 捕获后映射为 HTTP §4.3 错误码契约）。
 *
 * 规则来源：
 * - FIFO 排序（docs/02_初始化与录入闭环_待确认.md:78）：同日先用初始持仓成本，
 *   再按买入日期先后；同类按首次录入顺序（createdAt）；
 * - 分摊（docs/15_专业术语清单.md:64 算例）：使用 1,200 = 先耗 1,000（成本 7,800）
 *   + 再耗 200（成本 1,600）= 9,400；记录使用不删除、不改动任何原买入记录；
 * - 每片成本 = quantity × unitCost 按金额列精度（4 位）HALF_UP 舍一次
 *   （money 包 roundToCurrency 语义，packages/money/src/round.ts:21）；
 * - 日期校验语义复制自 transaction-calculator.assertTransactedAtInRange
 *   （UTC+8 日界「今天」+ 账本起点下界），错误码独立（INVALID_USAGE_PARAMS），
 *   两侧行为一致性由 usage-calculator.spec.ts 镜像用例锁定；
 * - 资金状态映射（§3.4）：PREPARING / READY / USED_UP 三态，口径唯一。
 *
 * 该层设计为无 IO 纯函数：M8 使用更正（改金额/改日期重算）直接复用同一实现，
 * 保证首次记账与更正重算口径一致（技术方案 §9）。
 */

/** usage-calculator 错误码（service 映射为 HTTP 后原样透出） */
export type UsageCalcErrorCode = "INVALID_USAGE_PARAMS" | "USAGE_LOT_SHORTAGE";

/** 领域错误（service 捕获后映射为 HTTP；data 随错误体返回，金额为 Decimal） */
export class UsageCalcError extends Error {
	readonly code: UsageCalcErrorCode;
	readonly data?: Record<string, unknown>;

	constructor(
		code: UsageCalcErrorCode,
		message: string,
		data?: Record<string, unknown>,
	) {
		super(message);
		this.name = new.target.name;
		this.code = code;
		this.data = data;
	}
}

/** FIFO 批次剩余量合计不足（数据异常防御；恒等式下不应发生，宁可拒绝不可错账） */
export class UsageLotShortageError extends UsageCalcError {
	constructor(
		message: string,
		data: { lotRemaining: Prisma.Decimal; requestedAmount: Prisma.Decimal },
	) {
		super("USAGE_LOT_SHORTAGE", message, data);
	}
}

// ────────────────────────── FIFO 分摊 ──────────────────────────

/** FIFO 排序入参的批次内存形态（CostLot 行的字段拷贝，不含模型实例） */
export interface FifoLotInput {
	id: string;
	sourceId: string;
	/** INITIAL / PURCHASE */
	sourceType: string;
	remainingQty: Prisma.Decimal;
	unitCost: Prisma.Decimal;
	acquiredAt: Date;
	/** 来源记录的首录时间，批次重建不影响排序 */
	createdAt: Date;
}

/** 单片分摊明细（UsageLotAllocation 行的数据来源） */
export interface FifoSlice {
	lotId: string;
	quantity: Prisma.Decimal;
	/** quantity × unitCost 按金额列精度 HALF_UP（Decimal(20,4)） */
	cost: Prisma.Decimal;
}

export interface FifoAllocationResult {
	slices: FifoSlice[];
	/** totalCost = Σ sliceCost（每片已各自舍入，此处仅求和不二次舍入） */
	totalCost: Prisma.Decimal;
}

/**
 * 账本序类型权重（docs/02:78）：INITIAL（初始持仓）= 0 先耗，PURCHASE = 1 后耗；
 * 同一业务日内，USAGE = 2 排在批次之后。
 * 未知 type 视为 PURCHASE（防御兜底，不阻断）。
 */
const LEDGER_TYPE_ORDER: Record<string, number> = {
	INITIAL: 0,
	PURCHASE: 1,
	USAGE: 2,
};

/** 账本条目排序键（增量批次与重放事件共用；字段名取两侧内存形态的并集） */
export interface LedgerOrderKey {
	/** 批次取得/事件发生时刻（增量 = CostLot.acquiredAt，重放 = LedgerEvent.happenedAt） */
	happenedAt: Date;
	/** INITIAL / PURCHASE / USAGE */
	type: string;
	/** 首录顺序（更正永不修改 createdAt） */
	createdAt: Date;
	/** 稳定兜底（同刻 createdAt 并列时保证全序确定性） */
	id: string;
}

/**
 * FIFO 排序权威比较器（§3.3 唯一实现，增量记账与更正重放共享，禁止另行复制）：
 * UTC+8 业务日升序 → INITIAL / PURCHASE / USAGE → 首录时间 → 来源记录 id。
 */
export function compareLedgerEntries(
	a: LedgerOrderKey,
	b: LedgerOrderKey,
): number {
	const byDay =
		utc8DayStart(a.happenedAt).getTime() -
		utc8DayStart(b.happenedAt).getTime();
	if (byDay !== 0) {
		return byDay;
	}
	const orderA = LEDGER_TYPE_ORDER[a.type] ?? 1;
	const orderB = LEDGER_TYPE_ORDER[b.type] ?? 1;
	if (orderA !== orderB) {
		return orderA - orderB;
	}
	const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
	if (byCreated !== 0) {
		return byCreated;
	}
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * FIFO 批次比较器（增量分摊入口；语义 = 权威比较器 compareLedgerEntries，
 * 字段名映射：acquiredAt → happenedAt、sourceType → type、sourceId → id）。
 */
export function compareLots(a: FifoLotInput, b: FifoLotInput): number {
	return compareLedgerEntries(
		{
			happenedAt: a.acquiredAt,
			type: a.sourceType,
			createdAt: a.createdAt,
			id: a.sourceId,
		},
		{
			happenedAt: b.acquiredAt,
			type: b.sourceType,
			createdAt: b.createdAt,
			id: b.sourceId,
		},
	);
}

/**
 * FIFO 消耗共享内核（§3.3 分摊算法的唯一消耗实现；DEBT-02 抽取——
 * 增量记账 allocateLotsFifo 与更正重放 ledger-replay 共用，禁止复制第二份）：
 * 调用方保证 orderedLots 已按权威比较器（compareLedgerEntries）排好序，
 * 内核只做「顺序消耗 remainingQty > 0 的批次，每片成本按金额列精度 4 位
 * HALF_UP 舍一次」；ΣremainingQty < need 时产出部分分摊 + shortfall 数量
 * （增量入口据此抛 UsageLotShortageError；更正重放以累计资金余额校验 V3）。
 */
export interface FifoConsumptionLot {
	id: string;
	remainingQty: Prisma.Decimal;
	unitCost: Prisma.Decimal;
}

export interface FifoConsumptionResult {
	slices: FifoSlice[];
	/** totalCost = Σ sliceCost（每片已各自舍入，此处仅求和不二次舍入） */
	totalCost: Prisma.Decimal;
	/** 当前批次无法分摊的数量（> 0 时增量入口抛错） */
	shortfall: Prisma.Decimal;
}

export function consumeLotsInFifoOrder(
	orderedLots: FifoConsumptionLot[],
	need: Prisma.Decimal,
): FifoConsumptionResult {
	const slices: FifoSlice[] = [];
	let totalCost = new Prisma.Decimal(0);
	let remaining = need;
	for (const lot of orderedLots) {
		if (remaining.lte(0)) {
			break;
		}
		if (lot.remainingQty.lte(0)) {
			continue; // 防御性跳过（调用方已过滤，此处兜底）
		}
		const slice = Prisma.Decimal.min(remaining, lot.remainingQty);
		const sliceCost = slice
			.mul(lot.unitCost)
			.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
		slices.push({ lotId: lot.id, quantity: slice, cost: sliceCost });
		totalCost = totalCost.add(sliceCost);
		remaining = remaining.sub(slice);
	}
	return {
		slices,
		totalCost,
		shortfall: remaining.gt(0) ? remaining : new Prisma.Decimal(0),
	};
}

/**
 * FIFO 顺序分摊（增量记账入口；语义 = 共享内核 consumeLotsInFifoOrder +
 * 权威比较器排序 + 不足抛 UsageLotShortageError 不产出部分结果）：
 * 按比较器排序后顺序消耗 remainingQty，每片成本按 4 位 HALF_UP 舍一次。
 *
 * @param lots 成本批次（调用方保证 remainingQty > 0，内核再防御性跳过 ≤ 0 批次）
 * @param need 本次使用量（> 0；精度校验由本入口负责）
 * @param decimalPlaces 币种精度（0 = 日元/韩元整数；need 精度超限在此拦截）
 */
export function allocateLotsFifo(
	lots: FifoLotInput[],
	need: Prisma.Decimal,
	decimalPlaces: 0 | 2,
): FifoAllocationResult {
	if (!need.isFinite() || need.lte(0)) {
		throw new UsageCalcError(
			"INVALID_USAGE_PARAMS",
			`使用金额必须为大于 0 的有效数字，收到：${need.toFixed(4)}`,
		);
	}
	if (need.decimalPlaces() > decimalPlaces) {
		throw new UsageCalcError(
			"INVALID_USAGE_PARAMS",
			decimalPlaces === 0
				? "该币种（如日元/韩元）为整数币种，使用金额不能带小数位"
				: `使用金额最多支持 ${decimalPlaces} 位小数，收到：${need.toFixed()}`,
		);
	}

	const sorted = [...lots].sort(compareLots);
	const consumption = consumeLotsInFifoOrder(sorted, need);
	if (consumption.shortfall.gt(0)) {
		const lotRemaining = lots.reduce(
			(sum, lot) => sum.add(Prisma.Decimal.max(lot.remainingQty, 0)),
			new Prisma.Decimal(0),
		);
		throw new UsageLotShortageError(
			`成本批次剩余量不足以分摊本次使用（剩余 ${lotRemaining.toFixed(4)}，需求 ${need.toFixed(4)}），已整体拒绝记账`,
			{ lotRemaining, requestedAmount: need },
		);
	}
	return { slices: consumption.slices, totalCost: consumption.totalCost };
}

// ────────────────────────── 使用日期校验 ──────────────────────────

/** UTC+8 时区偏移（毫秒）；「今天」日界口径与 transaction-calculator 同源常量 */
export const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 一天的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 某时刻在 UTC+8 口径下的「当日 0 点」对应的 UTC 时刻（语义复制自 transaction-calculator） */
export function utc8DayStart(instant: Date): Date {
	const shifted = instant.getTime() + UTC8_OFFSET_MS;
	return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - UTC8_OFFSET_MS);
}

/**
 * 使用日期上下界校验（§4.3 INVALID_USAGE_PARAMS；语义复制自
 * transaction-calculator.assertTransactedAtInRange，错误码独立不耦合）：
 * - UTC+8 口径不晚于今天（允许补录历史）；
 * - 不早于记账起点 ledgerStartedAt（未设置时跳过下界校验）。
 * 两类失败的 message 必须可区分（接口测试 §8.2 断言依据）。
 */
/**
 * 使用日期上下界校验（§4.3 INVALID_USAGE_PARAMS；语义对齐
 * transaction-calculator.assertTransactedAtInRange，错误码独立不耦合）：
 * - UTC+8 口径不晚于今天（允许补录历史；上界按日历日窗口比较）；
 * - 不早于记账起点 ledgerStartedAt（未设置时跳过；下界按 UTC+8 日历日粒度——
 *   起点当日任意时刻可补录，早于起点所在日才拒绝）。
 * 两类失败的 message 必须可区分（接口测试 §8.2 断言依据）。
 */
export function assertUsedAtInRange(
	usedAt: Date,
	now: Date,
	ledgerStartedAt: Date | null,
): void {
	const todayStart = utc8DayStart(now).getTime();
	if (usedAt.getTime() >= todayStart + DAY_MS) {
		throw new UsageCalcError(
			"INVALID_USAGE_PARAMS",
			"使用日期不能晚于今天（UTC+8 口径）",
		);
	}
	if (
		ledgerStartedAt &&
		usedAt.getTime() < utc8DayStart(ledgerStartedAt).getTime()
	) {
		throw new UsageCalcError(
			"INVALID_USAGE_PARAMS",
			"使用日期不能早于记账起点",
		);
	}
}

// ────────────────────────── 资金状态派生 ──────────────────────────

/** 资金状态（§3.4 表格：PREPARING 准备中 / READY 资金已备齐 / USED_UP 资金已使用完成） */
export type FundStatus = "PREPARING" | "READY" | "USED_UP";

export interface ComputeFundStatusInput {
	/** 还需使用金额 = max(0, target − used)（computeDerived 派生量） */
	stillNeeded: Prisma.Decimal;
	/** 资金缺口 = max(0, 还需使用 − 剩余分配)（computeDerived 派生量） */
	gap: Prisma.Decimal;
	/** 计划剩余分配（computeDerived 派生量） */
	remainingAllocation: Prisma.Decimal;
}

/**
 * 资金状态映射（§3.4 口径唯一实现，plan.service 与 usage.service 共用）：
 * - USED_UP：还需使用 = 0 且剩余分配 = 0（之后由用户点完成确认，系统不自动完成）；
 * - READY：还需使用 > 0 且缺口 = 0（钱已留够）；
 * - PREPARING：其余（含「还需使用 = 0 但剩余分配 > 0」的理论不可达防御态——
 *   不判 USED_UP，归 PREPARING，由 canComplete = false 拦截完成，与
 *   checkCompleteReady 口径一致）。
 */
export function computeFundStatus(input: ComputeFundStatusInput): FundStatus {
	const { stillNeeded, gap, remainingAllocation } = input;
	if (stillNeeded.lte(0)) {
		return remainingAllocation.lte(0) ? "USED_UP" : "PREPARING";
	}
	return gap.lte(0) ? "READY" : "PREPARING";
}
