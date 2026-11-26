import {
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
	Logger,
} from "@nestjs/common";
import { getCurrency } from "@fxplanner-new/money";
import { Prisma, type Account } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
	orgWhere,
	type ReadScope,
} from "../authorization/organization-scope";
import { resolveOrganizationPreferences } from "../organization/organization-preferences";
import {
	computeRemainingCost,
	mergeLedgerItems,
	sumAllocatedByCurrency,
} from "./account-calculator";
import type {
	AccountDetailDto,
	AccountLedgerDto,
	AccountLedgerItemDto,
	AccountListDto,
	AccountListItemDto,
	AccountPlanAllocationDto,
	AccountPlanAllocationListDto,
} from "./dto/account.dto";

/**
 * 模块错误（错误响应统一 { code, message }，风格与 transaction/plan 模块一致）：
 * - INVALID_ACCOUNT_CURRENCY（400）：币种不在 15 种支持列表
 * - ACCOUNT_NOT_FOUND（404）：该币种未建账户（含他人账户，不泄露存在性）
 */
export class AccountCurrencyInvalidException extends HttpException {
	constructor(message: string) {
		super(
			{ code: "INVALID_ACCOUNT_CURRENCY", message },
			HttpStatus.BAD_REQUEST,
		);
	}
}

export class AccountNotFoundException extends HttpException {
	constructor() {
		super(
			{ code: "ACCOUNT_NOT_FOUND", message: "该币种暂无外汇账户" },
			HttpStatus.NOT_FOUND,
		);
	}
}

/** 流水源行的内存中间形态：排序键（Date）+ 展示字段，排序后剥离 createdAt 映射出参 DTO */
interface LedgerSourceItem {
	id: string;
	type: "PURCHASE" | "USAGE" | "INITIAL";
	occurredAt: Date;
	createdAt: Date;
	quantity: string;
	totalCost: string | null;
	feeKnown: boolean;
	version: number;
}

/**
 * 外汇账户只读编排（account-module 技术方案 §3.1/§4）：并行查询 + 调 account-calculator，
 * 业务计算逻辑禁止内联（口径唯一实现在 calculator，单测覆盖）。
 */
@Injectable()
export class AccountService {
	private readonly logger = new Logger(AccountService.name);

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	/**
	 * 账户列表（GET /api/accounts，§4.1；W18 组织隔离）：当前组织账户
	 * （currencyCode 升序）+ 本位币 + 分配汇总。账户查询按**纯组织作用域**
	 * （W30 MIG-E/F：账户行属于组织，跨成员共享，无兼容回落分支）；
	 * baseCurrency 取 OrganizationSettings（组织设置是唯一真相）。
	 */
	async list(scope: ReadScope): Promise<AccountListDto> {
		const [accounts, baseCurrency, allocatedByCurrency] = await Promise.all([
			this.prisma.account.findMany({
				where: orgWhere(scope),
				orderBy: { currencyCode: "asc" },
			}),
			this.resolveBaseCurrency(scope),
			this.sumAllocatedByCurrencyForUser(scope),
		]);
		return {
			baseCurrency,
			accounts: accounts.map((account) =>
				this.toListItemDto(account, allocatedByCurrency, scope.userId),
			),
		};
	}

	/**
	 * 账户详情（GET /api/accounts/:currencyCode，§4.2；W18 组织隔离）：
	 * 列表单项字段 + 剩余成本/平均单位成本。币种先按 money 包校验（400），
	 * 再按组织作用域查账户（跨组织/不存在统一 404，不泄露存在性）。
	 */
	async detail(
		scope: ReadScope,
		currencyCodeRaw: string,
	): Promise<AccountDetailDto> {
		const currencyCode = this.normalizeCurrency(currencyCodeRaw);
		const [account, baseCurrency, costLots, allocatedByCurrency] =
			await Promise.all([
				this.prisma.account.findFirst({
					where: { currencyCode, ...orgWhere(scope) },
				}),
				this.resolveBaseCurrency(scope),
				this.prisma.costLot.findMany({
					where: { currencyCode, ...orgWhere(scope) },
				}),
				this.sumAllocatedByCurrencyForUser(scope),
			]);
		if (!account) {
			throw new AccountNotFoundException();
		}
		const { remainingTotalCost, averageUnitCost } =
			computeRemainingCost(costLots);
		return {
			baseCurrency,
			...this.toListItemDto(account, allocatedByCurrency, scope.userId),
			// 序列化口径（§3.3）：成本 toFixed(4)、单位成本 toFixed(8)；边界下 null
			remainingTotalCost:
				remainingTotalCost === null
					? null
					: remainingTotalCost.toFixed(4),
			averageUnitCost:
				averageUnitCost === null ? null : averageUnitCost.toFixed(8),
		};
	}

	/**
	 * 账户按计划分配明细（GET /api/accounts/:currencyCode/allocations，阶段5 §2 功能 13 收尾）：
	 * 纯只读事实展示——不过滤计划状态（与 allocatedAmount 汇总口径一致：CANCELLED
	 * 已释放 amount=max(used,0)，剩余 0 仍如实列出）；remainingAllocation = amount −
	 * usedAmount（Decimal 服务端算好，前端禁止重算）。amount 与 usedAmount 均为 0 的
	 * 计划（从未分配/取消且无使用）不产生明细行——对汇总贡献为 0，列出即噪声。
	 * PlanAllocation 与 Plan 裸外键无 relation，沿用内存 join 先例（§3.3）。
	 * 排序：计划创建时间升序（稳定确定）；无分页无上限（个位到十位级；上限截断会与
	 * allocatedAmount 全量汇总口径错位——前 N 个全零而第 N+1 个有分配时出现
	 * 「明细为空、汇总非零」的不一致，对抗审 M2）。
	 */
	async allocations(
		scope: ReadScope,
		currencyCodeRaw: string,
	): Promise<AccountPlanAllocationListDto> {
		const currencyCode = this.normalizeCurrency(currencyCodeRaw);
		// 取消计划会在同一事务中更新状态和分配额，读取也必须使用同一快照。
		const { plans, allocations } = await this.prisma.$transaction(
			async (tx) => {
				const account = await tx.account.findFirst({
					where: { currencyCode, ...orgWhere(scope) },
					select: { id: true },
				});
				if (!account) {
					throw new AccountNotFoundException();
				}
				const plans = await tx.plan.findMany({
					where: { targetCurrency: currencyCode, ...orgWhere(scope) },
					orderBy: { createdAt: "asc" },
					select: { id: true, name: true, status: true },
				});
				const allocations =
					plans.length > 0
						? await tx.planAllocation.findMany({
								where: { planId: { in: plans.map((plan) => plan.id) } },
							})
						: [];
				return { plans, allocations };
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
		);
		const allocationByPlanId = new Map(
			allocations.map((allocation) => [allocation.planId, allocation]),
		);
		const items: AccountPlanAllocationDto[] = [];
		for (const plan of plans) {
			const allocation = allocationByPlanId.get(plan.id);
			if (!allocation) continue; // 无分配行：对汇总贡献 0，不出明细
			if (allocation.amount.isZero() && allocation.usedAmount.isZero()) {
				continue; // 全 0 行（从未分配/取消且无使用）：无事实可展示
			}
			items.push({
				planId: plan.id,
				planName: plan.name,
				planStatus: plan.status,
				amount: allocation.amount.toFixed(4),
				usedAmount: allocation.usedAmount.toFixed(4),
				remainingAllocation: allocation.amount
					.sub(allocation.usedAmount)
					.toFixed(4),
			});
		}
		return { items };
	}

	/**
	 * 账户流水（GET /api/accounts/:currencyCode/transactions，§4.3）：
	 * Transaction（type=PURCHASE）+ UsageRecord（type=USAGE）+ InitialHolding（type=INITIAL，
	 * M8 起：账户流水初始持仓行承载「更正」入口，corrections 技术方案 §7）并行查询后内存合并，
	 * occurredAt 倒序、同刻 createdAt 倒序。USAGE 行 totalCost 由 M7 起
	 * 按 UsageLotAllocation 按 usageId 聚合填实（方案 §3.5 遗留落地），契约与前端零改动。
	 */
	async ledger(
		scope: ReadScope,
		currencyCodeRaw: string,
	): Promise<AccountLedgerDto> {
		const currencyCode = this.normalizeCurrency(currencyCodeRaw);
		const [account, baseCurrency] = await Promise.all([
			this.prisma.account.findFirst({
				where: { currencyCode, ...orgWhere(scope) },
			}),
			this.resolveBaseCurrency(scope),
		]);
		if (!account) {
			throw new AccountNotFoundException();
		}
		const [transactions, usageRecords, initialHoldings] = await Promise.all([
			this.prisma.transaction.findMany({
				where: { currencyCode, ...orgWhere(scope) },
			}),
			this.prisma.usageRecord.findMany({
				where: { currencyCode, ...orgWhere(scope) },
			}),
			this.prisma.initialHolding.findMany({
				where: { currencyCode, ...orgWhere(scope) },
			}),
		]);
		// USAGE 行成本（M7 落地）：按 usageId 聚合分摊明细（一次 groupBy，禁止循环内查询）
		const usageCostRows =
			usageRecords.length > 0
				? await this.prisma.usageLotAllocation.groupBy({
						by: ["usageId"],
						where: {
							usageId: { in: usageRecords.map((record) => record.id) },
						},
						_sum: { cost: true },
					})
				: [];
		const costByUsage = new Map(
			usageCostRows.map((row) => [
				row.usageId,
				row._sum.cost ?? new Prisma.Decimal(0),
			]),
		);

		// 内部行：occurredAt/createdAt 为排序键（Date），排序后剥离 createdAt
		const purchases: LedgerSourceItem[] = transactions.map((transaction) => ({
			id: transaction.id,
			type: "PURCHASE" as const,
			occurredAt: transaction.transactedAt,
			createdAt: transaction.createdAt,
			quantity: transaction.quantity.toFixed(4),
			// 买入成本 = 本金 + 手续费（未知时以本金口径，doc 05「费用可能不完整」）
			totalCost: transaction.principalAmount
				.add(transaction.feeAmount ?? 0)
				.toFixed(4),
			feeKnown: transaction.feeAmount !== null,
			version: transaction.version,
		}));
		const usages: LedgerSourceItem[] = usageRecords.map((record) => ({
			id: record.id,
			type: "USAGE" as const,
			occurredAt: record.usedAt,
			createdAt: record.createdAt,
			quantity: record.amount.toFixed(4),
			// 本笔使用成本 = UsageLotAllocation 按 usageId 聚合（M7 落地，§3.5）
			totalCost: (
				costByUsage.get(record.id) ?? new Prisma.Decimal(0)
			).toFixed(4),
			feeKnown: true,
			version: record.version,
		}));

		const initialItems: LedgerSourceItem[] = initialHoldings.map((holding) => ({
			id: holding.id,
			type: "INITIAL" as const,
			// 展示日期用确认时刻（用户视角的「初始记录日」）；批次 acquiredAt 的账本起点口径仅用于 FIFO 排序
			occurredAt: holding.confirmedAt,
			createdAt: holding.createdAt,
			quantity: holding.amount.toFixed(4),
			totalCost: holding.cost.toFixed(4),
			feeKnown: true,
			version: 1,
		}));

		const merged = mergeLedgerItems(purchases, usages, initialItems);
		const items: AccountLedgerItemDto[] = merged.map(
			// 排序完成后剥离 createdAt 排序键，occurredAt 序列化为 ISO 字符串
			({ occurredAt, createdAt: _createdAt, ...rest }) => ({
				...rest,
				occurredAt: occurredAt.toISOString(),
			}),
		);
		return { baseCurrency, items };
	}

	// ────────────────────────── 私有辅助 ──────────────────────────

	/** 币种规范化（trim + toUpperCase）并按 money 包 15 币种清单校验（§4.2） */
	private normalizeCurrency(raw: string): string {
		const code = raw.trim().toUpperCase();
		if (!getCurrency(code)) {
			throw new AccountCurrencyInvalidException(
				`币种必须是支持的 15 种币种之一，收到：${raw}`,
			);
		}
		return code;
	}

	/**
	 * 本位币解析（W18；LEDGER-02 组织偏好）：统一走组织偏好解析——
	 * OrganizationSettings 优先，兼容回落仅限「该组织是其所有者的默认组织」
	 * （评审 I-08：不再读请求者本人的 UserSettings，避免把个人本位币带进
	 * 其新建或受邀加入的其他组织）；均无 → null。
	 */
	private async resolveBaseCurrency(scope: ReadScope): Promise<string | null> {
		const preferences = await resolveOrganizationPreferences(
			this.prisma,
			scope.organizationId,
		);
		return preferences?.baseCurrency ?? null;
	}

	/**
	 * 组织作用域全部分配明细按币种汇总（§3.3 已分配口径）：Plan（组织作用域）
	 * 与 PlanAllocation（裸外键随父计划）内存关联后交 calculator 求和。
	 */
	private async sumAllocatedByCurrencyForUser(
		scope: ReadScope,
	): Promise<Map<string, Prisma.Decimal>> {
		const plans = await this.prisma.plan.findMany({
			where: orgWhere(scope),
			select: { id: true, targetCurrency: true },
		});
		const allocations =
			plans.length > 0
				? await this.prisma.planAllocation.findMany({
						where: { planId: { in: plans.map((plan) => plan.id) } },
					})
				: [];
		const allocationByPlanId = new Map(
			allocations.map((allocation) => [allocation.planId, allocation]),
		);
		const items = [];
		for (const plan of plans) {
			const allocation = allocationByPlanId.get(plan.id);
			if (allocation) {
				items.push({
					currencyCode: plan.targetCurrency,
					amount: allocation.amount,
					usedAmount: allocation.usedAmount,
				});
			}
		}
		return sumAllocatedByCurrency(items);
	}

	/**
	 * 账户行 → 列表单项 DTO（金额 toFixed(4) 字符串）。
	 * 未分配余额/已分配为负（数据破坏信号，§3.3/§6）时 warn 打印具体数值并如实返回，
	 * 禁止钳 0（§7 例外口径：异常诊断必需，仅限 warn 场景，info 日志不打金额）。
	 */
	private toListItemDto(
		account: Account,
		allocatedByCurrency: Map<string, Prisma.Decimal>,
		userId: string,
	): AccountListItemDto {
		const allocatedAmount =
			allocatedByCurrency.get(account.currencyCode) ??
			new Prisma.Decimal(0);
		const unallocatedAmount = account.balance.sub(allocatedAmount);
		if (allocatedAmount.isNegative() || unallocatedAmount.isNegative()) {
			this.logger.warn(
				`账户分配数据异常（如实返回不钳制，走人工更正流程） userId=${userId} currencyCode=${account.currencyCode} balance=${account.balance.toFixed(4)} allocatedAmount=${allocatedAmount.toFixed(4)} unallocatedAmount=${unallocatedAmount.toFixed(4)}`,
			);
		}
		return {
			currencyCode: account.currencyCode,
			balance: account.balance.toFixed(4),
			allocatedAmount: allocatedAmount.toFixed(4),
			unallocatedAmount: unallocatedAmount.toFixed(4),
		};
	}
}
