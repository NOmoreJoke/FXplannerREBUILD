import type { Prisma } from "@prisma/client";
import { compatReadWhere, type ReadScope } from "./organization-scope";

type DefaultOrganizationReader = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * 用户默认组织（个人工作台；技术方案 §7.3「唯一默认组织」；评审 I-08 / R2-I03）：
 * **该用户创建的最早的组织**。
 *
 * 创建者的识别（两个条件同时成立）：
 * 1. 是该组织的第一个成员（按 created_at、id 升序，无更早的成员关系）；
 * 2. 该成员关系与组织同事务创建（memberships.created_at = organizations.created_at）。
 *
 * 创建组织的三个路径（注册 / 验证码首登兜底、显式新建、MIG-B 回填）都以嵌套写入
 * 在同一事务内建组织与其首个成员关系：Postgres 的 CURRENT_TIMESTAMP 取事务开始
 * 时间，故二者 created_at 恒等，且创建时组织只有这一个成员。
 * test/integration/organization-migration.spec.ts 钉住该不变量。
 *
 * 为什么不是「最早的 ACTIVE OWNER 成员关系」（评审 R2-I03）：那个口径会随所有权
 * 转移漂移。用户 A 把默认组织 Org 1 转给 B 后，最早的 ACTIVE OWNER 变成后建的
 * Org 2 → Org 2 立刻被当成默认组织，A 的个人设置与 A 写下的存量 NULL 行整批
 * 「瞬移」进 Org 2（对其全体成员可见），MIG-B 重跑也会把 A 的行灌进 Org 2。
 * 「创建者」身份不随角色 / 状态变化：转移后 A 在 Org 1 是 ADMIN，Org 1 仍是 A 的
 * 默认组织，其存量 NULL 行留在原处；Org 2 从来不是默认组织。
 *
 * 为什么要求「创建者」而不是「最早的成员关系」：存量用户若在被回填之前先受邀
 * 加入了他人组织，其最早的成员关系属于那个组织。按「最早成员关系」口径，回填会
 * 把该用户的全部个人账本灌进他人组织、其个人设置也会被当成那个组织的偏好。
 * 要求创建者时该用户解析为「尚无默认组织」（回填为其新建个人工作台），fail-closed。
 *
 * 为什么还要「第一个成员」：仅凭时间戳相等时，直写库的夹具 / 种子若在组织创建的
 * 同一毫秒内再插入别的成员关系，后者也会被误判为创建者。嵌套写入里创建者的 id
 * 先生成，同毫秒内后插入的成员关系按 id 排在其后，条件 1 即把它排除（id 仅作
 * 确定性决胜，不依赖其时间有序性）。受邀加入的成员关系晚于组织创建，本就不会命中。
 *
 * 用途：兼容窗口内 organizationId IS NULL 的存量写路径行、以及尚未迁入
 * OrganizationSettings 的个人设置，逻辑上都属于默认组织——只允许在默认组织
 * 上下文里可见，严禁渗入用户后来新建或受邀加入的其他组织（ORG-01.5/ORG-02.2）。
 * MIG-B 回填 / 核对 SQL 里的 `defaults` CTE 与本函数同口径，改一处须同步另一处。
 */
export async function resolveDefaultOrganizationId(
	db: DefaultOrganizationReader,
	userId: string,
): Promise<string | null> {
	const [earliest] = await db.$queryRaw<Array<{ organizationId: string }>>`
		SELECT m.organization_id AS "organizationId"
		FROM memberships m
		JOIN organizations o ON o.id = m.organization_id
		WHERE m.user_id = ${userId}
			AND m.created_at = o.created_at
			AND NOT EXISTS (
				SELECT 1 FROM memberships earlier
				WHERE earlier.organization_id = m.organization_id
					AND (earlier.created_at, earlier.id) < (m.created_at, m.id)
			)
		ORDER BY m.joined_at ASC, m.created_at ASC, m.id ASC
		LIMIT 1`;
	return earliest?.organizationId ?? null;
}

/**
 * 解析一个组织的「默认工作台创建者」userId（I-2 双账户行防护）：
 * 1. 先找出该组织的创建者成员（m.created_at = o.created_at 且无更早成员）；
 * 2. 再验证该创建者的默认组织恰好就是本 organizationId（防止用户新建的第 2 个
 *    组织误认或吞并该用户在默认组织下的 organization_id IS NULL 存量行）。
 *
 * 仅当两条件同时成立时返回 creatorUserId，否则返回 null。
 */
export async function resolveDefaultOrganizationCreatorUserId(
	db: DefaultOrganizationReader,
	organizationId: string,
): Promise<string | null> {
	const [creator] = await db.$queryRaw<Array<{ userId: string }>>`
		SELECT m.user_id AS "userId"
		FROM memberships m
		JOIN organizations o ON o.id = m.organization_id
		WHERE m.organization_id = ${organizationId}
			AND m.created_at = o.created_at
			AND NOT EXISTS (
				SELECT 1 FROM memberships earlier
				WHERE earlier.organization_id = m.organization_id
					AND (earlier.created_at, earlier.id) < (m.created_at, m.id)
			)
		ORDER BY m.created_at ASC, m.id ASC
		LIMIT 1`;
	if (!creator?.userId) return null;
	const creatorDefaultOrgId = await resolveDefaultOrganizationId(
		db,
		creator.userId,
	);
	return creatorDefaultOrgId === organizationId ? creator.userId : null;
}

/**
 * 计划占用汇总的组织作用域条件（R2-I1 预约对称性）：
 * 在 compatReadWhere(scope) 之上补充「默认组织创建者尚未迁入组织的 organizationId: null
 * 存量计划」，确保受邀成员与创建者在计算未分配余额 / caps / 账户已分配汇总时看到
 * 完全对称的计划占用，消除受邀成员绕过存量计划超额分配。
 */
export async function planReservationWhere(
	db: DefaultOrganizationReader,
	scope: ReadScope,
): Promise<ReturnType<typeof compatReadWhere>> {
	const defaultOwnerUserId = await resolveDefaultOrganizationCreatorUserId(
		db,
		scope.organizationId,
	);
	if (!defaultOwnerUserId) {
		return compatReadWhere(scope);
	}
	const branches: ReturnType<typeof compatReadWhere>["OR"] = [
		{ organizationId: scope.organizationId },
		{ organizationId: null, userId: defaultOwnerUserId },
	];
	if (
		scope.isDefaultOrganization === true &&
		scope.userId !== defaultOwnerUserId
	) {
		branches.push({ organizationId: null, userId: scope.userId });
	}
	return { OR: branches };
}
