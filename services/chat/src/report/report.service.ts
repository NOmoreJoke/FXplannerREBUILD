import {
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
	Logger,
} from "@nestjs/common";
import { getCurrency } from "@fxplanner-new/money";
import type { Prisma, CostLot, Plan } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { ReadScope } from "../authorization/organization-scope";
import { planReservationWhere } from "../authorization/default-organization";
import { resolveOrganizationPreferences } from "../organization/organization-preferences";
import {
	aggregatePlanUsage,
	computeRemainingToUse,
	computeReportUpdatedAt,
	formatUnitCost,
	resolveYieldDisplayType,
	type PlanUsageAggregate,
	type ReportAllocationRow,
	type ReportUsageRecordRow,
} from "./report-calculator";
import type {
	PlanReportDto,
	ReportPlanListItemDto,
	ReportPlanListDto,
	ReportSourceSplitItemDto,
} from "./dto/report.dto";

/**
 * 模块错误（错误响应统一 { code, message }，风格与 account/plan 模块一致）：
 * - INVALID_REPORT_PARAMS（400）：status 不在三值枚举 / 币种不在 15 种支持列表 / 计划 id 格式非法
 * - PLAN_NOT_FOUND（404）：计划不存在或不属于本人（不泄露存在性，对齐 plan 模块）
 */
export class ReportInvalidParamsException extends HttpException {
	constructor(message: string) {
		super(
			{ code: "INVALID_REPORT_PARAMS", message },
			HttpStatus.BAD_REQUEST,
		);
	}
}

export class ReportPlanNotFoundException extends HttpException {
	constructor() {
		super(
			{ code: "PLAN_NOT_FOUND", message: "计划不存在" },
			HttpStatus.NOT_FOUND,
		);
	}
}

/** 合法计划 id 形态（cuid：字母数字；防御性格式校验，非法格式 400，合法但不存在 404） */
const PLAN_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

const PLAN_STATUSES = ["ACTIVE", "COMPLETED", "CANCELLED"] as const;

/**
 * 计划占用对称口径的 where 片段类型（authorization/default-organization.ts）：
 * 在 compatReadWhere 之上补入「默认组织创建者尚未回填 organizationId 的存量计划」。
 */
type PlanReservationWhere = Awaited<ReturnType<typeof planReservationWhere>>;

/** 聚合所需的全部关联事实（loadUsageContext 一次载入，内存 join 防 N+1） */
interface UsageContext {
	/** planId → 该计划使用记录 */
	usageRecordsByPlan: Map<string, ReportUsageRecordRow[]>;
	/** usageId → 分摊明细 */
	allocationsByUsageId: Map<string, UsageLotAllocationRow[]>;
	/** lotId → 成本批次（sourceType / sourceId） */
	lotById: Map<string, Pick<CostLot, "id" | "sourceType" | "sourceId">>;
	/** 交易 id → 手续费原值（Decimal | null；null = 未明确） */
	feeAmountByTransactionId: Map<string, Prisma.Decimal | null>;
	/** usageId → USAGE 更正时间 */
	usageCorrectionTimes: Map<string, Date[]>;
	/** planId → 该计划关联交易 id（Transaction.planId = planId，§4.2 口径 3 字面域） */
	planTransactionIdsByPlan: Map<string, string[]>;
	/** 交易 id → TRANSACTION 更正时间 */
	transactionCorrectionTimes: Map<string, Date[]>;
}

/** 分摊明细行内存形态（UsageLotAllocation 字段拷贝） */
interface UsageLotAllocationRow {
	usageId: string;
	lotId: string;
	quantity: Prisma.Decimal;
	cost: Prisma.Decimal;
}

/**
 * 成本摘要与报告只读编排（reports 技术方案 §3/§5）：纯只读聚合层，
 * 不重跑 FIFO——直接读 M7/M8 落库的 UsageLotAllocation 分摊事实。
 * 业务计算全部下沉 report-calculator（口径唯一实现，单测覆盖），
 * 本层只做 Prisma 并行读取、内存 join 与 DTO 序列化（toFixed 约定）。
 *
 * M7 未上线时 UsageRecord/UsageLotAllocation 为空集，全链路表现为
 * 「尚未使用」（usedQuantity="0.0000"、成本 null、无下载入口）。
 */
@Injectable()
export class ReportService {
	private readonly logger = new Logger(ReportService.name);

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	/**
	 * 本位币解析（W18，与 account.service 同款规则；LEDGER-02）：统一走组织偏好
	 * 解析——OrganizationSettings 优先，兼容回落仅限「该组织是其所有者的默认组织」
	 * （评审 I-08），均无 → null。
	 */
	private async resolveBaseCurrency(scope: ReadScope): Promise<string | null> {
		const preferences = await resolveOrganizationPreferences(
			this.prisma,
			scope.organizationId,
		);
		return preferences?.baseCurrency ?? null;
	}

	/**
	 * 报告中心列表（GET /api/reports/plans，§5.1；W18 组织隔离）：全计划成本摘要 + 状态/币种筛选
	 *
	 * 计划集合按**计划占用对称口径**（planReservationWhere）读取，而非 compatReadWhere：
	 * 默认组织创建者尚未回填 organizationId 的存量计划在逻辑上属于该组织，若按
	 * compatReadWhere 读取，创建者（默认组织上下文能看到自己的 NULL 行）与受邀成员
	 * （非默认组织上下文看不到行主的 NULL 行）会看到**不同的计划集合**，报告视图
	 * 逐字段不一致且遗漏 Plan 维度的成本归属（W24 对抗审 N-1 / P-2）。
	 * 该口径与 AccountService.sumAllocatedByCurrencyForUser、CorrectionService 的
	 * 计划占用读取同源（authorization/default-organization.ts）。
	 */
	async list(
		scope: ReadScope,
		query: { status?: string; currencyCode?: string },
	): Promise<ReportPlanListDto> {
		const status = this.normalizeStatus(query.status);
		const currencyCode = this.normalizeCurrencyCode(query.currencyCode);
		const reservationWhere = await planReservationWhere(this.prisma, scope);

		const [baseCurrency, plans] = await Promise.all([
			this.resolveBaseCurrency(scope),
			// @org-scope-exempt: W30 MIG-D/F 待清理
			this.prisma.plan.findMany({
				where: {
					...reservationWhere,
					...(status ? { status } : {}),
					...(currencyCode ? { targetCurrency: currencyCode } : {}),
				},
				orderBy: { createdAt: "desc" },
			}),
		]);

		const context = await this.loadUsageContext(
			plans.map((plan) => plan.id),
			reservationWhere,
		);

		const items = plans.map((plan) =>
			this.toListItemDto(
				plan,
				this.aggregateForPlan(plan.id, context),
				context,
			),
		);
		return { baseCurrency, items };
	}

	/**
	 * 单计划报告（GET /api/reports/plans/:id，§5.2；W18 组织隔离）：页面摘要与打印视图共用数据源
	 *
	 * 计划归属按同一「计划占用对称口径」校验（见 list 的 N-1 / P-2 说明）：
	 * 同组织的创建者与受邀成员对同一计划得到逐字段一致的报告视图。
	 */
	async detail(scope: ReadScope, planId: string): Promise<PlanReportDto> {
		if (!PLAN_ID_PATTERN.test(planId)) {
			throw new ReportInvalidParamsException("计划 ID 格式非法");
		}
		const reservationWhere = await planReservationWhere(this.prisma, scope);
		// @org-scope-exempt: W30 MIG-D/F 待清理
		const plan = await this.prisma.plan.findFirst({
			where: { id: planId, ...reservationWhere },
		});
		if (!plan) {
			// 组织作用域外与不存在均 404（防枚举，对齐 plan 模块）
			throw new ReportPlanNotFoundException();
		}
		const [baseCurrency, context] = await Promise.all([
			this.resolveBaseCurrency(scope),
			this.loadUsageContext([plan.id], reservationWhere),
		]);

		const aggregate = this.aggregateForPlan(plan.id, context);
		const updatedAt = this.resolveUpdatedAt(plan.id, context);
		return {
			plan: {
				id: plan.id,
				name: plan.name,
				status: plan.status,
				currencyCode: plan.targetCurrency,
				baseCurrency,
				targetAmount: plan.targetAmount.toFixed(4),
				usedQuantity: aggregate.usedQuantity.toFixed(4),
				remainingToUseAmount: computeRemainingToUse(
					plan.targetAmount,
					aggregate.usedQuantity,
				).toFixed(4),
			},
			cost: {
				usedTotalCost:
					aggregate.usedTotalCost === null
						? null
						: aggregate.usedTotalCost.toFixed(4),
				usedUnitCost:
					aggregate.usedUnitCost === null
						? null
						: formatUnitCost(aggregate.usedUnitCost),
				hasUnknownFee: aggregate.hasUnknownFee,
			},
			sourceSplit: {
				initial: this.toSourceSplitItemDto(
					aggregate.initialQuantity,
					aggregate.initialCost,
				),
				purchase: this.toSourceSplitItemDto(
					aggregate.purchaseQuantity,
					aggregate.purchaseCost,
				),
			},
			yieldSection: { displayType: resolveYieldDisplayType(aggregate) },
			meta: {
				updatedAt: updatedAt ? updatedAt.toISOString() : null,
				generatedAt: new Date().toISOString(),
			},
		};
	}

	// ────────────────────────── 私有辅助 ──────────────────────────

	/** 状态参数校验（缺省 undefined = 全部；非法 400 INVALID_REPORT_PARAMS，错误体带模块 code） */
	private normalizeStatus(raw: string | undefined): string | undefined {
		if (raw === undefined || raw === "") {
			return undefined;
		}
		if (!(PLAN_STATUSES as readonly string[]).includes(raw)) {
			throw new ReportInvalidParamsException(
				"状态必须是 ACTIVE / COMPLETED / CANCELLED 之一",
			);
		}
		return raw;
	}

	/** 币种参数校验（trim + 大写 + money 包 15 币种清单；非法 400 INVALID_REPORT_PARAMS） */
	private normalizeCurrencyCode(raw: string | undefined): string | undefined {
		if (raw === undefined || raw.trim() === "") {
			return undefined;
		}
		const code = raw.trim().toUpperCase();
		if (!getCurrency(code)) {
			throw new ReportInvalidParamsException(
				`币种必须是支持的 15 种币种之一，收到：${raw}`,
			);
		}
		return code;
	}

	/**
	 * 一次载入聚合所需的全部关联事实（防 N+1）：使用记录 → 分摊明细 → 成本批次 →
	 * 来源交易手续费 → 相关更正。方案 §4.2 口径 3：TRANSACTION 更正取
	 * planId = 该计划的交易（字面口径；分摊来源交易若 planId=null 不参与 updatedAt）。
	 *
	 * 作用域（scope）统一由调用方传入的「计划占用对称口径」承担
	 * （planReservationWhere）：使用记录与关联交易按同一口径读取，使同组织的
	 * 创建者与受邀成员在**数量 / 成本 / 来源拆分 / 均价 / 更新时间**上逐字段一致
	 * （W24 对抗审 N-1 / P-2：遗漏 Plan 维度的成本归属）。
	 */
	private async loadUsageContext(
		planIds: string[],
		reservationWhere: PlanReservationWhere,
	): Promise<UsageContext> {
		const empty: UsageContext = {
			usageRecordsByPlan: new Map(),
			allocationsByUsageId: new Map(),
			lotById: new Map(),
			feeAmountByTransactionId: new Map(),
			usageCorrectionTimes: new Map(),
			planTransactionIdsByPlan: new Map(),
			transactionCorrectionTimes: new Map(),
		};
		if (planIds.length === 0) {
			return empty;
		}

		const [usageRecords, planTransactions] = await Promise.all([
			// @org-scope-exempt: W30 MIG-D/F 待清理
			this.prisma.usageRecord.findMany({
				where: { planId: { in: planIds }, ...reservationWhere },
			}),
			// @org-scope-exempt: W30 MIG-D/F 待清理
			this.prisma.transaction.findMany({
				where: { planId: { in: planIds }, ...reservationWhere },
				select: { id: true, planId: true },
			}),
		]);

		const usageIds = usageRecords.map((record) => record.id);
		const [allocations, usageCorrections] = await Promise.all([
			usageIds.length
				? this.prisma.usageLotAllocation.findMany({
						where: { usageId: { in: usageIds } },
					})
				: Promise.resolve([]),
			usageIds.length
				? (
					// @org-scope-exempt: 已由父集合（reservationWhere 筛选的计划/使用记录）限定租户边界，按关联 ID 批量回查
					this.prisma.correction.findMany({
						where: { targetType: "USAGE", targetId: { in: usageIds } },
						select: { targetId: true, createdAt: true },
					})
				)
				: Promise.resolve([]),
		]);

		const lotIds = [...new Set(allocations.map((row) => row.lotId))];
		// @org-scope-exempt: 已由父集合（reservationWhere 筛选的计划/使用分摊）限定租户边界，按 lotIds 批量回查
		const lots = lotIds.length
			? await this.prisma.costLot.findMany({
					where: { id: { in: lotIds } },
					select: { id: true, sourceType: true, sourceId: true },
				})
			: [];

		// 手续费探测（§4.1）：分摊批次的 PURCHASE 来源交易 ∪ 计划关联交易（更正查询 id 域）
		const planTransactionIdList = planTransactions.map((tx) => tx.id);
		const purchaseSourceIds = lots
			.filter((lot) => lot.sourceType === "PURCHASE")
			.map((lot) => lot.sourceId);
		const feeProbeIds = [
			...new Set([...purchaseSourceIds, ...planTransactionIdList]),
		];
		const [feeTransactions, transactionCorrections] = await Promise.all([
			feeProbeIds.length
				? (
					// @org-scope-exempt: 已由父集合（reservationWhere 筛选的计划/批次）限定租户边界，按关联交易 ID 回查手续费
					this.prisma.transaction.findMany({
						where: { id: { in: feeProbeIds } },
						select: { id: true, feeAmount: true },
					})
				)
				: Promise.resolve([]),
			planTransactionIdList.length
				? (
					// @org-scope-exempt: 已由父集合（reservationWhere 筛选的计划关联交易）限定租户边界，按关联交易 ID 回查更正
					this.prisma.correction.findMany({
						where: {
							targetType: "TRANSACTION",
							targetId: { in: planTransactionIdList },
						},
						select: { targetId: true, createdAt: true },
					})
				)
				: Promise.resolve([]),
		]);

		// 内存分组（join 全部在本层完成，calculator 零 IO）
		const usageRecordsByPlan = new Map<string, ReportUsageRecordRow[]>();
		for (const record of usageRecords) {
			const list = usageRecordsByPlan.get(record.planId) ?? [];
			list.push({
				id: record.id,
				amount: record.amount,
				updatedAt: record.updatedAt,
			});
			usageRecordsByPlan.set(record.planId, list);
		}
		const allocationsByUsageId = new Map<string, UsageLotAllocationRow[]>();
		for (const allocation of allocations) {
			const list =
				allocationsByUsageId.get(allocation.usageId) ?? [];
			list.push({
				usageId: allocation.usageId,
				lotId: allocation.lotId,
				quantity: allocation.quantity,
				cost: allocation.cost,
			});
			allocationsByUsageId.set(allocation.usageId, list);
		}
		const feeAmountByTransactionId = new Map(
			feeTransactions.map(
				(tx) => [tx.id, tx.feeAmount] as const,
			),
		);
		const usageCorrectionTimes = new Map<string, Date[]>();
		for (const correction of usageCorrections) {
			const list = usageCorrectionTimes.get(correction.targetId) ?? [];
			list.push(correction.createdAt);
			usageCorrectionTimes.set(correction.targetId, list);
		}
		const planTransactionIdsByPlan = new Map<string, string[]>();
		for (const tx of planTransactions) {
			if (tx.planId) {
				const list = planTransactionIdsByPlan.get(tx.planId) ?? [];
				list.push(tx.id);
				planTransactionIdsByPlan.set(tx.planId, list);
			}
		}
		const transactionCorrectionTimes = new Map<string, Date[]>();
		for (const correction of transactionCorrections) {
			const list =
				transactionCorrectionTimes.get(correction.targetId) ?? [];
			list.push(correction.createdAt);
			transactionCorrectionTimes.set(correction.targetId, list);
		}

		return {
			usageRecordsByPlan,
			allocationsByUsageId,
			lotById: new Map(lots.map((lot) => [lot.id, lot] as const)),
			feeAmountByTransactionId,
			usageCorrectionTimes,
			planTransactionIdsByPlan,
			transactionCorrectionTimes,
		};
	}

	/**
	 * 单计划聚合：记录/分摊/批次/手续费内存 join 后交 calculator（§4.1 口径唯一实现）。
	 * 裸外键（usage_lot_allocations.lot_id 无 FK）：批次缺失为数据破坏信号，
	 * 如实按 PURCHASE + 未知手续费保守聚合并 warn（对齐 account 模块「不掩盖」原则）。
	 */
	private aggregateForPlan(
		planId: string,
		context: UsageContext,
	): PlanUsageAggregate {
		const records = context.usageRecordsByPlan.get(planId) ?? [];
		const allocations: ReportAllocationRow[] = [];
		for (const record of records) {
			for (const allocation of context.allocationsByUsageId.get(record.id) ??
				[]) {
				const lot = context.lotById.get(allocation.lotId);
				if (!lot) {
					this.logger.warn(
						`分摊明细引用的成本批次缺失 lotId=${allocation.lotId} usageId=${allocation.usageId} planId=${planId}`,
					);
				}
				const sourceType = lot?.sourceType ?? "PURCHASE";
				const feeAmount =
					sourceType === "PURCHASE" && lot
						? (context.feeAmountByTransactionId.get(lot.sourceId) ?? null)
						: null;
				allocations.push({
					usageId: allocation.usageId,
					quantity: allocation.quantity,
					cost: allocation.cost,
					sourceType,
					feeAmount,
				});
			}
		}
		return aggregatePlanUsage(records, allocations);
	}

	/** 信息更新时间（§4.2 口径 3）：使用记录 updatedAt + USAGE 更正 + 该计划交易更正，取 max */
	private resolveUpdatedAt(planId: string, context: UsageContext): Date | null {
		const times: Date[] = [];
		for (const record of context.usageRecordsByPlan.get(planId) ?? []) {
			times.push(record.updatedAt);
			for (const correction of context.usageCorrectionTimes.get(record.id) ?? []) {
				times.push(correction);
			}
		}
		for (const txId of context.planTransactionIdsByPlan.get(planId) ?? []) {
			for (const correction of context.transactionCorrectionTimes.get(txId) ?? []) {
				times.push(correction);
			}
		}
		return computeReportUpdatedAt(times);
	}

	/** 列表单项 DTO（金额 toFixed(4)、均价 roundRateTo8 后 toFixed(8)；null 语义见口径） */
	private toListItemDto(
		plan: Plan,
		aggregate: PlanUsageAggregate,
		context: UsageContext,
	): ReportPlanListItemDto {
		const updatedAt = this.resolveUpdatedAt(plan.id, context);
		return {
			planId: plan.id,
			name: plan.name,
			status: plan.status,
			currencyCode: plan.targetCurrency,
			targetAmount: plan.targetAmount.toFixed(4),
			usedQuantity: aggregate.usedQuantity.toFixed(4),
			usedTotalCost:
				aggregate.usedTotalCost === null
					? null
					: aggregate.usedTotalCost.toFixed(4),
			usedUnitCost:
				aggregate.usedUnitCost === null
					? null
					: formatUnitCost(aggregate.usedUnitCost),
			hasUnknownFee: aggregate.hasUnknownFee,
			updatedAt: updatedAt ? updatedAt.toISOString() : null,
		};
	}

	/** 来源拆分单项 DTO（无该来源数量恒 "0.0000"；批次必有成本，cost 恒有值） */
	private toSourceSplitItemDto(
		quantity: Prisma.Decimal,
		cost: Prisma.Decimal,
	): ReportSourceSplitItemDto {
		return { quantity: quantity.toFixed(4), cost: cost.toFixed(4) };
	}
}
