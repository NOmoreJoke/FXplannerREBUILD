import { useMemo } from "react";
import { useQuery, type QueryObserverResult } from "@tanstack/react-query";
import { differenceInCalendarDays, parseISO } from "date-fns";
import Decimal from "decimal.js";
import { fetchHomePortfolio, homeApi } from "@/lib/api/home";
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import type { HomePortfolioData } from "@/lib/api/home";
import type { HomeState, PlanSummary } from "@/lib/api/contract";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { useLedgerQueryGate } from "@/lib/hooks/use-organization-capabilities";

/**
 * 首页状态查询 Key
 */
export const HOME_STATE_QUERY_KEY = queryKeys.home.state();

/**
 * 首页持仓成本查询 Key（GET /home/portfolio，与 state 并行、互不阻塞）
 */
export const HOME_PORTFOLIO_QUERY_KEY = queryKeys.home.portfolio();

/**
 * 仪表盘焦点计划：status=ACTIVE 计划中 latestPrepDate 最早者
 * （从 state.plans 派生，不发额外请求；契约 changes/home-dashboard/接口契约.md §3）
 */
export interface HomeDashboardFocusPlan {
	id: string;
	/** 透传 PlanSummary.name（未命名时为 null） */
	name: string | null;
	targetCurrency: string;
	targetAmount: string;
	allocatedAmount: string;
	remainingAmount: string;
	/** allocatedAmount/targetAmount×100 四舍五入取整，钳位 0-100；targetAmount=0 → 0 */
	progressPercent: number;
	latestPrepDate: string;
	/** latestPrepDate 与本地今天的天数差（ceil 日历天）；负数=已逾期 */
	daysUntilPrepDeadline: number;
	/** daysUntilPrepDeadline < 0 */
	isOverdue: boolean;
}

/**
 * 首页仪表盘数据（state + portfolio 双请求归一结果）
 */
export interface HomeDashboardData {
	/** 账户数（= state.accounts.length） */
	accountCount: number;
	/** 账户币种去重升序 */
	currencies: string[];
	/** 每币种一卡，顺序透传 state.accounts（已按 currencyCode 升序） */
	accountCards: Array<{
		currencyCode: string;
		/** 透传 state.accounts.balance */
		balance: string;
		/** 来自 portfolio.byCurrency；portfolio 未成功返回或该币种无持仓记录 → null */
		avgUnitCost: string | null;
	}>;
	/** portfolio.totalRemainingCost；portfolio 请求失败 → null（卡片显示 "—"，不阻塞整页） */
	totalRemainingCost: string | null;
	/** portfolio.baseCurrency；portfolio 请求失败 → null */
	baseCurrency: string | null;
	/** 透传 state.latestRateObservedAt */
	latestRateObservedAt: string | null;
	/** 透传 state.hasInitialHoldings（存在 INITIAL CostLot 即 true；false 时首页挂补录引导卡） */
	hasInitialHoldings: boolean;
	/** 无 ACTIVE 计划 → null */
	focusPlan: HomeDashboardFocusPlan | null;
}

/**
 * 从 state.plans 派生焦点计划（契约 §3）。
 *
 * - 候选限定 status="ACTIVE"，取 latestPrepDate 最早者（ISO 8601 按时刻比较）；
 * - progressPercent 用 Decimal 十进制运算（金额为字符串，禁止裸 parseFloat 算钱）：
 *   allocatedAmount ÷ targetAmount × 100，四舍五入取整后钳位 0-100，targetAmount=0 → 0；
 * - daysUntilPrepDeadline 为 latestPrepDate 与本地今天的日历天差（ceil 取整，date-fns
 *   differenceInCalendarDays 按本地时区日历日计算），负数=已逾期。
 */
function deriveFocusPlan(plans: PlanSummary[]): HomeDashboardFocusPlan | null {
	const focus = plans
		.filter((plan) => plan.status === "ACTIVE")
		.reduce<PlanSummary | null>((earliest, plan) => {
			if (earliest === null) {
				return plan;
			}
			return parseISO(plan.latestPrepDate) < parseISO(earliest.latestPrepDate)
				? plan
				: earliest;
		}, null);
	if (!focus) {
		return null;
	}

	const target = new Decimal(focus.targetAmount);
	const allocated = new Decimal(focus.allocatedAmount);
	const progressPercent = target.isZero()
		? 0
		: Math.min(
				100,
				Math.max(
					0,
					allocated
						.div(target)
						.mul(100)
						.toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
						.toNumber(),
				),
			);
	const daysUntilPrepDeadline = differenceInCalendarDays(
		parseISO(focus.latestPrepDate),
		new Date(),
	);

	return {
		id: focus.id,
		name: focus.name,
		targetCurrency: focus.targetCurrency,
		targetAmount: focus.targetAmount,
		allocatedAmount: focus.allocatedAmount,
		remainingAmount: focus.remainingAmount,
		progressPercent,
		latestPrepDate: focus.latestPrepDate,
		daysUntilPrepDeadline,
		isOverdue: daysUntilPrepDeadline < 0,
	};
}

/**
 * 由 state + portfolio 归一出仪表盘数据。
 *
 * portfolio 为 undefined（加载中或失败）时，成本相关字段一律降级 null，
 * state 数据照常返回——portfolio 失败不阻塞整页（契约 §3）。
 */
function deriveDashboard(
	state: HomeState,
	portfolio: HomePortfolioData | undefined,
): HomeDashboardData {
	const avgUnitCostByCurrency = new Map(
		(portfolio?.byCurrency ?? []).map(
			(row) => [row.currencyCode, row.avgUnitCost] as const,
		),
	);

	return {
		accountCount: state.accounts.length,
		currencies: [...new Set(state.accounts.map((a) => a.currencyCode))].sort(),
		accountCards: state.accounts.map((account) => ({
			currencyCode: account.currencyCode,
			balance: account.balance,
			avgUnitCost: avgUnitCostByCurrency.get(account.currencyCode) ?? null,
		})),
		totalRemainingCost: portfolio?.totalRemainingCost ?? null,
		baseCurrency: portfolio?.baseCurrency ?? null,
		latestRateObservedAt: state.latestRateObservedAt,
		hasInitialHoldings: state.hasInitialHoldings,
		focusPlan: deriveFocusPlan(state.plans),
	};
}

/**
 * 查询首页状态与持仓成本（/home 分流与仪表盘的数据源）
 *
 * 两个请求并行发起、互不阻塞：
 * - state 失败 → isError（页面错误态消费），dashboard 为 null；
 * - portfolio 失败 → 仅 totalRemainingCost/baseCurrency/avgUnitCost 降级 null，
 *   不进入页面错误态。
 *
 * 归一返回：
 * - isLoading：组织详情未返回，或放行后 state 首次请求进行中
 * - isError / refetch：state 请求失败与重试（页面错误态消费，不跳转不误判）
 * - state：state 成功时的数据（分流三布尔 + 账户/计划列表 + 最新汇率观测时间）
 * - dashboard：state 成功时的仪表盘数据（state 失败/加载中 → null；portfolio
 *   未成功时仅成本字段降级 null）
 * - gate：账本查询闸门（见下）
 * - needsOnboarding：当前组织未建账（页面分流到 /onboarding）
 * - isDeletionLocked：组织删除处理中（页面分流到 /data-requests）
 *
 * 查询降噪（技术方案 §10.3；Goal #3B W28）：两个请求都挂在组织锁守卫上，受账本查询
 * 闸门（useLedgerQueryGate）约束——未选组织 / 组织详情未返回 / 未建账 / 组织删除处理中
 * 一律不发。建账分流改读当前组织详情的 onboardingCompleted（与 /home/state 的
 * onboardingCompleted 在后端是同一判定：组织偏好是否存在），未建账组织不再为此请求
 * /home/state 与 /home/portfolio；组织删除处理中两者必然 403，页面据 isDeletionLocked
 * 主动去进度页，不靠 403 硬跳转。
 *
 * 分流决策表（changes/home-state-routing/技术方案.md §3.1 + onboarding-rework 口径）：
 * !onboardingCompleted → /onboarding 建账向导；!hasAccounts && !hasPlans → 空状态；
 * 其余 → 正常首页；!hasInitialHoldings → 叠加补录初始持仓引导卡。
 */
export function useHomeState() {
	// 组织作用域缓存键 + 账本查询闸门（需求 15.1.3 切组织隔离）
	const orgId = useActiveOrgId();
	const gate = useLedgerQueryGate();
	const ledgerEnabled = gate === "ready";

	const stateQuery = useQuery<HomeState>({
		queryKey: withOrgScope(orgId, HOME_STATE_QUERY_KEY),
		queryFn: homeApi.getState,
		enabled: ledgerEnabled,
		staleTime: 5 * 60 * 1000, // 与全局默认一致；纯只读数据，允许秒级陈旧（方案 §2）
		retry: false, // 401 由 apiClient 统一跳登录，其余失败直接交给页面错误态
	});

	const portfolioQuery = useQuery<HomePortfolioData>({
		queryKey: withOrgScope(orgId, HOME_PORTFOLIO_QUERY_KEY),
		queryFn: fetchHomePortfolio,
		enabled: ledgerEnabled,
		staleTime: 5 * 60 * 1000, // 与 state 同策略；纯只读聚合数据
		retry: false, // 失败静默降级（见 deriveDashboard），不进入页面错误态
	});

	const dashboard = useMemo(
		() =>
			stateQuery.data
				? deriveDashboard(stateQuery.data, portfolioQuery.data)
				: null,
		[stateQuery.data, portfolioQuery.data],
	);

	/**
	 * 重试只在闸门放行时才真的发请求：React Query 的 refetch 会绕过 enabled，
	 * 组织未建账 / 删除锁下若沿用缓存的错误态点重试，就会打出一个必然的 409 / 403。
	 */
	const refetch = (): Promise<QueryObserverResult<HomeState, Error>> =>
		ledgerEnabled ? stateQuery.refetch() : Promise.resolve(stateQuery);

	return {
		isLoading: gate === "loading" || stateQuery.isLoading,
		isError: stateQuery.isError,
		refetch,
		state: stateQuery.data,
		dashboard,
		gate,
		// 闸门判定优先；组织详情读取失败时闸门放行、回落到首页状态自报的建账态
		needsOnboarding:
			gate === "not-onboarded" ||
			stateQuery.data?.onboardingCompleted === false,
		isDeletionLocked: gate === "deletion-locked",
	};
}
