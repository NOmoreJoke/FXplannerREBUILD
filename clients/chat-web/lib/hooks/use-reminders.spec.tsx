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
	const jsdomStorage = dom?.window.localStorage;
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
import { organizationsApi } from "@/lib/api/organizations";
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import {
	isReminderBypassRoute,
	useMarkReminderRead,
	useReminderGate,
	useReminders,
} from "./use-reminders";
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

vi.mock("@/lib/api/settings", () => ({
	settingsApi: {
		getSettings: vi.fn(),
	},
}));

// 当前组织详情：账本查询闸门的判定依据（建账态 / 组织锁）
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

/** 组织设置视图（提醒开关默认开启） */
const settingsView = {
	email: "u@example.com",
	region: "CN",
	locale: "zh-CN",
	baseCurrency: "CNY",
	prepPreference: "balanced" as const,
	reminderEnabled: true,
	ledgerStartedAt: "2026-01-01T00:00:00.000Z",
};

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

/** 等所有已发起的异步查询落定（断言「零请求」前必须等到底） */
async function settle() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("useReminders", () => {
	beforeEach(() => {
		// ToB W20：业务查询按组织门控（enabled: orgId !== null）——测试统一选中组织
		useOrganizationStore.setState({ activeOrganizationId: "org-test" });
		mockCurrentOrganization();
		vi.mocked(settingsApi.getSettings).mockResolvedValue(settingsView);
		vi.clearAllMocks();
	});

	it("闸门放行后首次请求进行中：isLoading=true，items/unreadCount 为空值（此前不该有请求）", async () => {
		vi.mocked(remindersApi.list).mockReturnValue(new Promise(() => {}));

		const { result } = renderHook(() => useReminders(), {
			wrapper: createWrapper(),
		});

		// 组织详情未返回前闸门关闭：既不加载也不请求
		expect(result.current.isLoading).toBe(false);
		expect(remindersApi.list).not.toHaveBeenCalled();

		// 放行后请求发出，进入加载态
		await waitFor(() => expect(result.current.isLoading).toBe(true));
		expect(remindersApi.list).toHaveBeenCalledOnce();
		expect(result.current.isError).toBe(false);
		expect(result.current.items).toEqual([]);
		expect(result.current.unreadCount).toBe(0);
	});

	it("查询成功应返回 items 与 unreadCount 派生", async () => {
		vi.mocked(remindersApi.list).mockResolvedValue(viewData);

		const { result } = renderHook(() => useReminders(), {
			wrapper: createWrapper(),
		});

		// 闸门未放行时 isLoading 本就是 false：要等的是数据到达，不是「加载结束」
		await waitFor(() => expect(result.current.items).toEqual(viewData.items));
		expect(result.current.isLoading).toBe(false);
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
		await waitFor(() => expect(first.result.current.items).toEqual(emptyData.items));
		await waitFor(() => expect(remindersApi.list).toHaveBeenCalledOnce());

		const second = renderHook(() => useReminders(), { wrapper });
		await waitFor(() => expect(second.result.current.items).toEqual(emptyData.items));

		expect(remindersApi.list).toHaveBeenCalledTimes(1);
	});

	it("查询 Key 应符合项目 [domain, action] 约定", async () => {
		const { REMINDERS_QUERY_KEY } = await import("./use-reminders");
		expect(REMINDERS_QUERY_KEY).toEqual(["reminders", "list"]);
	});

	it.each([
		["未选组织", null, {}],
		["未建账组织", "org-test", { onboardingCompleted: false }],
		[
			"组织删除处理中",
			"org-test",
			{ dataRequestLock: { active: true, type: "DELETION" } },
		],
	] as const)(
		"查询降噪：%s：即使调用方传 enabled=true 也零 GET /reminders",
		async (_label, activeOrganizationId, overrides) => {
			useOrganizationStore.setState({ activeOrganizationId });
			mockCurrentOrganization(overrides as Partial<OrganizationCurrent>);
			const { result } = renderHook(() => useReminders(), {
				wrapper: createWrapper(),
			});
			if (activeOrganizationId !== null) {
				await waitFor(() => expect(organizationsApi.current).toHaveBeenCalledOnce());
			}
			await settle();
			expect(remindersApi.list).not.toHaveBeenCalled();
			expect(result.current.items).toEqual([]);
			expect(result.current.isLoading).toBe(false);
		},
	);

	it("CLEAR 锁不拦读：清空冷静期内 GET 放行，照常拉取（写操作由后端 403 引导）", async () => {
		mockCurrentOrganization({
			dataRequestLock: { active: true, type: "CLEAR" },
		});
		vi.mocked(remindersApi.list).mockResolvedValue(viewData);
		const { result } = renderHook(() => useReminders(), {
			wrapper: createWrapper(),
		});
		await waitFor(() => expect(result.current.unreadCount).toBe(1));
		expect(remindersApi.list).toHaveBeenCalledOnce();
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

describe("useReminderGate（顶栏铃铛：路由豁免 + 账本查询闸门）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// 门控查询按组织门控且键按组织分桶（评审 R2-I07 / R2-I10）——显式选中组织，
		// 不依赖前一个 describe 留下的 store 状态
		useOrganizationStore.setState({
			activeOrganizationId: "org-test",
			activeOrganizationSetAt: 0,
			rejectedOrganizationIds: [],
		});
		mockCurrentOrganization();
		vi.mocked(settingsApi.getSettings).mockResolvedValue(settingsView);
	});

	it("拦截路由：零 settings 与 reminders 请求，铃铛不展示", () => {
		expect(isReminderBypassRoute("/onboarding")).toBe(true);
		expect(isReminderBypassRoute("/onboarding?backfill=1")).toBe(true);
		expect(isReminderBypassRoute("/data-requests")).toBe(true);
		// 邀请页：受邀者可能尚无组织/未选组织，铃铛的业务请求会被 400 ORGANIZATION_REQUIRED
		// 拒绝并把人从邀请页带走（外部评审前端批次）
		expect(isReminderBypassRoute("/invitations/invite-token-123")).toBe(true);
		expect(isReminderBypassRoute("/invitations")).toBe(true);
		// 按路径段匹配：同前缀的其他路径不误豁免（与 isOrglessRouteAllowed 同口径）
		expect(isReminderBypassRoute("/invitations-old")).toBe(false);
		expect(isReminderBypassRoute("/onboarding-test")).toBe(false);
		expect(isReminderBypassRoute("/data-requests-v2")).toBe(false);
		expect(isReminderBypassRoute("/home")).toBe(false);

		for (const path of ["/onboarding", "/data-requests", "/invitations/tok-1"]) {
			const { result } = renderHook(() => useReminderGate(path), {
				wrapper: createWrapper(),
			});
			expect(result.current.isBypassed).toBe(true);
			expect(result.current.isOpen).toBe(false);
		}
		expect(settingsApi.getSettings).not.toHaveBeenCalled();
		expect(remindersApi.list).not.toHaveBeenCalled();
	});

	it("R2-I10：未选组织时零 settings / reminders 请求（铃铛不得抢发无组织头的请求）", async () => {
		useOrganizationStore.setState({ activeOrganizationId: null });
		const { result } = renderHook(() => useReminderGate("/home"), {
			wrapper: createWrapper(),
		});
		await settle();
		expect(organizationsApi.current).not.toHaveBeenCalled();
		expect(settingsApi.getSettings).not.toHaveBeenCalled();
		expect(remindersApi.list).not.toHaveBeenCalled();
		expect(result.current.gate).toBe("no-organization");
		expect(result.current.isOpen).toBe(false);
		expect(result.current.reminderEnabled).toBe(false);
	});

	it("R2-I07：设置键按组织分桶——切换组织后按新组织键重新拉取，不沿用上一个组织的缓存", async () => {
		vi.mocked(remindersApi.list).mockResolvedValue(viewData);
		const { queryClient, Wrapper } = createWrapperWithClient();
		const { result } = renderHook(() => useReminderGate("/home"), {
			wrapper: Wrapper,
		});
		await waitFor(() => expect(result.current.reminderEnabled).toBe(true));
		expect(
			queryClient.getQueryData(
				withOrgScope("org-test", queryKeys.settings.detail()),
			),
		).toEqual(settingsView);

		// 切到另一组织：提醒开关是组织级的，按新组织键重新拉取
		mockCurrentOrganization({
			name: "另一个组织",
			ledgerStartedAt: "2026-02-01T00:00:00.000Z",
		});
		vi.mocked(settingsApi.getSettings).mockResolvedValue({
			...settingsView,
			reminderEnabled: false,
		});
		act(() => {
			useOrganizationStore.setState({ activeOrganizationId: "org-other" });
		});
		// 等的是新组织的设置真正落进它自己的键（新键上 data 为 undefined 时 reminderEnabled
		// 本就是 false，不能拿它当「已切换」的信号）
		await waitFor(() =>
			expect(
				queryClient.getQueryData(
					withOrgScope("org-other", queryKeys.settings.detail()),
				),
			).toMatchObject({ reminderEnabled: false }),
		);
		expect(settingsApi.getSettings).toHaveBeenCalledTimes(2);
		expect(result.current.reminderEnabled).toBe(false);
		// 键含组织 id：两个组织的设置缓存互不覆盖
		expect(
			queryClient.getQueryData(
				withOrgScope("org-other", queryKeys.settings.detail()),
			),
		).toMatchObject({ reminderEnabled: false });
		expect(
			queryClient.getQueryData(
				withOrgScope("org-test", queryKeys.settings.detail()),
			),
		).toMatchObject({ reminderEnabled: true });
	});

	it("useReminders({ enabled: false }) 不触发 GET /reminders", () => {
		const { result } = renderHook(() => useReminders({ enabled: false }), {
			wrapper: createWrapper(),
		});

		expect(result.current.items).toEqual([]);
		expect(result.current.unreadCount).toBe(0);
		expect(remindersApi.list).not.toHaveBeenCalled();
	});

	it("DEBT-06：未建账组织零 settings、零 reminders 请求（此前铃铛每次都吃一个 409）", async () => {
		mockCurrentOrganization({ onboardingCompleted: false });
		const { result } = renderHook(() => useReminderGate("/home"), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.gate).toBe("not-onboarded"));
		await settle();
		expect(organizationsApi.current).toHaveBeenCalledOnce();
		expect(settingsApi.getSettings).not.toHaveBeenCalled();
		expect(remindersApi.list).not.toHaveBeenCalled();
		expect(result.current.isOpen).toBe(false);
	});

	it("组织删除处理中：零 settings、零 reminders 请求（否则必然 403 并被跳转）", async () => {
		mockCurrentOrganization({
			dataRequestLock: { active: true, type: "DELETION" },
		});
		const { result } = renderHook(() => useReminderGate("/home"), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.gate).toBe("deletion-locked"));
		await settle();
		expect(settingsApi.getSettings).not.toHaveBeenCalled();
		expect(remindersApi.list).not.toHaveBeenCalled();
		expect(result.current.isOpen).toBe(false);
	});

	it("组织详情在途：闸门先关着（零请求），放行后才查 settings", async () => {
		let release: (value: OrganizationCurrent) => void = () => {};
		vi.mocked(organizationsApi.current).mockReturnValueOnce(
			new Promise<OrganizationCurrent>((resolve) => {
				release = resolve;
			}),
		);
		const { result } = renderHook(() => useReminderGate("/home"), {
			wrapper: createWrapper(),
		});
		await waitFor(() => expect(organizationsApi.current).toHaveBeenCalledOnce());
		await settle();
		expect(result.current.gate).toBe("loading");
		expect(result.current.isOpen).toBe(false);
		expect(settingsApi.getSettings).not.toHaveBeenCalled();

		release({
			id: "org-test",
			name: "测试组织",
			role: "OWNER",
			capabilities: {},
			onboardingCompleted: true,
			baseCurrency: "CNY",
			ledgerStartedAt: "2026-01-01T00:00:00.000Z",
			dataRequestLock: { active: false, type: null },
		});
		await waitFor(() => expect(result.current.gate).toBe("ready"));
		await waitFor(() => expect(result.current.reminderEnabled).toBe(true));
		expect(settingsApi.getSettings).toHaveBeenCalledOnce();
	});

	it("组织详情读取失败：闸门回退放行，交给 /settings 自身裁决（不把用户卡在无声的空状态）", async () => {
		vi.mocked(organizationsApi.current).mockRejectedValue(new Error("网络抖动"));
		vi.mocked(remindersApi.list).mockResolvedValue(viewData);
		const { result } = renderHook(() => useReminderGate("/home"), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.unreadCount).toBe(1));
		expect(result.current.gate).toBe("ready");
		expect(result.current.isOpen).toBe(true);
	});

	it("已建账但关闭提醒（reminderEnabled=false）：查 settings 但零 reminders 请求", async () => {
		vi.mocked(settingsApi.getSettings).mockResolvedValue({
			...settingsView,
			reminderEnabled: false,
		});
		const { result } = renderHook(() => useReminderGate("/home"), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(settingsApi.getSettings).toHaveBeenCalledOnce());
		await waitFor(() => expect(result.current.reminderEnabled).toBe(false));
		expect(result.current.isOpen).toBe(true);
		expect(remindersApi.list).not.toHaveBeenCalled();
	});

	it("已建账且开启提醒（reminderEnabled=true）：正常拉取未读数", async () => {
		vi.mocked(remindersApi.list).mockResolvedValue(viewData);

		const { result } = renderHook(() => useReminderGate("/home"), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.unreadCount).toBe(1));
		expect(remindersApi.list).toHaveBeenCalledTimes(1);
		expect(result.current.isOpen).toBe(true);
	});

	it("拦截路由与闸门是「与」的关系：拦截路由上即便组织已建账也不发请求", async () => {
		vi.mocked(remindersApi.list).mockResolvedValue(viewData);
		const { result } = renderHook(() => useReminderGate("/data-requests"), {
			wrapper: createWrapper(),
		});
		// 闸门本身照常解析（页面上别的组件需要），但铃铛不查设置、不查提醒
		await waitFor(() => expect(result.current.gate).toBe("ready"));
		await settle();
		expect(settingsApi.getSettings).not.toHaveBeenCalled();
		expect(remindersApi.list).not.toHaveBeenCalled();
		expect(result.current.isBypassed).toBe(true);
	});
});
