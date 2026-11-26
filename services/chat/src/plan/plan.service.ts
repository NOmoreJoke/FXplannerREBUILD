import {
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
	Logger,
} from "@nestjs/common";
import { getCurrency } from "@fxplanner-new/money";
import type { Plan, PlanAllocation } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
	lockOrgLedgerAccounts,
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
	Permission,
} from "../authorization/authorization.types";
import {
	assertParentChildSameOrg,
	orgWhere,
	type ReadScope,
} from "../authorization/organization-scope";
import { can } from "../authorization/permission-policy";
import { lockOrganizationForActor } from "../organization/default-organization";
import { resolveOrganizationPreferences } from "../organization/organization-preferences";
import type {
	AdjustPreviewDto,
	AdjustPreviewResultDto,
	AdjustPlanDto,
	AllocatableCapsDto,
	CreatePlanDto,
	PlanAdjustSnapshotDto,
	PlanChangeLogDto,
	PlanDetailDto,
	PlanDto,
	PlanInstallmentDto,
	PlanListItemDto,
	SchedulePreviewDto,
	SchedulePreviewResultDto,
} from "./dto/plan.dto";
import {
	buildInstallments,
	computeLatestPrepDate,
	defaultIsWorkday,
	PACE_PREFERENCES,
	PREP_LEAD_DAYS_MAX,
	PREP_LEAD_DAYS_MIN,
	ScheduleBuildError,
	type BuildInstallmentsInput,
	type Installment,
	type PacePreference,
} from "./schedule-builder";
import {
	checkCompleteReady,
	computeAdjustPreview,
	computeCaps as computeCapsPure,
	computeDerived,
	computeRemainingAllocation,
	PlanCalcError,
	type AdjustPreviewChange,
	type AdjustPreviewContext,
	type AdjustPreviewPlanState,
	type AdjustPreviewResult,
	type AdjustPreviewStateSnapshot,
	type ComputeAdjustPreviewInput,
} from "./plan-calculator";
import { computeFundStatus } from "../usage/usage-calculator";

/**
 * 模块错误（错误响应统一 { code, message }，风格与 onboarding 模块一致）。
 * 契约见技术方案 §4/§5：
 * - INVALID_PLAN_PARAMS（400）：币种不在 15 币种 / 金额非法或超限 / 用途日期不晚于今天 /
 *   prepLeadDays 不在 1~30 / 节奏枚举非法 / 开始准备日早于今天
 * - NO_AVAILABLE_DATES（400）：用途日期前没有任何可安排工作日（R5 退化 0 天）
 * - AMOUNT_TOO_SMALL（400）：扣除剩余分配后金额过小，某批取整后为 0（R6）
 * - INSUFFICIENT_ALLOCATABLE_BALANCE（409）：事务内重检分配超上限，响应附 caps 现值
 */
export class PlanInvalidParamsException extends HttpException {
	constructor(message: string) {
		super({ code: "INVALID_PLAN_PARAMS", message }, HttpStatus.BAD_REQUEST);
	}
}

export class PlanNoAvailableDatesException extends HttpException {
	constructor(message: string) {
		super({ code: "NO_AVAILABLE_DATES", message }, HttpStatus.BAD_REQUEST);
	}
}

export class PlanAmountTooSmallException extends HttpException {
	constructor(message: string) {
		super({ code: "AMOUNT_TOO_SMALL", message }, HttpStatus.BAD_REQUEST);
	}
}

export class PlanInsufficientBalanceException extends HttpException {
	constructor(caps: AllocatableCapsDto) {
		super(
			{
				code: "INSUFFICIENT_ALLOCATABLE_BALANCE",
				message: "可分配余额不足，请调低本次分配金额",
				data: caps,
			},
			HttpStatus.CONFLICT,
		);
	}
}

/** 计划不存在或不属于当前组织（§4.4.2：跨组织按 404 处理，防枚举） */
export class PlanNotFoundException extends HttpException {
	constructor() {
		super(
			{ code: "PLAN_NOT_FOUND", message: "计划不存在或已删除" },
			HttpStatus.NOT_FOUND,
		);
	}
}

/** 乐观锁失配：计划已被其他修改更新（§4.4，前端据此引导重新预览） */
export class PlanStateConflictException extends HttpException {
	constructor() {
		super(
			{
				code: "PLAN_STATE_CHANGED",
				message: "计划已被其他修改更新，请重新预览后提交",
			},
			HttpStatus.CONFLICT,
		);
	}
}

/** 非法状态流转（完成/取消仅限 ACTIVE；提交时条件更新行数 = 0） */
export class PlanInvalidTransitionException extends HttpException {
	constructor(message: string) {
		super(
			{ code: "PLAN_INVALID_TRANSITION", message },
			HttpStatus.CONFLICT,
		);
	}
}

/** caps 计算所需的最小数据面（PrismaService 与事务客户端均满足） */
type CapsDb = Pick<
	Prisma.TransactionClient,
	"account" | "plan" | "planAllocation" | "$queryRaw"
>;

/** caps 的内存形态（Decimal），出口序列化为固定 4 位小数字符串 */
interface AllocatableCaps {
	allocatableBalance: Prisma.Decimal;
	maxAllocatable: Prisma.Decimal;
}

/** 列表服务端兑底条数（§4.1：个人工具无分页，limit 100 防御） */
const PLAN_LIST_LIMIT = 100;
const AGENT_RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

/** 解析后的排期入参（全部规范化：币种大写、日期 UTC 0 点、金额 Decimal） */
interface ParsedPlanParams {
	targetCurrency: string;
	decimalPlaces: 0 | 2;
	targetAmount: Prisma.Decimal;
	expectUseDate: Date;
	prepLeadDays: number;
	pacePreference: PacePreference;
	startDate: Date | null;
}

@Injectable()
export class PlanService {
	private readonly logger = new Logger(PlanService.name);

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(AuditService) private readonly auditService: AuditService,
	) {}

	/**
	 * 排期预览（POST /api/plans/schedule-preview，方案 §5.1）：
	 * 参数校验 → caps → buildInstallments（R1~R6）。只读，不落库。
	 * allocatedAmount（计入已有外币）与 create 同口径参与分批总额
	 * （分批总额 = 目标 − 已使用 − allocatedAmount），保证预览与落库排期一致；
	 * 超余额上限不在此拦（caps 随响应返回由前端预检，create 事务内权威重检）。
	 *
	 * 读作用域（评审 R2-I02）：本位币取组织偏好，caps 按当前组织的账户与计划计算
	 * ——与业务 GET 同口径。此前按请求者 userId 直查：受邀成员命中自己的空账本
	 * （caps 恒 0），而携带其他组织头时又会带出本人别的组织的余额（跨组织泄露）。
	 */
	async preview(
		scope: ReadScope,
		dto: SchedulePreviewDto,
	): Promise<SchedulePreviewResultDto> {
		// 目标币种 ≠ 本位币（组织偏好：OrganizationSettings 优先，默认组织兼容回落到
		// 所有者个人设置；preview 不拦未建账，缺偏好跳过比对）
		const preferences = await resolveOrganizationPreferences(
			this.prisma,
			scope.organizationId,
		);
		const params = this.parsePlanParams(
			dto,
			preferences?.baseCurrency ?? null,
		);
		const allocatedAmount =
			dto.allocatedAmount !== undefined && dto.allocatedAmount !== null
				? this.parseNonNegativeAmount(dto.allocatedAmount, "分配金额")
				: new Prisma.Decimal(0);
		const latestPrepDate = computeLatestPrepDate(
			params.expectUseDate,
			params.prepLeadDays,
		);
		const installments = this.buildInstallmentsOrThrow({
			targetAmount: params.targetAmount,
			allocatedAmount,
			decimalPlaces: params.decimalPlaces,
			startDate: params.startDate,
			latestPrepDate,
			pacePreference: params.pacePreference,
		});
		const caps = await this.computeCaps(
			this.prisma,
			scope,
			params.targetCurrency,
			params.targetAmount,
		);
		return {
			latestPrepDate: latestPrepDate.toISOString(),
			installments: installments.map((installment) =>
				this.toInstallmentDto(installment),
			),
			caps: this.toCapsDto(caps),
		};
	}

	/**
	 * 创建计划（POST /api/plans，方案 §5.2 / ToB R1 W23）：全程交互式事务——
	 * ① lockOrganizationForActor 重读最新角色并复验 plan.create（锁等降权 → 403 + DENIED 审计）
	 * ② resolveOrganizationPreferences 解析组织建账态（409）与本位币
	 * ③ 锁组织账本账户 lockOrgLedgerAccounts 后重检 caps（并发安全权威防线）
	 * ④ 插入 Plan（organizationId + createdById）、PlanAllocation、PlanInstallment
	 * ⑤ 同事务写入 plan.create 审计日志；任一失败全部回滚。
	 */
	async create(
		actor: ActorContext,
		dto: CreatePlanDto,
		requestId: string | null = null,
	): Promise<PlanDto> {
		const params = this.parsePlanParams(dto, null);
		const allocatedAmount =
			dto.allocatedAmount !== undefined && dto.allocatedAmount !== null
				? this.parseNonNegativeAmount(dto.allocatedAmount, "分配金额")
				: new Prisma.Decimal(0);
		const agentRunId =
			dto.agentRunId === undefined || dto.agentRunId === null
				? null
				: dto.agentRunId.trim();
		if (agentRunId !== null && !AGENT_RUN_ID_PATTERN.test(agentRunId)) {
			throw new PlanInvalidParamsException("agentRunId 格式非法");
		}

		let deniedRole: OrganizationRole = actor.role;
		try {
			return await this.prisma.$transaction(async (tx) => {
				const latestRole = await lockOrganizationForActor(tx, actor);
				if (!can(latestRole, "plan.create")) {
					deniedRole = latestRole;
					throw new PermissionDeniedException();
				}

				const preferences = await resolveOrganizationPreferences(
					tx,
					actor.organizationId,
				);
				if (!preferences) {
					throw new OnboardingNotCompletedException(
						"尚未完成首次设置，请先前往 /onboarding 完成建账后再创建计划",
					);
				}
				if (params.targetCurrency === preferences.baseCurrency) {
					throw new PlanInvalidParamsException(
						`目标币种不能与本位币相同（本位币：${preferences.baseCurrency}）`,
					);
				}

				await lockOrgLedgerAccounts(
					tx,
					actor.organizationId,
					[params.targetCurrency],
				);
				// 事务内重检（READ COMMITTED 下读到其他事务已提交的最新余额/分配）
				const caps = await this.computeCaps(
					tx,
					actor,
					params.targetCurrency,
					params.targetAmount,
				);
				if (allocatedAmount.gt(caps.maxAllocatable)) {
					throw new PlanInsufficientBalanceException(this.toCapsDto(caps));
				}

				// latestPrepDate 服务端重算（前端值不参与落库）
				const latestPrepDate = computeLatestPrepDate(
					params.expectUseDate,
					params.prepLeadDays,
				);
				// 分批总额 = 目标金额 − 已使用（创建场景恒 0）− 剩余分配（= 本次 allocatedAmount）
				const installments = this.buildInstallmentsOrThrow({
					targetAmount: params.targetAmount,
					allocatedAmount,
					decimalPlaces: params.decimalPlaces,
					startDate: params.startDate,
					latestPrepDate,
					pacePreference: params.pacePreference,
				});

				const plan = await tx.plan.create({
					data: {
						organizationId: actor.organizationId,
						createdById: actor.userId,
						name: dto.name?.trim() ? dto.name.trim() : null,
						targetCurrency: params.targetCurrency,
						targetAmount: params.targetAmount,
						expectUseDate: params.expectUseDate,
						prepLeadDays: params.prepLeadDays,
						latestPrepDate,
						pacePreference: params.pacePreference,
						// M5 起落库（plan-management §3.3）：修改接口重建排期时 earliest 优先取本字段，
						// 禁止无基准重建导致批次日期漂移（存量计划为 NULL，重建回退「明天起首个工作日」）
						planStartDate: params.startDate,
					},
				});

				// amount = 0 也必须创建：planId @unique 保证计划与分配 1:1，
				// 读取方（home 等）按「存在分配行」计算 allocated/remaining，缺行只能兜底 0，
				// 统一落一行 amount=0 保持数据形态一致（usedAmount 恒 0，无余额占用）
				await tx.planAllocation.create({
					data: {
						planId: plan.id,
						amount: allocatedAmount,
						usedAmount: new Prisma.Decimal(0),
					},
				});

				// 固定 3/2/1 条排期（R2/R5）
				await tx.planInstallment.createMany({
					data: installments.map((installment) => ({
						planId: plan.id,
						seq: installment.seq,
						scheduledAt: installment.scheduledAt,
						amount: installment.amount,
					})),
				});

				await this.auditService.recordInTx(tx, {
					organizationId: actor.organizationId,
					actorUserId: actor.userId,
					actorType: "USER",
					action: "plan.create",
					targetType: "plan",
					targetId: plan.id,
					result: "SUCCESS",
					requestId: requestId ?? null,
					agentRunId,
					detail: {
						...(agentRunId ? { source: "agent_draft" } : {}),
						targetCurrency: plan.targetCurrency,
						targetAmount: plan.targetAmount.toFixed(4),
						allocatedAmount: allocatedAmount.toFixed(4),
						pacePreference: plan.pacePreference,
						prepLeadDays: plan.prepLeadDays,
					},
				});

				return {
					id: plan.id,
					name: plan.name,
					targetCurrency: plan.targetCurrency,
					targetAmount: plan.targetAmount.toFixed(4),
					allocatedAmount: allocatedAmount.toFixed(4),
					remainingAmount: allocatedAmount.toFixed(4),
					expectUseDate: plan.expectUseDate.toISOString(),
					latestPrepDate: plan.latestPrepDate.toISOString(),
					prepLeadDays: plan.prepLeadDays,
					pacePreference: plan.pacePreference as PlanDto["pacePreference"],
					status: plan.status as PlanDto["status"],
					installments: installments.map((installment) =>
						this.toInstallmentDto(installment),
					),
				};
			});
		} catch (error) {
			if (error instanceof PermissionDeniedException) {
				await this.recordDeniedAudit(actor, deniedRole, "plan.create", requestId);
			}
			throw error;
		}
	}

	// ────────────────────────── M5 计划管理（plan-management §4.1~4.6）──────────────────────────

	/**
	 * 计划列表（GET /api/plans，§4.1）：本人计划，updatedAt 倒序，limit 100 兑底。
	 * 派生量（剩余分配/缺口）复用 plan-calculator.computeDerived，禁止另行实现公式。
	 */
	async list(
		scope: ReadScope,
		status?: string,
	): Promise<{ items: PlanListItemDto[] }> {
		const plans = await this.prisma.plan.findMany({
			where: { ...orgWhere(scope), ...(status ? { status } : {}) },
			orderBy: { updatedAt: "desc" },
			take: PLAN_LIST_LIMIT,
		});
		const ids = plans.map((plan) => plan.id);
		const [allocations, installments] = await Promise.all([
			ids.length > 0
				? this.prisma.planAllocation.findMany({
						where: { planId: { in: ids } },
					})
				: Promise.resolve([]),
			ids.length > 0
				? this.prisma.planInstallment.findMany({
						where: { planId: { in: ids } },
						orderBy: { scheduledAt: "asc" },
					})
				: Promise.resolve([]),
		]);
		const allocationByPlan = new Map(
			allocations.map((allocation) => [allocation.planId, allocation]),
		);
		// 下一准备节点：按计划聚合后取「今天（含）之后」的最早准备节点（无排期/全部过期 → null）
		const installmentsByPlan = new Map<string, Date[]>();
		for (const installment of installments) {
			const dates = installmentsByPlan.get(installment.planId) ?? [];
			dates.push(installment.scheduledAt);
			installmentsByPlan.set(installment.planId, dates);
		}
		const today = utcMidnight(new Date());
		return {
			items: plans.map((plan) => {
				const upcoming = (installmentsByPlan.get(plan.id) ?? []).find(
					(scheduledAt) =>
						utcMidnight(scheduledAt).getTime() >= today.getTime(),
				);
				return this.toPlanListItemDto(
					plan,
					allocationByPlan.get(plan.id) ?? null,
					upcoming ?? null,
				);
			}),
		};
	}

	/**
	 * 计划详情（GET /api/plans/:id，§4.2；W18 组织隔离）：组织作用域归属校验
	 * （组织外与不存在均 404，防枚举）。canModify/canCancel/canComplete/canReopen
	 * 由服务端按状态与数据计算，前端据此显隐按钮。
	 */
	async getDetail(scope: ReadScope, planId: string): Promise<PlanDetailDto> {
		const plan = await this.prisma.plan.findFirst({
			where: { id: planId, ...orgWhere(scope) },
		});
		if (!plan) {
			throw new PlanNotFoundException();
		}
		return this.buildDetail(plan);
	}

	/**
	 * 写路径收尾详情（原 getDetail 语义）：事务提交后按 orgWhere(scope) 重读，
	 * 含本次写入的变更记录。
	 */
	private async detailAfterWrite(
		scope: ReadScope,
		planId: string,
	): Promise<PlanDetailDto> {
		const plan = await this.prisma.plan.findFirst({
			where: { id: planId, ...orgWhere(scope) },
		});
		if (!plan) {
			throw new PlanNotFoundException();
		}
		return this.buildDetail(plan);
	}

	/**
	 * 详情组装：查询已按 orgWhere(scope) 校验计划归属，直接组装详情，
	 * 不重复归属查询（写路径收尾通过 detailAfterWrite 重读最新状态）。
	 */
	private async buildDetail(plan: Plan): Promise<PlanDetailDto> {
		const planId = plan.id;
		const [allocation, installments, changeLogs] = await Promise.all([
			this.prisma.planAllocation.findUnique({ where: { planId } }),
			this.prisma.planInstallment.findMany({
				where: { planId },
				orderBy: { seq: "asc" },
			}),
			// @org-scope-exempt: 已在 getDetail/detailAfterWrite 按当前组织作用域校验父 Plan 归属，按 planId 查关联变更日志
			this.prisma.planChangeLog.findMany({
				where: { planId },
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			}),
		]);
		const usedAmount = allocation?.usedAmount ?? new Prisma.Decimal(0);
		const allocatedAmount = allocation?.amount ?? new Prisma.Decimal(0);
		// 派生量与资金状态（§3.4 口径唯一）：stillNeeded 复用 computeDerived、
		// fundStatus 复用 usage-calculator.computeFundStatus，禁止另行实现公式
		const derived = computeDerived({
			targetAmount: plan.targetAmount,
			usedAmount,
			allocatedAmount,
		});

		// canComplete（§4.2）：仅 ACTIVE 且通过完成前置校验（checkCompleteReady：无超用 + 已用=目标 + 剩余分配=0）
		let canComplete = false;
		if (plan.status === "ACTIVE") {
			try {
				checkCompleteReady({
					targetAmount: plan.targetAmount,
					usedAmount,
					allocAmount: allocatedAmount,
				});
				canComplete = true;
			} catch {
				canComplete = false;
			}
		}
		// canReopen（§3.4 重开口径）：已完成且「严格完成态」（used == target 且剩余分配 == 0）
		const canReopen =
			plan.status === "COMPLETED" &&
			usedAmount.eq(plan.targetAmount) &&
			computeRemainingAllocation(allocatedAmount, usedAmount).eq(0);

		const today = utcMidnight(new Date());
		const nextInstallment = installments.find(
			(installment) =>
				utcMidnight(installment.scheduledAt).getTime() >= today.getTime(),
		);

		return {
			...this.toPlanListItemDto(
				plan,
				allocation,
				nextInstallment?.scheduledAt ?? null,
			),
			pacePreference:
				plan.pacePreference as PlanDetailDto["pacePreference"],
			prepLeadDays: plan.prepLeadDays,
			expectUseDate: plan.expectUseDate.toISOString(),
			planStartDate: plan.planStartDate
				? plan.planStartDate.toISOString()
				: null,
			installments: installments.map((installment) => ({
				seq: installment.seq,
				scheduledAt: installment.scheduledAt.toISOString(),
				amount: installment.amount.toFixed(4),
			})),
			changeLogs: changeLogs.map((log) => this.toChangeLogDto(log)),
			stillNeeded: derived.stillNeeded.toFixed(4),
			fundStatus: computeFundStatus(derived),
			canModify: plan.status === "ACTIVE",
			canCancel: plan.status === "ACTIVE",
			canComplete,
			canReopen,
		};
	}

	/**
	 * 修改预览（POST /api/plans/:id/adjust-preview，§4.3）：只读计算，不写任何数据。
	 * 计算全部委托 plan-calculator.computeAdjustPreview（预览/提交共用，杜绝公式漂移）；
	 * 仅 ACTIVE 可预览；COMPLETED 严格完成态 + 调高目标返回 valid + reopen 标记；
	 * CANCELLED / COMPLETED 非重开场景 → 409 PLAN_INVALID_TRANSITION（calculator 拦截 4）。
	 *
	 * 读作用域（评审 R2-I02）：计划归属、账户余额与同币种其他计划分配均按当前组织
	 * 读取——与 GET /plans/:id 同口径（跨组织 404；受邀成员看到的是组织账本）。
	 */
	async previewAdjust(
		scope: ReadScope,
		planId: string,
		dto: AdjustPreviewDto,
	): Promise<AdjustPreviewResultDto> {
		const { change } = this.parseAdjustChange(dto);
		const { plan, allocation, context } = await this.loadAdjustContext(
			this.prisma,
			scope,
			planId,
		);
		const result = this.computeAdjustPreviewOrThrow({
			plan: this.toAdjustPlanState(plan, allocation),
			change,
			context,
		});
		return this.toAdjustPreviewResultDto(result);
	}

	/**
	 * 提交修改 / 重新开启（PATCH /api/plans/:id，§3.2 时序 / ToB R1 W23）：
	 * $transaction 内：
	 * ① lockOrganizationForActor 重读最新角色并复验 plan.adjust（锁等降权 → 403 + DENIED 审计）
	 * ② resolveOrganizationPreferences 解析组织建账态
	 * ③ lockOrgPlanAccount 锁组织账本账户 + FOR UPDATE 锁目标 Plan 行
	 * ④ 条件更新（WHERE id + orgWhere(actor) + updatedAt = expected）原子完成乐观锁检查
	 * ⑤ 重算重校验 → confirmReopen 规则 → 落库 Plan / PlanAllocation / PlanInstallment
	 * ⑥ 写 plan_change_logs（带 organizationId + actorUserId）+ 同事务写入 plan.adjust 审计日志。
	 */
	async adjust(
		actor: ActorContext,
		planId: string,
		dto: AdjustPlanDto,
		requestId: string | null = null,
	): Promise<PlanDetailDto> {
		const { change, confirmReopen } = this.parseAdjustChange(dto);
		const expectedUpdatedAt = this.parseTimestamp(
			dto.expectedUpdatedAt,
			"expectedUpdatedAt",
		);

		let deniedRole: OrganizationRole = actor.role;
		try {
			await this.prisma.$transaction(async (tx) => {
				const latestRole = await lockOrganizationForActor(tx, actor);
				if (!can(latestRole, "plan.adjust")) {
					deniedRole = latestRole;
					throw new PermissionDeniedException();
				}

				const preferences = await resolveOrganizationPreferences(
					tx,
					actor.organizationId,
				);
				if (!preferences) {
					throw new OnboardingNotCompletedException(
						"尚未完成首次设置，请先前往 /onboarding 完成建账后再修改计划",
					);
				}
				if (!(await lockOrgPlanAccount(tx, actor, planId))) {
					throw new PlanNotFoundException();
				}
				await this.lockScopedPlanRow(tx, actor, planId);
				const current = await tx.plan.findFirst({
					where: { id: planId, ...orgWhere(actor) },
				});
				if (!current) {
					throw new PlanNotFoundException();
				}
				assertParentChildSameOrg(current.organizationId, actor.organizationId);

				// 条件更新 = 乐观锁检查 + 行写（原子；检查与写入合并为单条语句）
				const checkpoint = await tx.plan.updateMany({
					where: {
						id: planId,
						...orgWhere(actor),
						updatedAt: expectedUpdatedAt,
					},
					data: {
						status: current.status,
					},
				});
				if (checkpoint.count === 0) {
					throw new PlanStateConflictException();
				}

				// 重算重校验：条件更新后重读全部输入（分配/账户/他计划分配均为最新已提交值）
				const fresh = await this.loadAdjustContext(tx, actor, planId);
				const result = this.computeAdjustPreviewOrThrow({
					plan: this.toAdjustPlanState(fresh.plan, fresh.allocation),
					change,
					context: fresh.context,
				});

				// confirmReopen 组合规则（§3.4）：仅在真实触发重开时生效；ACTIVE 携带一律忽略
				if (result.reopen) {
					if (confirmReopen !== true) {
						throw new PlanInvalidParamsException(
							"已完成计划重新开启必须显式确认：confirmReopen = true",
						);
					}
					if (
						change.newAllocAmount !== undefined ||
						change.pacePreference !== null ||
						change.prepLeadDays !== null
					) {
						throw new PlanInvalidParamsException(
							"重新开启只调整目标金额，不能同时修改分配总额、节奏或准备缓冲",
						);
					}
				}

				// 落库：计划主行 + 分配行（金额/目标一律以事务内重算结果为准）
				// @org-scope-exempt: post-lock 主键更新（adjust 已持 lockScopedPlanRow 锁并经 orgWhere + updateMany 乐观锁校验）
				await tx.plan.update({
					where: { id: planId },
					data: {
						targetAmount: result.after.targetAmount,
						pacePreference: result.after.pacePreference,
						prepLeadDays: result.after.prepLeadDays,
						latestPrepDate: result.newLatestPrepDate,
						planStartDate: result.after.planStartDate,
						status: result.reopen ? "ACTIVE" : fresh.plan.status,
					},
				});
				await tx.planAllocation.update({
					where: { planId },
					data: { amount: result.after.allocAmount },
				});

				// 排期重建（§3.4）：全量 deleteMany + createMany；缺口为 0 → 清空（不生成排期）
				await tx.planInstallment.deleteMany({ where: { planId } });
				if (result.impact.newSchedule) {
					await tx.planInstallment.createMany({
						data: result.impact.newSchedule.map((installment) => ({
							planId,
							seq: installment.seq,
							scheduledAt: installment.scheduledAt,
							amount: installment.amount,
						})),
					});
				}

				// 变更记录（§3.3）：主类型按「目标金额变化优先」归类；零变更不写日志
				const changeType = pickAdjustChangeType(result);
				if (changeType) {
					await tx.planChangeLog.create({
						data: {
							planId,
							organizationId: actor.organizationId,
							actorUserId: actor.userId,
							changeType,
							beforeTarget: result.before.targetAmount,
							afterTarget: result.after.targetAmount,
							beforeAlloc: result.before.allocAmount,
							afterAlloc: result.after.allocAmount,
							releasedAmount: result.impact.releasedAmount,
							beforeSnapshot: this.adjustSnapshotPayload(
								result.before,
								fresh.plan,
								fresh.plan.status,
								fresh.plan.latestPrepDate,
							),
							afterSnapshot: this.adjustSnapshotPayload(
								result.after,
								fresh.plan,
								result.reopen ? "ACTIVE" : fresh.plan.status,
								result.newLatestPrepDate,
							),
						},
					});
				}

				await this.auditService.recordInTx(tx, {
					organizationId: actor.organizationId,
					actorUserId: actor.userId,
					actorType: "USER",
					action: "plan.adjust",
					targetType: "plan",
					targetId: planId,
					result: "SUCCESS",
					requestId: requestId ?? null,
					detail: {
						changeType: changeType ?? "NO_OP",
						targetCurrency: fresh.plan.targetCurrency,
						beforeTarget: result.before.targetAmount.toFixed(4),
						afterTarget: result.after.targetAmount.toFixed(4),
						beforeAlloc: result.before.allocAmount.toFixed(4),
						afterAlloc: result.after.allocAmount.toFixed(4),
						releasedAmount: result.impact.releasedAmount.toFixed(4),
					},
				});
			});
		} catch (error) {
			if (error instanceof PermissionDeniedException) {
				await this.recordDeniedAudit(actor, deniedRole, "plan.adjust", requestId);
			}
			throw error;
		}
		return this.detailAfterWrite(actor, planId);
	}

	/**
	 * 完成确认（POST /api/plans/:id/complete，§4.5 / ToB R1 W23）：
	 * 锁组织复验 plan.adjust → 组织账本与计划行锁 → 条件更新（WHERE status = "ACTIVE"）
	 * 原子防「并发取消 + 完成」双写；检查点后重读最新数据跑 checkCompleteReady，
	 * 失败回滚。写 COMPLETED 变更记录与同事务 plan.complete 审计日志。
	 */
	async complete(
		actor: ActorContext,
		planId: string,
		requestId: string | null = null,
	): Promise<PlanDetailDto> {
		let deniedRole: OrganizationRole = actor.role;
		try {
			await this.prisma.$transaction(async (tx) => {
				const latestRole = await lockOrganizationForActor(tx, actor);
				if (!can(latestRole, "plan.adjust")) {
					deniedRole = latestRole;
					throw new PermissionDeniedException();
				}

				const preferences = await resolveOrganizationPreferences(
					tx,
					actor.organizationId,
				);
				if (!preferences) {
					throw new OnboardingNotCompletedException(
						"尚未完成首次设置，请先前往 /onboarding 完成建账后再完成计划",
					);
				}
				if (!(await lockOrgPlanAccount(tx, actor, planId))) {
					throw new PlanNotFoundException();
				}
				await this.lockScopedPlanRow(tx, actor, planId);
				const current = await tx.plan.findFirst({
					where: { id: planId, ...orgWhere(actor) },
					select: {
						id: true,
						organizationId: true,
					},
				});
				if (!current) {
					throw new PlanNotFoundException();
				}
				assertParentChildSameOrg(current.organizationId, actor.organizationId);

				const updated = await tx.plan.updateMany({
					where: {
						id: planId,
						...orgWhere(actor),
						status: "ACTIVE",
					},
					data: {
						status: "COMPLETED",
					},
				});
				if (updated.count === 0) {
					throw new PlanInvalidTransitionException(
						"仅进行中的计划可以确认完成",
					);
				}
				// 检查点后重读（行锁已持有，本计划不再被并发修改；used 读 allocation 行最新值）
				const [freshPlan, allocation] = await Promise.all([
					// @org-scope-exempt: post-lock 主键重读（complete 已持 lockScopedPlanRow 锁并经 orgWhere + updateMany 状态校验）
					tx.plan.findUnique({ where: { id: planId } }),
					tx.planAllocation.findUnique({ where: { planId } }),
				]);
				if (!freshPlan || !allocation) {
					throw new PlanNotFoundException();
				}
				try {
					checkCompleteReady({
						targetAmount: freshPlan.targetAmount,
						usedAmount: allocation.usedAmount,
						allocAmount: allocation.amount,
					});
				} catch (error) {
					// 400 PLAN_COMPLETE_NOT_READY（附差值）→ 异常穿透令整个事务回滚，状态流转一并撤销
					throw this.mapCalcError(error);
				}
				await tx.planChangeLog.create({
					data: {
						planId,
						organizationId: actor.organizationId,
						actorUserId: actor.userId,
						changeType: "COMPLETED",
						beforeTarget: freshPlan.targetAmount,
						afterTarget: freshPlan.targetAmount,
						beforeAlloc: allocation.amount,
						afterAlloc: allocation.amount,
						releasedAmount: new Prisma.Decimal(0),
						beforeSnapshot: this.planRowSnapshot(
							freshPlan,
							allocation,
							"ACTIVE",
						),
						afterSnapshot: this.planRowSnapshot(
							freshPlan,
							allocation,
							"COMPLETED",
						),
					},
				});

				await this.auditService.recordInTx(tx, {
					organizationId: actor.organizationId,
					actorUserId: actor.userId,
					actorType: "USER",
					action: "plan.complete",
					targetType: "plan",
					targetId: planId,
					result: "SUCCESS",
					requestId: requestId ?? null,
					detail: {
						targetCurrency: freshPlan.targetCurrency,
						targetAmount: freshPlan.targetAmount.toFixed(4),
						allocatedAmount: allocation.amount.toFixed(4),
						usedAmount: allocation.usedAmount.toFixed(4),
					},
				});
			});
		} catch (error) {
			if (error instanceof PermissionDeniedException) {
				await this.recordDeniedAudit(actor, deniedRole, "plan.adjust", requestId);
			}
			throw error;
		}
		return this.detailAfterWrite(actor, planId);
	}

	/**
	 * 取消计划（POST /api/plans/:id/cancel，§4.6 / ToB R1 W23）：
	 * 锁组织复验 plan.adjust → 组织账本与计划行锁 → 条件更新（WHERE status = "ACTIVE"）；
	 * amount → max(used, 0) 释放全部剩余分配；installments 清空；
	 * 写 CANCELLED 变更记录与同事务 plan.cancel 审计日志。
	 */
	async cancel(
		actor: ActorContext,
		planId: string,
		requestId: string | null = null,
	): Promise<PlanDetailDto> {
		let deniedRole: OrganizationRole = actor.role;
		try {
			await this.prisma.$transaction(async (tx) => {
				const latestRole = await lockOrganizationForActor(tx, actor);
				if (!can(latestRole, "plan.adjust")) {
					deniedRole = latestRole;
					throw new PermissionDeniedException();
				}

				const preferences = await resolveOrganizationPreferences(
					tx,
					actor.organizationId,
				);
				if (!preferences) {
					throw new OnboardingNotCompletedException(
						"尚未完成首次设置，请先前往 /onboarding 完成建账后再取消计划",
					);
				}
				if (!(await lockOrgPlanAccount(tx, actor, planId))) {
					throw new PlanNotFoundException();
				}
				await this.lockScopedPlanRow(tx, actor, planId);
				const current = await tx.plan.findFirst({
					where: { id: planId, ...orgWhere(actor) },
					select: {
						id: true,
						organizationId: true,
					},
				});
				if (!current) {
					throw new PlanNotFoundException();
				}
				assertParentChildSameOrg(current.organizationId, actor.organizationId);

				const updated = await tx.plan.updateMany({
					where: {
						id: planId,
						...orgWhere(actor),
						status: "ACTIVE",
					},
					data: {
						status: "CANCELLED",
					},
				});
				if (updated.count === 0) {
					throw new PlanInvalidTransitionException(
						"仅进行中的计划可以取消",
					);
				}
				const [freshPlan, allocation] = await Promise.all([
					// @org-scope-exempt: post-lock 主键重读（cancel 已持 lockScopedPlanRow 锁并经 orgWhere + updateMany 状态校验）
					tx.plan.findUnique({ where: { id: planId } }),
					tx.planAllocation.findUnique({ where: { planId } }),
				]);
				if (!freshPlan || !allocation) {
					throw new PlanNotFoundException();
				}
				// amount → max(used, 0)（§3.4）：释放额 = max(0, 原分配总额 − 已使用)；余额不动
				const newAmount = Prisma.Decimal.max(allocation.usedAmount, 0);
				const releasedAmount = Prisma.Decimal.max(
					allocation.amount.sub(newAmount),
					0,
				);
				await tx.planAllocation.update({
					where: { planId },
					data: { amount: newAmount },
				});
				await tx.planInstallment.deleteMany({ where: { planId } });
				await tx.planChangeLog.create({
					data: {
						planId,
						organizationId: actor.organizationId,
						actorUserId: actor.userId,
						changeType: "CANCELLED",
						beforeTarget: freshPlan.targetAmount,
						afterTarget: freshPlan.targetAmount,
						beforeAlloc: allocation.amount,
						afterAlloc: newAmount,
						releasedAmount,
						beforeSnapshot: this.planRowSnapshot(
							freshPlan,
							allocation,
							"ACTIVE",
						),
						afterSnapshot: this.planRowSnapshot(
							freshPlan,
							{ ...allocation, amount: newAmount },
							"CANCELLED",
						),
					},
				});

				await this.auditService.recordInTx(tx, {
					organizationId: actor.organizationId,
					actorUserId: actor.userId,
					actorType: "USER",
					action: "plan.cancel",
					targetType: "plan",
					targetId: planId,
					result: "SUCCESS",
					requestId: requestId ?? null,
					detail: {
						targetCurrency: freshPlan.targetCurrency,
						beforeAlloc: allocation.amount.toFixed(4),
						afterAlloc: newAmount.toFixed(4),
						releasedAmount: releasedAmount.toFixed(4),
					},
				});
			});
		} catch (error) {
			if (error instanceof PermissionDeniedException) {
				await this.recordDeniedAudit(actor, deniedRole, "plan.adjust", requestId);
			}
			throw error;
		}
		return this.detailAfterWrite(actor, planId);
	}

// ────────────────────────── 私有辅助 ──────────────────────────

/** 列表项出参（§4.1）：派生量（剩余分配/缺口）走 computeDerived 唯一口径 */
private toPlanListItemDto(
	plan: Plan,
	allocation: Pick<PlanAllocation, "amount" | "usedAmount"> | null,
	nextInstallmentAt: Date | null,
): PlanListItemDto {
	const usedAmount = allocation?.usedAmount ?? new Prisma.Decimal(0);
	const allocatedAmount = allocation?.amount ?? new Prisma.Decimal(0);
	const derived = computeDerived({
		targetAmount: plan.targetAmount,
		usedAmount,
		allocatedAmount,
	});
	return {
		id: plan.id,
		name: plan.name,
		status: plan.status as PlanListItemDto["status"],
		targetCurrency: plan.targetCurrency,
		targetAmount: plan.targetAmount.toFixed(4),
		usedAmount: usedAmount.toFixed(4),
		allocatedAmount: allocatedAmount.toFixed(4),
		remainingAllocation: derived.remainingAllocation.toFixed(4),
		gap: derived.gap.toFixed(4),
		latestPrepDate: plan.latestPrepDate.toISOString(),
		nextInstallmentAt: nextInstallmentAt
			? nextInstallmentAt.toISOString()
			: null,
		updatedAt: plan.updatedAt.toISOString(),
	};
}

/** 修改记录出参（§4.2 changeLogs 元素；JSON 快照原样透出） */
private toChangeLogDto(log: {
	id: string;
	changeType: string;
	beforeTarget: Prisma.Decimal;
	afterTarget: Prisma.Decimal;
	beforeAlloc: Prisma.Decimal;
	afterAlloc: Prisma.Decimal;
	releasedAmount: Prisma.Decimal;
	beforeSnapshot: Prisma.JsonValue;
	afterSnapshot: Prisma.JsonValue;
	createdAt: Date;
}): PlanChangeLogDto {
	return {
		id: log.id,
		changeType: log.changeType,
		beforeTarget: log.beforeTarget.toFixed(4),
		afterTarget: log.afterTarget.toFixed(4),
		beforeAlloc: log.beforeAlloc.toFixed(4),
		afterAlloc: log.afterAlloc.toFixed(4),
		releasedAmount: log.releasedAmount.toFixed(4),
		beforeSnapshot:
			(log.beforeSnapshot as Record<string, unknown> | null) ?? {},
		afterSnapshot:
			(log.afterSnapshot as Record<string, unknown> | null) ?? {},
		createdAt: log.createdAt.toISOString(),
	};
}

/** 计划当前状态 → calculator 入参（字段拷贝，不含模型实例） */
private toAdjustPlanState(
	plan: Plan,
	allocation: Pick<PlanAllocation, "amount" | "usedAmount">,
): AdjustPreviewPlanState {
	return {
		status: plan.status,
		targetAmount: plan.targetAmount,
		allocAmount: allocation.amount,
		usedAmount: allocation.usedAmount,
		pacePreference: plan.pacePreference as PacePreference,
		prepLeadDays: plan.prepLeadDays,
		expectUseDate: plan.expectUseDate,
		planStartDate: plan.planStartDate,
	};
}

/**
 * 加载修改预览/提交所需全部数据（同币种口径，§3.4）：
 * 计划（404 归属校验）→ 分配行（1:1，缺行防御性 404）→ 同币种账户余额 →
 * 同币种「其他」计划分配快照（computeCaps otherPlanAllocations 必须按 targetCurrency 过滤）。
 * db 传 PrismaService 或事务客户端均可。
 * 全部按 orgWhere(scope) 组织作用域读取（零 userId 旁路）。
 */
private async loadAdjustContext(
	db: CapsDb,
	scope: ReadScope,
	planId: string,
): Promise<{
	plan: Plan;
	allocation: PlanAllocation;
	context: AdjustPreviewContext;
}> {
	const owner = orgWhere(scope);
	const plan = await db.plan.findFirst({ where: { id: planId, ...owner } });
	if (!plan) {
		throw new PlanNotFoundException();
	}
	const allocation = await db.planAllocation.findUnique({
		where: { planId },
	});
	if (!allocation) {
		throw new PlanNotFoundException(); // 创建事务保证 1:1，此处防御性兑底
	}
	const [accounts, siblingPlans] = await Promise.all([
		db.account.findMany({
			where: { currencyCode: plan.targetCurrency, ...owner },
			select: { balance: true },
		}),
		db.plan.findMany({
			where: {
				targetCurrency: plan.targetCurrency,
				id: { not: planId },
				...owner,
			},
			select: { id: true },
		}),
	]);
	const accountBalance = accounts.reduce(
		(sum, row) => sum.add(row.balance),
		new Prisma.Decimal(0),
	);
	const currencyInfo = getCurrency(plan.targetCurrency);
	if (!currencyInfo) {
		throw new PlanInvalidParamsException(
			`目标币种 ${plan.targetCurrency} 不在支持的 15 币种内`,
		);
	}
	const siblingAllocations =
		siblingPlans.length > 0
			? await db.planAllocation.findMany({
					where: {
						planId: { in: siblingPlans.map((plan) => plan.id) },
					},
				})
			: [];
	return {
		plan,
		allocation,
		context: {
			accountBalance,
			otherPlanAllocations: siblingAllocations.map((allocation) => ({
				amount: allocation.amount,
				usedAmount: allocation.usedAmount,
			})),
			decimalPlaces: currencyInfo.decimalPlaces,
		},
	};
}

/**
 * 修改入参规范化（§4.3/4.4 装饰器清单的服务侧补充）：
 * - 「至少一项」判空（service 首行，400 INVALID_PLAN_PARAMS）
 * - 金额入参超 4 位小数在解析层直接拒绝（§4 通用约定，禁依赖 Postgres 静默舍入）
 * - startDate 三态：undefined = 沿用；null = 清空回退「明天起首个工作日」；Date = 替换
 * - 节奏/缓冲兜底校验（DTO @IsIn/@IsInt 已拦大部分，保持模块错误码一致）
 */
private parseAdjustChange(dto: AdjustPreviewDto): {
	change: AdjustPreviewChange;
	confirmReopen: boolean | undefined;
} {
	const newTargetAmount = this.parseOptionalPositiveAmount(
		dto.newTargetAmount,
		"目标金额",
	);
	const newAllocAmount = this.parseOptionalNonNegativeAmount(
		dto.newAllocAmount,
		"分配金额",
	);
	if (
		dto.pacePreference !== undefined &&
		dto.pacePreference !== null &&
		!PACE_PREFERENCES.includes(dto.pacePreference as PacePreference)
	) {
		throw new PlanInvalidParamsException(
			"资金准备节奏必须是 conservative / balanced / aggressive 之一",
		);
	}
	let prepLeadDays: number | null = null;
	if (dto.prepLeadDays !== undefined && dto.prepLeadDays !== null) {
		if (
			!Number.isInteger(dto.prepLeadDays) ||
			dto.prepLeadDays < PREP_LEAD_DAYS_MIN ||
			dto.prepLeadDays > PREP_LEAD_DAYS_MAX
		) {
			throw new PlanInvalidParamsException(
				`提前准备天数必须是 ${PREP_LEAD_DAYS_MIN}~${PREP_LEAD_DAYS_MAX} 的整数，收到：${dto.prepLeadDays}`,
			);
		}
		prepLeadDays = dto.prepLeadDays;
	}
	// startDate 三态（PATCH 需区分「字段缺省」与显式 null）
	let startDate: Date | null | undefined;
	if (dto.startDate === undefined) {
		startDate = undefined;
	} else if (dto.startDate === null) {
		startDate = null;
	} else {
		const parsed = this.parseUtcDate(dto.startDate, "开始准备日");
		if (parsed.getTime() < utcMidnight(new Date()).getTime()) {
			throw new PlanInvalidParamsException("开始准备日不能早于今天");
		}
		startDate = parsed;
	}
	// 「至少一项」（§4.3：service 首行判空，不用自定义装饰器）
	if (
		newTargetAmount === undefined &&
		newAllocAmount === undefined &&
		(dto.pacePreference ?? null) === null &&
		prepLeadDays === null &&
		startDate === undefined
	) {
		throw new PlanInvalidParamsException(
			"至少提供一项修改内容（新目标金额 / 新分配总额 / 资金准备节奏 / 准备缓冲 / 开始准备日）",
		);
	}
	const confirmReopen =
		"confirmReopen" in dto ? (dto as AdjustPlanDto).confirmReopen : undefined;
	return {
		change: {
			newTargetAmount,
			newAllocAmount,
			pacePreference: dto.pacePreference ?? null,
			prepLeadDays,
			startDate,
		},
		confirmReopen,
	};
}

/**
 * 乐观锁时间戳解析（完整精度，不截断 UTC 0 点）——
	 * expectedUpdatedAt 须与 plans.updatedAt 逐毫秒相等，截断会导致比对恒失配。
	 */
	private parseTimestamp(value: string, label: string): Date {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			throw new PlanInvalidParamsException(
				`${label}必须是有效的 ISO 8601 时间戳，收到：${value}`,
			);
		}
		return date;
	}

	/** 可选正金额（新目标金额）：存在时校验有效数字 / > 0 / ≤ 单笔上限 / ≤ 4 位小数 */
	private parseOptionalPositiveAmount(
		value: string | null | undefined,
		label: string,
	): Prisma.Decimal | undefined {
		if (value === undefined || value === null) {
			return undefined;
		}
		const amount = this.parsePositiveAmount(value, label);
		this.assertMaxDecimalPlaces(amount, label, value);
		return amount;
	}

	/** 可选非负金额（新分配总额）：存在时校验有效数字 / ≥ 0 / ≤ 单笔上限 / ≤ 4 位小数 */
	private parseOptionalNonNegativeAmount(
		value: string | null | undefined,
		label: string,
	): Prisma.Decimal | undefined {
		if (value === undefined || value === null) {
			return undefined;
		}
		const amount = this.parseNonNegativeAmount(value, label);
		this.assertMaxDecimalPlaces(amount, label, value);
		return amount;
	}

	/** 金额入参超 4 位小数直接拒绝（§4 通用约定，如 10000.00005） */
	private assertMaxDecimalPlaces(
		amount: Prisma.Decimal,
		label: string,
		original: string,
	): void {
		if (amount.dp() > 4) {
			throw new PlanInvalidParamsException(
				`${label}最多支持 4 位小数，收到：${original}`,
			);
		}
	}

	/** calculator/schedule-builder 领域错误 → HTTP（§4.4 错误码契约，data 金额序列化 4 位） */
	private computeAdjustPreviewOrThrow(
		input: ComputeAdjustPreviewInput,
	): AdjustPreviewResult {
		try {
			return computeAdjustPreview(input);
		} catch (error) {
			throw this.mapCalcError(error);
		}
	}

	private mapCalcError(error: unknown): unknown {
		if (error instanceof PlanCalcError) {
			const status =
				error.code === "PLAN_INVALID_TRANSITION"
					? HttpStatus.CONFLICT
					: HttpStatus.BAD_REQUEST;
			throw new HttpException(
				{
					code: error.code,
					message: error.message,
					...(error.data
						? { data: this.serializeDecimals(error.data) }
						: {}),
				},
				status,
			);
		}
		if (error instanceof ScheduleBuildError) {
			switch (error.code) {
				case "NO_AVAILABLE_DATES":
					throw new PlanNoAvailableDatesException(error.message);
				case "AMOUNT_TOO_SMALL":
					throw new PlanAmountTooSmallException(error.message);
				default:
					throw new PlanInvalidParamsException(error.message);
			}
		}
		throw error;
	}

	/** 错误 data 内 Decimal 递归序列化为固定 4 位小数字符串 */
	private serializeDecimals(value: unknown): unknown {
		if (value instanceof Prisma.Decimal) {
			return value.toFixed(4);
		}
		if (Array.isArray(value)) {
			return value.map((item) => this.serializeDecimals(item));
		}
		if (value !== null && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [
					key,
					this.serializeDecimals(item),
				]),
			);
		}
		return value;
	}

	/** 预览结果出参（§4.3；重新开启场景 caps 三值无意义，省略） */
	private toAdjustPreviewResultDto(
		result: AdjustPreviewResult,
	): AdjustPreviewResultDto {
		return {
			valid: true,
			reopen: result.reopen,
			caps: result.reopen
				? null
				: {
						limit: result.caps.limit.toFixed(4),
						unallocatedBalance:
							result.caps.unallocatedBalance.toFixed(4),
						stillNeeded: result.caps.stillNeeded.toFixed(4),
					},
			impact: {
				releasedAmount: result.impact.releasedAmount.toFixed(4),
				newGap: result.impact.newGap.toFixed(4),
				newSchedule: result.impact.newSchedule
					? result.impact.newSchedule.map((installment) =>
							this.toInstallmentDto(installment),
						)
					: null,
				scheduleDropped: result.impact.scheduleDropped,
			},
			before: this.toAdjustSnapshotDto(result.before),
			after: this.toAdjustSnapshotDto(result.after),
			newLatestPrepDate: result.newLatestPrepDate.toISOString(),
		};
	}

	private toAdjustSnapshotDto(
		snapshot: AdjustPreviewStateSnapshot,
	): PlanAdjustSnapshotDto {
		return {
			targetAmount: snapshot.targetAmount.toFixed(4),
			allocAmount: snapshot.allocAmount.toFixed(4),
			usedAmount: snapshot.usedAmount.toFixed(4),
			remainingAllocation:
				snapshot.remainingAllocation.toFixed(4),
			gap: snapshot.gap.toFixed(4),
			pacePreference: snapshot.pacePreference,
			prepLeadDays: snapshot.prepLeadDays,
			planStartDate: snapshot.planStartDate
				? snapshot.planStartDate.toISOString()
				: null,
		};
	}

	/** 变更记录 JSON 快照（§3.3 全量字段：目标/分配/已使用/剩余/缺口/节奏/缓冲/开始日/状态） */
	private adjustSnapshotPayload(
		snapshot: AdjustPreviewStateSnapshot,
		plan: Plan,
		status: string,
		latestPrepDate: Date,
	): Prisma.InputJsonValue {
		return {
			status,
			name: plan.name,
			targetCurrency: plan.targetCurrency,
			targetAmount: snapshot.targetAmount.toFixed(4),
			allocAmount: snapshot.allocAmount.toFixed(4),
			usedAmount: snapshot.usedAmount.toFixed(4),
			remainingAllocation: snapshot.remainingAllocation.toFixed(4),
			gap: snapshot.gap.toFixed(4),
			pacePreference: snapshot.pacePreference,
			prepLeadDays: snapshot.prepLeadDays,
			expectUseDate: plan.expectUseDate.toISOString(),
			latestPrepDate: latestPrepDate.toISOString(),
			planStartDate: snapshot.planStartDate
				? snapshot.planStartDate.toISOString()
				: null,
		};
	}

	/** 完成/取消的 JSON 快照（与 adjustSnapshotPayload 同构，直接从行构造） */
	private planRowSnapshot(
		plan: Plan,
		allocation: Pick<PlanAllocation, "amount" | "usedAmount">,
		status: string,
	): Prisma.InputJsonValue {
		const derived = computeDerived({
			targetAmount: plan.targetAmount,
			usedAmount: allocation.usedAmount,
			allocatedAmount: allocation.amount,
		});
		return {
			status,
			name: plan.name,
			targetCurrency: plan.targetCurrency,
			targetAmount: plan.targetAmount.toFixed(4),
			allocAmount: allocation.amount.toFixed(4),
			usedAmount: allocation.usedAmount.toFixed(4),
			remainingAllocation: derived.remainingAllocation.toFixed(4),
			gap: derived.gap.toFixed(4),
			pacePreference: plan.pacePreference,
			prepLeadDays: plan.prepLeadDays,
			expectUseDate: plan.expectUseDate.toISOString(),
			latestPrepDate: plan.latestPrepDate.toISOString(),
			planStartDate: plan.planStartDate
				? plan.planStartDate.toISOString()
				: null,
		};
	}

	/**
	 * 入参规范化与合法性校验（方案 §4.3），全部失败路径抛 400 INVALID_PLAN_PARAMS。
	 * buildInstallments 依赖本方法保证入参合法（builder 内仅防御性兜底）。
	 * baseCurrency 传入时校验目标币种 ≠ 本位币（create 恒传；preview 未建账时为 null 跳过比对）。
	 */
	private parsePlanParams(
		dto: SchedulePreviewDto,
		baseCurrency?: string | null,
	): ParsedPlanParams {
		const normalizedCurrency = dto.targetCurrency?.trim().toUpperCase() ?? "";
		const currencyInfo = getCurrency(normalizedCurrency);
		if (!currencyInfo) {
			throw new PlanInvalidParamsException(
				`目标币种必须是支持的 15 种币种之一，收到：${dto.targetCurrency}`,
			);
		}
		if (baseCurrency && normalizedCurrency === baseCurrency) {
			throw new PlanInvalidParamsException(
				`目标币种不能与本位币相同（本位币：${baseCurrency}）`,
			);
		}

		const targetAmount = this.parsePositiveAmount(dto.targetAmount, "目标金额");

		const expectUseDate = this.parseUtcDate(
			dto.expectUseDate,
			"用途日期",
		);
		if (expectUseDate.getTime() <= utcMidnight(new Date()).getTime()) {
			throw new PlanInvalidParamsException("用途日期必须晚于今天");
		}

		if (
			!Number.isInteger(dto.prepLeadDays) ||
			dto.prepLeadDays < PREP_LEAD_DAYS_MIN ||
			dto.prepLeadDays > PREP_LEAD_DAYS_MAX
		) {
			throw new PlanInvalidParamsException(
				`提前准备天数必须是 ${PREP_LEAD_DAYS_MIN}~${PREP_LEAD_DAYS_MAX} 的整数，收到：${dto.prepLeadDays}`,
			);
		}

		if (
			!PACE_PREFERENCES.includes(
				dto.pacePreference as PacePreference,
			)
		) {
			throw new PlanInvalidParamsException(
				"资金准备节奏必须是 conservative / balanced / aggressive 之一",
			);
		}

		let startDate: Date | null = null;
		if (dto.startDate) {
			startDate = this.parseUtcDate(dto.startDate, "开始准备日");
			if (startDate.getTime() < utcMidnight(new Date()).getTime()) {
				throw new PlanInvalidParamsException("开始准备日不能早于今天");
			}
		}

		return {
			targetCurrency: normalizedCurrency,
			decimalPlaces: currencyInfo.decimalPlaces,
			targetAmount,
			expectUseDate,
			prepLeadDays: dto.prepLeadDays,
			pacePreference: dto.pacePreference as PacePreference,
			startDate,
		};
	}

	/** 解析正金额：有效数字、> 0、≤ 单笔上限（money 包校验，统一转 INVALID_PLAN_PARAMS） */
	private parsePositiveAmount(value: string, label: string): Prisma.Decimal {
		const amount = this.parseDecimalOrThrow(value, label);
		try {
			assertAmountLimitOf(amount);
		} catch {
			throw new PlanInvalidParamsException(
				`${label}必须为大于 0 且小于单笔上限的有效数字`,
			);
		}
		return amount;
	}

	/** 解析非负金额：有效数字、≥ 0、≤ 单笔上限（分配金额允许 0） */
	private parseNonNegativeAmount(value: string, label: string): Prisma.Decimal {
		const amount = this.parseDecimalOrThrow(value, label);
		if (amount.isNegative()) {
			throw new PlanInvalidParamsException(`${label}不能为负数`);
		}
		if (amount.gte(AMOUNT_UPPER_LIMIT_VALUE)) {
			throw new PlanInvalidParamsException(
				`${label}必须小于单笔上限 100,000,000,000`,
			);
		}
		return amount;
	}

	private parseDecimalOrThrow(value: string, label: string): Prisma.Decimal {
		try {
			const amount = new Prisma.Decimal(value);
			if (!amount.isFinite()) {
				throw new Error("not finite");
			}
			return amount;
		} catch {
			throw new PlanInvalidParamsException(
				`${label}必须是有效的数字字符串，收到：${value}`,
			);
		}
	}

	private parseUtcDate(value: string, label: string): Date {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			throw new PlanInvalidParamsException(
				`${label}必须是有效的 ISO 8601 日期，收到：${value}`,
			);
		}
		return utcMidnight(date);
	}

	/**
	 * 分配校验（方案 §4.2 / plan-management §3.4）：
	 * DB 读取在此（账户余额 + 同币种全部计划分配），公式下沉 plan-calculator 唯一实现——
	 * 未分配余额 = max(0, balance − Σ同币种剩余分配)；创建上限 = min(未分配余额, 还需准备金额)。
	 * 事务内调用即为「创建时重检余额」（并发安全的权威防线）。
	 * 全部按 orgWhere(scope) 组织作用域读取（零 userId 旁路）。
	 */
	private async computeCaps(
		db: CapsDb,
		scope: ReadScope,
		currencyCode: string,
		targetAmount: Prisma.Decimal,
	): Promise<AllocatableCaps> {
		const owner = orgWhere(scope);
		const [accounts, plans] = await Promise.all([
			db.account.findMany({
				where: { currencyCode, ...owner },
				select: { balance: true },
			}),
			db.plan.findMany({
				where: { targetCurrency: currencyCode, ...owner },
				select: { id: true },
			}),
		]);
		const accountBalance = accounts.reduce(
			(sum, row) => sum.add(row.balance),
			new Prisma.Decimal(0),
		);
		// PlanAllocation 与 Plan 无 Prisma relation（planId 裸外键），按计划 ID 批量取出
		const allocations =
			plans.length > 0
				? await db.planAllocation.findMany({
						where: { planId: { in: plans.map((plan) => plan.id) } },
					})
				: [];

		// 创建场景本计划尚不存在：ownPlan = null，全部计划均为「其他计划」
		const caps = computeCapsPure({
			mode: "create",
			accountBalance,
			otherPlanAllocations: allocations.map((allocation) => ({
				amount: allocation.amount,
				usedAmount: allocation.usedAmount,
			})),
			ownPlan: null,
			targetAmount,
		});
		return {
			allocatableBalance: caps.unallocatedBalance,
			maxAllocatable: caps.maxAllocatable,
		};
	}

	/** 锁内按 orgWhere(scope) 对目标 Plan 行加 FOR UPDATE 锁，防止跨组织泄露与并发写竞态 */
	private async lockScopedPlanRow(
		tx: Prisma.TransactionClient,
		scope: ReadScope,
		planId: string,
	): Promise<void> {
		const rows = await tx.$queryRaw<Array<{ id: string }>>`
			SELECT id FROM plans
			WHERE id = ${planId}
				AND organization_id = ${scope.organizationId}
			FOR UPDATE`;
		if (rows.length === 0) {
			throw new PlanNotFoundException();
		}
	}

	private async recordDeniedAudit(
		actor: ActorContext,
		role: OrganizationRole,
		required: Permission,
		requestId: string | null,
	): Promise<void> {
		await recordDeniedAuditBestEffort(this.auditService, this.logger, {
			actor,
			role,
			required,
			requestId,
		});
	}

	/** R1~R6 纯函数调用 + 错误码到 HTTP 400 的映射 */
	private buildInstallmentsOrThrow(
		input: BuildInstallmentsInput,
	): Installment[] {
		try {
			return buildInstallments(input);
		} catch (error) {
			if (error instanceof ScheduleBuildError) {
				switch (error.code) {
					case "NO_AVAILABLE_DATES":
						throw new PlanNoAvailableDatesException(error.message);
					case "AMOUNT_TOO_SMALL":
						throw new PlanAmountTooSmallException(error.message);
					default:
						throw new PlanInvalidParamsException(error.message);
				}
			}
			throw error;
		}
	}

	private toInstallmentDto(installment: Installment): PlanInstallmentDto {
		return {
			seq: installment.seq,
			scheduledAt: installment.scheduledAt.toISOString(),
			amount: installment.amount.toFixed(4),
		};
	}

	private toCapsDto(caps: AllocatableCaps): AllocatableCapsDto {
		return {
			allocatableBalance: caps.allocatableBalance.toFixed(4),
			maxAllocatable: caps.maxAllocatable.toFixed(4),
		};
	}
}

// ── 模块内工具（不依赖注入）─────────────────────────────

/**
 * 修改变更主类型归类（§3.3：多字段同改时以目标金额变化优先）：
 * REOPENED > TARGET_ADJUSTED > ALLOCATION_ADJUSTED > PARAMS_ADJUSTED（仅节奏/缓冲/开始日变化）。
 * 节奏/缓冲/开始日-only 变更在枚举五值中无归属（§3.3 仅列目标/分配/完成/取消/重开），
 * 采用 PARAMS_ADJUSTED 保证变更必留痕（架构视角 #5），完整明细由 JSON 快照承载。
 * 返回 null = 零变更，不写日志。
 */
function pickAdjustChangeType(
	result: AdjustPreviewResult,
): "REOPENED" | "TARGET_ADJUSTED" | "ALLOCATION_ADJUSTED" | "PARAMS_ADJUSTED" | null {
	if (result.reopen) {
		return "REOPENED";
	}
	if (!result.after.targetAmount.eq(result.before.targetAmount)) {
		return "TARGET_ADJUSTED";
	}
	if (!result.after.allocAmount.eq(result.before.allocAmount)) {
		return "ALLOCATION_ADJUSTED";
	}
	const sameDate = (a: Date | null, b: Date | null) =>
		a === b || (a !== null && b !== null && a.getTime() === b.getTime());
	if (
		result.after.pacePreference !== result.before.pacePreference ||
		result.after.prepLeadDays !== result.before.prepLeadDays ||
		!sameDate(result.after.planStartDate, result.before.planStartDate)
	) {
		return "PARAMS_ADJUSTED";
	}
	return null;
}

	/** 截取为 UTC 0 点（与 builder 的 utcMidnight 同义；日期统一 UTC 0 点口径） */
	function utcMidnight(date: Date): Date {
	return new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
	);
}

/** 正金额校验（money 包语义：> 0 且 < 上限），超限/非法统一由调用方转 400 */
function assertAmountLimitOf(amount: Prisma.Decimal): void {
	if (!amount.isFinite() || amount.lte(0) || amount.gte(AMOUNT_UPPER_LIMIT_VALUE)) {
		throw new Error("amount out of range");
	}
}

const AMOUNT_UPPER_LIMIT_VALUE = new Prisma.Decimal("100000000000");

// defaultIsWorkday 目前仅由 builder 默认注入；此处 re-export 便于测试替换断言
export { defaultIsWorkday };
