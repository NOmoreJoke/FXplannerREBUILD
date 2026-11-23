import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { OnboardingNotCompletedException } from "../onboarding/onboarding.service";
import type { ReadScope } from "../authorization/organization-scope";
import type {
	SettingsViewDto,
	UpdateSettingsDto,
} from "./dto/update-settings.dto";

/**
 * 设置更新空入参（400 SETTINGS_UPDATE_EMPTY）：白名单四字段全空时拒绝。
 * 含 baseCurrency 的请求经全局 ValidationPipe whitelist 剥离后为空 → 落入本错误
 * （本位币无更新写路径的第一道防线，DTO 不声明该字段）。
 */
export class SettingsUpdateEmptyException extends HttpException {
	constructor() {
		super(
			{
				code: "SETTINGS_UPDATE_EMPTY",
				message: "至少提供一个要更新的设置字段",
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}

/**
 * 用户设置读写（settings-rework 技术方案 §4.3/§4.4）：
 * - GET：完整设置视图（含 User.email；未建账 409 复用 onboarding 的
 *   OnboardingNotCompletedException，不复制错误类）；
 * - PATCH：白名单四字段（region/locale/prepPreference/reminderEnabled），全空 400；
 *   幂等（同值更新无副作用）。
 * 质量红线：baseCurrency 无任何更新写路径——本 service 不存在携带 baseCurrency
 * 的写调用，唯一写为 prisma.userSettings.update 且 data 只来自白名单四字段。
 */
@Injectable()
export class SettingsService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	/**
	 * 查询完整设置视图（未建账 → 409 ONBOARDING_NOT_COMPLETED；W18 组织隔离）：
	 * 个人展示字段（email/locale/region）读 UserSettings；组织偏好
	 * （baseCurrency/prepPreference/reminderEnabled/ledgerStartedAt）优先读
	 * OrganizationSettings（LEDGER-02），未迁旧记录回落 UserSettings 原值。
	 */
	async getSettings(scope: ReadScope): Promise<SettingsViewDto> {
		const view = await this.getUserSettingsView(scope.userId);
		const orgSettings = await this.prisma.organizationSettings.findUnique({
			where: { organizationId: scope.organizationId },
		});
		if (orgSettings) {
			return {
				...view,
				baseCurrency: orgSettings.baseCurrency,
				prepPreference: orgSettings.prepPreference,
				reminderEnabled: orgSettings.reminderEnabled,
				ledgerStartedAt: orgSettings.ledgerStartedAt,
			};
		}
		return view;
	}

	/** UserSettings 原值视图（写路径收尾复用；未建账 409） */
	private async getUserSettingsView(
		userId: string,
	): Promise<SettingsViewDto> {
		const settings = await this.prisma.userSettings.findUnique({
			where: { userId },
			include: { user: { select: { email: true } } },
		});
		if (!settings) {
			throw new OnboardingNotCompletedException();
		}
		return this.toView(settings);
	}

	/**
	 * 更新偏好（幂等）：显式白名单组装 data（DTO 枚举已校验，service 不重复校验）；
	 * 记录不存在时 Prisma 抛 P2025 → 409。baseCurrency 永不出现在 data 中。
	 */
	async updateSettings(
		userId: string,
		dto: UpdateSettingsDto,
	): Promise<SettingsViewDto> {
		const data: {
			region?: string;
			locale?: string;
			prepPreference?: string;
			reminderEnabled?: boolean;
		} = {};
		if (dto.region !== undefined) data.region = dto.region;
		if (dto.locale !== undefined) data.locale = dto.locale;
		if (dto.prepPreference !== undefined) {
			data.prepPreference = dto.prepPreference;
		}
		if (dto.reminderEnabled !== undefined) {
			data.reminderEnabled = dto.reminderEnabled;
		}
		if (Object.keys(data).length === 0) {
			throw new SettingsUpdateEmptyException();
		}

		await this.prisma.userSettings
			.update({ where: { userId }, data })
			.catch((error: unknown) => {
				if ((error as { code?: string }).code === "P2025") {
					throw new OnboardingNotCompletedException();
				}
				throw error;
			});
		// 写路径收尾返回 UserSettings 原值（compat：组织偏好覆盖语义仅 GET 展示，
		// 个人写路径的响应忠实反映本次写入；组织化写随 Goal #3B 收口）
		return this.getUserSettingsView(userId);
	}

	/** UserSettings（含 user.email）→ 视图 DTO（金额/时间不做格式化，序列化交给 HTTP 层） */
	private toView(settings: {
		region: string;
		locale: string;
		baseCurrency: string;
		prepPreference: string;
		reminderEnabled: boolean;
		ledgerStartedAt: Date | null;
		user: { email: string | null };
	}): SettingsViewDto {
		return {
			email: settings.user.email,
			region: settings.region,
			locale: settings.locale,
			baseCurrency: settings.baseCurrency,
			prepPreference: settings.prepPreference,
			reminderEnabled: settings.reminderEnabled,
			ledgerStartedAt: settings.ledgerStartedAt,
		};
	}
}
