import {
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
	Logger,
} from "@nestjs/common";
import { getCurrency } from "@fxplanner-new/money";
import type { Transaction as TransactionModel } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
	lockOrgLedgerAccounts,
	upsertOrgAccountWithLegacyMerge,
} from "../prisma/ledger-write-lock";
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
	compatReadWhere,
	type ReadScope,
} from "../authorization/organization-scope";
import { can } from "../authorization/permission-policy";
import { lockOrganizationForActor } from "../organization/default-organization";
import {
	materializeLegacyOrganizationSettings,
	resolveOrganizationPreferences,
} from "../organization/organization-preferences";
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
 * - PLAN_NOT_FOUND（404）：关联计划不存在或不属于当前组织（不泄露跨组织数据）
 * - PLAN_CURRENCY_MISMATCH（400）：计划目标币种与买入币种不一致
 * - TRANSACTION_NOT_FOUND（404）：交易不存在或不属于当前组织
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
	private readonly logger = new Logger(TransactionService.name);

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(AuditService) private readonly auditService: AuditService,
	) {}

	/**
	 * 创建买入记录（POST /api/transactions，方案 §5.1 / ToB R1 W23）：
	 * 参数解析与自洽校验（事务外，失败不进事务）→ unitCost 容量预校验（事务外，§3.4）→
	 * 交互式事务——
	 * ① lockOrganizationForActor 重读最新角色并复验 transaction.create（锁等降权 → 403 + DENIED 审计）
	 * ② resolveOrganizationPreferences 解析组织建账态（409）与记账起点；OWNER_LEGACY 先固化，
	 *    再校验 assertTransactedAtInRange
	 * ③ lockOrgLedgerAccounts 锁定组织账本账户（兼容默认组织创建者 legacy 行）
	 * ④ planId 非空时按 compatReadWhere(actor) 校验计划归属（404）/同组织一致/币种一致（400）
	 * ⑤ 经 upsertOrgAccountWithLegacyMerge 收口默认创建者 legacy 行（如有）并累加余额
	 * ⑥ 插入 Transaction（userId + organizationId + createdById）与 CostLot（带 organizationId）
	 * ⑦ 同事务写入 transaction.create 审计日志（审计失败整单回滚）。
	 */
	async create(
		actor: ActorContext,
		dto: CreateTransactionDto,
		requestId: string | null = null,
	): Promise<TransactionDto> {
		const params = this.parseParams(dto);

		// unitCost 容量预校验（§3.4）：Decimal(20,10) 整数位仅 10 位，合法录入域可达 unitCost=1e11，
		// 溢出时 Prisma 抛 P2000 变 500——必须在进入事务前拦截（400 INVALID_TRANSACTION_PARAMS）
		assertUnitCostInRange(params.principalAmount, params.feeAmount, params.quantity);

		let deniedRole: OrganizationRole = actor.role;
		try {
			return await this.prisma.$transaction(async (tx) => {
				const latestRole = await lockOrganizationForActor(tx, actor);
				if (!can(latestRole, "transaction.create")) {
					deniedRole = latestRole;
					throw new PermissionDeniedException();
				}

				const preferences = await resolveOrganizationPreferences(
					tx,
					actor.organizationId,
				);
				if (!preferences) {
					throw new OnboardingNotCompletedException(
						"尚未完成首次设置，请先前往 /onboarding 完成建账后再录入交易",
					);
				}
				if (preferences.source === "OWNER_LEGACY") {
					await materializeLegacyOrganizationSettings(tx, actor.organizationId);
				}
				assertTransactedAtInRange(
					params.transactedAt,
					new Date(),
					preferences.ledgerStartedAt,
				);

				await lockOrgLedgerAccounts(
					tx,
					actor.organizationId,
					[params.currencyCode],
				);

				// 关联计划校验：裸外键（无 Prisma relation），按 compatReadWhere(actor) 校验归属与币种
				let planName: string | null = null;
				if (dto.planId) {
					const plan = await tx.plan.findFirst({
						where: { id: dto.planId, ...compatReadWhere(actor) },
						select: {
							id: true,
							organizationId: true,
							targetCurrency: true,
							name: true,
						},
					});
					if (!plan) {
						throw new PlanNotFoundException();
					}
					if (plan.organizationId !== null) {
						assertParentChildSameOrg(plan.organizationId, actor.organizationId);
					}
					if (plan.targetCurrency !== params.currencyCode) {
						throw new PlanCurrencyMismatchException();
					}
					planName = plan.name;
				}

				// 账户建户、默认创建者 legacy 行收口与余额累加（I-2：无论由 Owner 还是受邀成员触发，
				// 一并合并/升级默认组织创建者的 legacy 行，消除双行分裂与 P2002）
				await upsertOrgAccountWithLegacyMerge({
					tx,
					organizationId: actor.organizationId,
					currencyCode: params.currencyCode,
					actorUserId: actor.userId,
					computeBalance: ({ existingBalance }) =>
						existingBalance.add(params.quantity),
				});

				// 落交易记录：提交的汇率一律视为实际成交数据（doc 14）
				const transaction = await tx.transaction.create({
					data: {
						userId: actor.userId,
						organizationId: actor.organizationId,
						createdById: actor.userId,
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

				// 补写成本批次（§3.4）：与存量回填共用 buildPurchaseLot（含 organizationId 与容量预校验），
				// remainingQty=quantity（新批次未消耗）；任一后续失败随事务整体回滚
				await tx.costLot.create({ data: buildPurchaseLot(transaction) });

				await this.auditService.recordInTx(tx, {
					organizationId: actor.organizationId,
					actorUserId: actor.userId,
					actorType: "USER",
					action: "transaction.create",
					targetType: "transaction",
					targetId: transaction.id,
					result: "SUCCESS",
					requestId: requestId ?? null,
					detail: {
						currencyCode: transaction.currencyCode,
						quantity: transaction.quantity.toFixed(4),
						principalAmount: transaction.principalAmount.toFixed(4),
						feeKnown: transaction.feeAmount !== null,
						planId: transaction.planId,
					},
				});

				return this.toTransactionDto(transaction, planName);
			});
		} catch (error) {
			if (error instanceof PermissionDeniedException) {
				await this.recordDeniedAudit(actor, deniedRole, requestId);
			}
			throw error;
		}
	}

	/**
	 * 交易详情（GET /transactions/:id，方案 §5.2）：
	 * 按 id + compatReadWhere(scope) 联查，不存在或不属于当前组织一律 404（不泄露存在性）。
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
			// 裸外键：计划可能已被删除，按同组织作用域兜底名称（禁跨组织泄露）
			const plan = await this.prisma.plan.findFirst({
				where: { id: transaction.planId, ...compatReadWhere(scope) },
				select: { name: true },
			});
			planName = plan?.name ?? null;
		}
		return this.toTransactionDto(transaction, planName);
	}

	// ────────────────────────── 私有辅助 ──────────────────────────

	private async recordDeniedAudit(
		actor: ActorContext,
		role: OrganizationRole,
		requestId: string | null,
	): Promise<void> {
		await recordDeniedAuditBestEffort(this.auditService, this.logger, {
			actor,
			role,
			required: "transaction.create",
			requestId,
		});
	}

	/** 入参规范化与合法性校验（方案 §4.6），全部失败路径抛 400（不含日期范围，范围在事务内取组织设置后校验） */
	private parseParams(dto: CreateTransactionDto) {
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
		// 无效 / 越界日期在进事务之前拦截（评审 R3-I06 同类面）：DTO 会放行解析不出时间的写法
		assertValidTransactedAt(transactedAt);

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
