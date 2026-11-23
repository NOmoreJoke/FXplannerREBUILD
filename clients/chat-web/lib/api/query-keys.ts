import type { QueryClient, QueryFilters } from "@tanstack/react-query";
import type {
	CorrectionTargetType,
	PlanListStatus,
	ReportListStatus,
} from "@/lib/api/contract";

/**
 * 集中式 React Query Key 工厂与跨模块失效器（F1-3 / DEBT-06）。
 *
 * - 全前端业务域的 queryKey 唯一事实来源（禁止在页面/组件零散拼装裸数组）；
 * - 保留既有 tuple 结构与顺序，确保存量测试与缓存命中契约无缝兼容；
 * - withOrgScope(orgId, key) 给业务键加组织前缀（ToB 多组织工作台按组织隔离缓存）。
 *
 * 组织感知失效（评审 I-19）：带前缀的键形如 ["org", <id>, ...业务键]，
 * `invalidateQueries({ queryKey: ["plans"] })` 的前缀匹配**命中不了**它。
 * 因此跨模块失效一律走 invalidateBusinessKey：同时命中无前缀键与任意组织的
 * 前缀键，写操作后首页/计划列表/会话列表不再残留陈旧数据。
 */

export const queryKeys = {
	auth: {
		all: ["auth"] as const,
		me: () => ["auth", "me"] as const,
	},
	onboarding: {
		all: ["onboarding"] as const,
		status: () => ["onboarding", "status"] as const,
	},
	home: {
		all: ["home"] as const,
		state: () => ["home", "state"] as const,
		portfolio: () => ["home", "portfolio"] as const,
	},
	accounts: {
		all: ["accounts"] as const,
		list: () => ["accounts", "list"] as const,
		detail: (code: string | null) => ["accounts", "detail", code] as const,
		ledger: (code: string | null) => ["accounts", "ledger", code] as const,
		allocations: (code: string | null) =>
			["accounts", "allocations", code] as const,
		reportDetails: (currenciesKey: string) =>
			["accounts", "report-details", currenciesKey] as const,
	},
	plans: {
		all: ["plans"] as const,
		listStem: ["plans", "list"] as const,
		list: (status?: PlanListStatus) =>
			["plans", "list", status ?? "all"] as const,
		detail: (id: string) => ["plans", "detail", id] as const,
	},
	transactions: {
		all: ["transactions"] as const,
		detail: (id: string | undefined) =>
			["transactions", "detail", id] as const,
	},
	usages: {
		all: ["usages"] as const,
		list: (planId: string) => ["usages", "list", planId] as const,
	},
	corrections: {
		all: ["corrections"] as const,
		list: (
			targetType: CorrectionTargetType,
			targetId: string,
			page: number,
		) => ["corrections", "list", targetType, targetId, page] as const,
	},
	rates: {
		all: ["rates"] as const,
		supported: () => ["rates", "supported"] as const,
		latestStem: ["rates", "latest"] as const,
		latestPair: (base: string | null, target: string) =>
			["rates", "latest", base, target] as const,
		latestGroup: (base: string, targetsKey: string, locked: boolean) =>
			["rates", "latest", base, targetsKey, locked ? "locked" : "live"] as const,
		historyStem: ["rates", "history"] as const,
		history: (base: string, target: string, period: 7 | 30 | 90 | 365) =>
			["rates", "history", base, target, period] as const,
	},
	reminders: {
		all: ["reminders"] as const,
		list: () => ["reminders", "list"] as const,
	},
	settings: {
		all: ["settings"] as const,
		detail: () => ["settings"] as const,
	},
	reports: {
		all: ["reports"] as const,
		plans: (status?: ReportListStatus, currencyCode?: string) =>
			["reports", "plans", status ?? "all", currencyCode ?? "all"] as const,
		plan: (planId: string) => ["reports", "plan", planId] as const,
	},
	dataRequests: {
		all: ["data-request"] as const,
		current: () => ["data-request", "current"] as const,
		impact: () => ["data-request", "impact"] as const,
	},
	ai: {
		all: ["ai"] as const,
		conversations: () => ["ai", "conversations"] as const,
		messagesStem: ["ai", "messages"] as const,
		messages: (conversationId: string) =>
			["ai", "messages", conversationId] as const,
		models: () => ["ai", "models"] as const,
	},
	// ToB R1 组织域（W20）：组织/成员/邀请/审计
	organizations: {
		all: ["organizations"] as const,
		list: () => ["organizations", "list"] as const,
		/** 详情键词根：匹配任意组织的详情 */
		currentStem: ["organizations", "current"] as const,
		/**
		 * 当前组织详情按组织分桶（评审 I-18）：键不含组织 id 时，切换后重拉期间
		 * 仍会读到上一个组织的 capabilities/建账态。
		 */
		current: (organizationId: string) =>
			["organizations", "current", organizationId] as const,
	},
	members: {
		all: ["members"] as const,
		list: () => ["members", "list"] as const,
	},
	invitations: {
		all: ["invitations"] as const,
		list: () => ["invitations", "list"] as const,
	},
	auditLogs: {
		all: ["audit-logs"] as const,
		list: () => ["audit-logs", "list"] as const,
	},
	/** 受邀摘要（个人端点，按 token 分桶；对抗审 R1 [Nit]：入工厂禁裸拼） */
	organizationInvitation: {
		summary: (token: string) =>
			["organization-invitation", token] as const,
	},
} as const;

type QueryKey = readonly unknown[];
type QueryPredicate = NonNullable<QueryFilters["predicate"]>;

/** withOrgScope 的前缀锚点：["org", organizationId, ...业务键] */
const ORG_SCOPE_ANCHOR = "org";

/** ToB 组织上下文作用域封装：未传 orgId 时保持个人工作区原 Key */
export function withOrgScope<TKey extends readonly unknown[]>(
	orgId: string | null | undefined,
	key: TKey,
): readonly unknown[] {
	return orgId ? [ORG_SCOPE_ANCHOR, orgId, ...key] : key;
}

/** 前缀匹配（与 invalidateQueries({ queryKey }) 的 partial 语义一致） */
function hasKeyPrefix(queryKey: QueryKey, key: QueryKey): boolean {
	if (queryKey.length < key.length) return false;
	return key.every((part, index) => part === queryKey[index]);
}

/** 是否为带组织前缀的键（["org", <id>, ...]） */
export function isOrgScopedKey(queryKey: QueryKey): boolean {
	return (
		queryKey[0] === ORG_SCOPE_ANCHOR && typeof queryKey[1] === "string"
	);
}

/**
 * 业务键的「全形态」匹配：无前缀键本身，或任意组织前缀下的同一业务键。
 * 评审 I-19：此前跨模块失效只用无前缀键，带前缀的首页/计划/会话缓存从不被失效。
 */
export function matchesBusinessKey(
	queryKey: QueryKey,
	key: QueryKey,
): boolean {
	if (hasKeyPrefix(queryKey, key)) return true;
	return isOrgScopedKey(queryKey) && hasKeyPrefix(queryKey.slice(2), key);
}

/** 失效某业务键的全部形态（无前缀 + 任意组织前缀） */
export function invalidateBusinessKey(
	queryClient: QueryClient,
	key: QueryKey,
): void {
	const predicate: QueryPredicate = (query) =>
		matchesBusinessKey(query.queryKey, key);
	void queryClient.invalidateQueries({ predicate });
}

/** 首次建账完成后统一失效缓存，确保首页、顶栏铃铛、设置与账户立即反映已建账态 */
export function invalidateAfterOnboarding(queryClient: QueryClient): void {
	invalidateBusinessKey(queryClient, queryKeys.onboarding.status());
	invalidateBusinessKey(queryClient, queryKeys.home.state());
	invalidateBusinessKey(queryClient, queryKeys.home.portfolio());
	invalidateBusinessKey(queryClient, queryKeys.settings.all);
	invalidateBusinessKey(queryClient, queryKeys.reminders.all);
	invalidateBusinessKey(queryClient, queryKeys.accounts.all);
}

/**
 * 账本/计划/使用写操作成功后集中失效联动域缓存（账户、计划、使用、报告、首页、提醒），
 * 防止页面切回时读到 stale 余额或未更新的成本报告。
 */
export function invalidateAfterLedgerMutation(
	queryClient: QueryClient,
	options?: { planId?: string },
): void {
	invalidateBusinessKey(queryClient, queryKeys.accounts.all);
	invalidateBusinessKey(queryClient, queryKeys.plans.all);
	invalidateBusinessKey(queryClient, queryKeys.usages.all);
	if (options?.planId) {
		invalidateBusinessKey(queryClient, queryKeys.plans.detail(options.planId));
		invalidateBusinessKey(queryClient, queryKeys.usages.list(options.planId));
	}
	invalidateBusinessKey(queryClient, queryKeys.reports.all);
	invalidateBusinessKey(queryClient, queryKeys.home.state());
	invalidateBusinessKey(queryClient, queryKeys.home.portfolio());
	invalidateBusinessKey(queryClient, queryKeys.reminders.all);
}

/** 数据权利请求提交/撤回后统一失效当前请求与影响快照 */
export function invalidateAfterDataRequestMutation(
	queryClient: QueryClient,
): void {
	invalidateBusinessKey(queryClient, queryKeys.dataRequests.all);
}

/**
 * 随当前组织变化的**无前缀**键：这些域的查询尚未迁到带前缀键，缓存里存的
 * 就是上一个组织的数据，切换时必须显式移除（否则页面不卸载即残留旧组织数据）。
 */
const UNSCOPED_ORG_DATA_KEYS: readonly QueryKey[] = [
	queryKeys.home.all,
	queryKeys.accounts.all,
	queryKeys.plans.all,
	queryKeys.transactions.all,
	queryKeys.usages.all,
	queryKeys.corrections.all,
	queryKeys.reminders.all,
	queryKeys.settings.all,
	queryKeys.reports.all,
	queryKeys.ai.conversations(),
	queryKeys.ai.messagesStem,
	queryKeys.members.all,
	queryKeys.invitations.all,
	queryKeys.auditLogs.all,
	queryKeys.organizations.currentStem,
	// 建账状态自 ToB R1 起按组织解析（组织偏好决定是否已建账），不再是公共缓存
	queryKeys.onboarding.all,
];

/**
 * 组织切换缓存清理（ToB R1 W20；需求 15.1.4「无缓存串数据」）：
 * 1. 先 cancelQueries 中止全部在途的组织数据请求（防迟到响应回写新组织页面）；
 * 2. 再 removeQueries 清除：**任意组织**的带前缀缓存（旧组织数据不留存内存，
 *    切回时重新拉取）+ 随组织变化的无前缀键 + 组织详情；
 * 3. 公共缓存保留（汇率、币种/模型白名单、认证、组织列表——与当前组织无关）。
 */
export function clearOrganizationScopedQueries(queryClient: QueryClient): void {
	const isOrganizationData: QueryPredicate = (query) =>
		isOrgScopedKey(query.queryKey) ||
		UNSCOPED_ORG_DATA_KEYS.some((key) => hasKeyPrefix(query.queryKey, key));
	void queryClient.cancelQueries({ predicate: isOrganizationData });
	queryClient.removeQueries({ predicate: isOrganizationData });
}
