import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Account, Plan, PlanAllocation } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RateService } from "../rate/rate.service";
import type {
	AccountSummaryDto,
	HomeStateDto,
	PlanSummaryDto,
	PortfolioByCurrencyDto,
	PortfolioDto,
} from "./dto/home.dto";

/** 无分配记录时的金额占位（固定 4 位小数，方案 §3.1） */
const ZERO_AMOUNT = "0.0000";

/** CostLot 分币种聚合行（$queryRaw 原始列名，契约 §2：SUM/GROUP BY 全部在 SQL 层完成） */
interface PortfolioGroupRow {
	currency_code: string;
	remaining_qty: Prisma.Decimal;
	total_cost: Prisma.Decimal;
}

@Injectable()
export class HomeService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(RateService) private readonly rateService: RateService,
	) {}

	/**
	 * 首页状态（GET /api/home/state，方案 §4.2）：四组查询并行，一次请求返回分流 + 摘要。
	 * 只读、无副作用；空状态只返回原始事实（三布尔），分流规则归前端展示层，后端保持数据中立。
	 */
	async getState(userId: string): Promise<HomeStateDto> {
		const [settings, accounts, plans, latestRateObservedAt] =
			await Promise.all([
				this.prisma.userSettings.findUnique({ where: { userId } }),
				this.prisma.account.findMany({
					where: { userId },
					orderBy: { currencyCode: "asc" },
				}),
				this.prisma.plan.findMany({
					where: { userId },
					orderBy: { createdAt: "desc" },
				}),
				this.rateService.getLatestObservedAt(),
			]);

		// PlanAllocation 与 Plan 无 Prisma relation（planId 为裸外键 + @unique），
		// 方案中的 include 不可行：改为按本页计划 ID 批量取出后内存关联（等价语义）
		const allocations = await this.prisma.planAllocation.findMany({
			where: { planId: { in: plans.map((plan) => plan.id) } },
		});
		const allocationByPlanId = new Map(
			allocations.map((allocation) => [allocation.planId, allocation]),
		);

		return {
			onboardingCompleted: settings !== null,
			hasAccounts: accounts.length > 0,
			hasPlans: plans.length > 0,
			accounts: accounts.map((account) => this.toAccountSummary(account)),
			plans: plans.map((plan) =>
				this.toPlanSummary(
					plan,
					allocationByPlanId.get(plan.id) ?? null,
				),
			),
			latestRateObservedAt: latestRateObservedAt
				? latestRateObservedAt.toISOString()
				: null,
		};
	}

	/**
	 * 持仓聚合（GET /api/home/portfolio，契约 §2）：CostLot 剩余持仓按币种聚合 + 本位币。
	 *
	 * ⚠️ 口径假设：CostLot.unitCost 以用户**当前** baseCurrency 计价（本位币买入价）；
	 * 本位币历史变更不对存量 lot 重算（契约 §2），跨口径数据为近似值。
	 *
	 * 实现要求：聚合在 SQL 层完成（SUM/GROUP BY，WHERE 按 userId 过滤），
	 * 仅分组结果返回内存，禁止全表明细拉内存再过滤（契约 §2）。
	 */
	async getPortfolio(userId: string): Promise<PortfolioDto> {
		const [settings, rows] = await Promise.all([
			this.prisma.userSettings.findUnique({
				where: { userId },
				select: { baseCurrency: true },
			}),
			this.prisma.$queryRaw<PortfolioGroupRow[]>`
				SELECT
					currency_code,
					SUM(remaining_qty) AS remaining_qty,
					SUM(remaining_qty * unit_cost) AS total_cost
				FROM cost_lots
				WHERE user_id = ${userId} AND remaining_qty > 0
				GROUP BY currency_code
				ORDER BY currency_code ASC
			`,
		]);

		// 顶层合计用未舍入的 Decimal 累加后再序列化，避免逐币种先舍入引入累积误差
		const totalRemainingCost = rows
			.reduce(
				(sum, row) => sum.add(row.total_cost),
				new Prisma.Decimal(0),
			)
			.toFixed(4);

		return {
			baseCurrency: settings?.baseCurrency ?? null,
			totalRemainingCost,
			byCurrency: rows.map((row) => this.toPortfolioByCurrency(row)),
		};
	}

	/** 单币种持仓聚合行 → DTO（toFixed 序列化规则同方案 §3.3，除零保护见契约 §2） */
	private toPortfolioByCurrency(
		row: PortfolioGroupRow,
	): PortfolioByCurrencyDto {
		// 除零保护：SQL 已过滤 remaining_qty > 0，但极小量/精度边界下仍防御，避免 NaN/Infinity 泄漏
		const avgUnitCost = row.remaining_qty.isZero()
			? new Prisma.Decimal(0)
			: row.total_cost.div(row.remaining_qty);
		return {
			currencyCode: row.currency_code,
			remainingQty: row.remaining_qty.toFixed(4),
			totalRemainingCost: row.total_cost.toFixed(4),
			avgUnitCost: avgUnitCost.toFixed(10),
		};
	}

	/** 金额序列化：toFixed(4) 固定 4 位小数（裸 toString 会丢尾零，禁止，方案 §3.3） */
	private toAccountSummary(account: Account): AccountSummaryDto {
		return {
			currencyCode: account.currencyCode,
			balance: account.balance.toFixed(4),
		};
	}

	private toPlanSummary(
		plan: Plan,
		allocation: PlanAllocation | null,
	): PlanSummaryDto {
		return {
			id: plan.id,
			targetCurrency: plan.targetCurrency,
			targetAmount: plan.targetAmount.toFixed(4),
			allocatedAmount: allocation
				? allocation.amount.toFixed(4)
				: ZERO_AMOUNT,
			remainingAmount: allocation
				? allocation.amount.sub(allocation.usedAmount).toFixed(4)
				: ZERO_AMOUNT,
			expectUseDate: plan.expectUseDate.toISOString(),
			latestPrepDate: plan.latestPrepDate.toISOString(),
			status: plan.status as PlanSummaryDto["status"],
		};
	}
}
