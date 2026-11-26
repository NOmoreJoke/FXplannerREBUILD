/**
 * 登录后的落地页解析（Goal #3C W30 · MIG-D：关闭「缺组织头猜唯一默认组织」的兼容窗口）。
 *
 * 背景：登录成功时会话上下文已重置（session-reset.ts 清掉持久化的组织选择），
 * 此时任何**组织域**端点都缺 X-Organization-Id——W30（MIG-D）起一律
 * 400 ORGANIZATION_REQUIRED，后端不再回落「唯一默认组织」。因此登录页不得再靠
 * 组织域的 GET /onboarding/status 判定建账态（那正是前端侧的「无头单组织猜想」）。
 *
 * 改用个人域端点 GET /organizations 的列表项判定——列表项自带 onboardingCompleted，
 * 不需要组织上下文：
 * - 恰好一个组织且尚未建账 → 进建账向导，并把登录前来源页带在 redirect 上
 *   （否则受邀的新用户登录后回不到 /invitations/<token> 继续接受邀请）；
 * - 其余（0 组织 / 多组织 / 已建账）→ 回登录前来源页或首页。其余分流交给受保护区
 *   布局的组织路由分流（0 组织进新建引导、多组织进选择页、已建账组织由首页按
 *   建账态再分流）——不再由登录页猜测组织。
 */

/** 组织列表项的最小形状（GET /organizations 的 OrganizationViewDto 局部） */
export interface PostLoginOrganization {
	onboardingCompleted: boolean;
}

/**
 * 解析登录后的落地路径。
 *
 * @param organizations 本人组织列表（个人域端点返回，空数组 = 0 组织）
 * @param safeTarget 已通过白名单校验的站内来源页；缺省时落到 /home
 */
export function resolvePostLoginTarget(
	organizations: readonly PostLoginOrganization[],
	safeTarget: string | undefined,
): string {
	const fallback = safeTarget ?? "/home";
	// 0 组织 / 多组织：建账态由所选组织决定，登录页不猜——交给组织路由分流
	if (organizations.length !== 1) return fallback;
	if (organizations[0].onboardingCompleted) return fallback;
	// 唯一组织且未建账：进向导；带上来源页，建账完成后回跳（受邀者据此继续接受邀请）
	return safeTarget
		? `/onboarding?redirect=${encodeURIComponent(safeTarget)}`
		: "/onboarding";
}
