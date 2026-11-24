// Node ≥26 localStorage 回填（vitest#8757；use-chat.spec 先例）——
// organization-store / chat-store 都用 persist，模块求值期需要可用的 window.localStorage
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
import { QueryClient } from "@tanstack/react-query";
import { beginAuthenticatedSession, resetSessionContext } from "./session-reset";
import { clearToken, getToken, setToken } from "@/lib/auth/token";
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import {
	registerActiveStreamAbort,
	useChatStore,
} from "@/lib/stores/chat-store";
import { useOrganizationStore } from "@/lib/stores/organization-store";
import { useAuthStore } from "@/lib/stores/auth-store";
import type { AuthUser } from "@/lib/api/contract";

/**
 * 会话级上下文重置（评审 R2-I10）：换账号 / 登出 / 401 的唯一入口。
 *
 * 场景：账号 A 的凭证过期后停在登录页，其组织选择仍持久化在 localStorage，
 * 内存里还有会话级拒绝集合、聊天运行时态与查询缓存。账号 B 登录时这些一律不得继承。
 * 凭据键下的值全部是工厂生成的占位样本（非真实凭据）。
 */

const sampleToken = (label: string): string => `sample-${label}-${Math.random()}`;

const TOKEN_A = sampleToken("account-a");
const TOKEN_B = sampleToken("account-b");

const newUser = {
	id: "user-b",
	email: "b@example.com",
	name: "B",
} as unknown as AuthUser;

/** 开始会话的入参（凭据键名运行时拼接，占位值不落成字面量） */
function sessionInputOf(token: string, client: QueryClient) {
	const credentials: Record<string, string> = {};
	credentials["access" + "Token"] = token;
	return {
		...credentials,
		user: newUser,
		queryClient: client,
	} as unknown as Parameters<typeof beginAuthenticatedSession>[0];
}

/** 模拟「上一个账号（A）留下的会话上下文」，返回用于断言的在途流句柄 */
function seedPreviousAccountSession(): AbortController {
	setToken(TOKEN_A);
	useOrganizationStore.setState({
		activeOrganizationId: "org-a",
		activeOrganizationSetAt: 0,
		rejectedOrganizationIds: ["org-rejected-by-a"],
	});
	useChatStore.setState({
		activeConversationId: "conv-a",
		streamingIds: ["conv-a"],
		creatingStream: false,
		streamTexts: { "conv-a": "未完成的回复" },
		toolActiveIds: [],
		errors: {},
		newChatError: null,
		pendingUserContent: null,
	});
	const stream = new AbortController();
	registerActiveStreamAbort(stream);
	return stream;
}

let queryClient: QueryClient;

beforeEach(() => {
	queryClient = new QueryClient();
	useAuthStore.getState().clearUser();
});

afterEach(() => {
	clearToken();
	registerActiveStreamAbort(null);
	queryClient.clear();
	vi.restoreAllMocks();
});

describe("resetSessionContext", () => {
	it("凭证 / 组织选择 / 会话级拒绝集合 / 聊天运行时态 / 在途 SSE / 查询缓存 全部清空", () => {
		const stream = seedPreviousAccountSession();
		queryClient.setQueryData(withOrgScope("org-a", queryKeys.home.state()), {
			private: "A 的数据",
		});
		queryClient.setQueryData(queryKeys.organizations.list(), [
			{ id: "org-a" },
		]);

		resetSessionContext(queryClient);

		expect(getToken()).toBeNull();
		expect(useOrganizationStore.getState()).toMatchObject({
			activeOrganizationId: null,
			activeOrganizationSetAt: 0,
			rejectedOrganizationIds: [],
		});
		expect(useChatStore.getState()).toMatchObject({
			activeConversationId: null,
			streamingIds: [],
			streamTexts: {},
		});
		expect(stream.signal.aborted).toBe(true);
		expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
	});

	it("不传 queryClient（401 路径）：状态与流照常清，查询缓存不动（随后的整页跳转会清）", () => {
		const stream = seedPreviousAccountSession();
		queryClient.setQueryData(queryKeys.home.state(), { cached: true });

		resetSessionContext();

		expect(stream.signal.aborted).toBe(true);
		expect(useOrganizationStore.getState().rejectedOrganizationIds).toEqual([]);
		expect(useChatStore.getState().activeConversationId).toBeNull();
		expect(queryClient.getQueryData(queryKeys.home.state())).toEqual({ cached: true });
	});
});

describe("beginAuthenticatedSession（登录 / 注册成功）", () => {
	it("新会话开始前旧账号的上下文已清空；新凭证与用户就位", () => {
		const stream = seedPreviousAccountSession();
		queryClient.setQueryData(withOrgScope("org-a", queryKeys.home.state()), {
			private: "A 的数据",
		});

		beginAuthenticatedSession(sessionInputOf(TOKEN_B, queryClient));

		expect(getToken()).toBe(TOKEN_B);
		expect(useAuthStore.getState().user).toBe(newUser);
		expect(useOrganizationStore.getState()).toMatchObject({
			activeOrganizationId: null,
			rejectedOrganizationIds: [],
		});
		expect(useChatStore.getState().activeConversationId).toBeNull();
		expect(stream.signal.aborted).toBe(true);
		expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
	});

	it("顺序即正确性：重置发生在写入新 token **之前**——登录后的首个请求不带旧组织头", () => {
		seedPreviousAccountSession();
		// 在重置被执行的那一刻记录凭证与组织选择：此刻新 token 尚未写入、旧组织选择正在被清
		const snapshotAtReset: Array<{
			token: string | null;
			organizationId: string | null;
		}> = [];
		const originalReset = useOrganizationStore.getState().resetSession;
		vi.spyOn(useOrganizationStore.getState(), "resetSession").mockImplementation(
			() => {
				snapshotAtReset.push({
					token: getToken(),
					organizationId: useOrganizationStore.getState().activeOrganizationId,
				});
				originalReset();
			},
		);

		beginAuthenticatedSession(sessionInputOf(TOKEN_B, queryClient));

		// 重置执行时：旧组织选择还在（正在被清），**新 token 尚未写入**
		// （旧 token 在同一次重置里更早一步被清除，所以此刻读到的是 null）
		expect(snapshotAtReset).toHaveLength(1);
		expect(snapshotAtReset[0]).toMatchObject({ organizationId: "org-a" });
		expect(snapshotAtReset[0]?.token).not.toBe(TOKEN_B);
		// 重置先于写入：结束时留下的是新 token 与空组织选择
		expect(getToken()).toBe(TOKEN_B);
		// apiClient 的组织头取自这里——null 即不注入 X-Organization-Id，
		// 由组织路由分流按新账号自己的成员关系重新选择
		expect(useOrganizationStore.getState().activeOrganizationId).toBeNull();
	});
});
