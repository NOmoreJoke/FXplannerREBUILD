// Node ≥26 localStorage 回填（vitest#8757；use-chat.spec 先例）——
// use-organizations 经 organization-store(persist)、chat-store(persist) 与
// QueryClient 交互需要
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	useCreateOrganization,
	useCurrentOrganization,
	useLeaveOrganization,
	useOrganizationRouting,
	useOrganizations,
	useSwitchOrganization,
} from "@/lib/hooks/use-organizations";
import { membersApi, organizationsApi } from "@/lib/api/organizations";
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import { useOrganizationStore } from "@/lib/stores/organization-store";
import {
	registerActiveStreamAbort,
	useChatStore,
} from "@/lib/stores/chat-store";
import type React from "react";

/**
 * 组织上下文 hook 测试（GOAL-3A W20 必配；外部评审前端批次 I-18/I-19 回归）：
 * 列表门控、当前组织详情按组织分桶、切换触发缓存清理/流中止/聊天态重置、
 * 路由分流（单组织直达、失效选择清除、加载失败重试、被拒绝组织不循环）、
 * 创建与退出组织的上下文收尾。
 */

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

const summary = (id: string, name: string) => ({
	id,
	name,
	role: "OWNER" as const,
	baseCurrency: "CNY",
	onboardingCompleted: true,
	createdAt: "2026-11-01T00:00:00.000Z",
});

const currentOf = (id: string, name: string) => ({
	id,
	name,
	role: "OWNER" as const,
	capabilities: { "organization.read": true } as Record<string, boolean>,
	onboardingCompleted: true,
	baseCurrency: "CNY",
	ledgerStartedAt: "2026-01-01T00:00:00.000Z",
	dataRequestLock: { active: false, type: null },
});

const CHAT_RUNTIME = {
	activeConversationId: null as string | null,
	streamingIds: [] as string[],
	creatingStream: false,
	streamTexts: {} as Record<string, string>,
	toolActiveIds: [] as string[],
	errors: {} as Record<string, string | null>,
	newChatError: null as string | null,
	pendingUserContent: null as string | null,
	selectedModel: null as string | null,
};

const wrapperFactory = () => {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return { queryClient, wrapper };
};

beforeEach(() => {
	vi.resetAllMocks();
	useOrganizationStore.setState({
		activeOrganizationId: null,
		activeOrganizationSetAt: 0,
		rejectedOrganizationIds: [],
	});
	useChatStore.setState(CHAT_RUNTIME);
});

afterEach(() => {
	registerActiveStreamAbort(null);
	vi.clearAllMocks();
});

describe("useOrganizations（列表）", () => {
	it("拉取本人组织列表", async () => {
		vi.mocked(organizationsApi.list).mockResolvedValue([
			summary("org-a", "组织 A"),
		]);
		const { wrapper } = wrapperFactory();
		const { result } = renderHook(() => useOrganizations(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.[0]?.id).toBe("org-a");
	});

	it("enabled=false 时不发请求（认证未就绪不拉组织列表）", async () => {
		const { wrapper } = wrapperFactory();
		const { result } = renderHook(
			() => useOrganizations({ enabled: false }),
			{ wrapper },
		);
		await act(async () => {
			await Promise.resolve();
		});
		expect(result.current.fetchStatus).toBe("idle");
		expect(organizationsApi.list).not.toHaveBeenCalled();
	});
});

describe("useCurrentOrganization（当前组织）", () => {
	it("未选组织不发请求（enabled 门控）", async () => {
		const { wrapper } = wrapperFactory();
		const { result } = renderHook(() => useCurrentOrganization(), { wrapper });
		expect(result.current.fetchStatus).toBe("idle");
		expect(organizationsApi.current).not.toHaveBeenCalled();
	});

	it("选中组织后拉取详情", async () => {
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		vi.mocked(organizationsApi.current).mockResolvedValue(currentOf("org-a", "组织 A"));
		const { wrapper } = wrapperFactory();
		const { result } = renderHook(() => useCurrentOrganization(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.role).toBe("OWNER");
	});

	it("缓存按组织 id 分桶：切换后重拉期间不会读到上一个组织的 capabilities", async () => {
		vi.mocked(organizationsApi.current).mockResolvedValueOnce(
			currentOf("org-a", "组织 A"),
		);
		const { wrapper } = wrapperFactory();
		const { result, rerender } = renderHook(() => useCurrentOrganization(), {
			wrapper,
		});
		act(() => {
			useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		});
		await waitFor(() => expect(result.current.data?.id).toBe("org-a"));

		// 切到组织 B：详情请求挂起，期间不得残留组织 A 的数据
		vi.mocked(organizationsApi.current).mockReturnValue(new Promise(() => {}));
		act(() => {
			useOrganizationStore.setState({ activeOrganizationId: "org-b" });
		});
		rerender();
		await waitFor(() => expect(result.current.fetchStatus).toBe("fetching"));
		expect(result.current.data).toBeUndefined();
	});
});

describe("useSwitchOrganization（切换）", () => {
	it("清旧组织缓存（无前缀 + 带前缀 + 组织详情）→ 切 store → 失效组织列表重拉", async () => {
		const { queryClient, wrapper } = wrapperFactory();
		queryClient.setQueryData(queryKeys.home.state(), { stale: "unprefixed" });
		queryClient.setQueryData(withOrgScope("org-a", queryKeys.plans.list()), {
			stale: "org-a",
		});
		queryClient.setQueryData(queryKeys.organizations.current("org-a"), {
			stale: "current-a",
		});
		queryClient.setQueryData(queryKeys.rates.supported(), { public: true });
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(() => useSwitchOrganization(), { wrapper });
		act(() => {
			result.current("org-b");
		});

		expect(useOrganizationStore.getState().activeOrganizationId).toBe("org-b");
		expect(queryClient.getQueryData(queryKeys.home.state())).toBeUndefined();
		expect(
			queryClient.getQueryData(withOrgScope("org-a", queryKeys.plans.list())),
		).toBeUndefined();
		expect(
			queryClient.getQueryData(queryKeys.organizations.current("org-a")),
		).toBeUndefined();
		// 公共缓存保留
		expect(queryClient.getQueryData(queryKeys.rates.supported())).toBeDefined();
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: queryKeys.organizations.list(),
		});
	});

	it("评审 I-18：中止在途 SSE 流并重置聊天运行时态", async () => {
		const { wrapper } = wrapperFactory();
		const abort = new AbortController();
		registerActiveStreamAbort(abort);
		useChatStore.setState({
			...CHAT_RUNTIME,
			activeConversationId: "conv-old",
			streamingIds: ["conv-old"],
			streamTexts: { "conv-old": "进行中的回复" },
			selectedModel: "gpt-x",
		});

		const { result } = renderHook(() => useSwitchOrganization(), { wrapper });
		act(() => {
			result.current("org-b");
		});

		expect(abort.signal.aborted).toBe(true);
		const chat = useChatStore.getState();
		expect(chat.activeConversationId).toBeNull();
		expect(chat.streamingIds).toEqual([]);
		expect(chat.streamTexts).toEqual({});
		// 模型偏好是个人偏好，切换组织不清除
		expect(chat.selectedModel).toBe("gpt-x");
	});

	it("迟到慢响应不污染新组织缓存（旧组织键已被移除，新组织读的是自己的前缀键）", async () => {
		const { queryClient, wrapper } = wrapperFactory();
		const { result } = renderHook(() => useSwitchOrganization(), { wrapper });
		act(() => {
			result.current("org-b");
		});
		// 模拟旧组织迟到响应到达：手工写回旧键，不影响新组织页面读取的键
		queryClient.setQueryData(queryKeys.home.state(), { late: true });
		expect(
			queryClient.getQueryData(withOrgScope("org-b", queryKeys.home.state())),
		).toBeUndefined();
	});
});

describe("useOrganizationRouting（受保护区的组织路由分流）", () => {
	it("enabled=false：不拉列表，status=disabled", async () => {
		const { wrapper } = wrapperFactory();
		const { result } = renderHook(
			() => useOrganizationRouting({ enabled: false }),
			{ wrapper },
		);
		await act(async () => {
			await Promise.resolve();
		});
		expect(result.current.status).toBe("disabled");
		expect(organizationsApi.list).not.toHaveBeenCalled();
	});

	it("加载中 → 就绪：多组织且已选", async () => {
		useOrganizationStore.setState({ activeOrganizationId: "org-b" });
		vi.mocked(organizationsApi.list).mockResolvedValue([
			summary("org-a", "组织 A"),
			summary("org-b", "组织 B"),
		]);
		const { wrapper } = wrapperFactory();
		const { result } = renderHook(
			() => useOrganizationRouting({ enabled: true }),
			{ wrapper },
		);
		expect(result.current.status).toBe("loading");
		await waitFor(() => expect(result.current.status).toBe("ready"));
	});

	it("多组织未选 → pick（由 layout 渲染选择页），且不替用户做选择", async () => {
		vi.mocked(organizationsApi.list).mockResolvedValue([
			summary("org-a", "组织 A"),
			summary("org-b", "组织 B"),
		]);
		const { wrapper } = wrapperFactory();
		const { result } = renderHook(
			() => useOrganizationRouting({ enabled: true }),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.status).toBe("pick"));
		expect(useOrganizationStore.getState().activeOrganizationId).toBeNull();
	});

	it("单组织：首帧即 ready（选择页不闪现），选择由受控副作用落到 store", async () => {
		vi.mocked(organizationsApi.list).mockResolvedValue([
			summary("org-a", "组织 A"),
		]);
		const { wrapper } = wrapperFactory();
		const { result } = renderHook(
			() => useOrganizationRouting({ enabled: true }),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.status).toBe("ready"));
		await waitFor(() =>
			expect(useOrganizationStore.getState().activeOrganizationId).toBe("org-a"),
		);
	});

	it("持久化的选择不属于本人组织（换账号/被移出）→ 清除；剩余单组织则自动选中它", async () => {
		vi.mocked(organizationsApi.list).mockResolvedValue([
			summary("org-a", "组织 A"),
		]);
		useOrganizationStore.setState({ activeOrganizationId: "org-other-account" });
		const { wrapper } = wrapperFactory();
		const { result } = renderHook(
			() => useOrganizationRouting({ enabled: true }),
			{ wrapper },
		);
		await waitFor(() =>
			expect(useOrganizationStore.getState().activeOrganizationId).toBe("org-a"),
		);
		expect(result.current.status).toBe("ready");
	});

	it("应用设置的选择（切换/接受邀请/新建组织）：列表尚未重拉时不得被当作失效选择清除", async () => {
		vi.mocked(organizationsApi.list).mockResolvedValue([
			summary("org-a", "组织 A"),
		]);
		const { wrapper } = wrapperFactory();
		const { result } = renderHook(
			() => useOrganizationRouting({ enabled: true }),
			{ wrapper },
		);
		await waitFor(() =>
			expect(useOrganizationStore.getState().activeOrganizationId).toBe("org-a"),
		);

		// 模拟刚接受邀请：应用立即选中新组织，而列表缓存（已失效、重拉在途）还不含它
		act(() => {
			useOrganizationStore.getState().setActiveOrganization("org-new");
		});
		await waitFor(() => expect(result.current.status).toBe("ready"));
		await act(async () => {
			await Promise.resolve();
		});
		// 选择保留（否则用户会被切回默认组织，而不是刚加入的那个）
		expect(useOrganizationStore.getState().activeOrganizationId).toBe("org-new");
	});

	it("应用设置的选择在列表数据新于设置时刻后仍不存在 → 清除（服务端从未认可该组织）", async () => {
		vi.mocked(organizationsApi.list).mockResolvedValue([
			summary("org-a", "组织 A"),
		]);
		useOrganizationStore.setState({
			activeOrganizationId: "org-ghost",
			activeOrganizationSetAt: 1,
		});
		const { wrapper } = wrapperFactory();
		const { result } = renderHook(
			() => useOrganizationRouting({ enabled: true }),
			{ wrapper },
		);

		// 列表到达（数据时刻远晚于设置时刻）且不含 org-ghost → 清除 → 剩余单组织自动选中
		await waitFor(() =>
			expect(useOrganizationStore.getState().activeOrganizationId).toBe("org-a"),
		);
		expect(result.current.status).toBe("ready");
	});

	it("被拒绝的组织在本会话内重新加入（再次接受邀请）后可以再次进入", async () => {
		vi.mocked(organizationsApi.list).mockResolvedValue([
			summary("org-a", "组织 A"),
		]);
		useOrganizationStore.setState({
			activeOrganizationId: null,
			activeOrganizationSetAt: 0,
			rejectedOrganizationIds: ["org-a"],
		});
		const { wrapper } = wrapperFactory();
		const { result, rerender } = renderHook(
			() => ({
				routing: useOrganizationRouting({ enabled: true }),
				switchOrganization: useSwitchOrganization(),
			}),
			{ wrapper },
		);
		// 被移出后：不得自动选回
		await waitFor(() => expect(result.current.routing.status).toBe("pick"));

		// 再次接受邀请 → 应用显式选中该组织：拒绝态解除，可以进入
		act(() => {
			result.current.switchOrganization("org-a");
		});
		rerender();
		await waitFor(() => expect(result.current.routing.status).toBe("ready"));
		expect(useOrganizationStore.getState().activeOrganizationId).toBe("org-a");
		expect(useOrganizationStore.getState().rejectedOrganizationIds).toEqual([]);
	});

	it("列表加载失败 → error（不误入「创建组织」引导），重试后恢复", async () => {
		vi.mocked(organizationsApi.list).mockRejectedValueOnce(new Error("网络异常"));
		vi.mocked(organizationsApi.list).mockResolvedValue([]);
		const { wrapper } = wrapperFactory();
		const { result } = renderHook(
			() => useOrganizationRouting({ enabled: true }),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.status).toBe("error"));
		expect(organizationsApi.list).toHaveBeenCalledTimes(1);

		await act(async () => {
			result.current.retry();
		});
		await waitFor(() => expect(result.current.status).toBe("pick"));
		expect(organizationsApi.list).toHaveBeenCalledTimes(2);
	});

	it("被服务端拒绝的组织不再被自动选中（防「清除 → 自动选回 → 再 404」循环），并触发列表重拉", async () => {
		vi.mocked(organizationsApi.list).mockResolvedValue([
			summary("org-a", "组织 A"),
		]);
		const { queryClient, wrapper } = wrapperFactory();
		const refetchSpy = vi.spyOn(queryClient, "refetchQueries");
		useOrganizationStore.setState({
			activeOrganizationId: null,
			rejectedOrganizationIds: ["org-a"],
		});

		const { result } = renderHook(
			() => useOrganizationRouting({ enabled: true }),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.status).toBe("pick"));
		// 列表里确实只有这一个组织，但它被拒绝了：不得选中
		expect(useOrganizationStore.getState().activeOrganizationId).toBeNull();
		await waitFor(() => expect(refetchSpy).toHaveBeenCalled());
		expect(refetchSpy).toHaveBeenCalledWith({
			queryKey: queryKeys.organizations.list(),
		});
	});
});

describe("useCreateOrganization / useLeaveOrganization", () => {
	it("创建成功：切换到新组织（清缓存 + 切选择 + 列表失效）", async () => {
		vi.mocked(organizationsApi.create).mockResolvedValue(
			summary("org-new", "新组织"),
		);
		const { queryClient, wrapper } = wrapperFactory();
		queryClient.setQueryData(queryKeys.home.state(), { stale: true });
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(() => useCreateOrganization(), { wrapper });
		await act(async () => {
			await result.current.mutateAsync({ name: "新组织" });
		});

		expect(organizationsApi.create).toHaveBeenCalledWith({ name: "新组织" });
		expect(useOrganizationStore.getState().activeOrganizationId).toBe("org-new");
		expect(queryClient.getQueryData(queryKeys.home.state())).toBeUndefined();
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: queryKeys.organizations.list(),
		});
	});

	it("退出成功：清空组织上下文（缓存/流/聊天态/选择）并重拉列表", async () => {
		vi.mocked(membersApi.leave).mockResolvedValue({ status: "DISABLED" });
		const { queryClient, wrapper } = wrapperFactory();
		queryClient.setQueryData(queryKeys.home.state(), { stale: true });
		queryClient.setQueryData(queryKeys.members.list(), [{ id: "m1" }]);
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
		const abort = new AbortController();
		registerActiveStreamAbort(abort);
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		useChatStore.setState({ ...CHAT_RUNTIME, activeConversationId: "conv-1" });

		const { result } = renderHook(() => useLeaveOrganization(), { wrapper });
		await act(async () => {
			await result.current.mutateAsync();
		});

		expect(membersApi.leave).toHaveBeenCalledTimes(1);
		const state = useOrganizationStore.getState();
		expect(state.activeOrganizationId).toBeNull();
		expect(queryClient.getQueryData(queryKeys.home.state())).toBeUndefined();
		expect(queryClient.getQueryData(queryKeys.members.list())).toBeUndefined();
		expect(abort.signal.aborted).toBe(true);
		expect(useChatStore.getState().activeConversationId).toBeNull();
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: queryKeys.organizations.list(),
		});
	});
});
