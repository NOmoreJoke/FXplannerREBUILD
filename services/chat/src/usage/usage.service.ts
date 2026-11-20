import {
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
	Logger,
} from "@nestjs/common";
import { getCurrency } from "@fxplanner-new/money";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OnboardingNotCompletedException } from "../onboarding/onboarding.service";
import {
	checkCompleteReady,
	computeDerived,
	computeRemainingAllocation,
} from "../plan/plan-calculator";
import type { Plan, PlanAllocation, UsageRecord } from "@prisma/client";
import {
	assertUsedAtInRange,
	allocateLotsFifo,
	computeFundStatus,
	UsageCalcError,
	UsageLotShortageError,
} from "./usage-calculator";
import type {
	CreateUsageRespDto,
	CreateUsageDto,
	PlanFundSummaryDto,
	UsageDto,
	UsageListRespDto,
} from "./dto/usage.dto";

/**
 * 模块错误（错误响应统一 { code, message, data? }，风格与 plan 模块一致）：
 * - INVALID_USAGE_PARAMS（400）：金额非法/超币种精度/超上限；日期晚于今天/早于
 *   记账起点/格式非法；备注超 200 字
 * - PLAN_NOT_FOUND（404）：计划不存在或不属于本人（防枚举，对齐 plan.service 口径）
 * - PLAN_INVALID_TRANSITION（409）：仅 ACTIVE 可记录使用
 * - INSUFFICIENT_PLAN_ALLOCATION（409）：本次金额 > 计划剩余分配（事务内条件更新判定）
 * - INSUFFICIENT_ACCOUNT_BALANCE（409）：余额不足（恒等式下不应发生，防御兜底）
 * - USAGE_LOT_SHORTAGE（409）：FIFO 批次剩余量合计不足（数据异常防御）
 */
export class UsageInvalidParamsException extends HttpException {
	constructor(message: string) {
		super({ code: "INVALID_USAGE_PARAMS", message }, HttpStatus.BAD_REQUEST);
	}
}

export class UsagePlanNotFoundException extends HttpException {
	constructor() {
		super(
			{ code: "PLAN_NOT_FOUND", message: "计划不存在或已删除" },
			HttpStatus.NOT_FOUND,
		);
	}
}

export class UsagePlanInvalidTransitionException extends HttpException {
	constructor(message: string) {
		super(
			{ code: "PLAN_INVALID_TRANSITION", message },
			HttpStatus.CONFLICT,
		);
	}
}

export class UsageInsufficientAllocationException extends HttpException {
	constructor(
		remainingAllocation: Prisma.Decimal,
		requestedAmount: Prisma.Decimal,
	) {
		super(
			{
				code: "INSUFFICIENT_PLAN_ALLOCATION",
				message: `计划剩余分配不足（当前剩余 ${remainingAllocation.toFixed(4)}，本次申请 ${requestedAmount.toFixed(4)}），请先调整分配`,
				data: {
					remainingAllocation: remainingAllocation.toFixed(4),
					requestedAmount: requestedAmount.toFixed(4),
				},
			},
			HttpStatus.CONFLICT,
		);
	}
}

export class UsageInsufficientBalanceException extends HttpException {
	constructor(balance: Prisma.Decimal, requestedAmount: Prisma.Decimal) {
		super(
			{
				code: "INSUFFICIENT_ACCOUNT_BALANCE",
				message: "账户余额不足，数据疑似异常（余额应不小于计划剩余分配），已拒绝记账",
				data: {
					balance: balance.toFixed(4),
					requestedAmount: requestedAmount.toFixed(4),
				},
			},
			HttpStatus.CONFLICT,
		);
	}
}

export class UsageLotShortageException extends HttpException {
	constructor(
		lotRemaining: Prisma.Decimal,
		requestedAmount: Prisma.Decimal,
	) {
		super(
			{
				code: "USAGE_LOT_SHORTAGE",
				message: "成本批次剩余量不足以分摊本次使用（数据疑似异常），已整体拒绝记账",
				data: {
					lotRemaining: lotRemaining.toFixed(4),
					requestedAmount: requestedAmount.toFixed(4),
				},
			},
			HttpStatus.CONFLICT,
		);
	}
}

/** 单笔金额上限（money 包 AMOUNT_UPPER_LIMIT 同值语义：< 100,000,000,000） */
const AMOUNT_UPPER_LIMIT_VALUE = new Prisma.Decimal("100000000000");

/** 列表服务端兑底条数（§4.2：个人工具无分页，limit 100 防御，对齐 plan 列表约定） */
const USAGE_LIST_LIMIT = 100;

/** 备注长度上限（§4.1） */
const REMARK_MAX_LENGTH = 200;

/** 记账事务的结果中间形态（Decimal 形态，序列化在出口统一做） */
interface CreateUsageTxResult {
	usage: UsageRecord;
	totalCost: Prisma.Decimal;
	sliceCount: number;
	plan: Plan;
	allocation: PlanAllocation;
}

@Injectable()
export class UsageService {
	private readonly logger = new Logger(UsageService.name);

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	/**
	 * 记录使用（POST /api/plans/:id/usages，方案 §3.1 五步事务）：
	 * 事务外装载与校验（失败不进事务）→ 交互式事务——
	 * ⓪ Account 行锁（FOR UPDATE；与更正 apply 锁序统一，防倒序死锁）
	 * ① $executeRaw 条件扣分配（WHERE used + amt <= amount，列间比较单语句原子）
	 * ② account.updateMany 条件扣余额（WHERE balance >= amt）
	 * ③ usageRecord.create（version = 1）
	 * ④ costLot 剩余批次全取 → 内存 FIFO 排序分摊（usage-calculator 纯函数）
	 * ⑤ usageLotAllocation.createMany + costLot 逐批递减 remainingQty
	 * 任一步失败整体回滚，绝不留半条记录（需求 §7 中途中断）。
	 * READ COMMITTED 下条件更新基于最新已提交行重估 WHERE，行数 0 即失败回滚，
	 * 与 plan.service complete/cancel 的 updateMany 先例同构（并发权威防线）。
	 */
	async create(
		userId: string,
		planId: string,
		dto: CreateUsageDto,
	): Promise<CreateUsageRespDto> {
		// 事务外：归属/状态/币种/账本起点装载（404/409 不进事务）
		const context = await this.loadPlanContext(userId, planId);
		// 事务外：入参规范化与合法性校验（400 不进事务）
		const amount = this.parseUsageAmount(dto.amount, context.decimalPlaces);
		const usedAt = this.parseUsedAt(dto.usedAt);
		try {
			assertUsedAtInRange(usedAt, new Date(), context.ledgerStartedAt);
		} catch (error) {
			// 领域错误（UsageCalcError）→ HTTP 400 INVALID_USAGE_PARAMS（§4.3 契约）
			if (error instanceof UsageCalcError) {
				throw new UsageInvalidParamsException(error.message);
			}
			throw error;
		}
		const remark = this.parseRemark(dto.remark);

		const result = await this.prisma.$transaction(async (tx) => {
			// ⓪ 账户行锁（MVP-F0-3 锁序统一）：先锁 Account 再动 PlanAllocation——
			// 与更正 apply 的锁序（lockAccountRows → persistUsageCorrection）一致，
			// 消除「更正先锁账户后改分配 / 记录使用先改分配后扣账户」的倒序死锁窗口
			//（同用户同币种并发时在此串行化）。行锁后重读分配现状（条件更新基于最新已提交行）。
			await tx.$queryRaw`
				SELECT id FROM accounts
				WHERE user_id = ${userId} AND currency_code = ${context.currencyCode}
				FOR UPDATE`;
			// ① 条件扣分配：列间比较（used + amt <= amount）Prisma updateMany 无法表达，
			// 单条 UPDATE 原子完成「检查 + 扣减」；updated_at 手动刷新（绕过 @updatedAt）
			const allocationUpdated = await tx.$executeRaw`
				UPDATE "plan_allocations"
				SET "used_amount" = "used_amount" + ${amount}, "updated_at" = NOW()
				WHERE "plan_id" = ${planId} AND "used_amount" + ${amount} <= "amount"`;
			if (allocationUpdated === 0) {
				const allocation = await tx.planAllocation.findUnique({
					where: { planId },
				});
				const remainingAllocation = allocation
					? computeRemainingAllocation(
							allocation.amount,
							allocation.usedAmount,
						)
					: new Prisma.Decimal(0);
				throw new UsageInsufficientAllocationException(
					remainingAllocation,
					amount,
				);
			}

			// ② 条件扣余额（列对常量，原生 updateMany 表达；恒等式下不应失败，防御兜底）
			const balanceUpdated = await tx.account.updateMany({
				where: {
					userId,
					currencyCode: context.currencyCode,
					balance: { gte: amount },
				},
				data: { balance: { decrement: amount } },
			});
			if (balanceUpdated.count === 0) {
				const account = await tx.account.findUnique({
					where: {
						userId_currencyCode: {
							userId,
							currencyCode: context.currencyCode,
						},
					},
				});
				throw new UsageInsufficientBalanceException(
					account?.balance ?? new Prisma.Decimal(0),
					amount,
				);
			}

			// ③ 落使用记录（version = 1，M8 更正预留）
			const usage = await tx.usageRecord.create({
				data: {
					userId,
					planId,
					currencyCode: context.currencyCode,
					amount,
					usedAt,
					remark,
					version: 1,
				},
			});

			// ④ FIFO 分摊：剩余批次全取（百条级，内存排序即可）→ 纯函数分摊
			const lots = await tx.costLot.findMany({
				where: {
					userId,
					currencyCode: context.currencyCode,
					remainingQty: { gt: 0 },
				},
			});
			let totalCost: Prisma.Decimal;
			let slices: {
				lotId: string;
				quantity: Prisma.Decimal;
				cost: Prisma.Decimal;
			}[];
			try {
				const allocation = allocateLotsFifo(
					lots,
					amount,
					context.decimalPlaces,
				);
				totalCost = allocation.totalCost;
				slices = allocation.slices;
			} catch (error) {
				if (error instanceof UsageLotShortageError) {
					// 数据异常防御：批次剩余量合计 < 需求量，宁可拒绝不可错账
					throw new UsageLotShortageException(
						(error.data?.lotRemaining as Prisma.Decimal) ??
							new Prisma.Decimal(0),
						amount,
					);
				}
				throw error;
			}

			// ⑤ 写分摊明细 + 逐批递减 remainingQty（同事务，任一失败整体回滚）
			await tx.usageLotAllocation.createMany({
				data: slices.map((slice) => ({
					usageId: usage.id,
					lotId: slice.lotId,
					quantity: slice.quantity,
					cost: slice.cost,
				})),
			});
			for (const slice of slices) {
				await tx.costLot.update({
					where: { id: slice.lotId },
					data: { remainingQty: { decrement: slice.quantity } },
				});
			}

			// 资金面快照（事务内已扣减的最新值，前端一次往返刷新进度区）
			const [freshPlan, freshAllocation] = await Promise.all([
				tx.plan.findUnique({ where: { id: planId } }),
				tx.planAllocation.findUnique({ where: { planId } }),
			]);
			if (!freshPlan || !freshAllocation) {
				// 创建事务保证 1:1，此处防御性兜底（触发即整体回滚）
				throw new UsagePlanNotFoundException();
			}
			return {
				usage,
				totalCost,
				sliceCount: slices.length,
				plan: freshPlan,
				allocation: freshAllocation,
			} satisfies CreateUsageTxResult;
		});

		// 可观测性（§7）：成功 Info 记一次汇总（循环外），金额不脱敏（个人工具内部日志）
		this.logger.log(
			`usage created userId=${userId} planId=${planId} usageId=${result.usage.id} amount=${result.usage.amount.toFixed(4)} usedAt=${result.usage.usedAt.toISOString()} lots=${result.sliceCount} totalCost=${result.totalCost.toFixed(4)}`,
		);

		return {
			usage: this.toUsageDto(result.usage, result.totalCost),
			plan: this.toFundSummary(result.plan, result.allocation),
		};
	}

	/**
	 * 使用记录列表（GET /api/plans/:id/usages，§4.2）：
	 * usedAt 倒序、同刻 createdAt 倒序，limit 100 兑底；成本按 usageId 聚合
	 * UsageLotAllocation。plan 不存在或不属于本人 → 404 防枚举。
	 */
	async list(userId: string, planId: string): Promise<UsageListRespDto> {
		const plan = await this.prisma.plan.findFirst({
			where: { id: planId, userId },
		});
		if (!plan) {
			throw new UsagePlanNotFoundException();
		}
		const records = await this.prisma.usageRecord.findMany({
			where: { userId, planId },
			orderBy: [{ usedAt: "desc" }, { createdAt: "desc" }],
			take: USAGE_LIST_LIMIT,
		});
		const costRows =
			records.length > 0
				? await this.prisma.usageLotAllocation.groupBy({
						by: ["usageId"],
						where: { usageId: { in: records.map((record) => record.id) } },
						_sum: { cost: true },
					})
				: [];
		const costByUsage = new Map(
			costRows.map((row) => [
				row.usageId,
				row._sum.cost ?? new Prisma.Decimal(0),
			]),
		);
		return {
			items: records.map((record) =>
				this.toUsageDto(record, costByUsage.get(record.id) ?? new Prisma.Decimal(0)),
			),
		};
	}

	// ────────────────────────── 私有辅助 ──────────────────────────

	/**
	 * 事务外装载计划上下文（§3.1 loadPlanContext）：
	 * BE-03 防线：未建账（无 UserSettings）409 优先于计划 404（未建账用户必然无计划，
	 * 409 引导去 /onboarding 而非泄露 404；与 plan/transaction 写入口一致）→
	 * 归属 404 防枚举 → 状态闸门（仅 ACTIVE）→ 币种精度 → 账本起点。
	 */
	private async loadPlanContext(userId: string, planId: string) {
		const settings = await this.prisma.userSettings.findUnique({
			where: { userId },
			select: { ledgerStartedAt: true },
		});
		if (!settings) {
			throw new OnboardingNotCompletedException(
				"尚未完成首次设置，请先前往 /onboarding 完成建账后再记录使用",
			);
		}
		const plan = await this.prisma.plan.findFirst({
			where: { id: planId, userId },
		});
		if (!plan) {
			throw new UsagePlanNotFoundException();
		}
		if (plan.status !== "ACTIVE") {
			throw new UsagePlanInvalidTransitionException(
				"仅进行中的计划可记录使用",
			);
		}
		const currencyInfo = getCurrency(plan.targetCurrency);
		if (!currencyInfo) {
			// 计划创建已校验 15 币种，此处防御性兜底
			throw new UsageInvalidParamsException(
				`目标币种 ${plan.targetCurrency} 不在支持的 15 币种内`,
			);
		}
		return {
			currencyCode: plan.targetCurrency,
			decimalPlaces: currencyInfo.decimalPlaces,
			ledgerStartedAt: settings.ledgerStartedAt,
		};
	}

	/**
	 * 使用金额解析（§4.1）：有效数字 → > 0 → < 单笔上限 → 币种精度
	 * （日元/韩元整数、其余 2 位；超精度 400 不静默截断，语义对齐
	 * transaction-calculator.assertQuantityPrecision）。
	 */
	private parseUsageAmount(
		value: string,
		decimalPlaces: 0 | 2,
	): Prisma.Decimal {
		let amount: Prisma.Decimal;
		try {
			amount = new Prisma.Decimal(value);
			if (!amount.isFinite()) {
				throw new Error("not finite");
			}
		} catch {
			throw new UsageInvalidParamsException(
				`使用金额必须是有效的数字字符串，收到：${value}`,
			);
		}
		if (amount.lte(0)) {
			throw new UsageInvalidParamsException("使用金额必须大于 0");
		}
		if (amount.gte(AMOUNT_UPPER_LIMIT_VALUE)) {
			throw new UsageInvalidParamsException(
				"使用金额必须小于单笔上限 100,000,000,000",
			);
		}
		if (amount.decimalPlaces() > decimalPlaces) {
			throw new UsageInvalidParamsException(
				decimalPlaces === 0
					? "该币种（如日元/韩元）为整数币种，使用金额不能带小数位"
					: "使用金额最多支持 2 位小数",
			);
		}
		return amount;
	}

	/** 使用日期解析：有效 ISO 8601，保存精确时刻（与买入 transactedAt 原样存储口径一致） */
	private parseUsedAt(value: string): Date {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			throw new UsageInvalidParamsException(
				`使用日期必须是有效的 ISO 8601 日期，收到：${value}`,
			);
		}
		// 禁止截断到日 0 点：FIFO 权威比较器（compareLedgerEntries）按精确时刻排序，
		// 截断会把同日使用排到买入之前，更正账本重放误报资金不足并阻断合法更正
		// （对抗审 B1）。上下界校验（assertUsedAtInRange）按 UTC+8 日历日窗口比较，
		// 任意当日时刻原样通过；「不早于账本起点」为日粒度（当日任意时刻可补录）。
		return date;
	}

	/** 备注解析：trim 后空串归 null；超 200 字 400（§4.1） */
	private parseRemark(value: string | undefined | null): string | null {
		if (value === undefined || value === null) {
			return null;
		}
		const trimmed = value.trim();
		if (trimmed === "") {
			return null;
		}
		if (trimmed.length > REMARK_MAX_LENGTH) {
			throw new UsageInvalidParamsException(
				`备注最多 ${REMARK_MAX_LENGTH} 字符`,
			);
		}
		return trimmed;
	}

	/** 使用记录出参（§4.1：金额/成本 toFixed(4)、日期 ISO 序列化） */
	private toUsageDto(record: UsageRecord, cost: Prisma.Decimal): UsageDto {
		return {
			id: record.id,
			planId: record.planId,
			currencyCode: record.currencyCode,
			amount: record.amount.toFixed(4),
			usedAt: record.usedAt.toISOString(),
			remark: record.remark,
			cost: cost.toFixed(4),
			version: record.version,
			createdAt: record.createdAt.toISOString(),
		};
	}

	/**
	 * 资金面快照（§3.4 PlanFundSummaryDto）：派生量复用 computeDerived 唯一口径，
	 * fundStatus 复用 computeFundStatus，canComplete 复用 checkCompleteReady（禁止公式漂移）。
	 */
	private toFundSummary(
		plan: Plan,
		allocation: PlanAllocation,
	): PlanFundSummaryDto {
		const derived = computeDerived({
			targetAmount: plan.targetAmount,
			usedAmount: allocation.usedAmount,
			allocatedAmount: allocation.amount,
		});
		let canComplete = false;
		if (plan.status === "ACTIVE") {
			try {
				checkCompleteReady({
					targetAmount: plan.targetAmount,
					usedAmount: allocation.usedAmount,
					allocAmount: allocation.amount,
				});
				canComplete = true;
			} catch {
				canComplete = false;
			}
		}
		return {
			targetAmount: plan.targetAmount.toFixed(4),
			usedAmount: allocation.usedAmount.toFixed(4),
			allocatedAmount: allocation.amount.toFixed(4),
			remainingAllocation: derived.remainingAllocation.toFixed(4),
			stillNeeded: derived.stillNeeded.toFixed(4),
			gap: derived.gap.toFixed(4),
			fundStatus: computeFundStatus(derived),
			canComplete,
		};
	}
}

// UsageCalcError 领域错误到 HTTP 的映射：参数层日期校验内联映射为 400
// INVALID_USAGE_PARAMS；事务内 UsageLotShortageError 映射为 409 USAGE_LOT_SHORTAGE。
void UsageCalcError;
