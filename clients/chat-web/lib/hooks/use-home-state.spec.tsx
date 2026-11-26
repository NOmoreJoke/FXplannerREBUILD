// Node ≥26 在 globalThis 上自带一个返回 undefined 的 localStorage 原生 getter，
// 会遮蔽 vitest 4 populateGlobal 注入的 jsdom localStorage（vitest#8757）——
// zustand persist 在 store 模块求值期通过 `window.localStorage` 取 storage，
// 拿到 undefined 后首次 setState 即崩。此处从 vitest 暴露的原始 jsdom 实例
// （globalThis.jsdom.window.localStorage 完好）回填，覆盖被遮蔽的 getter。
// （use-chat.spec 先例；ToB W20 起 organization-store 也用 persist，本文件同样需要）
vi.hoisted(() => {
	const dom = (
		globalThis as { jsdom?: { window: Window & { localStorage?: Storage } } }
	).jsdom;
	const jsdomStorage = dom?.window?.localStorage;
	if (!jsdomStorage) return;
	const globals = [globalThis, globalThis.window] as Array<
		Record<string, unknown>
	>;
	for (const target of globals) {
		if (target.localStorage === undefined) {
			Object.defineProperty(target, "localStorage", {
				value: jsdomStorage,
				configurable: true,
				writable: true,
			});
		}
	}
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "@testing-library/react";
import { useOrganizationStore } from "@/lib/stores/organization-store";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { addDays, subDays } from "date-fns";
import { organizationsApi } from "@/lib/api/organizations";
import { withOrgScope } from "@/lib/api/query-keys";
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

// 当前组织详情：账本查询闸门的判定依据（建账态 / 组织删除锁）
vi.mock("@/lib/api/organizations", () => ({
	organizationsApi: {
		list: vi.fn(),
		current: vi.fn(),
		create: vi.fn(),
	},
	membersApi: {
		leave: vi.fn(),
	},
}));

type OrganizationCurrent = Awaited<ReturnType<typeof organizationsApi.current>>;

/** 让当前组织详情解析为给定状态的组织（id 跟随 store 的当前选择） */
function mockCurrentOrganization(
	overrides: Partial<OrganizationCurrent> = {},
) {
	vi.mocked(organizationsApi.current).mockImplementation(async () => ({
		id: useOrganizationStore.getState().activeOrganizationId ?? "org-test",
		name: "测试组织",
		role: "OWNER",
		capabilities: {},
		onboardingCompleted: true,
		baseCurrency: "CNY",
		ledgerStartedAt: "2026-01-01T00:00:00.000Z",
		dataRequestLock: { active: false, type: null },
		...overrides,
	}));
}

/** 等所有已发起的异步查询落定（断言「零请求」前必须等到底） */
async function settle() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

/** 新用户（未完成设置；分流至 /onboarding 建账向导，onboarding-rework 口径） */
const onboardingIncompleteState: HomeState = {
	onboardingCompleted: false,
	hasAccounts: false,
	hasPlans: false,
	accounts: [],
	plans: [],
	latestRateObservedAt: null,
	hasInitialHoldings: false,
};

/** 完成设置但空账本（→ 空状态引导页；未录初始持仓时叠加补录引导卡） */
const emptyBookState: HomeState = {
	onboardingCompleted: true,
	hasAccounts: false,
	hasPlans: false,
	accounts: [],
	plans: [],
	latestRateObservedAt: null,
	hasInitialHoldings: false,
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
	hasInitialHoldings: true,
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

/** 同上，但同时暴露 QueryClient（断言缓存键形态用） */
const createWrapperWithClient = () => {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const Wrapper = ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return { queryClient, Wrapper };
};

describe("useHomeState", () => {
	beforeEach(() => {
		// ToB W20：业务查询按组织门控（enabled: orgId !== null）——测试统一选中组织；
		// W28 起还要过账本查询闸门：组织详情解析为「已建账、无锁」
		useOrganizationStore.setState({ activeOrganizationId: "org-test" });
		mockCurrentOrganization();
		vi.clearAllMocks();
		// 默认 portfolio 成功；仅 portfolio 降级场景的用例内覆盖
		vi.mocked(fetchHomePortfolio).mockResolvedValue(portfolioData);
	});

	it("组织详情在途：isLoading=true、state 为空且零首页请求；放行后 state 首次请求进行中", async () => {
		vi.mocked(homeApi.getState).mockReturnValue(new Promise(() => {}));

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		// 闸门未开：建账态与锁态未知，不发 /home/state 与 /home/portfolio
		await waitFor(() => expect(organizationsApi.current).toHaveBeenCalledOnce());
		expect(result.current.isLoading).toBe(true);
		expect(result.current.isError).toBe(false);
		expect(result.current.state).toBeUndefined();
		expect(homeApi.getState).not.toHaveBeenCalled();

		// 放行后请求发出
		await waitFor(() => expect(homeApi.getState).toHaveBeenCalledOnce());
		expect(result.current.isLoading).toBe(true);
		expect(result.current.state).toBeUndefined();
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

	it("组织详情读取失败时的回落：/home/state 自报 onboardingCompleted=false 原样返回，needsOnboarding 同步为 true", async () => {
		// 闸门只是降噪优化：判定依据拿不到时放行，分流回落到首页状态自己的建账布尔
		mockCurrentOrganization();
		vi.mocked(organizationsApi.current).mockRejectedValue(new Error("网络抖动"));
		vi.mocked(homeApi.getState).mockResolvedValue(onboardingIncompleteState);

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.state).toBeDefined());

		expect(result.current.isError).toBe(false);
		expect(result.current.state).toEqual(onboardingIncompleteState);
		expect(result.current.needsOnboarding).toBe(true);
		expect(result.current.gate).toBe("ready");
	});

	it("空账本（三布尔中 completed=true 且无账户无计划）应返回空状态分支所需数据", async () => {
		vi.mocked(homeApi.getState).mockResolvedValue(emptyBookState);

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.state).toBeDefined());

		expect(result.current.state).toEqual({
			onboardingCompleted: true,
			hasAccounts: false,
			hasPlans: false,
			accounts: [],
			plans: [],
			latestRateObservedAt: null,
			hasInitialHoldings: false,
		});
	});

	it("有数据（有账户或有计划）应返回完整 state 供正常首页渲染", async () => {
		vi.mocked(homeApi.getState).mockResolvedValue(dataState);

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.state).toBeDefined());

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

describe("useHomeState - 账本查询闸门（查询降噪，技术方案 §10.3）", () => {
	beforeEach(() => {
		useOrganizationStore.setState({ activeOrganizationId: "org-test" });
		mockCurrentOrganization();
		vi.clearAllMocks();
		vi.mocked(homeApi.getState).mockResolvedValue(dataState);
		vi.mocked(fetchHomePortfolio).mockResolvedValue(portfolioData);
	});

	it("DEBT-06：未建账组织零 /home/state、零 /home/portfolio 请求；needsOnboarding 直接取自组织详情", async () => {
		mockCurrentOrganization({
			onboardingCompleted: false,
			baseCurrency: null,
			ledgerStartedAt: null,
		});
		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.needsOnboarding).toBe(true));
		await settle();
		expect(homeApi.getState).not.toHaveBeenCalled();
		expect(fetchHomePortfolio).not.toHaveBeenCalled();
		// 不是「加载中」：页面据此分流去建账向导，而不是停在骨架屏
		expect(result.current.isLoading).toBe(false);
		expect(result.current.isError).toBe(false);
		expect(result.current.gate).toBe("not-onboarded");
		expect(result.current.dashboard).toBeNull();
	});

	it("组织删除处理中零首页请求（否则必然 403）；页面据 isDeletionLocked 主动去进度页", async () => {
		mockCurrentOrganization({
			dataRequestLock: { active: true, type: "DELETION" },
		});
		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isDeletionLocked).toBe(true));
		await settle();
		expect(homeApi.getState).not.toHaveBeenCalled();
		expect(fetchHomePortfolio).not.toHaveBeenCalled();
		expect(result.current.isLoading).toBe(false);
		expect(result.current.gate).toBe("deletion-locked");
		expect(result.current.needsOnboarding).toBe(false);
	});

	it("删除锁下 refetch 不发请求：refetch 会绕过 enabled，错误态的重试不能打出一个必然的 403", async () => {
		mockCurrentOrganization({
			dataRequestLock: { active: true, type: "DELETION" },
		});
		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});
		await waitFor(() => expect(result.current.isDeletionLocked).toBe(true));

		await act(async () => {
			await result.current.refetch();
		});
		expect(homeApi.getState).not.toHaveBeenCalled();
	});

	it("未选组织零首页请求（未建账 / 锁态也无从谈起）", async () => {
		useOrganizationStore.setState({ activeOrganizationId: null });
		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});
		await settle();
		expect(organizationsApi.current).not.toHaveBeenCalled();
		expect(homeApi.getState).not.toHaveBeenCalled();
		expect(fetchHomePortfolio).not.toHaveBeenCalled();
		expect(result.current.gate).toBe("no-organization");
		expect(result.current.isLoading).toBe(false);
	});

	it("CLEAR 锁不拦读：清空冷静期内首页照常加载（写操作由后端 403 引导去进度页）", async () => {
		mockCurrentOrganization({
			dataRequestLock: { active: true, type: "CLEAR" },
		});
		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});
		await waitFor(() => expect(result.current.state).toEqual(dataState));
		expect(homeApi.getState).toHaveBeenCalledOnce();
		expect(result.current.isDeletionLocked).toBe(false);
		expect(result.current.needsOnboarding).toBe(false);
	});

	it("组织详情读取失败时闸门放行：/home/state 照常请求，失败照常进错误态并可重试", async () => {
		vi.mocked(organizationsApi.current).mockRejectedValue(new Error("网络抖动"));
		vi.mocked(homeApi.getState)
			.mockRejectedValueOnce(new Error("网络失败"))
			.mockResolvedValueOnce(dataState);
		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.gate).toBe("ready");
		const refetchResult = await result.current.refetch();
		expect(refetchResult.isSuccess).toBe(true);
		await waitFor(() => expect(result.current.state).toEqual(dataState));
	});

	it("放行后两个请求都按组织分桶键缓存（切换组织不沿用上一个组织的首页数据）", async () => {
		const { queryClient, Wrapper } = createWrapperWithClient();
		const { result } = renderHook(() => useHomeState(), { wrapper: Wrapper });
		await waitFor(() => expect(result.current.state).toEqual(dataState));
		expect(
			queryClient.getQueryData(withOrgScope("org-test", HOME_STATE_QUERY_KEY)),
		).toEqual(dataState);
		expect(queryClient.getQueryData(HOME_STATE_QUERY_KEY)).toBeUndefined();
	});
});

describe("useHomeState - dashboard 派生（home-dashboard 数据层）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useOrganizationStore.setState({ activeOrganizationId: "org-test" });
		mockCurrentOrganization();
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
		hasInitialHoldings: true,
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
		// hasInitialHoldings 透传（初始持仓已录入 → true）
		expect(dashboard?.hasInitialHoldings).toBe(true);

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

	it("hasInitialHoldings=false 应透传（首页据此挂补录引导卡）", async () => {
		vi.mocked(homeApi.getState).mockResolvedValue({
			...multiActiveState,
			hasInitialHoldings: false,
		});

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.state).toBeDefined());

		expect(result.current.state?.hasInitialHoldings).toBe(false);
		expect(result.current.dashboard?.hasInitialHoldings).toBe(false);
	});

	it("portfolio 请求失败：state 数据仍在，成本字段降级 null，不进入页面错误态", async () => {
		vi.mocked(homeApi.getState).mockResolvedValue(multiActiveState);
		vi.mocked(fetchHomePortfolio).mockRejectedValue(
			new Error("服务不可用（5xx）"),
		);

		const { result } = renderHook(() => useHomeState(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.state).toBeDefined());

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

		await waitFor(() => expect(result.current.state).toBeDefined());

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
