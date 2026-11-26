import type { Prisma } from "@prisma/client";

type Db = Pick<Prisma.TransactionClient, "organizationSettings">;

/**
 * 个人展示偏好（语言/地区）的产品默认值（需求 LEDGER-02.2：属个人维度）。
 * 受邀成员没有独立建账、无 UserSettings 行时取此默认值。
 */
export const PERSONAL_DEFAULT_LOCALE = "zh-CN";
export const PERSONAL_DEFAULT_REGION = "CN";
/** 个人偏好占位本位币（PATCH /settings/personal 仅建个人行时使用，绝不视作组织已建账） */
export const PERSONAL_PLACEHOLDER_BASE_CURRENCY = "";

/**
 * 组织偏好（LEDGER-02：本位币/准备节奏/提醒开关/记账起点属于组织）。
 *
 * W30（MIG-F）：`UserSettings` 的 baseCurrency / prepPreference / reminderEnabled /
 * ledgerStartedAt 已删除，个人设置不再承载组织偏好，故**不再有** OWNER_LEGACY
 * 回落语义——组织偏好的唯一真相是 OrganizationSettings；组织尚无该行即
 * 「未建账」（调用方按 409 ONBOARDING_NOT_COMPLETED 处理）。
 */
export interface OrganizationPreferences {
	baseCurrency: string;
	prepPreference: string;
	reminderEnabled: boolean;
	ledgerStartedAt: Date | null;
}

/**
 * 解析当前组织的偏好与建账态（评审 I-08 / I-10）。
 *
 * W30（MIG-F）后真相唯一：OrganizationSettings。
 * - 有行 → 组织已建账，返回其偏好；
 * - 无行 → 尚未建账，返回 null（调用方 409）。
 *
 * 纯读、无副作用。
 */
export async function resolveOrganizationPreferences(
	db: Db,
	organizationId: string,
): Promise<OrganizationPreferences | null> {
	const settings = await db.organizationSettings.findUnique({
		where: { organizationId },
	});
	if (!settings) return null;
	return {
		baseCurrency: settings.baseCurrency,
		prepPreference: settings.prepPreference,
		reminderEnabled: settings.reminderEnabled,
		ledgerStartedAt: settings.ledgerStartedAt,
	};
}
