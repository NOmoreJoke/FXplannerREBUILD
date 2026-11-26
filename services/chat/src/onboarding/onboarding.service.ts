import {
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
	Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
	assertAmountLimit,
	finalAmountOf,
	getCurrency,
	MoneyError,
	roundRateTo8,
} from "@fxplanner-new/money";
import { PrismaService } from "../prisma/prisma.service";
import {
	lockOrgLedgerAccounts,
	upsertOrgAccount,
} from "../prisma/ledger-write-lock";
import { RateService } from "../rate/rate.service";
import type {
	LatestRateGroupResponse,
	LatestRateItem,
	LatestRateResponse,
} from "../rate/rate.service";
import { utc8DayStart } from "../transaction/transaction-calculator";
import {
	AuditService,
	recordDeniedAuditBestEffort,
} from "../audit/audit.service";
import { PermissionDeniedException } from "../authorization/authorization.errors";
import type {
	ActorContext,
	OrganizationRole,
} from "../authorization/authorization.types";
import type { ReadScope } from "../authorization/organization-scope";
import { can } from "../authorization/permission-policy";
import { lockOrganizationForActor } from "../organization/default-organization";
import {
	PERSONAL_DEFAULT_LOCALE,
	PERSONAL_DEFAULT_REGION,
	resolveOrganizationPreferences,
} from "../organization/organization-preferences";
import {
	CONSENT_TYPES,
	CURRENT_TERMS_VERSION,
	type ConsentType,
} from "./onboarding.constants";
import type {
	CompleteOnboardingDto,
	InitialHoldingCreatedDto,
	InitialHoldingItemDto,
	InitialHoldingsResultDto,
	OnboardingCompleteResultDto,
	OnboardingConsentsResultDto,
	OnboardingSettingsViewDto,
	OnboardingStatusDto,
	SaveConsentsDto,
} from "./dto/onboarding.dto";

/**
 * 模块错误（错误响应统一 { code, message }，风格与 rate 模块一致）。
 * 契约见 changes/onboarding-rework/技术方案.md §4：
 * - CONSENT_REQUIRED（400）：条款先行——未确认年龄与当前版本条款时不能完成设置
 * - INVALID_BASE_CURRENCY（400）：本位币必须在 money 包 15 币种内
 * - ONBOARDING_ALREADY_COMPLETED（409）：已有设置（本位币锁定；并发重复由唯一约束兜底）
 * - ONBOARDING_NOT_COMPLETED（409）：尚未完成首次设置（补录前置）
 * - INITIAL_HOLDING_EXISTS（409）：该币种已有初始持仓记录（每币种仅一笔；并发由唯一约束兜底）
 * - RATE_UNAVAILABLE（400）：无有效报价（项级错误/超时/数据源不可用统一映射，整单回滚）
 * - INVALID_HOLDINGS（400）：持仓币种非法（不在 15 币种/等于本位币/重复）
 * - INVALID_AMOUNT（400）：金额或折算成本非法（≤0/超上限/小数位非法/舍入为 0）
 */
export class OnboardingConsentRequiredException extends HttpException {
	constructor() {
		super(
			{
				code: "CONSENT_REQUIRED",
				message: "请先确认已满 18 周岁并同意当前版本服务条款",
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}

export class OnboardingInvalidCurrencyException extends HttpException {
	constructor(currency: string) {
		super(
			{
				code: "INVALID_BASE_CURRENCY",
				message: `本位币必须是支持的 15 种币种之一，收到：${currency}`,
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}

export class OnboardingAlreadyCompletedException extends HttpException {
	constructor() {
		super(
			{
				code: "ONBOARDING_ALREADY_COMPLETED",
				message: "首次设置已完成，本位币不可更改，设置不可重复提交",
			},
			HttpStatus.CONFLICT,
		);
	}
}

export class OnboardingNotCompletedException extends HttpException {
	/**
	 * @param message 缺省与 reminder/settings/data-request 既有防线一致；
	 *   记账写入口（plan/transaction/usage，BE-03）传入含 /onboarding 引导的文案。
	 */
	constructor(
		message = "尚未完成首次设置",
	) {
		super(
			{
				code: "ONBOARDING_NOT_COMPLETED",
				message,
			},
			HttpStatus.CONFLICT,
		);
	}
}

export class InitialHoldingExistsException extends HttpException {
	constructor() {
		super(
			{
				code: "INITIAL_HOLDING_EXISTS",
				message:
					"该币种已有初始记录；金额有误请在对应币种账户的初始记录中发起更正",
			},
			HttpStatus.CONFLICT,
		);
	}
}

export class RateUnavailableException extends HttpException {
	constructor() {
		super(
			{
				code: "RATE_UNAVAILABLE",
				message: "暂无有效汇率报价，请稍后重试",
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}

export class InvalidHoldingsException extends HttpException {
	constructor(message: string) {
		super({ code: "INVALID_HOLDINGS", message }, HttpStatus.BAD_REQUEST);
	}
}

export class InvalidAmountException extends HttpException {
	constructor(message: string) {
		super({ code: "INVALID_AMOUNT", message }, HttpStatus.BAD_REQUEST);
	}
}

type TermsConsentStore = {
	count(args: {
		where: {
			userId: string;
			termsVersion: string;
			consentType: { in: string[] };
		};
	}): Promise<number>;
	upsert(args: {
		where: {
			userId_termsVersion_consentType: {
				userId: string;
				termsVersion: string;
				consentType: string;
			};
		};
		create: {
			userId: string;
			termsVersion: string;
			consentType: string;
			consentedAt: Date;
		};
		update: Record<string, never>;
	}): Promise<{ consentType: string; consentedAt: Date }>;
};

/** 事务失败阶段标记（可观测性：技术方案 §7，本次新立口径） */
type FailureStage = "CONSENT" | "RATE" | "LIMIT" | "UNIQUE";

/** rate-service 最新报价响应（单目标平铺 / 多目标组） */
type LatestRatesResponse = LatestRateResponse | LatestRateGroupResponse;

/** 个人展示偏好的产品默认值（与 settings 模块同源） */
const ONBOARDING_DEFAULT_LOCALE = PERSONAL_DEFAULT_LOCALE;
const ONBOARDING_DEFAULT_REGION = PERSONAL_DEFAULT_REGION;

/**
 * 首次设置编排（技术方案 §2/§3）：
 * - 完成态判定 / 条款 / 完成设置；向导中间态无后端存储，中断即从头重填；
 * - 本位币锁定的保证：本位币只存于 OrganizationSettings，创建后本模块
 *   （及全代码库）不存在任何更新 baseCurrency 的写路径（settings 模块 PATCH
 *   为白名单四字段，不含 baseCurrency）；
 * - 初始持仓：complete 可选入参与建账后补录共用单一入账方法 recordInitialHoldings，
 *   取价→时效断言→算成本→写 InitialHolding+CostLot→按批次汇总重算 Account，
 *   任一失败整体回滚。
 */
@Injectable()
export class OnboardingService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(RateService) private readonly rateService: RateService,
		@Inject(Logger) private readonly logger: Logger,
		@Inject(AuditService) private readonly auditService: AuditService,
	) {}

	/**
	 * 完成态判定：只读无副作用（W18 组织隔离；评审 I-10）。
	 *
	 * 完成态与组织偏好以**当前组织**为准（resolveOrganizationPreferences：
	 * 唯一真相是 OrganizationSettings，无行即未建账）——此前只读请求者本人的
	 * UserSettings：受邀加入已建账组织的成员读到 completed=false（前端据此
	 * 永久停发提醒），而已建账成员切到未建账的新组织却读到 completed=true。
	 * locale/region 是个人展示偏好、条款确认进度是个人维度，两者仍按请求者本人取值。
	 */
	async getStatus(scope: ReadScope): Promise<OnboardingStatusDto> {
		const [preferences, personal, consentCount] = await Promise.all([
			resolveOrganizationPreferences(this.prisma, scope.organizationId),
			this.prisma.userSettings.findUnique({
				where: { userId: scope.userId },
				select: { locale: true, region: true },
			}),
			this.countCurrentConsents(this.prisma.termsConsent, scope.userId),
		]);

		return {
			completed: preferences !== null,
			requiredConsentsMet: consentCount >= CONSENT_TYPES.length,
			settings: preferences
				? this.toSettingsView({
						baseCurrency: preferences.baseCurrency,
						locale: personal?.locale ?? ONBOARDING_DEFAULT_LOCALE,
						region: personal?.region ?? ONBOARDING_DEFAULT_REGION,
						prepPreference: preferences.prepPreference,
						reminderEnabled: preferences.reminderEnabled,
						ledgerStartedAt: preferences.ledgerStartedAt,
					})
				: null,
			currentTermsVersion: CURRENT_TERMS_VERSION,
		};
	}

	/** 条款确认：按 (userId, termsVersion, consentType) upsert，重复确认幂等保留首次时间 */
	async saveConsents(
		userId: string,
		dto: SaveConsentsDto,
	): Promise<OnboardingConsentsResultDto> {
		// 双保险：ValidationPipe 未启用（如直调 service）时也拒绝未确认的提交
		if (dto.age18Confirmed !== true || dto.termsConfirmed !== true) {
			throw new OnboardingConsentRequiredException();
		}
		const consentedAt = new Date();
		// 两条确认要么同时落库要么同时回滚
		const records = await this.prisma.$transaction(async (tx) => {
			const results: { consentType: string; consentedAt: Date }[] = [];
			for (const consentType of CONSENT_TYPES) {
				results.push(
					await tx.termsConsent.upsert({
						where: {
							userId_termsVersion_consentType: {
								userId,
								termsVersion: CURRENT_TERMS_VERSION,
								consentType,
							},
						},
						create: {
							userId,
							termsVersion: CURRENT_TERMS_VERSION,
							consentType,
							consentedAt,
						},
						// 重复确认幂等：不覆盖 consentedAt（保留首次时间）
						update: {},
					}),
				);
			}
			return results;
		});

		const byType = (consentType: ConsentType) => {
			const record = records.find((item) => item.consentType === consentType);
			if (!record) {
				throw new Error(`条款确认落库失败：${consentType}`);
			}
			return record.consentedAt;
		};
		return {
			termsVersion: CURRENT_TERMS_VERSION,
			age18ConsentedAt: byType("age18"),
			termsConsentedAt: byType("terms"),
		};
	}

	/**
	 * 完成设置（ToB R1 W22 组织独立建账 + 锁内复验 + 组织账本锁 + 同事务审计）：
	 * ① 个人条款校验 ② 本位币校验 ③ 事务内 lockOrganizationForActor 复验 settings.update
	 * ④ 校验当前组织建账态（resolveOrganizationPreferences 非空 → 409，不因本人 UserSettings 阻塞新组织）
	 * ⑤ 若带 initialHoldings：assertHoldings 后在写前先取组织级账本锁 lockOrgLedgerAccounts
	 * ⑥ 创建 OrganizationSettings（P2002 → 409）+ 维护本人 UserSettings（仅补建或只改 locale/region）
	 * ⑦ 入账初始持仓（带 organizationId / createdById）+ 同事务写 onboarding.complete 审计。
	 */
	async complete(
		actor: ActorContext,
		dto: CompleteOnboardingDto,
		requestId: string | null = null,
	): Promise<OnboardingCompleteResultDto> {
		await this.assertRequiredConsents(this.prisma.termsConsent, actor.userId);
		const baseCurrency = this.assertBaseCurrency(dto.baseCurrency);

		let deniedRole: OrganizationRole = actor.role;
		try {
			return await this.prisma.$transaction(async (tx) => {
				const latestRole = await lockOrganizationForActor(tx, actor);
				if (!can(latestRole, "settings.update")) {
					deniedRole = latestRole;
					throw new PermissionDeniedException();
				}

				const existingPreferences = await resolveOrganizationPreferences(
					tx,
					actor.organizationId,
				);
				if (existingPreferences !== null) {
					this.warnFailure(actor.userId, "UNIQUE", "首次设置已完成，重复提交");
					throw new OnboardingAlreadyCompletedException();
				}

				const holdings = dto.initialHoldings ?? [];
				if (holdings.length > 0) {
					this.assertHoldings(baseCurrency, holdings);
					const codes = holdings.map((item) =>
						item.currencyCode.trim().toUpperCase(),
					);
					await lockOrgLedgerAccounts(tx, actor.organizationId, codes);
				}

				// 记账起点 = 完成设置当日（UTC+8）日初：
				// 若取精确时刻，用户当天在 UI 录入交易（表单提交当日 00:00Z = 北京 08:00）会早于起点被拒；
				// 对齐日初后当天任意时刻可录入，历史日期（< 当日）照旧拒绝
				const completedAt = utc8DayStart(new Date());
				const prepPreference = dto.prepPreference ?? "balanced";
				const reminderEnabled = dto.reminderEnabled ?? true;

				const orgSettings = await tx.organizationSettings
					.create({
						data: {
							organizationId: actor.organizationId,
							baseCurrency,
							prepPreference,
							reminderEnabled,
							ledgerStartedAt: completedAt,
						},
					})
					.catch((error: unknown) => {
						if ((error as { code?: string }).code === "P2002") {
							this.warnFailure(
								actor.userId,
								"UNIQUE",
								"组织设置唯一约束冲突（并发重复提交）",
							);
							throw new OnboardingAlreadyCompletedException();
						}
						throw error;
					});

				// 个人展示行维护（W30 MIG-F）：UserSettings 只承载个人展示偏好
				// （locale / region）；组织偏好（本位币 / 准备节奏 / 提醒开关 / 记账起点）
				// 已全部归 OrganizationSettings，个人行不再写任何组织域字段。
				const personal = await tx.userSettings.upsert({
					where: { userId: actor.userId },
					create: {
						userId: actor.userId,
						locale: dto.locale,
						region: dto.region,
					},
					update: {
						locale: dto.locale,
						region: dto.region,
					},
					select: { locale: true, region: true },
				});

				// 可选初始持仓：与 settings 同事务入账，任一失败整体回滚
				let created: InitialHoldingCreatedDto[] = [];
				if (holdings.length > 0) {
					created = await this.recordInitialHoldings(
						tx,
						actor,
						baseCurrency,
						completedAt,
						holdings,
					);
				}

				await this.auditService.recordInTx(tx, {
					organizationId: actor.organizationId,
					actorUserId: actor.userId,
					actorType: "USER",
					action: "onboarding.complete",
					targetType: "organization_settings",
					targetId: actor.organizationId,
					result: "SUCCESS",
					requestId: requestId ?? null,
					detail: {
						baseCurrency,
						holdingsCount: created.length,
					},
				});

				this.logHoldingsSuccess("onboarding_complete", actor.userId, created);

				return {
					settings: this.toSettingsView({
						baseCurrency: orgSettings.baseCurrency,
						locale: personal.locale,
						region: personal.region,
						prepPreference: orgSettings.prepPreference,
						reminderEnabled: orgSettings.reminderEnabled,
						ledgerStartedAt: orgSettings.ledgerStartedAt,
					}),
					ledgerStartedAt: completedAt,
				};
			});
		} catch (error) {
			if (error instanceof PermissionDeniedException) {
				await this.recordDeniedAudit(actor, deniedRole, requestId);
			}
			throw error;
		}
	}

	/**
	 * 建账后补录初始持仓（ToB R1 W22 组织作用域 + 账本锁 + 同事务审计）：
	 * - 事务内 lockOrganizationForActor 复验 settings.update；
	 * - 未建账 → 409 ONBOARDING_NOT_COMPLETED；
	 * - assertHoldings 后先取组织账本锁，再按当前组织作用域查重（409 INITIAL_HOLDING_EXISTS）；
	 * - 写入带 organizationId / createdById 的记录并同事务写 onboarding.initial_holdings 审计。
	 */
	async saveInitialHoldings(
		actor: ActorContext,
		dto: { holdings: InitialHoldingItemDto[] },
		requestId: string | null = null,
	): Promise<InitialHoldingsResultDto> {
		let deniedRole: OrganizationRole = actor.role;
		try {
			return await this.prisma.$transaction(async (tx) => {
				const latestRole = await lockOrganizationForActor(tx, actor);
				if (!can(latestRole, "settings.update")) {
					deniedRole = latestRole;
					throw new PermissionDeniedException();
				}

				const preferences = await resolveOrganizationPreferences(
					tx,
					actor.organizationId,
				);
				if (!preferences) {
					this.warnFailure(
						actor.userId,
						"CONSENT",
						"补录前置检查：尚未完成首次设置",
					);
					throw new OnboardingNotCompletedException();
				}

				this.assertHoldings(preferences.baseCurrency, dto.holdings);
				const codes = dto.holdings.map((item) =>
					item.currencyCode.trim().toUpperCase(),
				);
				await lockOrgLedgerAccounts(tx, actor.organizationId, codes);

				// 锁内按当前组织作用域查重（不做部分成功）；并发兜底由唯一约束承担
				const existing = await tx.initialHolding.findMany({
					where: {
						organizationId: actor.organizationId,
						currencyCode: { in: codes },
					},
					select: { currencyCode: true },
				});
				if (existing.length > 0) {
					this.warnFailure(
						actor.userId,
						"UNIQUE",
						`币种已有初始持仓记录：${existing.map((row) => row.currencyCode).join(",")}`,
					);
					throw new InitialHoldingExistsException();
				}

				const ledgerStartedAt =
					preferences.ledgerStartedAt ?? utc8DayStart(new Date());
				const created = await this.recordInitialHoldings(
					tx,
					actor,
					preferences.baseCurrency,
					ledgerStartedAt,
					dto.holdings,
				);

				await this.auditService.recordInTx(tx, {
					organizationId: actor.organizationId,
					actorUserId: actor.userId,
					actorType: "USER",
					action: "onboarding.initial_holdings",
					targetType: "organization_settings",
					targetId: actor.organizationId,
					result: "SUCCESS",
					requestId: requestId ?? null,
					detail: {
						baseCurrency: preferences.baseCurrency,
						holdingsCount: created.length,
						currencies: created.map((item) => item.currencyCode),
					},
				});

				this.logHoldingsSuccess("onboarding_backfill", actor.userId, created);

				return { created, ledgerStartedAt };
			});
		} catch (error) {
			if (error instanceof PermissionDeniedException) {
				await this.recordDeniedAudit(actor, deniedRole, requestId);
			}
			throw error;
		}
	}

	/**
	 * 初始持仓入账（complete 与补录共用唯一入口，技术方案 §5.1 / ToB R1 W22）：
	 * ① 币种/金额校验 ② 批量取价（现汇卖出价优先，项级错误统一 400）③ 逐币种：
	 *    8 位舍入 → 成本折算（按本位币精度）→ 按当前确认时刻复核 fresh/validUntil →
	 *    写 InitialHolding（P2002 → 409）→ 写 CostLot(sourceType=INITIAL) →
	 *    Account 余额按组织全部批次 remainingQty 汇总重算后按
	 *    (organizationId, currencyCode) upsert。
	 * 本方法必须在持有组织账本锁的事务内调用：任一异常抛出即整体回滚。
	 */
	private async recordInitialHoldings(
		tx: Prisma.TransactionClient,
		actor: ActorContext,
		baseCurrency: string,
		ledgerStartedAt: Date,
		items: InitialHoldingItemDto[],
	): Promise<InitialHoldingCreatedDto[]> {
		this.assertHoldings(baseCurrency, items);
		const codes = items.map((item) => item.currencyCode.trim().toUpperCase());

		// 取价：base=本位币、target=外币（rate/sellRate 均为「1 外币 = X 本位币」，
		// 采用价 = sellRate ?? rate，对齐前端 rate-latest 录入价口径）
		const itemByTarget = await this.fetchLatestQuotes(
			actor.userId,
			baseCurrency,
			codes,
		);

		const created: InitialHoldingCreatedDto[] = [];
		for (const item of items) {
			const code = item.currencyCode.trim().toUpperCase();
			const quote = itemByTarget.get(code);
			if (!quote || "error" in quote) {
				this.warnFailure(actor.userId, "RATE", `币种 ${code} 无有效报价`);
				throw new RateUnavailableException();
			}
			const adopted = quote.sellRate ?? quote.rate;
			// observedAt 仅记录供应商发布时间；报价时效按系统确认窗口判断。
			const observedAt = new Date(quote.observedAt);

			const rate = roundRateTo8(adopted);
			const amount = new Prisma.Decimal(item.amount);
			// 成本以本位币计价：按本位币精度舍一次（JPY/KRW 本位币取整），非持仓币种精度
			const baseCurrencyInfo = getCurrency(baseCurrency);
			let cost: Prisma.Decimal;
			try {
				// 中间全精度 × 一次舍入；正数舍 0 / 非法值由 money 包拦截
				cost = finalAmountOf(amount, rate, baseCurrencyInfo!.decimalPlaces);
				assertAmountLimit(cost);
			} catch (error) {
				this.warnFailure(actor.userId, "LIMIT", `币种 ${code} 折算成本被拒`);
				throw new InvalidAmountException(
					`${code} 折算成本非法：${this.moneyErrorMessage(error)}`,
				);
			}

			// 前一币种的异步写入可能跨过本报价的有效期。
			const confirmedAt = Date.now();
			if (!this.isFreshQuote(quote, confirmedAt)) {
				this.warnFailure(
					actor.userId,
					"RATE",
					`币种 ${code} 报价在写账前已失效`,
				);
				throw new RateUnavailableException();
			}
			const holding = await tx.initialHolding
				.create({
					data: {
						organizationId: actor.organizationId,
						createdById: actor.userId,
						currencyCode: code,
						amount,
						rate,
						// 原报价与采用价一并落库（ExchangeRate 同 observedAt upsert 会覆盖原值，不可依赖回溯）
						rawRate: new Prisma.Decimal(adopted),
						rateSource: quote.source,
						rateObservedAt: observedAt,
						cost,
						confirmedAt: new Date(confirmedAt),
					},
				})
				.catch((error: unknown) => {
					if ((error as { code?: string }).code === "P2002") {
						this.warnFailure(
							actor.userId,
							"UNIQUE",
							`币种 ${code} 初始持仓唯一约束冲突（并发补录）`,
						);
						throw new InitialHoldingExistsException();
					}
					throw error;
				});

			// 成本批次：字段口径与 buildPurchaseLot（PURCHASE）一致——
			// quantity/remainingQty=持仓数量、unitCost=采用汇率、totalCost=折算成本；
			// acquiredAt=ledgerStartedAt（INITIAL 批次排同日 PURCHASE 之前，满足未来消耗排序前置）
			await tx.costLot.create({
				data: {
					organizationId: actor.organizationId,
					currencyCode: code,
					sourceType: "INITIAL",
					sourceId: holding.id,
					quantity: amount,
					remainingQty: amount,
					unitCost: rate,
					totalCost: cost,
					acquiredAt: ledgerStartedAt,
				},
			});

			// 按组织维度收口账户余额：同组织同币种恒有且仅有一行账户
			await upsertOrgAccount({
				tx,
				organizationId: actor.organizationId,
				currencyCode: code,
				actorUserId: actor.userId,
				computeBalance: async ({ existingBalance }) => {
					const aggregated = await tx.costLot.aggregate({
						_sum: { remainingQty: true },
						where: {
							currencyCode: code,
							organizationId: actor.organizationId,
						},
					});
					const lotSum = new Prisma.Decimal(aggregated._sum.remainingQty ?? 0);
					return Prisma.Decimal.max(lotSum, existingBalance.add(amount));
				},
			});

			created.push({
				currencyCode: code,
				amount: amount.toFixed(4),
				rate: rate.toFixed(10),
				rawRate: new Prisma.Decimal(adopted).toFixed(10),
				rateSource: quote.source,
				rateObservedAt: observedAt,
				cost: cost.toFixed(4),
			});
		}
		return created;
	}

	private async recordDeniedAudit(
		actor: ActorContext,
		role: OrganizationRole,
		requestId: string | null,
	): Promise<void> {
		await recordDeniedAuditBestEffort(this.auditService, this.logger, {
			actor,
			role,
			required: "settings.update",
			requestId,
		});
	}

	/**
	 * 批量取价并归一为 items 映射：单目标平铺响应（无 items）包一层、
	 * 多目标组响应原样取 items（两种响应形状归一，对齐前端 use-latest-rates 思路）。
	 * 取价复用新鲜缓存，过期或缺失时同步回源一次。按系统确认时效 fresh/validUntil
	 * 判断能否入账，取价失败、项级错误或报价过期均映射为 400 RATE_UNAVAILABLE。
	 */
	private async fetchLatestQuotes(
		userId: string,
		baseCurrency: string,
		codes: string[],
	): Promise<Map<string, LatestRateItem>> {
		let response: LatestRatesResponse;
		try {
			response = await this.rateService.getLatestForBooking(baseCurrency, codes);
		} catch {
			this.warnFailure(userId, "RATE", "汇率服务取价失败（整体异常）");
			throw new RateUnavailableException();
		}
		const items = "items" in response ? response.items : [response];
		const now = Date.now();
		const allFresh = items.every((item) => this.isFreshQuote(item, now));
		if (!allFresh) {
			this.warnFailure(userId, "RATE", "存在不可用或过期报价");
			throw new RateUnavailableException();
		}
		return new Map(items.map((item) => [item.target, item]));
	}

	private isFreshQuote(item: LatestRateItem, now: number): boolean {
		if (!("fresh" in item) || !item.fresh) return false;
		const until = Date.parse(item.validUntil);
		return Number.isFinite(until) && now < until;
	}

	/**
	 * 持仓币种/金额校验（同步，无 IO）：
	 * a) 币种 ∈ money 包 15 币种（normalize 后）b) ≠ 本位币 c) 数组内去重
	 * d) 金额有效且 < 10¹¹（money 包 assertAmountLimit）e) 小数位 ≤ 币种精度（JPY/KRW 整数）。
	 */
	private assertHoldings(
		baseCurrency: string,
		items: InitialHoldingItemDto[],
	): void {
		const seen = new Set<string>();
		for (const item of items) {
			const code = item.currencyCode.trim().toUpperCase();
			const currency = getCurrency(code);
			if (!currency) {
				throw new InvalidHoldingsException(
					`初始持仓币种必须是支持的 15 种币种之一，收到：${item.currencyCode}`,
				);
			}
			if (code === baseCurrency) {
				throw new InvalidHoldingsException(
					`初始持仓币种不能与本位币相同：${code}`,
				);
			}
			if (seen.has(code)) {
				throw new InvalidHoldingsException(`初始持仓币种重复：${code}`);
			}
			seen.add(code);

			try {
				assertAmountLimit(new Prisma.Decimal(item.amount));
			} catch (error) {
				throw new InvalidAmountException(
					`${code} 金额非法：${this.moneyErrorMessage(error)}`,
				);
			}
			const amount = new Prisma.Decimal(item.amount);
			if (amount.dp() > currency.decimalPlaces) {
				throw new InvalidAmountException(
					currency.decimalPlaces === 0
						? `${code} 为整数币种（如日元/韩元），持仓金额不能带小数位`
						: `${code} 持仓金额最多支持 ${currency.decimalPlaces} 位小数`,
				);
			}
		}
	}

	/** MoneyError → 用户可读原因（防御未知错误类型的兜底文案） */
	private moneyErrorMessage(error: unknown): string {
		return error instanceof MoneyError
			? error.message
			: "金额必须为大于 0 且小于单笔上限的有效数字";
	}

	/** 成功入账 Info 日志：只含 userId、币种代码、报价来源与报价时间；金额/成本/本位币不落日志 */
	private logHoldingsSuccess(
		event: string,
		userId: string,
		created: InitialHoldingCreatedDto[],
	): void {
		this.logger.log({
			event,
			userId,
			currencies: created.map((item) => ({
				code: item.currencyCode,
				rateSource: item.rateSource,
				rateObservedAt: item.rateObservedAt.toISOString(),
			})),
		});
	}

	/** 事务失败 Warn 日志：带失败阶段标记（CONSENT/RATE/LIMIT/UNIQUE），不含金额与本位币值 */
	private warnFailure(userId: string, stage: FailureStage, reason: string): void {
		this.logger.warn({ event: "onboarding_transaction_failed", userId, stage, reason });
	}

	private async assertRequiredConsents(
		store: TermsConsentStore,
		userId: string,
	): Promise<void> {
		const count = await this.countCurrentConsents(store, userId);
		if (count < CONSENT_TYPES.length) {
			this.warnFailure(userId, "CONSENT", "必要条款未确认齐全");
			throw new OnboardingConsentRequiredException();
		}
	}

	private async countCurrentConsents(
		store: TermsConsentStore,
		userId: string,
	): Promise<number> {
		return store.count({
			where: {
				userId,
				termsVersion: CURRENT_TERMS_VERSION,
				consentType: { in: [...CONSENT_TYPES] },
			},
		});
	}

	/** 币种校验：与 rate 模块同源（money 包 CURRENCIES 15 币种），返回规范化值 */
	private assertBaseCurrency(baseCurrency: string): string {
		const normalized = baseCurrency.trim().toUpperCase();
		if (!getCurrency(normalized)) {
			throw new OnboardingInvalidCurrencyException(baseCurrency);
		}
		return normalized;
	}

	private toSettingsView(settings: {
		baseCurrency: string;
		locale: string;
		region: string;
		prepPreference: string;
		reminderEnabled: boolean;
		ledgerStartedAt: Date | null;
	}): OnboardingSettingsViewDto {
		return {
			baseCurrency: settings.baseCurrency,
			locale: settings.locale,
			region: settings.region,
			prepPreference: settings.prepPreference,
			reminderEnabled: settings.reminderEnabled,
			ledgerStartedAt: settings.ledgerStartedAt,
		};
	}
}
