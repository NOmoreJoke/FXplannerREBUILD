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
	type: "PURCHASE" | "USAGE";
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
	 * 账户列表（GET /api/accounts，§4.1）：账户（currencyCode 升序）+ 本位币 + 分配汇总，
	 * 内存 join（PlanAllocation 与 Plan 裸外键无 relation，home.service 先例）。
	 * 新用户可能无 userSettings 行（注册路径不建），baseCurrency 返回 null。
	 */
	async list(userId: string): Promise<AccountListDto> {
		const [accounts, settings, allocatedByCurrency] = await Promise.all([
			this.prisma.account.findMany({
				where: { userId },
				orderBy: { currencyCode: "asc" },
			}),
			this.prisma.userSettings.findUnique({
				where: { userId },
				select: { baseCurrency: true },
			}),
			this.sumAllocatedByCurrencyForUser(userId),
		]);
		return {
			baseCurrency: settings?.baseCurrency ?? null,
			accounts: accounts.map((account) =>
				this.toListItemDto(account, allocatedByCurrency, userId),
			),
		};
	}

	/**
	 * 账户详情（GET /api/accounts/:currencyCode，§4.2）：列表单项字段 + 剩余成本/平均单位成本。
	 * 币种先按 money 包校验（400），再查账户（无账户 404，不泄露存在性）。
	 */
	async detail(userId: string, currencyCodeRaw: string): Promise<AccountDetailDto> {
		const currencyCode = this.normalizeCurrency(currencyCodeRaw);
		const [account, settings, costLots, allocatedByCurrency] =
			await Promise.all([
				this.prisma.account.findUnique({
					where: { userId_currencyCode: { userId, currencyCode } },
				}),
				this.prisma.userSettings.findUnique({
					where: { userId },
					select: { baseCurrency: true },
				}),
				this.prisma.costLot.findMany({ where: { userId, currencyCode } }),
				this.sumAllocatedByCurrencyForUser(userId),
			]);
		if (!account) {
			throw new AccountNotFoundException();
		}
		const { remainingTotalCost, averageUnitCost } =
			computeRemainingCost(costLots);
		return {
			baseCurrency: settings?.baseCurrency ?? null,
			...this.toListItemDto(account, allocatedByCurrency, userId),
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
	 * 账户流水（GET /api/accounts/:currencyCode/transactions，§4.3）：
	 * Transaction（type=PURCHASE）+ UsageRecord（type=USAGE，M7 前为空表）并行查询后内存合并，
	 * occurredAt 倒序、同刻 createdAt 倒序。UsageRecord 无成本字段，USAGE 行 totalCost 恒 null，
	 * M7 上线时追加 UsageLotAllocation 按 usageId 聚合（方案 §9.3 遗留，契约与前端零改动）。
	 */
	async ledger(userId: string, currencyCodeRaw: string): Promise<AccountLedgerDto> {
		const currencyCode = this.normalizeCurrency(currencyCodeRaw);
		const [account, settings] = await Promise.all([
			this.prisma.account.findUnique({
				where: { userId_currencyCode: { userId, currencyCode } },
			}),
			this.prisma.userSettings.findUnique({
				where: { userId },
				select: { baseCurrency: true },
			}),
		]);
		if (!account) {
			throw new AccountNotFoundException();
		}
		const [transactions, usageRecords] = await Promise.all([
			this.prisma.transaction.findMany({ where: { userId, currencyCode } }),
			this.prisma.usageRecord.findMany({ where: { userId, currencyCode } }),
		]);

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
			// UsageRecord 无成本字段（schema 冻结）；M7 上线时按 UsageLotAllocation 聚合（§9.3）
			totalCost: null,
			feeKnown: true,
			version: record.version,
		}));

		const merged = mergeLedgerItems(purchases, usages);
		const items: AccountLedgerItemDto[] = merged.map(
			// 排序完成后剥离 createdAt 排序键，occurredAt 序列化为 ISO 字符串
			({ occurredAt, createdAt: _createdAt, ...rest }) => ({
				...rest,
				occurredAt: occurredAt.toISOString(),
			}),
		);
		return { baseCurrency: settings?.baseCurrency ?? null, items };
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
	 * 本人全部分配明细按币种汇总（§3.3 已分配口径）：Plan（targetCurrency）与
	 * PlanAllocation（裸外键）内存关联后交 calculator 求和。
	 */
	private async sumAllocatedByCurrencyForUser(
		userId: string,
	): Promise<Map<string, Prisma.Decimal>> {
		const plans = await this.prisma.plan.findMany({
			where: { userId },
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
