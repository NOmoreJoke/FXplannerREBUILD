/**
 * E2E 组织上下文（Goal #3C W30 · MIG-D：关闭「缺组织头猜唯一默认组织」的兼容窗口）。
 *
 * 后端组织域端点一律挂 OrganizationContextGuard：缺 X-Organization-Id → 400
 * ORGANIZATION_REQUIRED，**不再**回落「用户唯一的默认组织」。E2E 的造数请求此前
 * 正是靠那个兼容窗口跑通的（不带头 → 后端猜唯一组织），现在必须像真实前端那样
 * 显式带上组织 id：前端从 organization-store 取「当前选中组织」注入请求头；
 * E2E 这里从个人域端点 GET /organizations 取本人组织并按 token 缓存复用。
 *
 * 组织选取口径：列表按 membership.joinedAt 升序（后端 orderBy），首位是用户
 * 注册兜底建的个人工作台——E2E 造数（建账/买入/计划/使用）都落在用户自己的
 * 组织里，与前端「单组织自动选中」的落点一致。多组织且需要指定别的组织时，
 * 调用方显式传 headers["X-Organization-Id"]（先例：12-account-data 的
 * handOverOwnership），此时不自动解析。
 */

/**
 * 组织域端点判定（后端挂 OrganizationContextGuard 的路径前缀）。
 *
 * 个人域端点（**不得**带组织头）：/auth/*、/organizations 列表与新建、
 * /organization-invitations/:token*、/onboarding/consents、/settings/personal、
 * /data-requests/*（个人域）、/rates/*、/currencies。
 */
export function isOrganizationScopedPath(path: string): boolean {
	const pathname = path.split("?")[0] ?? "";
	// 同一前缀下既有个人域又有组织域的，先把个人域排除
	if (
		pathname === "/api/organizations" ||
		pathname.startsWith("/api/organization-invitations/") ||
		pathname === "/api/onboarding/consents" ||
		pathname === "/api/settings/personal" ||
		pathname.startsWith("/api/data-requests")
	) {
		return false;
	}
	return (
		pathname.startsWith("/api/home/") ||
		pathname.startsWith("/api/onboarding/") ||
		pathname.startsWith("/api/transactions") ||
		pathname.startsWith("/api/plans") ||
		pathname.startsWith("/api/accounts") ||
		pathname.startsWith("/api/corrections") ||
		pathname.startsWith("/api/reminders") ||
		pathname.startsWith("/api/reports") ||
		pathname.startsWith("/api/ai/conversations") ||
		pathname === "/api/settings" ||
		pathname.startsWith("/api/organizations/current")
	);
}

/**
 * 组织 id 解析器（按 token 缓存）。
 *
 * @param listOrganizations 取本人组织列表（个人域端点 GET /organizations）
 */
export function createOrganizationIdResolver(
	listOrganizations: (
		token: string,
	) => Promise<readonly { id: string }[]>,
): (token: string) => Promise<string> {
	const cache = new Map<string, string>();
	return async (token: string): Promise<string> => {
		const cached = cache.get(token);
		if (cached) return cached;
		const organizations = await listOrganizations(token);
		const organization = organizations[0];
		if (!organization) {
			throw new Error(
				"组织域请求需要 X-Organization-Id，但该用户名下没有组织" +
					"（W30 MIG-D 起组织域端点缺头一律 400 ORGANIZATION_REQUIRED）",
			);
		}
		cache.set(token, organization.id);
		return organization.id;
	};
}
