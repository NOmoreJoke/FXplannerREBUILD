import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { getCurrency } from "@fxplanner-new/money";
import { Prisma, type Transaction as TransactionModel } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OnboardingNotCompletedException } from "../onboarding/onboarding.service";
import {
	compatReadWhere,
	type ReadScope,
} from "../authorization/organization-scope";
import {
	assertUnitCostInRange,
	buildPurchaseLot,
} from "../account/account-calculator";
import type { CreateTransactionDto, TransactionDto } from "./dto/transaction.dto";
import {
	assertQuantityPrecision,
	assertRateDecimalPlaces,
	assertSelfConsistent,
	assertTransactedAtInRange,
	assertValidTransactedAt,
	parseFeeAmount,
	parsePositiveAmount,
	TransactionInvalidParamsException,
} from "./transaction-calculator";

/**
 * 模块错误（错误响应统一 { code, message }，风格与 plan/rate 模块一致）。
 * 参数类错误（400 INVALID_TRANSACTION_PARAMS / ROUND_TO_ZERO）由 transaction-calculator 抛出；
 * 本文件定义依赖查询结果的业务状态错误：
 * - PLAN_NOT_FOUND（404）：关联计划不存在或不属于本人（不泄露他人数据）
 * - PLAN_CURRENCY_MISMATCH（400）：计划目标币种与买入币种不一致
 * - TRANSACTION_NOT_FOUND（404）：交易不存在或不属于本人
 */
export class PlanNotFoundException extends HttpException {
	constructor() {
		super(
			{ code: "PLAN_NOT_FOUND", message: "关联的计划不存在" },
			HttpStatus.NOT_FOUND,
		);
	}
}

export class PlanCurrencyMismatchException extends HttpException {
	constructor() {
		super(
			{
				code: "PLAN_CURRENCY_MISMATCH",
				message: "关联计划的目标币种与本次买入币种不一致",
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}

export class TransactionNotFoundException extends HttpException {
	constructor() {
		super(
			{ code: "TRANSACTION_NOT_FOUND", message: "交易记录不存在" },
			HttpStatus.NOT_FOUND,
		);
	}
}

@Injectable()
export class TransactionService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	/**
	 * 创建买入记录（POST /api/transactions，方案 §5.1）：
	 * 参数解析与自洽校验（事务外，失败不进事务）→ unitCost 容量预校验（事务外，§3.4）→
	 * 交互式事务——
	 * ① planId 非空时校验计划存在/本人/币种一致（不改动计划任何数据，仅标记）
	 * ② account.upsert 自动建户 + balance 原子累加（并发首购 P2002 降级 update+increment）
	 * ③ 插入 Transaction（version=1、rateSource="MANUAL"、rateObservedAt=transactedAt）
	 * ④ 补写 CostLot 成本批次（sourceType=PURCHASE，remainingQty=quantity；与存量回填
	 *    共用 buildPurchaseLot，account-module §3.4）——FIFO 成本核算的数据基础；
	 * 同一事务边界，任一失败全部回滚（含第④步，批次与余额/交易行原子一致）。
	 */
	async create(userId: string, dto: CreateTransactionDto): Promise<TransactionDto> {
		const params = await this.parseParams(userId, dto);

		// unitCost 容量预校验（§3.4）：Decimal(20,10) 整数位仅 10 位，合法录入域可达 unitCost=1e11，
		// 溢出时 Prisma 抛 P2000 变 500——必须在进入事务前拦截（400 INVALID_TRANSACTION_PARAMS）
		assertUnitCostInRange(params.principalAmount, params.feeAmount, params.quantity);

		return this.prisma.$transaction(async (tx) => {
			// ① 关联计划校验：裸外键（无 Prisma relation），业务层校验归属与币种
			let planName: string | null = null;
			if (dto.planId) {
				const plan = await tx.plan.findUnique({
					where: { id: dto.planId },
					select: { userId: true, targetCurrency: true, name: true },
				});
				if (!plan || plan.userId !== userId) {
					throw new PlanNotFoundException();
				}
				if (plan.targetCurrency !== params.currencyCode) {
					throw new PlanCurrencyMismatchException();
				}
				planName = plan.name;
			}

			// ② 自动建户 + 余额累加：increment 生成 SET balance = balance + x，
			// 禁止「先读再写回」（READ COMMITTED 下并发同币种买入会丢更新，方案 §4.4）
			try {
				await tx.account.upsert({
					where: {
						userId_currencyCode: {
							userId,
							currencyCode: params.currencyCode,
						},
					},
					create: {
						userId,
						currencyCode: params.currencyCode,
						balance: params.quantity,
					},
					update: { balance: { increment: params.quantity } },
				});
			} catch (error) {
				// 并发首次建户竞态：唯一约束冲突则账户已被并发请求创建，降级为累加
				if (
					error instanceof Prisma.PrismaClientKnownRequestError &&
					error.code === "P2002"
				) {
					await tx.account.update({
						where: {
							userId_currencyCode: {
								userId,
								currencyCode: params.currencyCode,
							},
						},
						data: { balance: { increment: params.quantity } },
					});
				} else {
					throw error;
				}
			}

			// ③ 落交易记录：提交的汇率一律视为实际成交数据（doc 14）
			const transaction = await tx.transaction.create({
				data: {
					userId,
					currencyCode: params.currencyCode,
					quantity: params.quantity,
					principalAmount: params.principalAmount,
					feeAmount: params.feeAmount,
					exchangeRate: params.exchangeRate,
					rateSource: "MANUAL",
					rateObservedAt: params.transactedAt,
					planId: dto.planId ?? null,
					transactedAt: params.transactedAt,
				},
			});

			// ④ 补写成本批次（§3.4）：与存量回填共用 buildPurchaseLot（含容量预校验），
			// remainingQty=quantity（新批次未消耗）；任一后续失败随事务整体回滚
			await tx.costLot.create({ data: buildPurchaseLot(transaction) });

			return this.toTransactionDto(transaction, planName);
		});
	}

	/**
	 * 交易详情（GET /transactions/:id，方案 §5.2）：
	 * 按 id + userId 联查，不存在或不属于本人一律 404（不泄露存在性）。
	 */
	async detail(scope: ReadScope, id: string): Promise<TransactionDto> {
		const transaction = await this.prisma.transaction.findFirst({
			where: { id, ...compatReadWhere(scope) },
		});
		if (!transaction) {
			throw new TransactionNotFoundException();
		}
		let planName: string | null = null;
		if (transaction.planId) {
			// 裸外键：计划可能已被删除，名称缺失时兜底 null
			const plan = await this.prisma.plan.findUnique({
				where: { id: transaction.planId },
				select: { name: true },
			});
			planName = plan?.name ?? null;
		}
		return this.toTransactionDto(transaction, planName);
	}

	// ────────────────────────── 私有辅助 ──────────────────────────

	/** 入参规范化与合法性校验（方案 §4.6），全部失败路径抛 400 */
	private async parseParams(userId: string, dto: CreateTransactionDto) {
		const normalizedCurrency = dto.currencyCode?.trim().toUpperCase() ?? "";
		const currencyInfo = getCurrency(normalizedCurrency);
		// DTO 已用 IsIn 挡未知币种，此处防御性兜底并取币种精度
		if (!currencyInfo) {
			throw new TransactionInvalidParamsException(
				`币种必须是支持的 15 种币种之一，收到：${dto.currencyCode}`,
			);
		}

		const principalAmount = parsePositiveAmount(dto.principalAmount, "本金金额");
		const exchangeRate = parsePositiveAmount(dto.exchangeRate, "汇率");
		assertRateDecimalPlaces(exchangeRate);
		const quantity = parsePositiveAmount(dto.quantity, "到账数量");
		assertQuantityPrecision(quantity, currencyInfo.decimalPlaces);
		const feeAmount = parseFeeAmount(dto.feeAmount);

		const transactedAt = new Date(dto.transactedAt);
		// 无效 / 越界日期在查库之前拦截（评审 R3-I06 同类面）：DTO 会放行解析不出时间的写法
		assertValidTransactedAt(transactedAt);
		// 日期上下界：UTC+8 口径不晚于今天；不早于账本起点（未设置时不校验下界）
		const settings = await this.prisma.userSettings.findUnique({
			where: { userId },
			select: { ledgerStartedAt: true },
		});
		// BE-03 防线：未建账不允许录交易（错误体附 /onboarding 引导，与 plan/usage 一致）
		if (!settings) {
			throw new OnboardingNotCompletedException(
				"尚未完成首次设置，请先前往 /onboarding 完成建账后再录入交易",
			);
		}
		assertTransactedAtInRange(transactedAt, new Date(), settings.ledgerStartedAt);

		// 三值双向自洽（权威防线；前端互算仅作体验层，方案 §6）
		assertSelfConsistent(
			principalAmount,
			exchangeRate,
			quantity,
			currencyInfo.decimalPlaces,
		);

		return {
			currencyCode: normalizedCurrency,
			decimalPlaces: currencyInfo.decimalPlaces,
			principalAmount,
			exchangeRate,
			quantity,
			feeAmount,
			transactedAt,
		};
	}

	/** 金额序列化统一 toFixed(4)、汇率 toFixed(8)（方案 §5.1 评审修正口径） */
	private toTransactionDto(
		transaction: TransactionModel,
		planName: string | null,
	): TransactionDto {
		const feeAmount = transaction.feeAmount;
		return {
			id: transaction.id,
			currencyCode: transaction.currencyCode,
			quantity: transaction.quantity.toFixed(4),
			principalAmount: transaction.principalAmount.toFixed(4),
			feeAmount: feeAmount === null ? null : feeAmount.toFixed(4),
			totalCost:
				feeAmount === null
					? null
					: transaction.principalAmount.add(feeAmount).toFixed(4),
			feeKnown: feeAmount !== null,
			exchangeRate: transaction.exchangeRate.toFixed(8),
			planId: transaction.planId,
			planName,
			transactedAt: transaction.transactedAt.toISOString(),
			version: transaction.version,
		};
	}
}
