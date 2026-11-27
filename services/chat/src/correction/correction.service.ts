import {
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
	Logger,
} from "@nestjs/common";
import { finalAmountOf, getCurrency, roundRateTo8 } from "@fxplanner-new/money";
import { createHash } from "node:crypto";
import {
	Prisma,
	type InitialHolding,
	type Transaction as TransactionModel,
	type UsageRecord,
} from "@prisma/client";
import {
	lockOrgLedgerAccounts,
	upsertOrgAccount,
} from "../prisma/ledger-write-lock";
import { PrismaService } from "../prisma/prisma.service";
import { RateService } from "../rate/rate.service";
import { resolveOrganizationPreferences } from "../organization/organization-preferences";
import {
	orgWhere,
	type ReadScope,
} from "../authorization/organization-scope";
import { can } from "../authorization/permission-policy";
import { lockOrganizationForActor } from "../organization/default-organization";
import { PermissionDeniedException } from "../authorization/authorization.errors";
import type {
	ActorContext,
	OrganizationRole,
} from "../authorization/authorization.types";
import {
	AuditService,
	recordDeniedAuditBestEffort,
} from "../audit/audit.service";
import { OnboardingNotCompletedException } from "../onboarding/onboarding.service";
import { replayCurrencyLedger, type LedgerEvent, type ReplayResult } from "./ledger-replay";
import {
	assertCorrectionBasics,
	assertUsageCorrectionAllowed,
	computeAllocationDelta,
	CorrectionInvalidParamsException,
	CorrectionNotAllowedException,
	hasEffectiveChange,
	parseCorrectionChanges,
	RateQuoteUnavailableException,
	type ParsedCorrectionChanges,
	type UsageAllocationDelta,
} from "./correction-calculator";
import type {
	CorrectionAllocationImpactDto,
	CorrectionApplyResultDto,
	CorrectionBlockerDetailDto,
	CorrectionHoldingQuoteDto,
	CorrectionListDto,
	CorrectionPreviewDto,
	CorrectionRequestDto,
	CorrectionTargetTypeValue,
} from "./dto/correction.dto";

// ────────────────────────── 模块错误（错误体 { code, message, details? }）──────────────────────────

/** 目标不存在或不属于当前组织（404，不泄露存在性，验收场景 17/20） */
export class CorrectionTargetNotFoundException extends HttpException {
	constructor() {
		super(
			{ code: "CORRECTION_TARGET_NOT_FOUND", message: "更正目标记录不存在" },
			HttpStatus.NOT_FOUND,
		);
	}
}

/** 乐观校验失配：预览后目标已被其他修改更新（409，前端据此引导重新预览，方案 §5.4 ②） */
export class CorrectionTargetChangedException extends HttpException {
	constructor(message = "该记录已被其他修改更新，请重新查看影响后再提交") {
		super(
			{
				code: "CORRECTION_TARGET_CHANGED",
				message,
			},
			HttpStatus.CONFLICT,
		);
	}
}

/** （已退役）MVP-F0-3 前 USAGE 更正的 400 降级异常；接线后无引用，保留类型导出
 *  供历史 Correction 行的 failReason 文本兼容读取，新代码禁止使用 */
export class CorrectionTargetTypeUnavailableException extends HttpException {
	constructor() {
		super(
			{
				code: "CORRECTION_TARGET_TYPE_UNAVAILABLE",
				message: "使用记录更正依赖资金使用功能，该功能就绪前暂不可用",
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}

/** 重放校验失败集合（V1/V2/V3；preview 收集为 blockers、apply 映射 409 并 FAILED 留痕） */
export interface ReplayFailure {
	code:
		| "CORRECTION_INSUFFICIENT_FUNDS"
		| "CORRECTION_ALLOCATION_CONFLICT"
		| "CORRECTION_HISTORICAL_SHORTFALL";
	message: string;
	details: CorrectionBlockerDetailDto[];
}

// ────────────────────────── 内存形态 ───────────────────────────

/** 交易目标的内存形态（变更前/后通用；Decimal 全精度） */
export interface EffectiveTransaction {
	id: string;
	currencyCode: string;
	quantity: Prisma.Decimal;
	principalAmount: Prisma.Decimal;
	feeAmount: Prisma.Decimal | null;
	exchangeRate: Prisma.Decimal;
	planId: string | null;
	transactedAt: Date;
	version: number;
	createdAt: Date;
}

/** 初始持仓目标的内存形态（变更前/后通用；Decimal 全精度） */
export interface EffectiveHolding {
	id: string;
	currencyCode: string;
	amount: Prisma.Decimal;
	rate: Prisma.Decimal;
	rawRate: Prisma.Decimal;
	rateSource: string;
	rateObservedAt: Date;
	cost: Prisma.Decimal;
	confirmedAt: Date;
	createdAt: Date;
	updatedAt: Date;
}

/** 使用记录目标的内存形态（变更前/后通用；Decimal 全精度；MVP-F0-3 接线） */
export interface EffectiveUsage {
	id: string;
	planId: string;
	currencyCode: string;
	amount: Prisma.Decimal;
	usedAt: Date;
	remark: string | null;
	version: number;
	createdAt: Date;
	updatedAt: Date;
}

/** 内部不变量收窄辅助（替代 `!` 非空断言；缺失即明确抛出上下文错误） */
function mustGet<T>(value: T | null | undefined, label: string): T {
	if (value === null || value === undefined) {
		throw new Error(`[correction] 内部不变量缺失：${label}`);
	}
	return value;
}

/** 目标加载产物（TRANSACTION / USAGE / INITIAL_HOLDING 三选一判别联合） */
type LoadedTarget =
	| { type: "TRANSACTION"; transaction: TransactionModel }
	| { type: "USAGE"; usage: UsageRecord }
	| { type: "INITIAL_HOLDING"; holding: InitialHolding };

/** 单币种重放上下文（该币种全部账本事件来源行 + 计划分配现状） */
interface CurrencyLedgerContext {
	initialHoldings: InitialHolding[];
	transactions: TransactionModel[];
	usageRecords: UsageRecord[];
	/** 该币种计划分配：planId → 分配/使用/状态/目标（V2 与 V4 依据；M7 接线后复用） */
	planAllocations: Map<
		string,
		{
			planId: string;
			amount: Prisma.Decimal;
			usedAmount: Prisma.Decimal;
			planStatus: string;
			targetAmount: Prisma.Decimal;
		}
	>;
}

/** evaluate 的最小 DB 接口（PrismaService 与事务客户端均满足；plan.service CapsDb 先例） */
type CorrectionDb = Pick<
	Prisma.TransactionClient,
	| "initialHolding"
	| "transaction"
	| "usageRecord"
	| "usageLotAllocation"
	| "plan"
	| "planAllocation"
	| "account"
	// resolveOrganizationPreferences 的最小数据面（只读预览取组织偏好）
	| "organizationSettings"
	| "$queryRaw"
>;

/** evaluate 的完整产物：preview 序列化为 CorrectionPreviewDto，apply 据此落库 */
interface Evaluation {
	targetType: CorrectionTargetTypeValue;
	targetId: string;
	affectedCurrencies: string[];
	/** 变更前目标（序列化） */
	before: Record<string, unknown>;
	beforeTransaction: EffectiveTransaction | null;
	beforeHolding: EffectiveHolding | null;
	beforeUsage: EffectiveUsage | null;
	/** 变更后目标（内存形态，apply 落库依据） */
	afterTransaction: EffectiveTransaction | null;
	afterHolding: EffectiveHolding | null;
	afterUsage: EffectiveUsage | null;
	/** USAGE 更正的计划分配调整量（apply 落库依据；amountDelta/usedAmountDelta/supplement） */
	usageAllocationDelta: UsageAllocationDelta | null;
	/** USAGE 更正关联的计划（分配调整与 V4 校验依据） */
	usagePlan: {
		planId: string;
		planStatus: string;
		planTargetAmount: Prisma.Decimal;
		allocationAmount: Prisma.Decimal;
		allocationUsedAmount: Prisma.Decimal;
	} | null;
	after: Record<string, unknown>;
	holdingQuote?: CorrectionHoldingQuoteDto;
	diff: Array<{ field: string; before: string | null; after: string | null; display: string }>;
	balances: Array<{ currencyCode: string; before: Prisma.Decimal; after: Prisma.Decimal }>;
	costsBefore: Map<string, Prisma.Decimal | null>;
	costsAfter: Map<string, Prisma.Decimal | null>;
	warnings: string[];
	failures: ReplayFailure[];
	/** 各受影响币种「变更后」重放结果（apply 重建批次/余额依据） */
	replayByCurrency: Map<string, ReplayResult>;
	/** 是否改回「未知」手续费（快照与 diff 的 null 语义，验收场景 1） */
	feeChangedToUnknown: boolean;
	/** 交易更正是否因改币种而解除了计划关联（planId → null，快照留痕） */
	planIdDetached: boolean;
}

interface UsageAllocationAudit {
	planId: string;
	currencyCode: string;
	amountBefore: string;
	amountAfter: string;
	usedBefore: string;
	usedAfter: string;
	supplement: string;
}

/** 列表分页大小（个人工具量级，固定值防深翻页） */
const PAGE_SIZE = 20;
const USAGE_IMPACT_CHANGED = "使用更正的影响已变化或缺少确认，请重新查看影响后再提交";

/** 审计与留痕用的目标类型名（UsageRecord 的 targetType 与 usage.create 审计同口径） */
function auditTargetType(
	targetType: CorrectionTargetTypeValue,
): "transaction" | "usage_record" | "initial_holding" {
	if (targetType === "TRANSACTION") return "transaction";
	return targetType === "USAGE" ? "usage_record" : "initial_holding";
}

/**
 * 更正服务（ToB R1 W24 组织化）：目标加载、账本重放、批次重建与账户写入全部以
 * actor 的组织为数据范围——同组织成员买入的批次、记录的使用都在同一个重放账本里；
 * 不存在「按请求者 userId 读个人设置 / 个人批次」的写路径。
 */
@Injectable()
export class CorrectionService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(RateService) private readonly rateService: RateService,
		@Inject(AuditService) private readonly auditService: AuditService,
		@Inject(Logger) private readonly logger: Logger,
	) {}

	// ──────────────────────── 对外端点（方案 §6）────────────────────────

	/**
	 * 影响预览（POST /api/corrections/preview，方案 §6.1）：全程只读，不落任何业务行
	 * （验收场景 22）。V1/V2/V3 收集为 blockers 返回 200；V0/V4/RATE 类直接以 400 抛出。
	 *
	 * 读作用域（评审 R2-I02 / W24）：目标归属、组织偏好与账本重放范围均按当前组织读取
	 * ——与 apply 同一口径（evaluate 单一组织作用域）。跨组织目标一律 404。
	 */
	async preview(
		actor: ReadScope,
		dto: CorrectionRequestDto,
	): Promise<CorrectionPreviewDto> {
		this.assertSupportedTargetType(dto.targetType);
		if (dto.targetType === "USAGE") {
			const evaluation = await this.prisma.$transaction(
				(tx) => this.evaluate(tx, actor, dto, "preview"),
				{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
			);
			const preview = this.buildPreview(evaluation);
			return { ...preview, expectedUsageImpact: this.usageImpactFingerprint(dto, preview) };
		}
		return this.buildPreview(
			await this.evaluate(this.prisma, actor, dto, "preview"),
		);
	}

	private buildPreview(evaluation: Evaluation): CorrectionPreviewDto {
		return {
			targetType: evaluation.targetType,
			targetId: evaluation.targetId,
			before: evaluation.before,
			after: evaluation.after,
			...(evaluation.holdingQuote ? { holdingQuote: evaluation.holdingQuote } : {}),
			diff: evaluation.diff,
			impacts: {
				balances: evaluation.balances.map((balance) => ({
					currencyCode: balance.currencyCode,
					before: balance.before.toFixed(4),
					after: balance.after.toFixed(4),
				})),
				allocations: serializeAllocationImpacts(evaluation),
				costs: [...evaluation.costsAfter.entries()].map(([usageId, costAfter]) => ({
					usageId,
					costBefore: serializeCostOrNull(evaluation.costsBefore.get(usageId)),
					costAfter: serializeCostOrNull(costAfter),
				})),
				warnings: evaluation.warnings,
			},
			blockers: evaluation.failures.map((failure) => ({
				code: failure.code,
				message: failure.message,
				details: failure.details,
			})),
		};
	}

	/** 同一序列化结果用于展示与确认，避免显示口径和事务校验漂移。 */
	private usageImpactFingerprint(dto: CorrectionRequestDto, preview: CorrectionPreviewDto): string {
		return createHash("sha256")
			.update(JSON.stringify([dto.reason.trim(), preview]))
			.digest("hex");
	}

	/**
	 * 提交更正（POST /api/corrections，方案 §5.4 事务编排 / ToB R1 W24）：
	 * ⓪ 锁外按组织作用域预载目标（跨组织 / 不存在即刻 404，不进事务、不留 FAILED）
	 * → 事务内 ① lockOrganizationForActor 重读最新角色并复验 correction.apply
	 * （锁等降权 → 403 + 事务外 DENIED 审计）→ ② 组织建账态（409）
	 * → ③ lockOrgLedgerAccounts 锁受影响币种账户 → Plan 行 FOR UPDATE
	 * → ④ 重读目标比对 baseVersion（并发更正 → 409 CORRECTION_TARGET_CHANGED）
	 * → ⑤ 新鲜数据重放 + V0~V4（复核不通过：主事务回滚 + 事务外 FAILED 留痕与 FAILED 审计）
	 * → ⑥ 目标行 update + version+1 → 删除受影响币种 CostLot/UsageLotAllocation 后按重放结果重建
	 * （批次沿用来源记录）→ ⑦ Account.balance = finalBalance → ⑧ Correction(status=APPLIED)
	 * 与补分配 PlanChangeLog 留痕（organizationId + actorUserId）→ ⑨ 同事务 correction.apply 审计。
	 * 任一失败全部回滚（审计写失败同样回滚）。
	 */
	async apply(
		actor: ActorContext,
		dto: CorrectionRequestDto,
		requestId: string | null = null,
	): Promise<CorrectionApplyResultDto> {
		this.assertSupportedTargetType(dto.targetType);
		// 锁外预载目标：404 即刻失败（不进事务）；复核失败的留痕也需要 before 内容
		const beforeTarget = await this.loadTarget(
			this.prisma,
			actor,
			dto.targetType,
			dto.targetId,
		);
		let deniedRole: OrganizationRole = actor.role;
		try {
			return await this.prisma.$transaction(async (tx) => {
				// 资格只认锁内重读的最新角色：请求在组织锁上等待期间可能已被降权 / 移除
				const latestRole = await lockOrganizationForActor(tx, actor);
				if (!can(latestRole, "correction.apply")) {
					deniedRole = latestRole;
					throw new PermissionDeniedException();
				}
				return this.applyInTransaction(tx, actor, dto, beforeTarget, requestId);
			});
		} catch (error) {
			if (error instanceof PermissionDeniedException) {
				await this.recordDeniedAudit(actor, deniedRole, requestId);
				throw error;
			}
			// V4 已令此前的 USAGE 预览失效。预览本身遇到 V4 仍返回原业务原因。
			if (dto.targetType === "USAGE" && error instanceof CorrectionNotAllowedException) {
				throw new CorrectionTargetChangedException(USAGE_IMPACT_CHANGED);
			}
			// 复核不通过（V1~V4 类业务拦截）：主事务已回滚，事务外尽力写 FAILED 尝试留痕
			// 与 FAILED 审计（doc 09:76-84「失败也保存尝试记录」；留痕失败仅记日志，不影响错误响应）
			if (error instanceof HttpException && this.isReplayRejection(error)) {
				await this.recordFailedCorrection(
					actor,
					dto,
					beforeTarget,
					error,
					requestId,
				).catch((recordError) => {
					// 留痕失败仅记日志（方案 §5.4：尽力而为，不影响错误响应）
					this.logger.error({
						event: "correction_failed_record_write_error",
						organizationId: actor.organizationId,
						actorUserId: actor.userId,
						targetId: dto.targetId,
						reason: recordError instanceof Error ? recordError.message : String(recordError),
					});
				});
			}
			throw error;
		}
	}

	/** 修改记录列表（GET /api/corrections，方案 §6.3）：createdAt 倒序分页，含 APPLIED 与 FAILED */
	async list(
		scope: ReadScope,
		targetTypeRaw: string | undefined,
		targetId: string | undefined,
		pageRaw: string | undefined,
	): Promise<CorrectionListDto> {
		if (!targetTypeRaw || !targetId) {
			throw new CorrectionInvalidParamsException("targetType 与 targetId 均必填");
		}
		const targetType = this.parseTargetType(targetTypeRaw);
		this.assertSupportedTargetType(targetType);
		const page = parsePage(pageRaw);
		// 目标存在性校验：组织作用域外与不存在一律 404（不泄露存在性，验收场景 20）
		await this.loadTarget(
			this.prisma,
			scope,
			targetType,
			targetId,
		);
		const where = { targetType, targetId, ...orgWhere(scope) };
		const [total, rows] = await Promise.all([
			this.prisma.correction.count({ where }),
			this.prisma.correction.findMany({
				where,
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				skip: (page - 1) * PAGE_SIZE,
				take: PAGE_SIZE,
			}),
		]);
		return {
			// LEDGER-04.4：更正日志显示实际操作者与所属组织
			items: rows.map((row) => ({
				id: row.id,
				organizationId: row.organizationId,
				actorUserId: row.actorUserId,
				targetType: row.targetType as CorrectionTargetTypeValue,
				targetId: row.targetId,
				reason: row.reason,
				beforeSnapshot: (row.beforeSnapshot as Record<string, unknown>) ?? {},
				afterSnapshot: (row.afterSnapshot as Record<string, unknown>) ?? {},
				status: row.status,
				failReason: row.failReason,
				createdAt: row.createdAt.toISOString(),
			})),
			total,
			page,
			pageSize: PAGE_SIZE,
		};
	}

	/** 目标当前内容（GET /api/corrections/target）：更正页表单初值与乐观校验基准的数据源 */
	async getTarget(
		scope: ReadScope,
		targetTypeRaw: string | undefined,
		targetId: string | undefined,
	): Promise<{
		targetType: CorrectionTargetTypeValue;
		targetId: string;
		target: Record<string, unknown>;
	}> {
		if (!targetTypeRaw || !targetId) {
			throw new CorrectionInvalidParamsException("targetType 与 targetId 均必填");
		}
		const targetType = this.parseTargetType(targetTypeRaw);
		this.assertSupportedTargetType(targetType);
		const target = await this.loadTarget(
			this.prisma,
			scope,
			targetType,
			targetId,
		);
		return {
			targetType,
			targetId,
			target:
				target.type === "TRANSACTION"
					? this.serializeTransaction(this.toEffectiveTransaction(target.transaction))
					: target.type === "USAGE"
						? this.serializeUsage(this.toEffectiveUsage(target.usage))
						: this.serializeHolding(this.toEffectiveHolding(target.holding)),
		};
	}

	// ──────────────────────── apply 事务内编排（方案 §5.4）────────────────────────

	/**
	 * 锁序（与 usage.service / plan.service 全流程一致，防死锁）：
	 * `membership:${orgId}`（调用方 lockOrganizationForActor）→ lockOrgLedgerAccounts
	 * （币种码序 advisory 锁 + 账户行）→ 涉及币种的 Plan 行 FOR UPDATE。
	 */
	private async applyInTransaction(
		tx: Prisma.TransactionClient,
		actor: ActorContext,
		dto: CorrectionRequestDto,
		_beforeTarget: LoadedTarget,
		requestId: string | null,
	): Promise<CorrectionApplyResultDto> {
		// ① 组织建账态：未建账不允许更正（与记交易 / 记使用 / 改计划写入口同一道 BE-03 防线）
		const preferences = await resolveOrganizationPreferences(
			tx,
			actor.organizationId,
		);
		if (!preferences) {
			throw new OnboardingNotCompletedException(
				"尚未完成首次设置，请先前往 /onboarding 完成建账后再提交更正",
			);
		}

		// ② 行锁范围按「目标当前币种 + 拟改新币种」解析；lockOrgLedgerAccounts 内部按币种码
		//    排序取 advisory 锁与账户行（改币种 = 旧 + 新两个币种），组织账本写入由此互斥
		const fresh = await this.loadTarget(tx, actor, dto.targetType, dto.targetId);
		const affectedCurrencies = this.resolveAffectedCurrencies(
			dto.targetType,
			fresh,
			dto.changes,
		);
		await lockOrgLedgerAccounts(
			tx,
			actor.organizationId,
			affectedCurrencies,
		);

		// ③ 涉及币种的计划行加 FOR UPDATE（组织作用域；必须在 lockOrgLedgerAccounts
		//    之后调用：账户行 → 计划行）
		const lockedCurrencies = [...new Set(affectedCurrencies)].sort((a, b) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		await this.lockScopedPlanRows(tx, actor, lockedCurrencies);

		// ④ 事务内重读目标 + 乐观校验（预览后目标已被其他成员的更正更新 → 409，
		//    前端引导重新预览，doc 10:11；LEDGER-04.2 并发更正不覆盖后者）
		const locked = await this.loadTarget(tx, actor, dto.targetType, dto.targetId);
		this.assertOptimisticMatch(dto, locked);
		if (locked.type === "USAGE" && !dto.expectedUsageImpact) {
			throw new CorrectionTargetChangedException(USAGE_IMPACT_CHANGED);
		}

		// ⑤ 新鲜数据完整重放 + V0~V4（与 preview 同一套计算、同一组织作用域，所见即所存）
		const evaluation = await this.evaluate(tx, actor, dto, "apply");
		if (
			evaluation.targetType === "USAGE" &&
			dto.expectedUsageImpact !== this.usageImpactFingerprint(dto, this.buildPreview(evaluation))
		) {
			throw new CorrectionTargetChangedException(USAGE_IMPACT_CHANGED);
		}
		if (evaluation.failures.length > 0) {
			throw this.failuresToException(evaluation.failures);
		}

		// ⑥~⑧ 落库：目标行（USAGE 连带计划分配调整）→ 批次重建 → 余额 → APPLIED 与补分配留痕
		//（同事务，任一失败全部回滚）
		let usageAllocationAudit: UsageAllocationAudit | null = null;
		if (evaluation.targetType === "TRANSACTION") {
			await this.persistTransactionCorrection(tx, evaluation);
		} else if (evaluation.targetType === "USAGE") {
			usageAllocationAudit = await this.persistUsageCorrection(tx, evaluation);
		} else {
			await this.persistHoldingCorrection(tx, evaluation);
		}
		for (const [currencyCode, replay] of evaluation.replayByCurrency) {
			await this.rebuildLots(tx, actor, currencyCode, replay);
		}
		for (const [currencyCode, replay] of evaluation.replayByCurrency) {
			// 重放终态即该币种账户余额的唯一真相（existingBalance 不参与，
			// 否则同一笔流入被计两次）。经统一入口写入：组织内同币种只保留一行账户，
			// 新币种无账户时由操作者建户
			await upsertOrgAccount({
				tx,
				organizationId: actor.organizationId,
				currencyCode,
				actorUserId: actor.userId,
				computeBalance: () => replay.finalBalance,
			});
		}
		const targetVersion =
			evaluation.afterTransaction?.version ?? evaluation.afterUsage?.version ?? null;
		const snapshots = this.buildSnapshots(
			dto,
			evaluation,
			targetVersion,
			usageAllocationAudit,
		);
		const correction = await tx.correction.create({
			data: {
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				targetType: evaluation.targetType,
				targetId: evaluation.targetId,
				reason: dto.reason,
				beforeSnapshot: snapshots.before,
				afterSnapshot: snapshots.after,
				status: "APPLIED",
			},
			select: { id: true, createdAt: true },
		});
		if (usageAllocationAudit && evaluation.usageAllocationDelta?.supplement.gt(0)) {
			await this.recordUsageSupplement(
				tx,
				actor,
				correction,
				evaluation,
				usageAllocationAudit,
			);
		}

		// ⑨ 同事务审计（§13.1：审计写失败 = 更正失败，账本与留痕一并回滚）
		await this.auditService.recordInTx(tx, {
			organizationId: actor.organizationId,
			actorUserId: actor.userId,
			actorType: "USER",
			action: "correction.apply",
			targetType: auditTargetType(evaluation.targetType),
			targetId: evaluation.targetId,
			result: "SUCCESS",
			requestId: requestId ?? null,
			detail: {
				correctionId: correction.id,
				targetVersion,
				changedFields: evaluation.diff.map((item) => item.field),
				planIdDetached: evaluation.planIdDetached,
				balances: evaluation.balances.map((balance) => ({
					currencyCode: balance.currencyCode,
					before: balance.before.toFixed(4),
					after: balance.after.toFixed(4),
				})),
				...(usageAllocationAudit
					? { allocation: usageAllocationAudit }
					: {}),
			},
		});

		return {
			correctionId: correction.id,
			status: "APPLIED",
			targetType: evaluation.targetType,
			targetId: evaluation.targetId,
			targetVersion,
			createdAt: correction.createdAt.toISOString(),
		};
	}

	/**
	 * 锁内对涉及币种的 Plan 行加 FOR UPDATE（纯组织作用域，与 orgWhere(scope) 同口径）：
	 * 更正会读这些计划的分配做 V2 校验、改 USAGE 所在计划的分配，行锁挡住绕过组织锁的
	 * 直接写入。按 id 排序取锁；必须在 lockOrgLedgerAccounts 之后调用（账户行 → 计划行）。
	 */
	private async lockScopedPlanRows(
		tx: Prisma.TransactionClient,
		scope: ReadScope,
		currencyCodes: readonly string[],
	): Promise<void> {
		await tx.$queryRaw`
			SELECT id FROM plans
			WHERE target_currency = ANY(${[...currencyCodes]}::text[])
				AND organization_id = ${scope.organizationId}
			ORDER BY id
			FOR UPDATE`;
	}

	// ──────────────────────── 评估核心（preview/apply 共用，方案 §3「所见即所存」）────────────────────────

	/**
	 * 只读评估：加载目标 → 乐观校验 → 解析变更 → V0 静态校验 → 受影响币种全量重放
	 * （before/after 各一次，纯内存）→ V1/V2/V3 收集为 failures。不改任何数据。
	 * preview 与 apply 共用同一组织作用域（W24）：目标、账本行、计划占用与组织偏好
	 * 一律按 actor 的组织读取——不存在「apply 退回请求者个人账本」的分支。
	 */
	private async evaluate(
		db: CorrectionDb,
		actor: ReadScope,
		dto: CorrectionRequestDto,
		mode: "preview" | "apply",
	): Promise<Evaluation> {
		const target = await this.loadTarget(
			db,
			actor,
			dto.targetType,
			dto.targetId,
		);
		this.assertOptimisticMatch(dto, target);
		// 本位币 / 记账起点取组织偏好（唯一真相 = OrganizationSettings；组织尚无该行即未建账）
		const preferences = await resolveOrganizationPreferences(
			db,
			actor.organizationId,
		);
		const settings =
			preferences && preferences.baseCurrency.trim()
				? {
						baseCurrency: preferences.baseCurrency,
						ledgerStartedAt: preferences.ledgerStartedAt,
					}
				: null;
		if (target.type === "TRANSACTION") {
			return this.evaluateTransaction(
				db,
				dto,
				target.transaction,
				settings,
				actor,
			);
		}
		if (target.type === "USAGE") {
			return this.evaluateUsage(db, dto, target.usage, settings, actor);
		}
		return this.evaluateHolding(db, dto, target.holding, settings, mode, actor);
	}

	/** 交易更正评估：变更解析 → 受影响币种重放（改币种时两币种各自全量）→ 校验 → 影响面 */
	private async evaluateTransaction(
		db: CorrectionDb,
		dto: CorrectionRequestDto,
		original: TransactionModel,
		settings: { baseCurrency: string; ledgerStartedAt: Date | null } | null,
		scope: ReadScope,
	): Promise<Evaluation> {
		const changes = parseCorrectionChanges(dto.changes as Record<string, unknown>, {
			targetType: "TRANSACTION",
			now: new Date(),
			ledgerStartedAt: settings?.ledgerStartedAt ?? null,
			currentCurrencyCode: original.currencyCode,
			currentExchangeRate: original.exchangeRate,
			original: {
				principalAmount: original.principalAmount,
				quantity: original.quantity,
				feeAmount: original.feeAmount,
			},
		});
		assertCorrectionBasics(
			dto.reason,
			hasEffectiveChange(changes, {
				currencyCode: original.currencyCode,
				principalAmount: original.principalAmount,
				quantity: original.quantity,
				feeAmount: original.feeAmount,
				transactedAt: original.transactedAt,
			}),
		);

		const nextCurrency = changes.currencyCode;
		const currencyChanged =
			nextCurrency !== undefined && nextCurrency !== original.currencyCode;
		const affectedCurrencies = currencyChanged
			? [original.currencyCode, nextCurrency]
			: [original.currencyCode];
		const context = await this.loadLedgerContexts(
			db,
			scope,
			affectedCurrencies,
		);

		// 变更后内存形态：改币种时同步解除计划关联（计划绑定原币种，planId → null，快照留痕）
		const planIdDetached = currencyChanged && original.planId !== null;
		const effective: EffectiveTransaction = {
			id: original.id,
			currencyCode: changes.currencyCode ?? original.currencyCode,
			quantity: changes.quantity ?? original.quantity,
			principalAmount: changes.principalAmount ?? original.principalAmount,
			feeAmount: changes.feeProvided
				? (changes.feeAmount ?? null)
				: original.feeAmount,
			exchangeRate: original.exchangeRate,
			planId: planIdDetached ? null : original.planId,
			transactedAt: changes.transactedAt ?? original.transactedAt,
			version: original.version + 1,
			createdAt: original.createdAt,
		};

		const beforeReplays = new Map<string, ReplayResult>();
		const afterReplays = new Map<string, ReplayResult>();
		for (const currencyCode of affectedCurrencies) {
			const ledger = mustGet(
				context.get(currencyCode),
				`context(${currencyCode})`,
			);
			beforeReplays.set(
				currencyCode,
				this.replayCurrency(
					ledger,
					currencyCode,
					settings?.ledgerStartedAt ?? null,
					{
						targetId: original.id,
						effective: this.toEffectiveTransaction(original),
					},
					null,
				),
			);
			afterReplays.set(
				currencyCode,
				this.replayCurrency(
					ledger,
					currencyCode,
					settings?.ledgerStartedAt ?? null,
					{
						targetId: original.id,
						effective,
					},
					null,
				),
			);
		}

		return {
			targetType: "TRANSACTION",
			targetId: original.id,
			affectedCurrencies,
			before: this.serializeTransaction(this.toEffectiveTransaction(original)),
			beforeTransaction: this.toEffectiveTransaction(original),
			beforeHolding: null,
			beforeUsage: null,
			afterTransaction: effective,
			afterHolding: null,
			afterUsage: null,
			usageAllocationDelta: null,
			usagePlan: null,
			after: this.serializeTransaction(effective),
			diff: this.transactionDiff(
				this.toEffectiveTransaction(original),
				effective,
				changes,
			),
			balances: affectedCurrencies.map((currencyCode) => ({
				currencyCode,
				before: mustGet(
					beforeReplays.get(currencyCode),
					`beforeReplays(${currencyCode})`,
				).finalBalance,
				after: mustGet(
					afterReplays.get(currencyCode),
					`afterReplays(${currencyCode})`,
				).finalBalance,
			})),
			costsBefore: collectUsageCosts(beforeReplays),
			costsAfter: collectUsageCosts(afterReplays),
			warnings: buildFeeWarnings(afterReplays),
			failures: this.collectReplayFailures(affectedCurrencies, afterReplays, context),
			replayByCurrency: afterReplays,
			feeChangedToUnknown: changes.feeProvided && changes.feeAmount === null,
			planIdDetached,
		};
	}

	/**
	 * 使用更正评估（MVP-F0-3 / DEBT-01：改金额/改日期；无币种变更维度）：
	 * 变更解析（V0）→ V4 计划状态矩阵（改 0/超目标/COMPLETED/CANCELLED，400）→
	 * 计划分配调整量（computeAllocationDelta，doc 14 例 02~05）→ 受影响币种
	 * 重放（before/after 各一次，usageVariant 应用拟变更）→ V1/V2/V3 收集为 failures。
	 * 更正前成本按已入账分摊汇总，更正后成本来自重放。
	 * 计划分配一致性在重放层之外显式校验（V2'：补分配不超计划目标池）。
	 */
	private async evaluateUsage(
		db: CorrectionDb,
		dto: CorrectionRequestDto,
		originalUsage: UsageRecord,
		settings: { baseCurrency: string; ledgerStartedAt: Date | null } | null,
		scope: ReadScope,
	): Promise<Evaluation> {
		const changes = parseCorrectionChanges(dto.changes as Record<string, unknown>, {
			targetType: "USAGE",
			now: new Date(),
			ledgerStartedAt: settings?.ledgerStartedAt ?? null,
			currentCurrencyCode: originalUsage.currencyCode,
			// USAGE 分支不使用汇率/三元组自洽（解析器仅 TRANSACTION 分支消费），传安全占位
			currentExchangeRate: new Prisma.Decimal(1),
			original: {
				principalAmount: new Prisma.Decimal(0),
				quantity: new Prisma.Decimal(1),
				feeAmount: null,
			},
		});
		assertCorrectionBasics(
			dto.reason,
			hasEffectiveChange(changes, {
				currencyCode: originalUsage.currencyCode,
				amount: originalUsage.amount,
				usedAt: originalUsage.usedAt,
			}),
		);

		// 计划与分配装载（UsageRecord.planId 非空；缺失即数据异常，拒绝更正）。
		// 计划按组织作用域读取（orgWhere）：使用记录本身已按组织作用域校验归属，
		// 组织内成员算出的未分配余额一致，V2 不会因看不到对方的计划占用而放行超额更正
		const usagePlan = await db.plan.findFirst({
			where: {
				id: originalUsage.planId,
				...orgWhere(scope),
			},
			select: { id: true, status: true, targetAmount: true },
		});
		const allocation = await db.planAllocation.findUnique({
			where: { planId: originalUsage.planId },
		});
		if (!usagePlan || !allocation) {
			throw new CorrectionInvalidParamsException(
				"使用记录关联的计划或分配不存在，无法更正（数据异常）",
			);
		}

		// V4 计划状态矩阵（doc 10:88-91：改 0/超目标/COMPLETED 改大或改日期/CANCELLED → 400）
		assertUsageCorrectionAllowed({
			planStatus: usagePlan.status,
			planTargetAmount: usagePlan.targetAmount,
			planCumulativeUsed: allocation.usedAmount,
			currentAmount: originalUsage.amount,
			changes,
		});

		const effective: EffectiveUsage = {
			id: originalUsage.id,
			planId: originalUsage.planId,
			currencyCode: originalUsage.currencyCode,
			amount: changes.amount ?? originalUsage.amount,
			usedAt: changes.usedAt ?? originalUsage.usedAt,
			remark: originalUsage.remark,
			version: originalUsage.version + 1,
			createdAt: originalUsage.createdAt,
			updatedAt: originalUsage.updatedAt,
		};

		// 计划分配调整量（doc 14 例 02~05）：改小同减、改大先耗剩余分配再补分配
		const allocationDelta = computeAllocationDelta({
			currentAmount: originalUsage.amount,
			newAmount: effective.amount,
			remainingAllocation: allocation.amount.sub(allocation.usedAmount),
		});

		// V2'（补分配池）：计划分配加补分配后不得超过计划目标金额
		//（targetAmount − amount − amountDelta < 0 即分配池不足）
		const allocationAfter =
			allocation.amount.add(allocationDelta.amountDelta);
		if (allocationAfter.gt(usagePlan.targetAmount)) {
			throw new CorrectionNotAllowedException(
				"更正后计划分配将超过计划目标金额，暂不支持（请先调整计划目标）",
			);
		}

		const affectedCurrencies = [originalUsage.currencyCode];
		const context = await this.loadLedgerContexts(
			db,
			scope,
			affectedCurrencies,
		);
		// 倒序补录时，按日期重放可能重新分配批次。原成本以账本已存的分摊为准。
		const ledger = mustGet(
			context.get(originalUsage.currencyCode),
			`context(${originalUsage.currencyCode})`,
		);
		const postedCosts = await db.usageLotAllocation.groupBy({
			by: ["usageId"],
			where: { usageId: { in: ledger.usageRecords.map((usage) => usage.id) } },
			_sum: { cost: true },
		});

		const beforeReplays = new Map<string, ReplayResult>();
		const afterReplays = new Map<string, ReplayResult>();
		for (const currencyCode of affectedCurrencies) {
			beforeReplays.set(
				currencyCode,
				this.replayCurrency(
					ledger,
					currencyCode,
					settings?.ledgerStartedAt ?? null,
					null,
					null,
					{
						targetId: originalUsage.id,
						effective: this.toEffectiveUsage(originalUsage),
					},
				),
			);
			afterReplays.set(
				currencyCode,
				this.replayCurrency(
					ledger,
					currencyCode,
					settings?.ledgerStartedAt ?? null,
					null,
					null,
					{
						targetId: originalUsage.id,
						effective,
					},
				),
			);
		}

		// V2 按更正后的分配与使用额计算剩余分配，与落库增量一致。
		ledger.planAllocations.set(usagePlan.id, {
			planId: usagePlan.id,
			amount: allocationAfter,
			usedAmount: allocation.usedAmount.add(allocationDelta.usedAmountDelta),
			planStatus: usagePlan.status,
			targetAmount: usagePlan.targetAmount,
		});

		return {
			targetType: "USAGE",
			targetId: originalUsage.id,
			affectedCurrencies,
			before: this.serializeUsage(this.toEffectiveUsage(originalUsage)),
			beforeTransaction: null,
			beforeHolding: null,
			beforeUsage: this.toEffectiveUsage(originalUsage),
			afterTransaction: null,
			afterHolding: null,
			afterUsage: effective,
			usageAllocationDelta: allocationDelta,
			usagePlan: {
				planId: usagePlan.id,
				planStatus: usagePlan.status,
				planTargetAmount: usagePlan.targetAmount,
				allocationAmount: allocation.amount,
				allocationUsedAmount: allocation.usedAmount,
			},
			after: this.serializeUsage(effective),
			diff: this.usageDiff(this.toEffectiveUsage(originalUsage), effective),
			balances: affectedCurrencies.map((currencyCode) => ({
				currencyCode,
				before: mustGet(
					beforeReplays.get(currencyCode),
					`beforeReplays(${currencyCode})`,
				).finalBalance,
				after: mustGet(
					afterReplays.get(currencyCode),
					`afterReplays(${currencyCode})`,
				).finalBalance,
			})),
			costsBefore: new Map(postedCosts.map(({ usageId, _sum }) => [usageId, _sum.cost])),
			costsAfter: collectUsageCosts(afterReplays),
			warnings: buildFeeWarnings(afterReplays),
			failures: this.collectReplayFailures(
				affectedCurrencies,
				afterReplays,
				context,
			),
			replayByCurrency: afterReplays,
			feeChangedToUnknown: false,
			planIdDetached: false,
		};
	}

	/** 初始持仓更正评估：金额（沿用原报价重算成本）或币种（原时点取价，方案 §5.3） */
	private async evaluateHolding(
		db: CorrectionDb,
		dto: CorrectionRequestDto,
		original: InitialHolding,
		settings: { baseCurrency: string; ledgerStartedAt: Date | null } | null,
		mode: "preview" | "apply",
		scope: ReadScope,
	): Promise<Evaluation> {
		const changes = parseCorrectionChanges(dto.changes as Record<string, unknown>, {
			targetType: "INITIAL_HOLDING",
			now: new Date(),
			ledgerStartedAt: settings?.ledgerStartedAt ?? null,
			currentCurrencyCode: original.currencyCode,
			currentExchangeRate: new Prisma.Decimal(1),
			original: {
				principalAmount: new Prisma.Decimal(0),
				quantity: new Prisma.Decimal(0),
				feeAmount: null,
			},
		});
		assertCorrectionBasics(
			dto.reason,
			hasEffectiveChange(changes, {
				currencyCode: original.currencyCode,
				amount: original.amount,
			}),
		);

		const baseCurrency = settings?.baseCurrency;
		const baseDecimalPlaces =
			(baseCurrency ? getCurrency(baseCurrency)?.decimalPlaces : undefined) ?? 2;
		const nextCode = changes.currencyCode ?? original.currencyCode;
		const currencyChanged = nextCode !== original.currencyCode;

		const affectedCurrencies = currencyChanged
			? [original.currencyCode, nextCode]
			: [original.currencyCode];
		const context = await this.loadLedgerContexts(
			db,
			scope,
			affectedCurrencies,
		);

		// 币种更正须取得原确认时点的合格报价，取价窗口由 RateService 按来源粒度处理。
		let nextRate = original.rate;
		let nextRawRate = original.rawRate;
		let nextRateSource = original.rateSource;
		let nextRateObservedAt = original.rateObservedAt;
		let holdingQuote: CorrectionHoldingQuoteDto | undefined;
		if (currencyChanged) {
			if (!baseCurrency) {
				throw new CorrectionInvalidParamsException(
					"尚未完成首次设置，无法更正初始持仓币种",
				);
			}
			if (nextCode === baseCurrency) {
				throw new CorrectionNotAllowedException("初始持仓币种不能与本位币相同");
			}
			if (
				mustGet(context.get(nextCode), `context(${nextCode})`).initialHoldings
					.length > 0
			) {
				throw new CorrectionInvalidParamsException(
					"该币种已有初始记录；请在对应币种账户的初始记录中发起更正",
				);
			}
			// 取价放在所有账本读取之后，提交仅查缓存，重放和落库使用同一份已确认报价。
			const quote = await this.rateService.findQuoteAt(
				baseCurrency,
				nextCode,
				original.confirmedAt,
				{ backfill: mode === "preview" },
			);
			if (!quote) {
				throw new RateQuoteUnavailableException();
			}
			const adopted = quote.sellRate ?? quote.rate;
			nextRate = roundRateTo8(adopted);
			nextRawRate = new Prisma.Decimal(adopted);
			nextRateSource = quote.source;
			nextRateObservedAt = quote.observedAt;
			const rawRate = nextRawRate.toFixed(10);
			const observedAt = nextRateObservedAt.toISOString();
			const confirmationKey = createHash("sha256")
				.update(JSON.stringify([
					original.id,
					baseCurrency,
					nextCode,
					rawRate,
					nextRateSource,
					observedAt,
				]))
				.digest("hex");
			if (mode === "apply" && dto.previewQuoteKey !== confirmationKey) {
				throw new HttpException(
					{
						code: "CORRECTION_QUOTE_CHANGED",
						message: "请重新查看影响并确认当前报价",
					},
					HttpStatus.CONFLICT,
				);
			}
			holdingQuote = {
				confirmationKey,
				rate: nextRate.toFixed(8),
				rawRate,
				source: nextRateSource,
				observedAt,
			};
		}

		// 沿用（或新取）报价重算折算成本：金额更正不用今天的行情（验收场景 12），改 0 成本归 0
		const nextAmount = changes.amount ?? original.amount;
		const nextCost = finalAmountOf(nextAmount, nextRate, baseDecimalPlaces as 0 | 2);

		const effective: EffectiveHolding = {
			id: original.id,
			currencyCode: nextCode,
			amount: nextAmount,
			rate: nextRate,
			rawRate: nextRawRate,
			rateSource: nextRateSource,
			rateObservedAt: nextRateObservedAt,
			cost: nextCost,
			confirmedAt: original.confirmedAt,
			createdAt: original.createdAt,
			updatedAt: original.updatedAt,
		};

		const beforeReplays = new Map<string, ReplayResult>();
		const afterReplays = new Map<string, ReplayResult>();
		for (const currencyCode of affectedCurrencies) {
			const ledger = mustGet(
				context.get(currencyCode),
				`context(${currencyCode})`,
			);
			beforeReplays.set(
				currencyCode,
				this.replayCurrency(
					ledger,
					currencyCode,
					settings?.ledgerStartedAt ?? null,
					null,
					{
						targetId: original.id,
						effective: this.toEffectiveHolding(original),
					},
				),
			);
			afterReplays.set(
				currencyCode,
				this.replayCurrency(
					ledger,
					currencyCode,
					settings?.ledgerStartedAt ?? null,
					null,
					{
						targetId: original.id,
						effective,
					},
				),
			);
		}

		return {
			targetType: "INITIAL_HOLDING",
			targetId: original.id,
			affectedCurrencies,
			before: this.serializeHolding(this.toEffectiveHolding(original)),
			beforeTransaction: null,
			beforeHolding: this.toEffectiveHolding(original),
			beforeUsage: null,
			afterTransaction: null,
			afterHolding: effective,
			afterUsage: null,
			usageAllocationDelta: null,
			usagePlan: null,
			after: this.serializeHolding(effective),
			holdingQuote,
			diff: this.holdingDiff(this.toEffectiveHolding(original), effective),
			balances: affectedCurrencies.map((currencyCode) => ({
				currencyCode,
				before: mustGet(
					beforeReplays.get(currencyCode),
					`beforeReplays(${currencyCode})`,
				).finalBalance,
				after: mustGet(
					afterReplays.get(currencyCode),
					`afterReplays(${currencyCode})`,
				).finalBalance,
			})),
			costsBefore: collectUsageCosts(beforeReplays),
			costsAfter: collectUsageCosts(afterReplays),
			warnings: buildFeeWarnings(afterReplays),
			failures: this.collectReplayFailures(affectedCurrencies, afterReplays, context),
			replayByCurrency: afterReplays,
			feeChangedToUnknown: false,
			planIdDetached: false,
		};
	}

	// ──────────────────────── 重放与校验 ────────────────────────

	/**
	 * 单币种账本重放（事件集构造）：本笔目标（交易/初始持仓）以 variant 形态注入，
	 * 并按 variant.currencyCode 归属币种——改币种时旧币种账本自然排除本笔、
	 * 新币种账本自然包含本笔（DB 行仍属旧币种，不能依赖 ledger.transactions 遍历到它）。
	 * 使用记录的币种/计划不随交易更正而变（doc 09），始终留在其 DB 行币种。
	 */
	private replayCurrency(
		ledger: CurrencyLedgerContext,
		currencyCode: string,
		ledgerStartedAt: Date | null,
		txVariant: { targetId: string; effective: EffectiveTransaction } | null,
		holdingVariant: { targetId: string; effective: EffectiveHolding } | null,
		usageVariant: { targetId: string; effective: EffectiveUsage } | null = null,
	): ReplayResult {
		const events: LedgerEvent[] = [];
		for (const holding of ledger.initialHoldings) {
			if (holdingVariant && holding.id === holdingVariant.targetId) continue;
			events.push(
				this.initialEventFromEffective(
					this.toEffectiveHolding(holding),
					ledgerStartedAt,
				),
			);
		}
		if (holdingVariant && holdingVariant.effective.currencyCode === currencyCode) {
			events.push(
				this.initialEventFromEffective(holdingVariant.effective, ledgerStartedAt),
			);
		}
		for (const transaction of ledger.transactions) {
			if (txVariant && transaction.id === txVariant.targetId) continue;
			events.push(this.transactionEvent(this.toEffectiveTransaction(transaction)));
		}
		if (txVariant && txVariant.effective.currencyCode === currencyCode) {
			events.push(this.transactionEvent(txVariant.effective));
		}
		for (const usage of ledger.usageRecords) {
			if (usageVariant && usage.id === usageVariant.targetId) continue;
			events.push(this.usageEvent(usage));
		}
		if (usageVariant && usageVariant.effective.currencyCode === currencyCode) {
			events.push(this.usageEventFromEffective(usageVariant.effective));
		}
		return replayCurrencyLedger(events);
	}

	private initialEventFromEffective(
		holding: EffectiveHolding,
		ledgerStartedAt: Date | null,
	): LedgerEvent {
		return {
			type: "INITIAL",
			id: holding.id,
			// INITIAL 批次业务时间 = 记账起点日（BE-02 统一：与 onboarding 写侧
			// CostLot.acquiredAt=ledgerStartedAt 同口径；跨日补录的重放不再把批次
			// 排到确认日导致 V3 误报/批次漂移）。起点缺失兜底确认时刻（存量防御）。
			happenedAt: ledgerStartedAt ?? holding.confirmedAt,
			createdAt: holding.createdAt,
			quantity: holding.amount,
			unitCost: holding.rate,
			totalCost: holding.cost,
		};
	}

	private transactionEvent(transaction: EffectiveTransaction): LedgerEvent {
		return {
			type: "PURCHASE",
			id: transaction.id,
			happenedAt: transaction.transactedAt,
			createdAt: transaction.createdAt,
			quantity: transaction.quantity,
			principalAmount: transaction.principalAmount,
			feeAmount: transaction.feeAmount,
		};
	}

	private usageEvent(usage: UsageRecord): LedgerEvent {
		return {
			type: "USAGE",
			id: usage.id,
			happenedAt: usage.usedAt,
			createdAt: usage.createdAt,
			quantity: usage.amount,
		};
	}

	/** 拟变更后的使用事件（与 usageEvent 同字段口径；重放排序/消耗共用） */
	private usageEventFromEffective(usage: EffectiveUsage): LedgerEvent {
		return {
			type: "USAGE",
			id: usage.id,
			happenedAt: usage.usedAt,
			createdAt: usage.createdAt,
			quantity: usage.amount,
		};
	}

	/**
	 * V1/V2/V3 收集（方案 §5.1 重放后校验表；全部币种跑完不短路，一次给完整 blockers）：
	 * - V1：每币种 finalBalance ≥ 0（改币种移走批次后旧币种变负即此项，验收场景 2）；
	 * - V2：未分配余额 = finalBalance − Σ剩余分配 ≥ 0；更正绝不自动减少分配，
	 *   违反时附受影响计划清单引导先去计划调整（doc 14 例 11）；
	 * - V3：历史时点充足性（violations 为空，附日期 + 缺口明细，验收场景 3/10/16）。
	 */
	private collectReplayFailures(
		currencies: string[],
		replays: Map<string, ReplayResult>,
		context: Map<string, CurrencyLedgerContext>,
	): ReplayFailure[] {
		const failures: ReplayFailure[] = [];
		for (const currencyCode of currencies) {
			const replay = mustGet(
				replays.get(currencyCode),
				`replays(${currencyCode})`,
			);
			// V3 优先收集（附日期+缺口明细，最具体）：终态负值常是同一缺口的两面，
			// 方案 #18「初始改 0 且有历史使用」期望响应 V3 缺口明细
			if (replay.violations.length > 0) {
				failures.push({
					code: "CORRECTION_HISTORICAL_SHORTFALL",
					message: `更正后历史使用发生时 ${currencyCode} 资金不足，不能提交；缺口明细见 details（不借未来买入补过去使用）`,
					details: replay.violations.map((violation) => ({
						currencyCode,
						shortfall: violation.shortfall.toFixed(4),
						usedAt: violation.usedAt.toISOString(),
						planId: null,
					})),
				});
			}
			if (replay.finalBalance.lt(0)) {
				failures.push({
					code: "CORRECTION_INSUFFICIENT_FUNDS",
					message: `更正后 ${currencyCode} 余额将变为 ${replay.finalBalance.toFixed(4)}，不能提交；请先核对该币种的买入与使用记录`,
					details: [
						{
							currencyCode,
							shortfall: replay.finalBalance.abs().toFixed(4),
							usedAt: null,
							planId: null,
						},
					],
				});
			}
			const ledger = mustGet(
				context.get(currencyCode),
				`context(${currencyCode})`,
			);
			let allocatedRemaining = new Prisma.Decimal(0);
			const planIdsWithRemaining: string[] = [];
			for (const allocation of ledger.planAllocations.values()) {
				const remaining = allocation.amount.sub(allocation.usedAmount);
				allocatedRemaining = allocatedRemaining.add(remaining);
				if (remaining.gt(0)) {
					planIdsWithRemaining.push(allocation.planId);
				}
			}
			const unallocated = replay.finalBalance.sub(allocatedRemaining);
			if (unallocated.lt(0)) {
				failures.push({
					code: "CORRECTION_ALLOCATION_CONFLICT",
					message: `更正后 ${currencyCode} 未分配余额将变为 ${unallocated.toFixed(4)}；更正不会自动减少计划分配，请先到对应计划调整或解除分配`,
					details: planIdsWithRemaining.map((planId) => ({
						currencyCode,
						shortfall: unallocated.abs().toFixed(4),
						usedAt: null,
						planId,
					})),
				});
			}
		}
		return failures;
	}

	// ──────────────────────── 落库（方案 §5.4 ④~⑦）────────────────────────

	/** 交易更正落库：目标行 update + version+1（改币种时 planId 已在 effective 中解除） */
	private async persistTransactionCorrection(
		tx: Prisma.TransactionClient,
		evaluation: Evaluation,
	): Promise<void> {
		const effective = mustGet(evaluation.afterTransaction, "afterTransaction");
		// @org-scope-exempt: post-lock 主键更新（applyInTransaction 已持组织账本锁并经 loadTarget+orgWhere 校验归属）
		await tx.transaction.update({
			where: { id: effective.id },
			data: {
				currencyCode: effective.currencyCode,
				quantity: effective.quantity,
				principalAmount: effective.principalAmount,
				feeAmount: effective.feeAmount,
				planId: effective.planId,
				transactedAt: effective.transactedAt,
				version: { increment: 1 },
			},
		});
	}

	/**
	 * 使用更正落库（MVP-F0-3）：目标行 update（amount/usedAt/version+1）+
	 * 计划分配调整（computeAllocationDelta：amount/usedAmount 同步）。
	 */
	private async persistUsageCorrection(
		tx: Prisma.TransactionClient,
		evaluation: Evaluation,
	): Promise<UsageAllocationAudit | null> {
		const effective = mustGet(evaluation.afterUsage, "afterUsage");
		const delta = mustGet(
			evaluation.usageAllocationDelta,
			"usageAllocationDelta",
		);
		const usagePlan = mustGet(evaluation.usagePlan, "usagePlan");
		// @org-scope-exempt: post-lock 主键更新（applyInTransaction 已持组织账本锁并经 loadTarget+orgWhere 校验归属）
		await tx.usageRecord.update({
			where: { id: effective.id },
			data: {
				amount: effective.amount,
				usedAt: effective.usedAt,
				version: { increment: 1 },
			},
		});
		if (delta.amountDelta.eq(0) && delta.usedAmountDelta.eq(0)) {
			return null;
		}
		const allocation = await tx.planAllocation.update({
			where: { planId: usagePlan.planId },
			data: {
				amount: { increment: delta.amountDelta },
				usedAmount: { increment: delta.usedAmountDelta },
			},
			select: { amount: true, usedAmount: true },
		});
		// 用实际写入行和本次增量还原写前值，两个审计记录共用这组金额。
		return {
			planId: usagePlan.planId,
			currencyCode: effective.currencyCode,
			amountBefore: allocation.amount.sub(delta.amountDelta).toFixed(4),
			amountAfter: allocation.amount.toFixed(4),
			usedBefore: allocation.usedAmount.sub(delta.usedAmountDelta).toFixed(4),
			usedAfter: allocation.usedAmount.toFixed(4),
			supplement: delta.supplement.toFixed(4),
		};
	}

	/** 补分配留痕：PlanChangeLog 带所属组织与实际操作者（随父 Plan 隔离，LEDGER-04.4） */
	private async recordUsageSupplement(
		tx: Prisma.TransactionClient,
		actor: Pick<ActorContext, "organizationId" | "userId">,
		correction: { id: string; createdAt: Date },
		evaluation: Evaluation,
		allocation: UsageAllocationAudit,
	): Promise<void> {
		const before = mustGet(evaluation.beforeUsage, "beforeUsage");
		const after = mustGet(evaluation.afterUsage, "afterUsage");
		const planTargetAmount = mustGet(
			evaluation.usagePlan,
			"usagePlan",
		).planTargetAmount;
		const link = {
			reason: "USAGE_CORRECTION_SUPPLEMENT",
			usageId: before.id,
			correctionId: correction.id,
		};
		await tx.planChangeLog.create({
			data: {
				planId: allocation.planId,
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				changeType: "ALLOCATION_ADJUSTED",
				beforeTarget: planTargetAmount,
				afterTarget: planTargetAmount,
				beforeAlloc: allocation.amountBefore,
				afterAlloc: allocation.amountAfter,
				createdAt: correction.createdAt,
				beforeSnapshot: {
					...link,
					amountBefore: before.amount.toFixed(4),
					versionBefore: before.version,
					usedBefore: allocation.usedBefore,
				},
				afterSnapshot: {
					...link,
					amountAfter: after.amount.toFixed(4),
					versionAfter: after.version,
					usedAfter: allocation.usedAfter,
					supplement: allocation.supplement,
				},
			},
		});
	}

	/** 初始持仓更正落库：金额/币种与报价三元组更新（无 version 列，乐观校验已在行锁后完成） */
	private async persistHoldingCorrection(
		tx: Prisma.TransactionClient,
		evaluation: Evaluation,
	): Promise<void> {
		const effective = mustGet(evaluation.afterHolding, "afterHolding");
		// @org-scope-exempt: post-lock 主键更新（applyInTransaction 已持组织账本锁并经 loadTarget+orgWhere 校验归属）
		await tx.initialHolding.update({
			where: { id: effective.id },
			data: {
				currencyCode: effective.currencyCode,
				amount: effective.amount,
				rate: effective.rate,
				rawRate: effective.rawRate,
				rateSource: effective.rateSource,
				rateObservedAt: effective.rateObservedAt,
				cost: effective.cost,
			},
		});
	}

	/**
	 * 成本批次重建（方案 §5.4 ⑤；W24 组织化）：先删该币种组织作用域内的
	 * UsageLotAllocation（裸外键先删引用）与 CostLot，再按重放结果重建；分摊明细按
	 * sourceId → 新批次 id 映射落库。
	 * - 删除范围 = orgWhere(actor)：组织内全部成员的批次，绝不按请求者 userId 删
	 *   （否则其他成员的批次留下、重建后成重复批次）；
	 * - 新批次只带 organizationId——批次归属由来源记录（Transaction / InitialHolding 的
	 *   createdById）承担，更正者只出现在 Correction 与审计里，不把别人的批次改挂到自己名下；
	 * - 账户行锁保护下与余额更新同事务，杜绝半更新；千级事件毫秒级完成（方案 §2）。
	 */
	private async rebuildLots(
		tx: Prisma.TransactionClient,
		actor: ReadScope,
		currencyCode: string,
		replay: ReplayResult,
	): Promise<void> {
		const owner = orgWhere(actor);
		const oldLots = await tx.costLot.findMany({
			where: { currencyCode, ...owner },
			select: { id: true },
		});
		// 分摊明细两头的裸外键都按本币种作用域清：批次侧兜住正常路径，使用侧兜住
		// 「批次已被删、明细成孤儿」的异常存量（usage_lot_allocations 不留孤儿行）。
		// 重放覆盖本币种作用域内全部使用记录，其 id 集合即使用侧清理范围
		const usageIds = [...replay.usageCosts.keys()];
		const oldLotIds = oldLots.map((lot) => lot.id);
		if (oldLotIds.length > 0 || usageIds.length > 0) {
			await tx.usageLotAllocation.deleteMany({
				where: {
					OR: [
						...(oldLotIds.length > 0 ? [{ lotId: { in: oldLotIds } }] : []),
						...(usageIds.length > 0 ? [{ usageId: { in: usageIds } }] : []),
					],
				},
			});
		}
		await tx.costLot.deleteMany({ where: { currencyCode, ...owner } });

		const lotIdBySource = new Map<string, string>();
		for (const lot of replay.lots) {
			const created = await tx.costLot.create({
				data: {
					organizationId: actor.organizationId,
					currencyCode,
					sourceType: lot.sourceType,
					sourceId: lot.sourceId,
					quantity: lot.quantity,
					remainingQty: lot.remainingQty,
					unitCost: lot.unitCost,
					totalCost: lot.totalCost,
					acquiredAt: lot.acquiredAt,
				},
			});
			lotIdBySource.set(lot.sourceId, created.id);
		}
		for (const allocation of replay.usageAllocations) {
			const lotId = lotIdBySource.get(allocation.lotSourceId);
			if (!lotId) {
				// 防御：重放产出与批次重建同源同序，正常不可达；触发即数据 bug，整体回滚
				throw new Error(
					`批次重建映射缺失：usage=${allocation.usageId} lot=${allocation.lotSourceId}`,
				);
			}
			await tx.usageLotAllocation.create({
				data: {
					usageId: allocation.usageId,
					lotId,
					quantity: allocation.quantity,
					cost: allocation.cost,
				},
			});
		}
	}

	/**
	 * FAILED 尝试留痕（业务事务已回滚，事务外独立写入，尽力而为；方案 §5.4：失败也保存
	 * 尝试记录）。留痕带所属组织与实际操作者（organizationId / actorUserId），并另写一条
	 * result=FAILED 的 correction.apply 独立审计——
	 * 「谁在什么时候尝试了哪次更正、为何被拒」必须有迹可循。两者任一失败只记日志，
	 * 不影响 409 错误响应（调用方 catch）。
	 */
	private async recordFailedCorrection(
		actor: ActorContext,
		dto: CorrectionRequestDto,
		beforeTarget: LoadedTarget,
		error: HttpException,
		requestId: string | null,
	): Promise<void> {
		const payload = error.getResponse() as {
			code?: string;
			message?: string;
			details?: CorrectionBlockerDetailDto[];
		};
		const failReason = `[${payload.code ?? "UNKNOWN"}] ${payload.message ?? "复核未通过"}`;
		const target =
			beforeTarget.type === "TRANSACTION"
				? this.serializeTransaction(
						this.toEffectiveTransaction(beforeTarget.transaction),
					)
				: beforeTarget.type === "USAGE"
					? this.serializeUsage(this.toEffectiveUsage(beforeTarget.usage))
					: this.serializeHolding(this.toEffectiveHolding(beforeTarget.holding));
		const correction = await this.prisma.correction.create({
			data: {
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				targetType: dto.targetType,
				targetId: dto.targetId,
				reason: dto.reason,
				beforeSnapshot: {
					target,
					changes: dto.changes,
					baseVersion: dto.baseVersion ?? null,
					baseUpdatedAt: dto.baseUpdatedAt ?? null,
					blockers: payload.details ?? [],
				} as unknown as Prisma.InputJsonValue,
				afterSnapshot: {},
				status: "FAILED",
				failReason,
			},
			select: { id: true },
		});
		await this.auditService.recordStandalone({
			organizationId: actor.organizationId,
			actorUserId: actor.userId,
			actorType: "USER",
			action: "correction.apply",
			targetType: auditTargetType(dto.targetType),
			targetId: dto.targetId,
			result: "FAILED",
			requestId: requestId ?? null,
			detail: {
				correctionId: correction.id,
				// 键名不能叫 code：审计脱敏器把精确名 code 的键当验证码本体整体抹掉
				failCode: payload.code ?? "UNKNOWN",
				baseVersion: dto.baseVersion ?? null,
				blockers: payload.details ?? [],
			},
		});
	}

	// ──────────────────────── 目标加载 / 校验 / 上下文 ────────────────────────

	/**
	 * 目标加载（preview / apply / list / target 统一口径，W24）：按组织作用域
	 * orgWhere(actor) 查找——组织行跨成员共享；跨组织与不存在一律 404（不泄露存在性）。
	 */
	private async loadTarget(
		db: CorrectionDb,
		scope: ReadScope,
		targetType: CorrectionTargetTypeValue,
		targetId: string,
	): Promise<LoadedTarget> {
		const owner = orgWhere(scope);
		if (targetType === "TRANSACTION") {
			const transaction = await db.transaction.findFirst({
				where: { id: targetId, ...owner },
			});
			if (!transaction) throw new CorrectionTargetNotFoundException();
			return { type: "TRANSACTION", transaction };
		}
		if (targetType === "USAGE") {
			const usage = await db.usageRecord.findFirst({
				where: { id: targetId, ...owner },
			});
			if (!usage) throw new CorrectionTargetNotFoundException();
			return { type: "USAGE", usage };
		}
		const holding = await db.initialHolding.findFirst({
			where: { id: targetId, ...owner },
		});
		if (!holding) throw new CorrectionTargetNotFoundException();
		return { type: "INITIAL_HOLDING", holding };
	}

	/** 乐观校验（方案假设 3）：TRANSACTION/USAGE 比对 baseVersion（UsageRecord 有 version 列）；INITIAL_HOLDING 比对 updatedAt（无版本列） */
	private assertOptimisticMatch(
		dto: CorrectionRequestDto,
		target: LoadedTarget,
	): void {
		if (target.type === "TRANSACTION" || target.type === "USAGE") {
			if (dto.baseVersion === undefined || dto.baseVersion === null) {
				throw new CorrectionInvalidParamsException(
					"TRANSACTION/USAGE 更正必须提供 baseVersion（乐观校验基准）",
				);
			}
			const version =
				target.type === "TRANSACTION"
					? target.transaction.version
					: target.usage.version;
			if (version !== dto.baseVersion) {
				throw new CorrectionTargetChangedException();
			}
			return;
		}
		if (!dto.baseUpdatedAt) {
			throw new CorrectionInvalidParamsException(
				"INITIAL_HOLDING 更正必须提供 baseUpdatedAt（乐观校验基准）",
			);
		}
		const expected = new Date(dto.baseUpdatedAt);
		if (
			Number.isNaN(expected.getTime()) ||
			target.holding.updatedAt.getTime() !== expected.getTime()
		) {
			throw new CorrectionTargetChangedException();
		}
	}

	/** 受影响币种解析（行锁与上下文加载范围；改币种 = 旧 + 新两个币种全量重放） */
	private resolveAffectedCurrencies(
		_targetType: CorrectionTargetTypeValue,
		target: LoadedTarget,
		changes: CorrectionRequestDto["changes"],
	): string[] {
		if (target.type === "USAGE") {
			// 使用更正无币种变更维度：恒为使用记录自身的币种
			return [target.usage.currencyCode];
		}
		const original =
			target.type === "TRANSACTION"
				? target.transaction.currencyCode
				: target.holding.currencyCode;
		const next =
			typeof changes.currencyCode === "string"
				? changes.currencyCode.trim().toUpperCase()
				: original;
		return next !== original ? [original, next] : [original];
	}

	/** 目标类型白名单放行（parseTargetType 已限定三态；MVP-F0-3 起 USAGE 闭环放行） */
	private assertSupportedTargetType(targetType: CorrectionTargetTypeValue): void {
		void targetType;
	}

	private parseTargetType(raw: string): CorrectionTargetTypeValue {
		if (raw === "TRANSACTION" || raw === "USAGE" || raw === "INITIAL_HOLDING") {
			return raw;
		}
		throw new CorrectionInvalidParamsException(
			"targetType 必须是 TRANSACTION / USAGE / INITIAL_HOLDING 之一",
		);
	}

	/**
	 * 组织内单币种（或多币种）账本上下文加载（该币种全部事件来源行 + 计划分配现状）。
	 * PlanAllocation 与 Plan 裸外键：先查该币种计划，再按 planId 批量取分配。
	 * 归属（W24，preview 与 apply 同口径）：初始持仓 / 交易 / 使用 / 计划一律按
	 * orgWhere(actor) 读取——组织全体成员的账本行与计划占用，严禁按请求者 userId 过滤
	 * （否则成员更正时按自己的空账本重放）。
	 */
	private async loadLedgerContexts(
		db: CorrectionDb,
		scope: ReadScope,
		currencies: string[],
	): Promise<Map<string, CurrencyLedgerContext>> {
		const currencyList = [...new Set(currencies)];
		const owner = orgWhere(scope);
		const [initialHoldings, transactions, usageRecords, plans] = await Promise.all([
			db.initialHolding.findMany({
				where: { currencyCode: { in: currencyList }, ...owner },
			}),
			db.transaction.findMany({
				where: { currencyCode: { in: currencyList }, ...owner },
			}),
			db.usageRecord.findMany({
				where: { currencyCode: { in: currencyList }, ...owner },
			}),
			db.plan.findMany({
				where: { targetCurrency: { in: currencyList }, ...owner },
				select: {
					id: true,
					targetCurrency: true,
					status: true,
					targetAmount: true,
				},
			}),
		]);
		const allocations =
			plans.length > 0
				? await db.planAllocation.findMany({
						where: { planId: { in: plans.map((plan) => plan.id) } },
					})
				: [];
		const planById = new Map(plans.map((plan) => [plan.id, plan]));
		const context = new Map<string, CurrencyLedgerContext>();
		for (const currencyCode of currencyList) {
			context.set(currencyCode, {
				initialHoldings: initialHoldings.filter(
					(holding) => holding.currencyCode === currencyCode,
				),
				transactions: transactions.filter(
					(transaction) => transaction.currencyCode === currencyCode,
				),
				usageRecords: usageRecords.filter(
					(usage) => usage.currencyCode === currencyCode,
				),
				planAllocations: new Map(),
			});
		}
		for (const allocation of allocations) {
			const plan = planById.get(allocation.planId);
			const ledger = plan ? context.get(plan.targetCurrency) : undefined;
			if (!plan || !ledger) continue;
			ledger.planAllocations.set(allocation.planId, {
				planId: allocation.planId,
				amount: allocation.amount,
				usedAmount: allocation.usedAmount,
				planStatus: plan.status,
				targetAmount: plan.targetAmount,
			});
		}
		return context;
	}

	// ──────────────────────── 序列化 / diff / 快照 ────────────────────────

	/** 序列化：金额 toFixed(4)、汇率 toFixed(8)、时间 ISO；手续费保留 null 语义（≠ 0） */
	private serializeTransaction(
		transaction: EffectiveTransaction,
	): Record<string, unknown> {
		return {
			id: transaction.id,
			targetType: "TRANSACTION",
			currencyCode: transaction.currencyCode,
			quantity: transaction.quantity.toFixed(4),
			principalAmount: transaction.principalAmount.toFixed(4),
			feeAmount:
				transaction.feeAmount === null ? null : transaction.feeAmount.toFixed(4),
			totalCost:
				transaction.feeAmount === null
					? null
					: transaction.principalAmount.add(transaction.feeAmount).toFixed(4),
			feeKnown: transaction.feeAmount !== null,
			exchangeRate: transaction.exchangeRate.toFixed(8),
			planId: transaction.planId,
			transactedAt: transaction.transactedAt.toISOString(),
			version: transaction.version,
			createdAt: transaction.createdAt.toISOString(),
		};
	}

	private serializeHolding(holding: EffectiveHolding): Record<string, unknown> {
		return {
			id: holding.id,
			targetType: "INITIAL_HOLDING",
			currencyCode: holding.currencyCode,
			amount: holding.amount.toFixed(4),
			rate: holding.rate.toFixed(10),
			rawRate: holding.rawRate.toFixed(10),
			rateSource: holding.rateSource,
			rateObservedAt: holding.rateObservedAt.toISOString(),
			cost: holding.cost.toFixed(4),
			confirmedAt: holding.confirmedAt.toISOString(),
			updatedAt: holding.updatedAt.toISOString(),
		};
	}

	private toEffectiveTransaction(
		transaction: TransactionModel,
	): EffectiveTransaction {
		return {
			id: transaction.id,
			currencyCode: transaction.currencyCode,
			quantity: transaction.quantity,
			principalAmount: transaction.principalAmount,
			feeAmount: transaction.feeAmount,
			exchangeRate: transaction.exchangeRate,
			planId: transaction.planId,
			transactedAt: transaction.transactedAt,
			version: transaction.version,
			createdAt: transaction.createdAt,
		};
	}

	private toEffectiveHolding(holding: InitialHolding): EffectiveHolding {
		return {
			id: holding.id,
			currencyCode: holding.currencyCode,
			amount: holding.amount,
			rate: holding.rate,
			rawRate: holding.rawRate,
			rateSource: holding.rateSource,
			rateObservedAt: holding.rateObservedAt,
			cost: holding.cost,
			confirmedAt: holding.confirmedAt,
			createdAt: holding.createdAt,
			updatedAt: holding.updatedAt,
		};
	}

	private toEffectiveUsage(usage: UsageRecord): EffectiveUsage {
		return {
			id: usage.id,
			planId: usage.planId,
			currencyCode: usage.currencyCode,
			amount: usage.amount,
			usedAt: usage.usedAt,
			remark: usage.remark,
			version: usage.version,
			createdAt: usage.createdAt,
			updatedAt: usage.updatedAt,
		};
	}

	/** 使用记录序列化（快照/预览；金额 4 位、时间 ISO；remark 保留 null 语义） */
	private serializeUsage(usage: EffectiveUsage): Record<string, unknown> {
		return {
			id: usage.id,
			targetType: "USAGE",
			planId: usage.planId,
			currencyCode: usage.currencyCode,
			amount: usage.amount.toFixed(4),
			usedAt: usage.usedAt.toISOString(),
			remark: usage.remark,
			version: usage.version,
			createdAt: usage.createdAt.toISOString(),
			updatedAt: usage.updatedAt.toISOString(),
		};
	}

	/** 使用 diff（金额/日期变化；remark 本期不在白名单，不参与 diff） */
	private usageDiff(
		original: EffectiveUsage,
		effective: EffectiveUsage,
	): Evaluation["diff"] {
		const diff: Evaluation["diff"] = [];
		if (!effective.amount.eq(original.amount)) {
			diff.push(
				fieldDiff(
					"amount",
					original.amount.toFixed(4),
					effective.amount.toFixed(4),
				),
			);
		}
		if (effective.usedAt.getTime() !== original.usedAt.getTime()) {
			diff.push(
				fieldDiff(
					"usedAt",
					original.usedAt.toISOString(),
					effective.usedAt.toISOString(),
				),
			);
		}
		return diff;
	}

	/** 交易 diff（仅列变化字段；手续费未知 → 值写「未知 → 20.0000」，绝不写 0 → 20） */
	private transactionDiff(
		original: EffectiveTransaction,
		effective: EffectiveTransaction,
		changes: ParsedCorrectionChanges,
	): Evaluation["diff"] {
		const diff: Evaluation["diff"] = [];
		if (effective.currencyCode !== original.currencyCode) {
			diff.push(
				fieldDiff("currencyCode", original.currencyCode, effective.currencyCode),
			);
		}
		if (!effective.principalAmount.eq(original.principalAmount)) {
			diff.push(
				fieldDiff(
					"principalAmount",
					original.principalAmount.toFixed(4),
					effective.principalAmount.toFixed(4),
				),
			);
		}
		if (!effective.quantity.eq(original.quantity)) {
			diff.push(
				fieldDiff(
					"quantity",
					original.quantity.toFixed(4),
					effective.quantity.toFixed(4),
				),
			);
		}
		if (changes.feeProvided) {
			const beforeFee =
				original.feeAmount === null ? null : original.feeAmount.toFixed(4);
			const afterFee =
				effective.feeAmount === null ? null : effective.feeAmount.toFixed(4);
			if (beforeFee !== afterFee) {
				diff.push(feeFieldDiff(beforeFee, afterFee));
				// 总成本派生对比（需求场景 1「成本 7,800→7,820」；费用未知时为「不完整」，
				// 绝不当 0 计算——null 显示语义由 feeFieldDiff 各自承载）
				const beforeTotal =
					original.feeAmount === null
						? null
						: original.principalAmount.add(original.feeAmount).toFixed(4);
				const afterTotal =
					effective.feeAmount === null
						? null
						: effective.principalAmount.add(effective.feeAmount).toFixed(4);
				diff.push({
					field: "totalCost",
					before: beforeTotal,
					after: afterTotal,
					display: `${beforeTotal ?? "不完整"} → ${afterTotal ?? "不完整"}`,
				});
			}
		}
		if (effective.transactedAt.getTime() !== original.transactedAt.getTime()) {
			diff.push(
				fieldDiff(
					"transactedAt",
					displayDate(original.transactedAt),
					displayDate(effective.transactedAt),
				),
			);
		}
		if (effective.planId !== original.planId) {
			diff.push(fieldDiff("planId", original.planId, effective.planId));
		}
		return diff;
	}

	/** 初始持仓 diff：金额/币种为用户变更；rate/cost 为派生变化（沿用原报价或新取报价重算） */
	private holdingDiff(
		original: EffectiveHolding,
		effective: EffectiveHolding,
	): Evaluation["diff"] {
		const diff: Evaluation["diff"] = [];
		if (effective.currencyCode !== original.currencyCode) {
			diff.push(
				fieldDiff("currencyCode", original.currencyCode, effective.currencyCode),
			);
		}
		if (!effective.amount.eq(original.amount)) {
			diff.push(
				fieldDiff(
					"amount",
					original.amount.toFixed(4),
					effective.amount.toFixed(4),
				),
			);
		}
		if (!effective.rate.eq(original.rate)) {
			diff.push(
				fieldDiff("rate", original.rate.toFixed(10), effective.rate.toFixed(10)),
			);
		}
		if (!effective.cost.eq(original.cost)) {
			diff.push(
				fieldDiff("cost", original.cost.toFixed(4), effective.cost.toFixed(4)),
			);
		}
		return diff;
	}

	/** Correction 快照（方案 §5.5）：修改前后完整字段 + 影响面摘要 + 操作时间 */
	private buildSnapshots(
		dto: CorrectionRequestDto,
		evaluation: Evaluation,
		targetVersion: number | null,
		usageAllocationAudit: UsageAllocationAudit | null,
	): { before: Prisma.InputJsonValue; after: Prisma.InputJsonValue } {
		const impactsSummary = {
			balances: evaluation.balances.map((balance) => ({
				currencyCode: balance.currencyCode,
				before: balance.before.toFixed(4),
				after: balance.after.toFixed(4),
			})),
			...(usageAllocationAudit && { allocations: [usageAllocationAudit] }),
			costs: [...evaluation.costsAfter.entries()].map(([usageId, costAfter]) => ({
				usageId,
				costBefore: serializeCostOrNull(evaluation.costsBefore.get(usageId)),
				costAfter: serializeCostOrNull(costAfter),
			})),
			warnings: evaluation.warnings,
		};
		return {
			before: {
				target: evaluation.before,
				changes: dto.changes,
				baseVersion: dto.baseVersion ?? null,
				baseUpdatedAt: dto.baseUpdatedAt ?? null,
				impacts: impactsSummary,
			} as unknown as Prisma.InputJsonValue,
			after: {
				target: evaluation.after,
				versionAfter: targetVersion,
				planIdDetached: evaluation.planIdDetached,
				impacts: impactsSummary,
				appliedAt: new Date().toISOString(),
			} as unknown as Prisma.InputJsonValue,
		};
	}

	/** V1/V2/V3 失败集合 → HTTP 异常（409 + 合并 message + 合并 details；FAILED 留痕由 apply 统一处理） */
	private failuresToException(failures: ReplayFailure[]): HttpException {
		const first = failures[0];
		return new HttpException(
			{
				code: first.code,
				message: failures.map((failure) => failure.message).join("；"),
				details: failures.flatMap((failure) => failure.details),
			},
			HttpStatus.CONFLICT,
		);
	}

	/** 是否业务复核类拒绝（V1~V4）：404 / TARGET_CHANGED / 参数类不留 FAILED 尝试 */
	private isReplayRejection(error: HttpException): boolean {
		const code = (error.getResponse() as { code?: string }).code;
		return (
			code === "CORRECTION_INSUFFICIENT_FUNDS" ||
			code === "CORRECTION_ALLOCATION_CONFLICT" ||
			code === "CORRECTION_HISTORICAL_SHORTFALL" ||
			code === "CORRECTION_NOT_ALLOWED"
		);
	}

	/**
	 * 锁内复验失败后的 DENIED 审计（事务已回滚，事务外独立写、尽力而为）：
	 * 记录锁内重读到的**最新**角色与 requestId，不沿用 Guard 放行时的旧角色。
	 */
	private async recordDeniedAudit(
		actor: ActorContext,
		role: OrganizationRole,
		requestId: string | null,
	): Promise<void> {
		await recordDeniedAuditBestEffort(this.auditService, this.logger, {
			actor,
			role,
			required: "correction.apply",
			requestId,
		});
	}
}

// ────────────────────────── 模块级辅助（无状态）──────────────────────────

/** 用提交同一份调整量展示计划变化与来源。 */
function serializeAllocationImpacts({
	afterUsage,
	usageAllocationDelta: delta,
	usagePlan,
}: Evaluation): CorrectionAllocationImpactDto[] {
	if (!afterUsage || !delta || !usagePlan || delta.usedAmountDelta.isZero()) {
		return [];
	}

	const { planId, allocationAmount, allocationUsedAmount } = usagePlan;
	const amountAfter = allocationAmount.add(delta.amountDelta);
	const usedAfter = allocationUsedAmount.add(delta.usedAmountDelta);
	const usedFromRemaining = delta.usedAmountDelta.isPositive()
		? delta.usedAmountDelta.sub(delta.supplement).toFixed(4)
		: "0.0000";

	return [
		{
			planId,
			currencyCode: afterUsage.currencyCode,
			amountBefore: allocationAmount.toFixed(4),
			amountAfter: amountAfter.toFixed(4),
			usedBefore: allocationUsedAmount.toFixed(4),
			usedAfter: usedAfter.toFixed(4),
			remainingBefore: allocationAmount.sub(allocationUsedAmount).toFixed(4),
			remainingAfter: amountAfter.sub(usedAfter).toFixed(4),
			fromPlan: usedFromRemaining,
			supplement: delta.supplement.toFixed(4),
			usedFromRemaining,
			// 剩余分配已反映在计划内，未分配余额只承担分配总额的反向变化。
			unallocatedDelta: delta.amountDelta.negated().toFixed(4),
		},
	];
}

/** 汇总重放结果中每笔使用成本（usageId → cost；无使用的币种自然为空 Map） */
function collectUsageCosts(
	replays: Map<string, ReplayResult>,
): Map<string, Prisma.Decimal | null> {
	const costs = new Map<string, Prisma.Decimal | null>();
	for (const replay of replays.values()) {
		for (const [usageId, cost] of replay.usageCosts) {
			costs.set(usageId, cost);
		}
	}
	return costs;
}

/** 费用未完整 warnings：变更后任一币种存在 fee=null 批次即提示（成本说明继续保留） */
function buildFeeWarnings(replays: Map<string, ReplayResult>): string[] {
	if ([...replays.values()].some((replay) => replay.hasUnknownFeeLot)) {
		return [
			"存在手续费未明确的买入记录，相关成本按已录金额计算，成本说明继续保留",
		];
	}
	return [];
}

function serializeCostOrNull(
	cost: Prisma.Decimal | null | undefined,
): string | null {
	return cost === null || cost === undefined ? null : cost.toFixed(4);
}

/** diff 字段项构造（display：金额 4 位、日期 yyyy-MM-dd、其余原样） */
function fieldDiff(
	field: string,
	before: string | null,
	after: string | null,
): { field: string; before: string | null; after: string | null; display: string } {
	return {
		field,
		before,
		after,
		display: `${before ?? "未知"} → ${after ?? "未知"}`,
	};
}

/** 手续费 diff：null（未知）语义显式化（验收场景 1：写「未知 → 20」，绝不写「0 → 20」） */
function feeFieldDiff(
	before: string | null,
	after: string | null,
): { field: string; before: string | null; after: string | null; display: string } {
	return {
		field: "feeAmount",
		before,
		after,
		display: `${before ?? "未知"} → ${after ?? "未知"}`,
	};
}

/** ISO 时间 → yyyy-MM-dd（展示口径与前端一致，直接取日期部分） */
function displayDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** 页码解析（缺省 1；非法/小于 1 → 400） */
function parsePage(raw: string | undefined): number {
	if (raw === undefined || raw === "") return 1;
	const page = Number(raw);
	if (!Number.isInteger(page) || page < 1) {
		throw new CorrectionInvalidParamsException("page 必须是从 1 起的整数");
	}
	return page;
}
