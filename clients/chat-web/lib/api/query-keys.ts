import type { QueryClient } from "@tanstack/react-query";
import type {
	CorrectionTargetType,
	PlanListStatus,
	ReportListStatus,
} from "@/lib/api/contract";

/**
 * 集中式 React Query Key 工厂与跨模块失效器（F1-3 / DEBT-06）。
 *
 * - 全前端 14 个业务域的 queryKey 唯一事实来源（禁止在页面/组件零散拼装裸数组）；
 * - 保留既有 tuple 结构与顺序，确保存量测试与缓存命中契约无缝兼容；
 * - 预留 withOrgScope(orgId, key)，供 ToB 多组织工作台接入时零改动按组织隔离缓存。
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
} as const;

/** ToB 组织上下文作用域封装：未传 orgId 时保持个人工作区原 Key */
export function withOrgScope<TKey extends readonly unknown[]>(
	orgId: string | null | undefined,
	key: TKey,
): readonly unknown[] {
	return orgId ? ["org", orgId, ...key] : key;
}

/** 首次建账完成后统一失效缓存，确保首页、顶栏铃铛、设置与账户立即反映已建账态 */
export function invalidateAfterOnboarding(queryClient: QueryClient): void {
	void queryClient.invalidateQueries({ queryKey: queryKeys.onboarding.status() });
	void queryClient.invalidateQueries({ queryKey: queryKeys.home.state() });
	void queryClient.invalidateQueries({ queryKey: queryKeys.home.portfolio() });
	void queryClient.invalidateQueries({ queryKey: queryKeys.settings.detail() });
	void queryClient.invalidateQueries({ queryKey: queryKeys.reminders.list() });
	void queryClient.invalidateQueries({ queryKey: queryKeys.accounts.all });
}

/**
 * 账本/计划/使用写操作成功后集中失效联动域缓存（账户、计划、使用、报告、首页、提醒），
 * 防止页面切回时读到 stale 余额或未更新的成本报告。
 */
export function invalidateAfterLedgerMutation(
	queryClient: QueryClient,
	options?: { planId?: string },
): void {
	void queryClient.invalidateQueries({ queryKey: queryKeys.accounts.all });
	void queryClient.invalidateQueries({ queryKey: queryKeys.plans.all });
	void queryClient.invalidateQueries({ queryKey: queryKeys.usages.all });
	if (options?.planId) {
		void queryClient.invalidateQueries({
			queryKey: queryKeys.plans.detail(options.planId),
		});
		void queryClient.invalidateQueries({
			queryKey: queryKeys.usages.list(options.planId),
		});
	}
	void queryClient.invalidateQueries({ queryKey: queryKeys.reports.all });
	void queryClient.invalidateQueries({ queryKey: queryKeys.home.state() });
	void queryClient.invalidateQueries({ queryKey: queryKeys.home.portfolio() });
	void queryClient.invalidateQueries({ queryKey: queryKeys.reminders.list() });
}

/** 数据权利请求提交/撤回后统一失效当前请求与影响快照 */
export function invalidateAfterDataRequestMutation(
	queryClient: QueryClient,
): void {
	void queryClient.invalidateQueries({ queryKey: queryKeys.dataRequests.all });
}
