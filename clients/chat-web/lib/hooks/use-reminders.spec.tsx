import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useReminders, useMarkReminderRead } from "./use-reminders";
import { remindersApi } from "@/lib/api/reminders";
import type { RemindersView } from "@/lib/api/contract";
import type React from "react";

// Mock 提醒接口封装（hook 单测不触网）
vi.mock("@/lib/api/reminders", () => ({
	remindersApi: {
		list: vi.fn(),
		markRead: vi.fn(),
		markAllRead: vi.fn(),
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

describe("useReminders", () => {
	beforeEach(() => {
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
