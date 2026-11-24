import type { Prisma } from "@prisma/client";
import { resolveDefaultOrganizationId } from "../authorization/default-organization";

type Db = Pick<
	Prisma.TransactionClient,
	"organizationSettings" | "membership" | "userSettings" | "$queryRaw"
>;

/**
 * 个人展示偏好（语言/地区）的产品默认值（需求 LEDGER-02.2：属个人维度）。
 * 受邀成员没有独立建账、无 UserSettings 行时取此默认值。
 */
export const PERSONAL_DEFAULT_LOCALE = "zh-CN";
export const PERSONAL_DEFAULT_REGION = "CN";

/**
 * 组织偏好（LEDGER-02：本位币/准备节奏/提醒开关/记账起点属于组织）。
 */
export interface OrganizationPreferences {
	baseCurrency: string;
	prepPreference: string;
	reminderEnabled: boolean;
	ledgerStartedAt: Date | null;
	/**
	 * - `ORG`：OrganizationSettings（MIG-B 回填或组织化写路径）；
	 * - `OWNER_LEGACY`：兼容窗口回落——该组织是其所有者的默认组织（所有者创建的
	 *   最早组织），且尚无 OrganizationSettings 时，以所有者的个人设置代表组织偏好。
	 */
	source: "ORG" | "OWNER_LEGACY";
}

/**
 * 解析当前组织的偏好与建账态（评审 I-08 / I-10）。
 *
 * 真相顺序：
 * 1. OrganizationSettings —— 组织的唯一真相；
 * 2. 兼容回落：仅当该组织是**其所有者的默认组织**（所有者创建的最早组织，
 *    见 default-organization.ts）时，用所有者的 UserSettings 代表——这覆盖「尚未执行
 *    MIG-B」与「onboarding 写路径仍只写 UserSettings」两种窗口态；
 *    用户新建或受邀加入的其他组织一律不回落（否则全新未建账组织会误报已建账
 *    并带出别的组织的本位币）。
 *
 * 回落读的是**组织所有者**的设置而非请求者的：受邀成员没有自己的 UserSettings，
 * 在已建账组织里同样必须读到组织本位币（此前对其直接 409）。
 * 纯读、无副作用；写路径（建账完成同时落 OrganizationSettings）随 Goal #3B。
 */
export async function resolveOrganizationPreferences(
	db: Db,
	organizationId: string,
): Promise<OrganizationPreferences | null> {
	const settings = await db.organizationSettings.findUnique({
		where: { organizationId },
	});
	if (settings) {
		return {
			baseCurrency: settings.baseCurrency,
			prepPreference: settings.prepPreference,
			reminderEnabled: settings.reminderEnabled,
			ledgerStartedAt: settings.ledgerStartedAt,
			source: "ORG",
		};
	}

	const owner = await db.membership.findFirst({
		where: { organizationId, role: "OWNER", status: "ACTIVE" },
		select: { userId: true },
	});
	if (!owner) return null;
	const ownerDefaultOrganizationId = await resolveDefaultOrganizationId(
		db,
		owner.userId,
	);
	if (ownerDefaultOrganizationId !== organizationId) return null;

	const legacy = await db.userSettings.findUnique({
		where: { userId: owner.userId },
	});
	if (!legacy) return null;
	return {
		baseCurrency: legacy.baseCurrency,
		prepPreference: legacy.prepPreference,
		reminderEnabled: legacy.reminderEnabled,
		ledgerStartedAt: legacy.ledgerStartedAt,
		source: "OWNER_LEGACY",
	};
}

/**
 * 把 OWNER_LEGACY 回落值固化为该组织自己的 OrganizationSettings（评审 R2-I03）。
 *
 * 触发场景：所有权转移。回落以「所有者」为锚——组织一旦换了所有者，新所有者的
 * 个人设置并不代表本组织，组织会凭空变成未建账（全端点 409）；而原所有者的
 * 个人设置又会转而支撑别的组织。所以凡让组织脱离其创建者的变更，都要先把此刻
 * 的回落值落成组织设置（字段与 MIG-B §12.2.3 复制口径一致）。
 *
 * 仅当该组织此刻的偏好确实由回落支撑时才写；已有 OrganizationSettings 则原样不动
 * （组织化写路径可能已独立修改过，不得被个人设置覆盖）。upsert 仅为并发兜底
 * （如同窗口内的 MIG-B 回填），不会改写既有行。调用方须持有组织级 advisory 锁。
 *
 * @returns 是否新建了组织设置
 */
export async function materializeLegacyOrganizationSettings(
	db: Db,
	organizationId: string,
): Promise<boolean> {
	const preferences = await resolveOrganizationPreferences(db, organizationId);
	if (preferences?.source !== "OWNER_LEGACY") return false;
	await db.organizationSettings.upsert({
		where: { organizationId },
		create: {
			organizationId,
			baseCurrency: preferences.baseCurrency,
			prepPreference: preferences.prepPreference,
			reminderEnabled: preferences.reminderEnabled,
			ledgerStartedAt: preferences.ledgerStartedAt,
		},
		update: {},
	});
	return true;
}
