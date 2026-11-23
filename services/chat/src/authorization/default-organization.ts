import type { Prisma } from "@prisma/client";

type MembershipReader = Pick<Prisma.TransactionClient, "membership">;

/**
 * 用户默认组织（技术方案 §7.3「唯一默认组织」；评审 I-08）：
 * 取其**最早的 ACTIVE OWNER 成员关系**所属组织。
 *
 * 依据：MIG-B 回填与注册/验证码首登兜底都为每个用户先建一个 OWNER 组织；
 * 之后新建的组织、受邀加入或被转移所有权的组织都晚于它。因此「最早的
 * ACTIVE OWNER 成员关系」在全部路径下唯一且确定地指向默认组织。
 *
 * 用途：兼容窗口内 organizationId IS NULL 的存量写路径行、以及尚未迁入
 * OrganizationSettings 的个人设置，逻辑上都属于默认组织——只允许在默认组织
 * 上下文里可见，严禁渗入用户后来新建或受邀加入的其他组织（ORG-01.5/ORG-02.2）。
 */
export async function resolveDefaultOrganizationId(
	db: MembershipReader,
	userId: string,
): Promise<string | null> {
	const earliest = await db.membership.findFirst({
		where: { userId, role: "OWNER", status: "ACTIVE" },
		orderBy: [{ joinedAt: "asc" }, { createdAt: "asc" }],
		select: { organizationId: true },
	});
	return earliest?.organizationId ?? null;
}
