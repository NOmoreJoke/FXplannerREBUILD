import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { addDays, subDays } from "date-fns";
import { useHomeState, HOME_STATE_QUERY_KEY } from "./use-home-state";
import { fetchHomePortfolio, homeApi } from "@/lib/api/home";
import type { HomePortfolioData } from "@/lib/api/home";
import type { HomeState } from "@/lib/api/contract";
import type React from "react";

// Mock homeApi 与持仓成本接口（fetchHomePortfolio）
vi.mock("@/lib/api/home", () => ({
	homeApi: {
		getState: vi.fn(),
	},
	fetchHomePortfolio: vi.fn(),
}));

/** 新用户（未完成设置；onboarding 已取消，此状态按空账本处理） */
const onboardingIncompleteState: HomeState = {
	onboardingCompleted: false,
	hasAccounts: false,
	hasPlans: false,
	accounts: [],
	plans: [],
	latestRateObservedAt: null,
};

/** 完成设置但空账本（→ 空状态引导页） */
const emptyBookState: HomeState = {
	onboardingCompleted: true,
	hasAccounts: false,
	hasPlans: false,
	accounts: [],
	plans: [],
	latestRateObservedAt: null,
};

/** 完成设置且有账户有计划（→ 正常数据首页，示例取自技术方案 §3.1 示例 B） */
const dataState: HomeState = {
	onboardingCompleted: true,
	hasAccounts: true,
	hasPlans: true,
	accounts: [
		{ currencyCode: "USD", balance: "1500.0000" },
		{ currencyCode: "JPY", balance: "120000.0000" },
	],
	plans: [
		{
			id: "cmex5g2h70000abcd",
			targetCurrency: "USD",
			targetAmount: "10000.0000",
			allocatedAmount: "4000.0000",
			remainingAmount: "6000.0000",
			expectUseDate: "2026-10-01T00:00:00.000Z",
			latestPrepDate: "2026-09-25T00:00:00.000Z",
			status: "ACTIVE",
		},
	],
	latestRateObservedAt: "2026-09-24T01:30:00.000Z",
};

/** 持仓成本聚合（契约 §2：本位币 + CostLot 剩余持仓聚合） */
const portfolioData: HomePortfolioData = {
	baseCurrency: "HKD",
	totalRemainingCost: "246380.0000",
	byCurrency: [
		{
			currencyCode: "JPY",
			remainingQty: "100000.0000",
			totalRemainingCost: "6000.0000",
			avgUnitCost: "0.0600000000",
		},
		{
			currencyCode: "USD",
			remainingQty: "1000.0000",
			totalRemainingCost: "7800.0000",
			avgUnitCost: "7.8000000000",
		},
	],
};

/** 相对本地今天偏移 n 天的 ISO 8601 UTC 时间串（latestPrepDate fixture 用） */
const isoDaysFromToday = (n: number) => addDays(new Date(), n).toISOString();

const createWrapper = () => {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
};

describe("useHomeState", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// 默认 portfolio 成功；仅 portfolio 降级场景的用例内覆盖
		vi.mocked(fetchHomePortfolio).mockResolvedValue(portfolioData);
	});

	it("加载中应返回 isLoading=true 且 state 为空", () => {
		vi.mocked(homeApi.getState).mockReturnValue(new Promise(() => {}));

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		expect(result.current.isLoading).toBe(true);
		expect(result.current.isError).toBe(false);
		expect(result.current.state).toBeUndefined();
		expect(homeApi.getState).toHaveBeenCalledOnce();
	});

	it("请求失败应返回 isError=true，refetch 可调用并恢复成功", async () => {
		vi.mocked(homeApi.getState)
			.mockRejectedValueOnce(new Error("网络失败"))
			.mockResolvedValueOnce(dataState);

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.isLoading).toBe(false);
		expect(result.current.state).toBeUndefined();
		expect(typeof result.current.refetch).toBe("function");

		const refetchResult = await result.current.refetch();
		expect(refetchResult.isSuccess).toBe(true);

		await waitFor(() => expect(result.current.state).toEqual(dataState));
		expect(result.current.isError).toBe(false);
	});

	it("onboardingCompleted=false 应原样返回，页面不再据此跳转（onboarding 已取消）", async () => {
		vi.mocked(homeApi.getState).mockResolvedValue(onboardingIncompleteState);

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.isError).toBe(false);
		expect(result.current.state?.onboardingCompleted).toBe(false);
	});

	it("空账本（三布尔中 completed=true 且无账户无计划）应返回空状态分支所需数据", async () => {
		vi.mocked(homeApi.getState).mockResolvedValue(emptyBookState);

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.state).toEqual({
			onboardingCompleted: true,
			hasAccounts: false,
			hasPlans: false,
			accounts: [],
			plans: [],
			latestRateObservedAt: null,
		});
	});

	it("有数据（有账户或有计划）应返回完整 state 供正常首页渲染", async () => {
		vi.mocked(homeApi.getState).mockResolvedValue(dataState);

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.state).toEqual(dataState);
		expect(result.current.state?.hasAccounts).toBe(true);
		expect(result.current.state?.hasPlans).toBe(true);
		expect(result.current.state?.accounts).toHaveLength(2);
		expect(result.current.state?.plans).toHaveLength(1);
	});

	it("查询 Key 应符合项目 [domain, action] 约定", () => {
		expect(HOME_STATE_QUERY_KEY).toEqual(["home", "state"]);
	});
});

describe("useHomeState - dashboard 派生（home-dashboard 数据层）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// 默认 portfolio 成功；仅 portfolio 降级场景的用例内覆盖
		vi.mocked(fetchHomePortfolio).mockResolvedValue(portfolioData);
	});

	/** 构造多币种账户 + 多个 ACTIVE 计划的 state */
	const multiActiveState: HomeState = {
		onboardingCompleted: true,
		hasAccounts: true,
		hasPlans: true,
		accounts: [
			{ currencyCode: "USD", balance: "1500.0000" },
			{ currencyCode: "JPY", balance: "120000.0000" },
		],
		plans: [
			{
				id: "plan-later",
				targetCurrency: "USD",
				targetAmount: "10000.0000",
				allocatedAmount: "4000.0000",
				remainingAmount: "6000.0000",
				expectUseDate: isoDaysFromToday(15),
				latestPrepDate: isoDaysFromToday(10),
				status: "ACTIVE",
			},
			{
				id: "plan-earlier",
				targetCurrency: "CAD",
				targetAmount: "8000.0000",
				allocatedAmount: "2000.0000",
				remainingAmount: "6000.0000",
				expectUseDate: isoDaysFromToday(8),
				latestPrepDate: isoDaysFromToday(5),
				status: "ACTIVE",
			},
		],
		latestRateObservedAt: "2026-09-24T01:30:00.000Z",
	};

	it("正常场景：dashboard 汇总账户/持仓成本，focusPlan 选 latestPrepDate 最早的 ACTIVE 计划", async () => {
		vi.mocked(homeApi.getState).mockResolvedValue(multiActiveState);

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() =>
			expect(result.current.dashboard?.focusPlan).not.toBeUndefined(),
		);
		const dashboard = result.current.dashboard;
		expect(dashboard).not.toBeNull();

		// 账户汇总：计数 + 币种去重升序 + 逐卡透传 balance 并匹配 avgUnitCost
		expect(dashboard?.accountCount).toBe(2);
		expect(dashboard?.currencies).toEqual(["JPY", "USD"]);
		expect(dashboard?.accountCards).toEqual([
			{
				currencyCode: "USD",
				balance: "1500.0000",
				avgUnitCost: "7.8000000000",
			},
			{
				currencyCode: "JPY",
				balance: "120000.0000",
				avgUnitCost: "0.0600000000",
			},
		]);

		// 持仓成本：portfolio 数据透传 + state 字段透传
		expect(dashboard?.totalRemainingCost).toBe("246380.0000");
		expect(dashboard?.baseCurrency).toBe("HKD");
		expect(dashboard?.latestRateObservedAt).toBe("2026-09-24T01:30:00.000Z");

		// focusPlan：两个 ACTIVE 中选 latestPrepDate 最早（today+5）者
		expect(dashboard?.focusPlan?.id).toBe("plan-earlier");
		expect(dashboard?.focusPlan?.name).toBeNull();
		expect(dashboard?.focusPlan?.targetCurrency).toBe("CAD");
		expect(dashboard?.focusPlan?.targetAmount).toBe("8000.0000");
		expect(dashboard?.focusPlan?.allocatedAmount).toBe("2000.0000");
		expect(dashboard?.focusPlan?.remainingAmount).toBe("6000.0000");
		// 2000/8000×100 = 25，四舍五入取整
		expect(dashboard?.focusPlan?.progressPercent).toBe(25);
		expect(dashboard?.focusPlan?.daysUntilPrepDeadline).toBe(5);
		expect(dashboard?.focusPlan?.isOverdue).toBe(false);
	});

	it("progressPercent 钳位：allocated > target → 100", async () => {
		vi.mocked(homeApi.getState).mockResolvedValue({
			...multiActiveState,
			plans: [
				{
					id: "plan-over",
					targetCurrency: "USD",
					targetAmount: "10000.0000",
					allocatedAmount: "12000.0000",
					remainingAmount: "0.0000",
					expectUseDate: isoDaysFromToday(10),
					latestPrepDate: isoDaysFromToday(5),
					status: "ACTIVE",
				},
			],
		});

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() =>
			expect(result.current.dashboard?.focusPlan?.id).toBe("plan-over"),
		);
		expect(result.current.dashboard?.focusPlan?.progressPercent).toBe(100);
	});

	it("progressPercent 钳位：targetAmount=0 → 0", async () => {
		vi.mocked(homeApi.getState).mockResolvedValue({
			...multiActiveState,
			plans: [
				{
					id: "plan-zero",
					targetCurrency: "USD",
					targetAmount: "0.0000",
					allocatedAmount: "0.0000",
					remainingAmount: "0.0000",
					expectUseDate: isoDaysFromToday(10),
					latestPrepDate: isoDaysFromToday(5),
					status: "ACTIVE",
				},
			],
		});

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() =>
			expect(result.current.dashboard?.focusPlan?.id).toBe("plan-zero"),
		);
		expect(result.current.dashboard?.focusPlan?.progressPercent).toBe(0);
	});

	it("portfolio 请求失败：state 数据仍在，成本字段降级 null，不进入页面错误态", async () => {
		vi.mocked(homeApi.getState).mockResolvedValue(multiActiveState);
		vi.mocked(fetchHomePortfolio).mockRejectedValue(
			new Error("服务不可用（5xx）"),
		);

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		// state 照常返回，页面错误态不被 portfolio 拖累
		expect(result.current.isError).toBe(false);
		expect(result.current.state).toEqual(multiActiveState);

		// 成本相关字段全部降级 null
		expect(result.current.dashboard?.totalRemainingCost).toBeNull();
		expect(result.current.dashboard?.baseCurrency).toBeNull();
		expect(
			result.current.dashboard?.accountCards.every(
				(card) => card.avgUnitCost === null,
			),
		).toBe(true);

		// state 派生字段不受影响
		expect(result.current.dashboard?.accountCount).toBe(2);
		expect(result.current.dashboard?.focusPlan?.id).toBe("plan-earlier");
	});

	it("无 ACTIVE 计划：focusPlan=null", async () => {
		vi.mocked(homeApi.getState).mockResolvedValue({
			...multiActiveState,
			plans: [
				{ ...multiActiveState.plans[0], id: "plan-done", status: "COMPLETED" },
				{
					...multiActiveState.plans[1],
					id: "plan-cancelled",
					status: "CANCELLED",
				},
			],
		});

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.dashboard?.focusPlan).toBeNull();
		// 其余字段照常派生
		expect(result.current.dashboard?.accountCount).toBe(2);
		expect(result.current.dashboard?.totalRemainingCost).toBe("246380.0000");
	});

	it("已逾期计划：isOverdue=true 且 daysUntilPrepDeadline 为负", async () => {
		vi.mocked(homeApi.getState).mockResolvedValue({
			...multiActiveState,
			plans: [
				{
					...multiActiveState.plans[0],
					id: "plan-overdue",
					latestPrepDate: subDays(new Date(), 3).toISOString(),
				},
			],
		});

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() =>
			expect(result.current.dashboard?.focusPlan?.id).toBe("plan-overdue"),
		);
		expect(result.current.dashboard?.focusPlan?.daysUntilPrepDeadline).toBe(-3);
		expect(result.current.dashboard?.focusPlan?.isOverdue).toBe(true);
	});

	it("dashboard 两个查询 Key 均符合 [domain, action] 约定", async () => {
		const { HOME_PORTFOLIO_QUERY_KEY } = await import("./use-home-state");
		expect(HOME_PORTFOLIO_QUERY_KEY).toEqual(["home", "portfolio"]);
	});
});
