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
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import {
	isReminderBypassRoute,
	useMarkReminderRead,
	useReminderGate,
	useReminders,
} from "./use-reminders";
import { onboardingApi } from "@/lib/api/onboarding";
import { remindersApi } from "@/lib/api/reminders";
import { settingsApi } from "@/lib/api/settings";
import type { RemindersView } from "@/lib/api/contract";
import type React from "react";

// Mock API 封装（hook 单测不触网）
vi.mock("@/lib/api/reminders", () => ({
	remindersApi: {
		list: vi.fn(),
		markRead: vi.fn(),
		markAllRead: vi.fn(),
	},
}));

vi.mock("@/lib/api/onboarding", () => ({
	onboardingApi: {
		getStatus: vi.fn(),
	},
}));

vi.mock("@/lib/api/settings", () => ({
	settingsApi: {
		getSettings: vi.fn(),
	},
}));

/** 一条未读 PREP_DUE 提醒（契约字段取自 schema.gen，示例值对齐接口测试 #3） */
const unreadItem = {
	id: "rem-1",
	planId: "plan-1",
	planName: null,
	targetCurrency: "USD",
	scheduledFor: "2026-09-16T16:00:00.000Z",
	readAt: null,
	recordedType: "PREP_DUE" as const,
	matters: [
		{
			kind: "PREP_DUE" as const,
			installmentAmount: "3000.0000",
			gapAmount: "9000.0000",
			isFundsReady: false,
			daysOverdue: null,
		},
	],
};

/** 一条已读 USE_DUE 提醒 */
const readItem = {
	...unreadItem,
	id: "rem-2",
	planId: "plan-2",
	recordedType: "USE_DUE" as const,
	readAt: "2026-09-16T16:05:00.000Z",
	matters: [
		{
			kind: "USE_DUE" as const,
			installmentAmount: null,
			gapAmount: "0.0000",
			isFundsReady: true,
			daysOverdue: null,
		},
	],
};

const viewData: RemindersView = {
	items: [unreadItem, readItem],
	unreadCount: 1,
};

const emptyData: RemindersView = { items: [], unreadCount: 0 };

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

describe("useReminders", () => {
	beforeEach(() => {
		// ToB W20：业务查询按组织门控（enabled: orgId !== null）——测试统一选中组织
		useOrganizationStore.setState({ activeOrganizationId: "org-test" });
		vi.clearAllMocks();
	});

	it("加载中应返回 isLoading=true 且 items/unreadCount 为空值", () => {
		vi.mocked(remindersApi.list).mockReturnValue(new Promise(() => {}));

		const { result } = renderHook(() => useReminders(), {
			wrapper: createWrapper(),
		});

		expect(result.current.isLoading).toBe(true);
		expect(result.current.isError).toBe(false);
		expect(result.current.items).toEqual([]);
		expect(result.current.unreadCount).toBe(0);
	});

	it("查询成功应返回 items 与 unreadCount 派生", async () => {
		vi.mocked(remindersApi.list).mockResolvedValue(viewData);

		const { result } = renderHook(() => useReminders(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.items).toEqual(viewData.items);
		expect(result.current.unreadCount).toBe(1);
		expect(result.current.isError).toBe(false);
	});

	it("查询失败应返回 isError=true，items/unreadCount 降级为空值", async () => {
		vi.mocked(remindersApi.list).mockRejectedValue(
			new Error("服务不可用（5xx）"),
		);

		const { result } = renderHook(() => useReminders(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.isLoading).toBe(false);
		expect(result.current.items).toEqual([]);
		expect(result.current.unreadCount).toBe(0);
	});

	it("staleTime 内重复挂载不重复请求（共享缓存，避免重复触发生成）", async () => {
		vi.mocked(remindersApi.list).mockResolvedValue(emptyData);

		const wrapper = createWrapper();
		const first = renderHook(() => useReminders(), { wrapper });
		await waitFor(() => expect(first.result.current.isLoading).toBe(false));

		const second = renderHook(() => useReminders(), { wrapper });
		await waitFor(() => expect(second.result.current.isLoading).toBe(false));

		expect(remindersApi.list).toHaveBeenCalledTimes(1);
	});

	it("查询 Key 应符合项目 [domain, action] 约定", async () => {
		const { REMINDERS_QUERY_KEY } = await import("./use-reminders");
		expect(REMINDERS_QUERY_KEY).toEqual(["reminders", "list"]);
	});
});

describe("useMarkReminderRead", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("markRead 成功后应失效列表缓存并重取（已读状态回读）", async () => {
		vi.mocked(remindersApi.list)
			.mockResolvedValueOnce(viewData) // 初始：1 条未读
			.mockResolvedValue({
				...viewData,
				items: [
					{ ...unreadItem, readAt: "2026-09-16T16:10:00.000Z" },
					readItem,
				],
				unreadCount: 0,
			}); // 已读后回读

		vi.mocked(remindersApi.markRead).mockResolvedValue({
			id: "rem-1",
			readAt: "2026-09-16T16:10:00.000Z",
		});

		const wrapper = createWrapper();
		const { result } = renderHook(
			() => ({
				reminders: useReminders(),
				markRead: useMarkReminderRead(),
			}),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.reminders.unreadCount).toBe(1));

		result.current.markRead.mutate("rem-1");

		await waitFor(() => expect(result.current.reminders.unreadCount).toBe(0));
		expect(remindersApi.markRead).toHaveBeenCalledWith("rem-1");
		// 缓存失效后列表重新拉取（初始 1 次 + invalidate 回读 1 次）
		await waitFor(() => expect(remindersApi.list).toHaveBeenCalledTimes(2));
	});

	it("markRead 失败不抛未捕获异常（mutation error 态）", async () => {
		vi.mocked(remindersApi.list).mockResolvedValue(emptyData);
		vi.mocked(remindersApi.markRead).mockRejectedValue(
			new Error("REMINDER_NOT_FOUND"),
		);

		const wrapper = createWrapper();
		const { result } = renderHook(() => useMarkReminderRead(), { wrapper });

		result.current.mutate("rem-x");

		await waitFor(() => expect(result.current.isError).toBe(true));
	});
});

describe("useReminderGate（未建账与锁定期请求门控，F1-3 / DEBT-06）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// 门控查询按组织门控且键按组织分桶（评审 R2-I07 / R2-I10）——显式选中组织，
		// 不依赖前一个 describe 留下的 store 状态
		useOrganizationStore.setState({
			activeOrganizationId: "org-test",
			activeOrganizationSetAt: 0,
			rejectedOrganizationIds: [],
		});
	});

	it("R2-I10：未选组织时零 onboarding / settings / reminders 请求（铃铛不得抢发无组织头的请求）", async () => {
		useOrganizationStore.setState({ activeOrganizationId: null });
		const { result } = renderHook(() => useReminderGate("/home"), {
			wrapper: createWrapper(),
		});
		await act(async () => {
			await Promise.resolve();
		});
		expect(onboardingApi.getStatus).not.toHaveBeenCalled();
		expect(settingsApi.getSettings).not.toHaveBeenCalled();
		expect(remindersApi.list).not.toHaveBeenCalled();
		expect(result.current.isOnboarded).toBe(false);
	});

	it("R2-I07：门控查询键按组织分桶——切换组织后 onboarding/settings 重新拉取，不沿用上一个组织的缓存", async () => {
		vi.mocked(onboardingApi.getStatus).mockResolvedValue({
			completed: false,
			requiredConsentsMet: true,
			settings: null,
			currentTermsVersion: "2026-01",
		});
		const { queryClient, Wrapper } = createWrapperWithClient();
		const { rerender } = renderHook(() => useReminderGate("/home"), {
			wrapper: Wrapper,
		});
		await waitFor(() => expect(onboardingApi.getStatus).toHaveBeenCalledTimes(1));
		// 键不含组织时，这里读到的是无前缀键（上一个组织的缓存会被沿用）
		expect(
			queryClient.getQueryData(
				withOrgScope("org-test", queryKeys.onboarding.status()),
			),
		).toMatchObject({ completed: false });

		// 切到另一组织：门控按新组织键重新拉取建账状态（不同组织建账态不同）
		act(() => {
			useOrganizationStore.setState({ activeOrganizationId: "org-other" });
		});
		rerender();
		await waitFor(() => expect(onboardingApi.getStatus).toHaveBeenCalledTimes(2));
	});

	it("useReminders({ enabled: false }) 不触发 GET /reminders", () => {
		const { result } = renderHook(() => useReminders({ enabled: false }), {
			wrapper: createWrapper(),
		});

		expect(result.current.items).toEqual([]);
		expect(result.current.unreadCount).toBe(0);
		expect(remindersApi.list).not.toHaveBeenCalled();
	});

	it("/onboarding、/data-requests、/invitations 路由：零 onboarding / settings / reminders 请求", () => {
		expect(isReminderBypassRoute("/onboarding")).toBe(true);
		expect(isReminderBypassRoute("/onboarding?backfill=1")).toBe(true);
		expect(isReminderBypassRoute("/data-requests")).toBe(true);
		// 邀请页：受邀者可能尚无组织/未选组织，铃铛的业务请求会被 400 ORGANIZATION_REQUIRED
		// 拒绝并把人从邀请页带走（外部评审前端批次）
		expect(isReminderBypassRoute("/invitations/invite-token-123")).toBe(true);
		expect(isReminderBypassRoute("/home")).toBe(false);

		for (const path of ["/onboarding", "/data-requests", "/invitations/tok-1"]) {
			const { result } = renderHook(() => useReminderGate(path), {
				wrapper: createWrapper(),
			});
			expect(result.current.isBypassed).toBe(true);
		}
		expect(onboardingApi.getStatus).not.toHaveBeenCalled();
		expect(settingsApi.getSettings).not.toHaveBeenCalled();
		expect(remindersApi.list).not.toHaveBeenCalled();
	});

	it("未建账用户（completed=false）：只查 onboarding/status，零 settings 与 reminders 请求", async () => {
		vi.mocked(onboardingApi.getStatus).mockResolvedValue({
			completed: false,
			requiredConsentsMet: true,
			settings: null,
			currentTermsVersion: "2026-01",
		});

		const { result } = renderHook(() => useReminderGate("/home"), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(onboardingApi.getStatus).toHaveBeenCalledTimes(1));
		expect(result.current.isOnboarded).toBe(false);
		expect(settingsApi.getSettings).not.toHaveBeenCalled();
		expect(remindersApi.list).not.toHaveBeenCalled();
	});

	it("已建账但关闭提醒（reminderEnabled=false）：查 settings 但零 reminders 请求", async () => {
		vi.mocked(onboardingApi.getStatus).mockResolvedValue({
			completed: true,
			requiredConsentsMet: true,
			settings: null,
			currentTermsVersion: "2026-01",
		});
		vi.mocked(settingsApi.getSettings).mockResolvedValue({
			email: "u@example.com",
			region: "CN",
			locale: "zh-CN",
			baseCurrency: "CNY",
			prepPreference: "balanced",
			reminderEnabled: false,
			ledgerStartedAt: "2026-01-01T00:00:00.000Z",
		});

		const { result } = renderHook(() => useReminderGate("/home"), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(settingsApi.getSettings).toHaveBeenCalledTimes(1));
		expect(result.current.isOnboarded).toBe(true);
		expect(result.current.reminderEnabled).toBe(false);
		expect(remindersApi.list).not.toHaveBeenCalled();
	});

	it("已建账且开启提醒（reminderEnabled=true）：正常拉取未读数", async () => {
		vi.mocked(onboardingApi.getStatus).mockResolvedValue({
			completed: true,
			requiredConsentsMet: true,
			settings: null,
			currentTermsVersion: "2026-01",
		});
		vi.mocked(settingsApi.getSettings).mockResolvedValue({
			email: "u@example.com",
			region: "CN",
			locale: "zh-CN",
			baseCurrency: "CNY",
			prepPreference: "balanced",
			reminderEnabled: true,
			ledgerStartedAt: "2026-01-01T00:00:00.000Z",
		});
		vi.mocked(remindersApi.list).mockResolvedValue(viewData);

		const { result } = renderHook(() => useReminderGate("/home"), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.unreadCount).toBe(1));
		expect(remindersApi.list).toHaveBeenCalledTimes(1);
	});
});
