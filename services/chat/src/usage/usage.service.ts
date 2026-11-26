import {
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
	Logger,
} from "@nestjs/common";
import { getCurrency } from "@fxplanner-new/money";
import { Prisma } from "@prisma/client";
import {
	lockOrgPlanRow,
	lockOrgPlanAccount,
} from "../prisma/ledger-write-lock";
import { PrismaService } from "../prisma/prisma.service";
import { OnboardingNotCompletedException } from "../onboarding/onboarding.service";
import {
	AuditService,
	recordDeniedAuditBestEffort,
} from "../audit/audit.service";
import { PermissionDeniedException } from "../authorization/authorization.errors";
import type {
	ActorContext,
	OrganizationRole,
} from "../authorization/authorization.types";
import {
	assertParentChildSameOrg,
	orgWhere,
	type ReadScope,
} from "../authorization/organization-scope";
import { can } from "../authorization/permission-policy";
import { lockOrganizationForActor } from "../organization/default-organization";
import { resolveOrganizationPreferences } from "../organization/organization-preferences";
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
	type FifoLotInput,
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
 * - PLAN_NOT_FOUND（404）：计划不存在或不属于当前组织（防枚举，对齐 plan.service 口径）
 * - PLAN_INVALID_TRANSITION（409）：仅 ACTIVE 可记录使用
 * - INSUFFICIENT_PLAN_ALLOCATION（409）：本次金额 > 计划剩余分配（事务内条件更新判定）
 * - INSUFFICIENT_ACCOUNT_BALANCE（409）：余额不足（恒等式下不应发生，防御兜底）
 * - USAGE_LOT_SHORTAGE（409）：FIFO 批次剩余量合计不足（数据异常防御）
 *
 * 组织上下文（ToB R1 W24）：本模块写路径以 ActorContext 为数据范围——账本属于组织，
 * 同组织成员买入的批次构成同一个 FIFO 池；权限 / 建账态拦截沿用授权层与 onboarding
 * 的统一错误族（403 PERMISSION_DENIED / 409 ONBOARDING_NOT_COMPLETED）。
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
		@Inject(AuditService) private readonly auditService: AuditService,
	) {}

	/**
	 * 记录使用（POST /api/plans/:id/usages，方案 §3.1 五步事务 / ToB R1 W24）：
	 * 组织共享账本——同组织全量活跃 CostLot 构成同一个 FIFO 池，成员 A 买入的批次
	 * 可被成员 B 的使用记录消耗；金额全程 Decimal，批次与账户只按组织维度取用。
	 * 交互式事务——
	 * ⓪ lockOrganizationForActor 重读最新角色并复验 usage.create（锁等降权 → 403 + DENIED 审计）
	 * ① resolveOrganizationPreferences 解析组织建账态（409）与记账起点
	 * ② lockOrgPlanAccount 锁组织账本账户 → FOR UPDATE 锁目标 Plan 行（跨组织 / 不存在 → 404）
	 * ③ $executeRaw 条件扣分配（WHERE used + amt <= amount，列间比较单语句原子）
	 * ④ 组织账户条件扣余额（WHERE balance >= amt）
	 * ⑤ usageRecord.create（version = 1，organizationId + createdById）
	 * ⑥ 同组织全量剩余批次 → 内存 FIFO 排序分摊（usage-calculator 纯函数）
	 * ⑦ usageLotAllocation.createMany + costLot 逐批递减 remainingQty
	 * ⑧ 同事务写入 usage.create 审计日志（审计失败整单回滚）
	 * 任一步失败整体回滚，绝不留半条记录（需求 §7 中途中断）。
	 * READ COMMITTED 下条件更新基于最新已提交行重估 WHERE，行数 0 即失败回滚，
	 * 与 plan.service complete/cancel 的 updateMany 先例同构（并发权威防线）。
	 */
	async create(
		actor: ActorContext,
		planId: string,
		dto: CreateUsageDto,
		requestId: string | null = null,
	): Promise<CreateUsageRespDto> {
		let deniedRole: OrganizationRole = actor.role;
		let result: CreateUsageTxResult;
		try {
			result = await this.prisma.$transaction(async (tx) => {
				const latestRole = await lockOrganizationForActor(tx, actor);
				if (!can(latestRole, "usage.create")) {
					deniedRole = latestRole;
					throw new PermissionDeniedException();
				}

				const preferences = await resolveOrganizationPreferences(
					tx,
					actor.organizationId,
				);
				if (!preferences) {
					throw new OnboardingNotCompletedException(
						"尚未完成首次设置，请先前往 /onboarding 完成建账后再记录使用",
					);
				}

				const context = await this.loadPlanContext(tx, actor, planId);
				const amount = this.parseUsageAmount(dto.amount, context.decimalPlaces);
				const usedAt = this.parseUsedAt(dto.usedAt);
				try {
					assertUsedAtInRange(usedAt, new Date(), preferences.ledgerStartedAt);
				} catch (error) {
					if (error instanceof UsageCalcError) {
						throw new UsageInvalidParamsException(error.message);
					}
					throw error;
				}
				const remark = this.parseRemark(dto.remark);

				// ③ 条件扣分配：列间比较（used + amt <= amount）Prisma updateMany 无法表达，
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

				// ④ 条件扣余额（列对常量，原生 updateMany 表达；恒等式下不应失败，防御兜底）。
				// 组织内同币种账户唯一，扣减只按组织维度命中——成员 B 的使用扣的是组织余额，
				// 不是某个成员的私有行。
				const balanceUpdated = await tx.account.updateMany({
					where: {
						organizationId: actor.organizationId,
						currencyCode: context.currencyCode,
						balance: { gte: amount },
					},
					data: { balance: { decrement: amount } },
				});
				if (balanceUpdated.count === 0) {
					const account = await tx.account.findFirst({
						where: {
							organizationId: actor.organizationId,
							currencyCode: context.currencyCode,
						},
					});
					throw new UsageInsufficientBalanceException(
						account?.balance ?? new Prisma.Decimal(0),
						amount,
					);
				}

				// ⑤ 落使用记录（version = 1，M8 更正预留；createdById = 记录人，仅审计用）
				const usage = await tx.usageRecord.create({
					data: {
						organizationId: actor.organizationId,
						createdById: actor.userId,
						planId,
						currencyCode: context.currencyCode,
						amount,
						usedAt,
						remark,
						version: 1,
					},
				});

				// ⑥ 批次重建会刷新批次时间与 ID，FIFO 沿用来源记录的首录键。
				// 跨成员共享 FIFO 池：组织内全部活跃批次构成同一个池；
				// 严禁按 userId 过滤批次——否则成员 B 记使用时看不到成员 A 的买入。
				const lots = await tx.$queryRaw<FifoLotInput[]>`
					SELECT lot.id, lot.source_id AS "sourceId", lot.source_type AS "sourceType",
						lot.remaining_qty AS "remainingQty", lot.unit_cost AS "unitCost",
						lot.acquired_at AS "acquiredAt",
						COALESCE(trade.created_at, holding.created_at, lot.created_at) AS "createdAt"
					FROM cost_lots AS lot
					LEFT JOIN transactions AS trade ON lot.source_type = 'PURCHASE'
						AND trade.id = lot.source_id
					LEFT JOIN initial_holdings AS holding ON lot.source_type = 'INITIAL'
						AND holding.id = lot.source_id
					WHERE lot.currency_code = ${context.currencyCode}
						AND lot.organization_id = ${actor.organizationId}
						AND lot.remaining_qty > 0
				`;
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

				// ⑦ 写分摊明细 + 逐批递减 remainingQty（同事务，任一失败整体回滚）
				await tx.usageLotAllocation.createMany({
					data: slices.map((slice) => ({
						usageId: usage.id,
						lotId: slice.lotId,
						quantity: slice.quantity,
						cost: slice.cost,
					})),
				});
				for (const slice of slices) {
					// @org-scope-exempt: post-lock 主键更新（cost_lots 已在同事务 lockOrgPlanAccount 后按 organizationId 过滤取出）
					await tx.costLot.update({
						where: { id: slice.lotId },
						data: { remainingQty: { decrement: slice.quantity } },
					});
				}

				// 资金面快照（事务内已扣减的最新值，前端一次往返刷新进度区）
				const [freshPlan, freshAllocation] = await Promise.all([
					// @org-scope-exempt: post-lock 主键重读（loadPlanContext 已按 lockOrgPlanRow + orgWhere 锁定并校验计划归属）
					tx.plan.findUnique({ where: { id: planId } }),
					tx.planAllocation.findUnique({ where: { planId } }),
				]);
				if (!freshPlan || !freshAllocation) {
					// 创建事务保证 1:1，此处防御性兜底（触发即整体回滚）
					throw new UsagePlanNotFoundException();
				}

				// ⑧ 同事务审计（§13.1：审计写失败 = 本次记账失败，不留「账已改但不知道谁改的」）
				await this.auditService.recordInTx(tx, {
					organizationId: actor.organizationId,
					actorUserId: actor.userId,
					actorType: "USER",
					action: "usage.create",
					targetType: "usage_record",
					targetId: usage.id,
					result: "SUCCESS",
					requestId: requestId ?? null,
					detail: {
						planId,
						currencyCode: usage.currencyCode,
						amount: usage.amount.toFixed(4),
						usedAt: usage.usedAt.toISOString(),
						totalCost: totalCost.toFixed(4),
						lotCount: slices.length,
					},
				});

				return {
					usage,
					totalCost,
					sliceCount: slices.length,
					plan: freshPlan,
					allocation: freshAllocation,
				} satisfies CreateUsageTxResult;
			});
		} catch (error) {
			if (error instanceof PermissionDeniedException) {
				await this.recordDeniedAudit(actor, deniedRole, requestId);
			}
			throw error;
		}

		// 可观测性（§13.3）：成功 Info 记一次汇总（循环外）——组织账本的公共日志只记
		// 标识与计数，不记金额明细
		this.logger.log(
			`usage created organizationId=${actor.organizationId} actorUserId=${actor.userId} planId=${planId} usageId=${result.usage.id} lots=${result.sliceCount} requestId=${requestId ?? "-"}`,
		);

		return {
			usage: this.toUsageDto(result.usage, result.totalCost),
			plan: this.toFundSummary(result.plan, result.allocation),
		};
	}

	/**
	 * 使用记录列表（GET /api/plans/:id/usages，§4.2）：
	 * usedAt 倒序、同刻 createdAt 倒序，limit 100 兑底；成本按 usageId 聚合
	 * UsageLotAllocation。计划不存在或不属于当前组织 → 404 防枚举。
	 * 组织共享账本：同组织任一成员记录的使用都对其他成员可见（createdById 仅标识记录人）。
	 */
	async list(scope: ReadScope, planId: string): Promise<UsageListRespDto> {
		const plan = await this.prisma.plan.findFirst({
			where: { id: planId, ...orgWhere(scope) },
		});
		if (!plan) {
			throw new UsagePlanNotFoundException();
		}
		const records = await this.prisma.usageRecord.findMany({
			where: { planId, ...orgWhere(scope) },
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
	 * 事务内装载计划上下文（§3.1 loadPlanContext / W24 组织化）：
	 * 权限复验与未建账 409 由调用方先行（BE-03：409 优先于计划 404——未建账组织必然
	 * 无计划，409 引导去 /onboarding 而非泄露 404）→ 锁组织账本账户 → FOR UPDATE 锁目标
	 * Plan 行 → 归属 404 防枚举（orgWhere(actor)：跨组织计划一律不可见）→ 状态闸门
	 * （仅 ACTIVE）→ 币种精度。
	 */
	private async loadPlanContext(
		tx: Prisma.TransactionClient,
		actor: ActorContext,
		planId: string,
	) {
		// 锁前只读取不可调整的目标币种用于路由；持锁后一切读取以锁内重读为准
		if (!(await lockOrgPlanAccount(tx, actor, planId))) {
			throw new UsagePlanNotFoundException();
		}
		if (!(await lockOrgPlanRow(tx, actor, planId))) {
			throw new UsagePlanNotFoundException();
		}
		const plan = await tx.plan.findFirst({
			where: { id: planId, ...orgWhere(actor) },
			select: {
				id: true,
				organizationId: true,
				status: true,
				targetCurrency: true,
			},
		});
		if (!plan) {
			throw new UsagePlanNotFoundException();
		}
		assertParentChildSameOrg(plan.organizationId, actor.organizationId);
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
		};
	}

	private async recordDeniedAudit(
		actor: ActorContext,
		role: OrganizationRole,
		requestId: string | null,
	): Promise<void> {
		await recordDeniedAuditBestEffort(this.auditService, this.logger, {
			actor,
			role,
			required: "usage.create",
			requestId,
		});
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

	/** 保留提交的 ISO 8601 时刻，日界校验和 FIFO 排序按 UTC+8 业务日处理。 */
	private parseUsedAt(value: string): Date {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			throw new UsageInvalidParamsException(
				`使用日期必须是有效的 ISO 8601 日期，收到：${value}`,
			);
		}
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
			createdById: record.createdById,
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
