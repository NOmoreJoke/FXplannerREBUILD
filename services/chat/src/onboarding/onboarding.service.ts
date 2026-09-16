import {
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
} from "@nestjs/common";
import { getCurrency } from "@fxplanner-new/money";
import { PrismaService } from "../prisma/prisma.service";
import { utc8DayStart } from "../transaction/transaction-calculator";
import {
	CONSENT_TYPES,
	CURRENT_TERMS_VERSION,
	type ConsentType,
} from "./onboarding.constants";
import type {
	CompleteOnboardingDto,
	OnboardingCompleteResultDto,
	OnboardingConsentsResultDto,
	OnboardingSettingsViewDto,
	OnboardingStatusDto,
	SaveConsentsDto,
} from "./dto/onboarding.dto";

/**
 * 模块错误（错误响应统一 { code, message }，风格与 rate 模块一致）。
 * 契约见技术方案 §2：
 * - CONSENT_REQUIRED（400）：条款先行——未确认年龄与当前版本条款时不能完成设置
 * - INVALID_BASE_CURRENCY（400）：本位币必须在 money 包 15 币种内
 * - ONBOARDING_ALREADY_COMPLETED（409）：已有设置（本位币锁定；并发重复由唯一约束兜底）
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

/**
 * 首次设置编排（技术方案 §2/§3）：
 * - 完成态判定 / 条款 / 完成设置；向导中间态无后端存储，中断即从头重填；
 * - 本位币锁定的保证：UserSettings 创建后本模块（及全代码库）不存在任何
 *   更新 baseCurrency 的写路径，本模块不提供 settings 更新入口。
 */
@Injectable()
export class OnboardingService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	/** 完成态判定：只读无副作用 */
	async getStatus(userId: string): Promise<OnboardingStatusDto> {
		const [settings, consentCount] = await Promise.all([
			this.prisma.userSettings.findUnique({ where: { userId } }),
			this.countCurrentConsents(this.prisma.termsConsent, userId),
		]);

		return {
			completed: settings !== null,
			requiredConsentsMet: consentCount >= CONSENT_TYPES.length,
			settings: settings ? this.toSettingsView(settings) : null,
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
	 * 完成设置（技术方案 §3.1）：全程交互式事务——
	 * ① 条款校验 ② 币种校验 ③ 已有设置 → 409 ④ 创建 UserSettings
	 * （ledgerStartedAt = 事务内同一时刻）。
	 * 并发/重复提交的最终防线是 UserSettings.userId 唯一约束：
	 * 同时通过检查的两个请求，第二个在插入处触发 P2002 → 映射 409，
	 * 不依赖"先查后建"（check-then-act 竞态窗口）。
	 */
	async complete(
		userId: string,
		dto: CompleteOnboardingDto,
	): Promise<OnboardingCompleteResultDto> {
		return this.prisma.$transaction(async (tx) => {
			await this.assertRequiredConsents(tx.termsConsent, userId);
			const baseCurrency = this.assertBaseCurrency(dto.baseCurrency);

			const existing = await tx.userSettings.findUnique({
				where: { userId },
			});
			if (existing) {
				throw new OnboardingAlreadyCompletedException();
			}

			// 记账起点 = 完成设置当日（UTC+8）日初：
			// 若取精确时刻，用户当天在 UI 录入交易（表单提交当日 00:00Z = 北京 08:00）会早于起点被拒；
			// 对齐日初后当天任意时刻可录入，历史日期（< 当日）照旧拒绝
			const completedAt = utc8DayStart(new Date());
			const settings = await tx.userSettings
				.create({
					data: {
						userId,
						baseCurrency,
						locale: dto.locale,
						region: dto.region,
						prepPreference: dto.prepPreference,
						reminderEnabled: dto.reminderEnabled,
						ledgerStartedAt: completedAt,
					},
				})
				.catch((error: unknown) => {
					if ((error as { code?: string }).code === "P2002") {
						throw new OnboardingAlreadyCompletedException();
					}
					throw error;
				});

			return {
				settings: this.toSettingsView(settings),
				ledgerStartedAt: completedAt,
			};
		});
	}

	private async assertRequiredConsents(
		store: TermsConsentStore,
		userId: string,
	): Promise<void> {
		const count = await this.countCurrentConsents(store, userId);
		if (count < CONSENT_TYPES.length) {
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
