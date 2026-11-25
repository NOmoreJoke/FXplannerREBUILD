import {
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
	Logger,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PermissionDeniedException } from "../authorization/authorization.errors";
import type {
	ActorContext,
	OrganizationRole,
} from "../authorization/authorization.types";
import type { ReadScope } from "../authorization/organization-scope";
import { can } from "../authorization/permission-policy";
import { OnboardingNotCompletedException } from "../onboarding/onboarding.service";
import { lockOrganizationForActor } from "../organization/default-organization";
import {
	materializeLegacyOrganizationSettings,
	PERSONAL_DEFAULT_LOCALE,
	PERSONAL_DEFAULT_REGION,
	PERSONAL_PLACEHOLDER_BASE_CURRENCY,
	resolveOrganizationPreferences,
} from "../organization/organization-preferences";
import { PrismaService } from "../prisma/prisma.service";
import type {
	PersonalSettingsViewDto,
	SettingsViewDto,
	UpdatePersonalSettingsDto,
	UpdateSettingsDto,
} from "./dto/update-settings.dto";

/** 个人展示偏好的产品默认值（无个人设置行时使用：受邀成员未独立建账） */
const DEFAULT_REGION = PERSONAL_DEFAULT_REGION;
const DEFAULT_LOCALE = PERSONAL_DEFAULT_LOCALE;

/**
 * 设置更新空入参（400 SETTINGS_UPDATE_EMPTY）：白名单字段全空时拒绝。
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
 * 个人与组织设置读写（ToB R1 W22 个人/组织分离；§4.3/§4.4/§13.1）：
 * - GET /settings：组织偏好 + 本人展示字段完整视图；未建账 409；
 * - PATCH /settings：按字段分权（region/locale → 本人 UserSettings；
 *   prepPreference/reminderEnabled → 组织 OrganizationSettings + 同事务审计）；
 * - GET / PATCH /settings/personal：纯个人展示偏好，无组织/建账前置要求；
 * - 质量红线：baseCurrency 建账后无任何更新写路径。
 */
@Injectable()
export class SettingsService {
	private readonly logger = new Logger(SettingsService.name);

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(AuditService) private readonly auditService: AuditService,
	) {}

	/** 查询纯个人展示偏好（无 UserSettings 行时回落产品默认值，不写库） */
	async getPersonalSettings(
		userId: string,
		identity: { email: string | null },
	): Promise<PersonalSettingsViewDto> {
		const personal = await this.prisma.userSettings.findUnique({
			where: { userId },
			select: { region: true, locale: true },
		});
		return {
			email: identity.email,
			region: personal?.region ?? DEFAULT_REGION,
			locale: personal?.locale ?? DEFAULT_LOCALE,
		};
	}

	/**
	 * 更新纯个人展示偏好（幂等）：无 UserSettings 行时以占位 baseCurrency: "CNY" 创建
	 * 个人展示行（绝不创建 OrganizationSettings，不影响组织未建账判定）；已有行只更新 region/locale。
	 */
	async updatePersonalSettings(
		userId: string,
		dto: UpdatePersonalSettingsDto,
		identity: { email: string | null },
	): Promise<PersonalSettingsViewDto> {
		const personalData: { region?: string; locale?: string } = {};
		if (dto.region !== undefined) personalData.region = dto.region;
		if (dto.locale !== undefined) personalData.locale = dto.locale;
		if (Object.keys(personalData).length === 0) {
			throw new SettingsUpdateEmptyException();
		}

		const updated = await this.prisma.userSettings.upsert({
			where: { userId },
			create: {
				userId,
				baseCurrency: PERSONAL_PLACEHOLDER_BASE_CURRENCY,
				region: dto.region ?? DEFAULT_REGION,
				locale: dto.locale ?? DEFAULT_LOCALE,
			},
			update: personalData,
			select: { region: true, locale: true },
		});
		return {
			email: identity.email,
			region: updated.region,
			locale: updated.locale,
		};
	}

	/**
	 * 查询完整设置视图（未建账 → 409 ONBOARDING_NOT_COMPLETED；W18 组织隔离）。
	 */
	async getSettings(
		scope: ReadScope,
		identity: { email: string | null },
	): Promise<SettingsViewDto> {
		const [preferences, personal] = await Promise.all([
			resolveOrganizationPreferences(this.prisma, scope.organizationId),
			this.prisma.userSettings.findUnique({
				where: { userId: scope.userId },
				select: { region: true, locale: true },
			}),
		]);
		if (!preferences) {
			throw new OnboardingNotCompletedException();
		}
		return {
			email: identity.email,
			region: personal?.region ?? DEFAULT_REGION,
			locale: personal?.locale ?? DEFAULT_LOCALE,
			baseCurrency: preferences.baseCurrency,
			prepPreference: preferences.prepPreference as SettingsViewDto["prepPreference"],
			reminderEnabled: preferences.reminderEnabled,
			ledgerStartedAt: preferences.ledgerStartedAt,
		};
	}

	/**
	 * 更新偏好（幂等；个人/组织字段分权校验）：
	 * - 全空（含 baseCurrency 被剥离后为空）→ 400 SETTINGS_UPDATE_EMPTY；
	 * - 含 prepPreference / reminderEnabled：先验 can(actor.role, "settings.update")，
	 *   事务内 lockOrganizationForActor 重读最新角色复验（锁等期间降权 → 回滚事务 + 写 DENIED 独立审计 + 403），
	 *   固化 OWNER_LEGACY 后更新 OrganizationSettings（默认组织且本人有 UserSettings 时同步兼容列）+ 同事务写审计；
	 * - 含 region / locale：确认当前组织已建账（兼容未建账 409 契约），对 actor.userId upsert
	 *   个人展示偏好（无行时以当前组织 baseCurrency 建行；已有行只更新 region/locale，绝不改 baseCurrency/ledgerStartedAt）。
	 */
	async updateSettings(
		actor: ActorContext,
		dto: UpdateSettingsDto,
		identity: { email: string | null },
		requestId: string | null = null,
	): Promise<SettingsViewDto> {
		const orgData: { prepPreference?: string; reminderEnabled?: boolean } = {};
		if (dto.prepPreference !== undefined) {
			orgData.prepPreference = dto.prepPreference;
		}
		if (dto.reminderEnabled !== undefined) {
			orgData.reminderEnabled = dto.reminderEnabled;
		}
		const personalData: { region?: string; locale?: string } = {};
		if (dto.region !== undefined) personalData.region = dto.region;
		if (dto.locale !== undefined) personalData.locale = dto.locale;

		const hasOrgFields = Object.keys(orgData).length > 0;
		const hasPersonalFields = Object.keys(personalData).length > 0;
		if (!hasOrgFields && !hasPersonalFields) {
			throw new SettingsUpdateEmptyException();
		}

		if (hasOrgFields && !can(actor.role, "settings.update")) {
			await this.recordDeniedAudit(actor, actor.role, requestId);
			throw new PermissionDeniedException();
		}

		let deniedRole: OrganizationRole = actor.role;
		try {
			return await this.prisma.$transaction(async (tx) => {
				if (hasOrgFields) {
					const latestRole = await lockOrganizationForActor(tx, actor);
					if (!can(latestRole, "settings.update")) {
						deniedRole = latestRole;
						throw new PermissionDeniedException();
					}
				}

				const preferences = await resolveOrganizationPreferences(
					tx,
					actor.organizationId,
				);
				if (!preferences) {
					throw new OnboardingNotCompletedException();
				}

				let nextPrepPreference = preferences.prepPreference;
				let nextReminderEnabled = preferences.reminderEnabled;
				const nextLedgerStartedAt = preferences.ledgerStartedAt;

				if (hasOrgFields) {
					if (preferences.source === "OWNER_LEGACY") {
						await materializeLegacyOrganizationSettings(tx, actor.organizationId);
					}
					const updatedOrg = await tx.organizationSettings.update({
						where: { organizationId: actor.organizationId },
						data: orgData,
					});
					nextPrepPreference = updatedOrg.prepPreference;
					nextReminderEnabled = updatedOrg.reminderEnabled;

					// 默认组织兼容同步：仅更新本人已有 UserSettings 的兼容列（不新建、不改 baseCurrency）
					if (actor.isDefaultOrganization) {
						await tx.userSettings.updateMany({
							where: { userId: actor.userId },
							data: orgData,
						});
					}

					await this.auditService.recordInTx(tx, {
						organizationId: actor.organizationId,
						actorUserId: actor.userId,
						actorType: "USER",
						action: "settings.update",
						targetType: "organization_settings",
						targetId: actor.organizationId,
						result: "SUCCESS",
						requestId: requestId ?? null,
						detail: {
							before: {
								prepPreference: preferences.prepPreference,
								reminderEnabled: preferences.reminderEnabled,
							},
							after: {
								prepPreference: updatedOrg.prepPreference,
								reminderEnabled: updatedOrg.reminderEnabled,
							},
						},
					});
				}

				let nextRegion: string;
				let nextLocale: string;
				if (hasPersonalFields) {
					const updatedPersonal = await tx.userSettings.upsert({
						where: { userId: actor.userId },
						create: {
							userId: actor.userId,
							baseCurrency: PERSONAL_PLACEHOLDER_BASE_CURRENCY,
							region: dto.region ?? DEFAULT_REGION,
							locale: dto.locale ?? DEFAULT_LOCALE,
						},
						update: personalData,
						select: { region: true, locale: true },
					});
					nextRegion = updatedPersonal.region;
					nextLocale = updatedPersonal.locale;
				} else {
					const existingPersonal = await tx.userSettings.findUnique({
						where: { userId: actor.userId },
						select: { region: true, locale: true },
					});
					nextRegion = existingPersonal?.region ?? DEFAULT_REGION;
					nextLocale = existingPersonal?.locale ?? DEFAULT_LOCALE;
				}

				return {
					email: identity.email,
					region: nextRegion,
					locale: nextLocale,
					baseCurrency: preferences.baseCurrency,
					prepPreference: nextPrepPreference,
					reminderEnabled: nextReminderEnabled,
					ledgerStartedAt: nextLedgerStartedAt,
				};
			});
		} catch (error) {
			if (error instanceof PermissionDeniedException) {
				await this.recordDeniedAudit(actor, deniedRole, requestId);
			}
			throw error;
		}
	}

	private async recordDeniedAudit(
		actor: ActorContext,
		role: OrganizationRole,
		requestId: string | null,
	): Promise<void> {
		try {
			await this.auditService.recordStandalone({
				organizationId: actor.organizationId,
				actorUserId: actor.userId,
				actorType: "USER",
				action: "permission.denied.settings.update",
				result: "DENIED",
				requestId,
				detail: { required: "settings.update", role },
			});
		} catch (error) {
			this.logger.warn(
				`DENIED 审计写入失败（不影响 403 返回）: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
