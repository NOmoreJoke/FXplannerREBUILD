// Node ≥26 在 globalThis 上自带一个返回 undefined 的 localStorage 原生 getter，
// 会遮蔽 vitest 4 populateGlobal 注入的 jsdom localStorage（vitest#8757）——
// zustand persist 在 store 模块求值期通过 `window.localStorage` 取 storage，
// 拿到 undefined 后首次 setState 即崩。此处从 vitest 暴露的原始 jsdom 实例
// （globalThis.jsdom.window.localStorage 完好）回填，覆盖被遮蔽的 getter。
// （use-chat.spec 先例；本文件断言「权限不落 storage」，依赖真实的 jsdom Storage）
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

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organizationsApi } from "@/lib/api/organizations";
import { queryKeys } from "@/lib/api/query-keys";
import { useOrganizationStore } from "@/lib/stores/organization-store";
import {
	ORGANIZATION_PERMISSIONS,
	resolveLedgerQueryGate,
	useLedgerQueryGate,
	useOrganizationCapabilities,
	type LedgerQueryGateInput,
	type OrganizationCapabilities,
	type OrganizationPermission,
	type OrganizationRole,
} from "./use-organization-capabilities";

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

/**
 * 后端 permission-policy.ts 角色矩阵在本 hook 消费的 11 个权限点上的镜像。
 * 这是「服务端会对每个角色下发哪些 true」的夹具，不是前端的角色逻辑——
 * 被测 hook 只按键取布尔值，下面有专门的用例证明它不看 role。
 */
const ROLE_MATRIX: Record<OrganizationRole, readonly OrganizationPermission[]> = {
	OWNER: ORGANIZATION_PERMISSIONS,
	ADMIN: ORGANIZATION_PERMISSIONS.filter((p) => p !== "organization.delete"),
	FINANCE: [
		"organization.read",
		"plan.create",
		"plan.adjust",
		"transaction.create",
		"usage.create",
		"correction.preview",
		"correction.apply",
		"data.export",
	],
	OPERATOR: ["organization.read", "plan.create", "plan.adjust"],
	VIEWER: ["organization.read"],
};

function capabilitiesOf(role: OrganizationRole): Record<string, boolean> {
	return Object.fromEntries(
		ORGANIZATION_PERMISSIONS.map((permission) => [
			permission,
			ROLE_MATRIX[role].includes(permission),
		]),
	);
}

function currentOf(
	overrides: Partial<OrganizationCurrent> = {},
): OrganizationCurrent {
	return {
		id: "org-a",
		name: "组织 A",
		role: "OWNER",
		capabilities: capabilitiesOf("OWNER"),
		onboardingCompleted: true,
		baseCurrency: "CNY",
		ledgerStartedAt: "2026-01-01T00:00:00.000Z",
		dataRequestLock: { active: false, type: null },
		...overrides,
	};
}

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return { queryClient, Wrapper };
	function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
	}
}

/** 可手动放行的挂起请求（模拟「详情在途」） */
function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve: (value: T) => resolve(value) };
}

/** 逐个权限点求 can，返回为 true 的集合（顺序稳定，便于与角色矩阵整体比对） */
function granted(caps: OrganizationCapabilities): OrganizationPermission[] {
	return ORGANIZATION_PERMISSIONS.filter((permission) => caps.can(permission));
}

beforeEach(() => {
	vi.resetAllMocks();
	window.localStorage.clear();
	window.sessionStorage.clear();
	useOrganizationStore.setState({
		activeOrganizationId: null,
		activeOrganizationSetAt: 0,
		rejectedOrganizationIds: [],
	});
});

afterEach(() => {
	vi.clearAllMocks();
	window.localStorage.clear();
	window.sessionStorage.clear();
});

describe("useOrganizationCapabilities（权限真源 = 后端 capabilities）", () => {
	it("can() 逐一映射后端下发的 capabilities：五种角色 × 11 个权限点与后端角色矩阵一致", async () => {
		for (const role of ["OWNER", "ADMIN", "FINANCE", "OPERATOR", "VIEWER"] as const) {
			vi.mocked(organizationsApi.current).mockResolvedValue(
				currentOf({ role, capabilities: capabilitiesOf(role) }),
			);
			useOrganizationStore.setState({ activeOrganizationId: "org-a" });
			const { Wrapper } = createWrapper();
			const { result, unmount } = renderHook(() => useOrganizationCapabilities(), {
				wrapper: Wrapper,
			});
			await waitFor(() => expect(result.current.role).toBe(role));
			expect(result.current.isLoading).toBe(false);
			expect(granted(result.current)).toEqual([...ROLE_MATRIX[role]]);
			unmount();
		}
	});

	it("权限真源是 capabilities 而不是 role：两者不一致时一律以 capabilities 为准（前端不复制角色逻辑）", async () => {
		// role 写着 VIEWER，但服务端下发了 plan.create → 以服务端为准，放行
		vi.mocked(organizationsApi.current).mockResolvedValueOnce(
			currentOf({ role: "VIEWER", capabilities: { "plan.create": true } }),
		);
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		const { Wrapper } = createWrapper();
		const { result } = renderHook(() => useOrganizationCapabilities(), {
			wrapper: Wrapper,
		});
		await waitFor(() => expect(result.current.role).toBe("VIEWER"));
		expect(result.current.can("plan.create")).toBe(true);
		expect(result.current.can("plan.adjust")).toBe(false);

		// role 写着 OWNER，但服务端一个权限都没给 → 全部拒绝（如降权后的迟到响应）
		vi.mocked(organizationsApi.current).mockResolvedValueOnce(
			currentOf({ id: "org-b", role: "OWNER", capabilities: {} }),
		);
		act(() => {
			useOrganizationStore.setState({ activeOrganizationId: "org-b" });
		});
		await waitFor(() => expect(result.current.role).toBe("OWNER"));
		expect(granted(result.current)).toEqual([]);
	});

	it("capabilities 原样透传服务端布尔表（引用一致、不重算、不裁剪未列出的权限点）", async () => {
		const serverCapabilities = {
			...capabilitiesOf("OWNER"),
			"member.invite": true,
			"owner.transfer": false,
		};
		vi.mocked(organizationsApi.current).mockResolvedValue(
			currentOf({ capabilities: serverCapabilities }),
		);
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		const { Wrapper } = createWrapper();
		const { result } = renderHook(() => useOrganizationCapabilities(), {
			wrapper: Wrapper,
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.capabilities).toEqual(serverCapabilities);
		expect(result.current.capabilities["member.invite"]).toBe(true);
	});

	it.each([
		["值不是布尔 true", { "plan.create": "true" }],
		["键缺失", { "plan.adjust": true }],
		["空表", {}],
	])("fail-closed：%s 时 can 为 false", async (_label, capabilities) => {
		vi.mocked(organizationsApi.current).mockResolvedValue(
			currentOf({ capabilities: capabilities as Record<string, boolean> }),
		);
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		const { Wrapper } = createWrapper();
		const { result } = renderHook(() => useOrganizationCapabilities(), {
			wrapper: Wrapper,
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.can("plan.create")).toBe(false);
	});
});

describe("useOrganizationCapabilities（fail-closed 的四种未就绪态）", () => {
	it("未选组织：零请求，can 全 false，isLoading=false，organizationId=null", async () => {
		const { Wrapper } = createWrapper();
		const { result } = renderHook(() => useOrganizationCapabilities(), {
			wrapper: Wrapper,
		});
		await act(async () => {
			await Promise.resolve();
		});
		expect(organizationsApi.current).not.toHaveBeenCalled();
		expect(result.current.organizationId).toBeNull();
		expect(result.current.isLoading).toBe(false);
		expect(result.current.can("plan.create")).toBe(false);
	});

	it("加载中：组织详情未返回前 can 全 false 且 isLoading=true", async () => {
		vi.mocked(organizationsApi.current).mockReturnValue(new Promise(() => {}));
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		const { Wrapper } = createWrapper();
		const { result } = renderHook(() => useOrganizationCapabilities(), {
			wrapper: Wrapper,
		});
		await waitFor(() => expect(organizationsApi.current).toHaveBeenCalledOnce());
		expect(result.current.isLoading).toBe(true);
		expect(granted(result.current)).toEqual([]);
	});

	it("加载失败：isError=true 且 can 全 false（不因为拿不到权限表就放行）", async () => {
		vi.mocked(organizationsApi.current).mockRejectedValue(new Error("网络异常"));
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		const { Wrapper } = createWrapper();
		const { result } = renderHook(() => useOrganizationCapabilities(), {
			wrapper: Wrapper,
		});
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.isLoading).toBe(false);
		expect(granted(result.current)).toEqual([]);
	});

	it("防权限闪烁：任一 can 为 true 的帧，组织详情都必然已就绪", async () => {
		vi.mocked(organizationsApi.current).mockResolvedValue(currentOf());
		const frames: Array<{ loading: boolean; anyGranted: boolean }> = [];
		const { Wrapper } = createWrapper();
		renderHook(
			() => {
				const caps = useOrganizationCapabilities();
				frames.push({
					loading: caps.isLoading,
					anyGranted: ORGANIZATION_PERMISSIONS.some((permission) =>
						caps.can(permission),
					),
				});
				return caps;
			},
			{ wrapper: Wrapper },
		);
		act(() => {
			useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		});
		await waitFor(() => expect(frames[frames.length - 1]?.anyGranted).toBe(true));
		// 出现过写权限（说明断言不是空转）……
		expect(frames.some((frame) => frame.anyGranted)).toBe(true);
		// ……且每一个带写权限的帧，组织详情都已就绪
		expect(
			frames.filter((frame) => frame.anyGranted).every((frame) => !frame.loading),
		).toBe(true);
		// 选择组织之前（organizationId 仍为 null）的帧没有权限
		const firstGranted = frames.findIndex((frame) => frame.anyGranted);
		expect(firstGranted).toBeGreaterThan(0);
		expect(frames.slice(0, firstGranted).some((frame) => frame.anyGranted)).toBe(
			false,
		);
	});
});

describe("useOrganizationCapabilities（组织切换与一致性）", () => {
	it("切换组织：重拉期间 can 全 false，随后反映新组织的权限，不残留上一个组织的", async () => {
		vi.mocked(organizationsApi.current).mockResolvedValueOnce(currentOf());
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		const { Wrapper } = createWrapper();
		const { result, rerender } = renderHook(() => useOrganizationCapabilities(), {
			wrapper: Wrapper,
		});
		await waitFor(() => expect(result.current.can("settings.update")).toBe(true));

		// 切到组织 B：详情在途期间不得沿用组织 A（OWNER）的权限
		const orgBDetail = deferred<OrganizationCurrent>();
		vi.mocked(organizationsApi.current).mockReturnValueOnce(orgBDetail.promise);
		act(() => {
			useOrganizationStore.setState({ activeOrganizationId: "org-b" });
		});
		rerender();
		await waitFor(() => expect(result.current.isLoading).toBe(true));
		expect(result.current.organizationId).toBe("org-b");
		expect(result.current.organizationName).toBeNull();
		expect(granted(result.current)).toEqual([]);

		// 组织 B 到达：当前用户在那里只是 VIEWER
		await act(async () => {
			orgBDetail.resolve(
				currentOf({
					id: "org-b",
					name: "组织 B",
					role: "VIEWER",
					capabilities: capabilitiesOf("VIEWER"),
				}),
			);
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.organizationName).toBe("组织 B");
		expect(result.current.can("settings.update")).toBe(false);
		expect(result.current.can("organization.read")).toBe(true);
	});

	it("缓存里的详情 id 与当前选中组织不一致时不采信其权限（fail-closed）", async () => {
		const { queryClient, Wrapper } = createWrapper();
		// 模拟串桶：org-b 的缓存位上放着 org-a 的详情（OWNER 全量权限）
		queryClient.setQueryData(
			queryKeys.organizations.current("org-b"),
			currentOf({ id: "org-a" }),
		);
		useOrganizationStore.setState({ activeOrganizationId: "org-b" });
		const { result } = renderHook(() => useOrganizationCapabilities(), {
			wrapper: Wrapper,
		});
		await act(async () => {
			await Promise.resolve();
		});
		expect(organizationsApi.current).not.toHaveBeenCalled();
		expect(result.current.organizationName).toBeNull();
		expect(granted(result.current)).toEqual([]);
	});
});

describe("useOrganizationCapabilities（建账态与组织锁摘要）", () => {
	it("透传建账态、本位币、记账起点", async () => {
		vi.mocked(organizationsApi.current).mockResolvedValue(
			currentOf({ onboardingCompleted: false, baseCurrency: null, ledgerStartedAt: null }),
		);
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		const { Wrapper } = createWrapper();
		const { result } = renderHook(() => useOrganizationCapabilities(), {
			wrapper: Wrapper,
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.onboardingCompleted).toBe(false);
		expect(result.current.baseCurrency).toBeNull();
		expect(result.current.ledgerStartedAt).toBeNull();
		expect(result.current.isDataLocked).toBe(false);
	});

	it.each([
		["CLEAR", true, false],
		["DELETION", true, true],
		[null, false, false],
	] as const)(
		"dataRequestLock.type=%s → isDataLocked=%s、isDeletionLocked=%s",
		async (type, isDataLocked, isDeletionLocked) => {
			vi.mocked(organizationsApi.current).mockResolvedValue(
				currentOf({ dataRequestLock: { active: type !== null, type } }),
			);
			useOrganizationStore.setState({ activeOrganizationId: "org-a" });
			const { Wrapper } = createWrapper();
			const { result } = renderHook(() => useOrganizationCapabilities(), {
				wrapper: Wrapper,
			});
			await waitFor(() => expect(result.current.isLoading).toBe(false));
			expect(result.current.dataRequestLock).toEqual({
				active: type !== null,
				type,
			});
			expect(result.current.isDataLocked).toBe(isDataLocked);
			expect(result.current.isDeletionLocked).toBe(isDeletionLocked);
		},
	);
});

describe("useOrganizationCapabilities（铁律：role / capabilities 只在内存）", () => {
	it("加载了完整权限表后，localStorage / sessionStorage 里没有任何角色或权限数据", async () => {
		const writes: string[] = [];
		const originalSetItem = Storage.prototype.setItem;
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
			this: Storage,
			key,
			value,
		) {
			writes.push(`${key}=${String(value)}`);
			originalSetItem.call(this, key, value);
		});

		vi.mocked(organizationsApi.current).mockResolvedValue(currentOf());
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		const { Wrapper } = createWrapper();
		const { result } = renderHook(() => useOrganizationCapabilities(), {
			wrapper: Wrapper,
		});
		await waitFor(() => expect(result.current.can("organization.delete")).toBe(true));

		// 权限确实在内存里生效了
		expect(granted(result.current)).toEqual([...ORGANIZATION_PERMISSIONS]);

		// 任何一次 storage 写入都不得携带角色或权限点
		const serializedWrites = JSON.stringify(writes);
		expect(serializedWrites).not.toContain("capabilities");
		expect(serializedWrites).not.toContain("OWNER");
		for (const permission of ORGANIZATION_PERMISSIONS) {
			expect(serializedWrites).not.toContain(permission);
		}

		// 落盘的只有「当前选中的组织 id」（organization-store 的 persist），且不含其他字段
		const persisted = window.localStorage.getItem("active-organization");
		expect(persisted).not.toBeNull();
		expect(JSON.parse(persisted ?? "null")).toEqual({
			state: { activeOrganizationId: "org-a" },
			version: 0,
		});
		expect(window.sessionStorage.length).toBe(0);
		vi.restoreAllMocks();
	});

	it("organization-store 的状态结构里没有 role / capabilities 字段", () => {
		expect(Object.keys(useOrganizationStore.getState()).sort()).toEqual([
			"activeOrganizationId",
			"activeOrganizationSetAt",
			"clearActiveOrganization",
			"rejectOrganizationContext",
			"rejectedOrganizationIds",
			"resetSession",
			"setActiveOrganization",
		]);
	});
});

describe("resolveLedgerQueryGate（账本查询闸门，纯函数决策表）", () => {
	const ready: LedgerQueryGateInput = {
		organizationId: "org-a",
		isLoading: false,
		isError: false,
		onboardingCompleted: true,
		isDeletionLocked: false,
	};

	it("逐一状态：未选组织 / 加载中 / 未建账 / 删除锁 / 放行", () => {
		expect(resolveLedgerQueryGate({ ...ready, organizationId: null })).toBe(
			"no-organization",
		);
		expect(resolveLedgerQueryGate({ ...ready, isLoading: true })).toBe("loading");
		// 加载中优先于其余状态：建账态与锁态此刻都未知
		expect(
			resolveLedgerQueryGate({
				...ready,
				isLoading: true,
				onboardingCompleted: false,
				isDeletionLocked: true,
			}),
		).toBe("loading");
		expect(
			resolveLedgerQueryGate({ ...ready, onboardingCompleted: false }),
		).toBe("not-onboarded");
		expect(resolveLedgerQueryGate({ ...ready, isDeletionLocked: true })).toBe(
			"deletion-locked",
		);
		expect(resolveLedgerQueryGate(ready)).toBe("ready");
	});

	it("未建账优先于删除锁（未建账的组织谈不上删除锁，但顺序必须确定）", () => {
		expect(
			resolveLedgerQueryGate({
				...ready,
				onboardingCompleted: false,
				isDeletionLocked: true,
			}),
		).toBe("not-onboarded");
	});

	it("CLEAR 锁不算闸门条件：清空冷静期内 GET 放行，仍可浏览", () => {
		// 闸门只看 isDeletionLocked；CLEAR 锁的 isDeletionLocked 为 false → 放行
		expect(resolveLedgerQueryGate(ready)).toBe("ready");
	});

	it("组织详情读取失败时放行：降噪不是权限防线，拿不到判定依据就交给业务端点裁决", () => {
		expect(resolveLedgerQueryGate({ ...ready, isError: true })).toBe("ready");
		// 失败态下建账态与锁态都不可信，不得据其拦请求
		expect(
			resolveLedgerQueryGate({
				...ready,
				isError: true,
				onboardingCompleted: false,
				isDeletionLocked: true,
			}),
		).toBe("ready");
	});
});

describe("useLedgerQueryGate（hook 形态随组织详情变化）", () => {
	it("未选 → 加载中 → 放行；随后切到一个处于删除锁的组织 → deletion-locked", async () => {
		const orgADetail = deferred<OrganizationCurrent>();
		vi.mocked(organizationsApi.current).mockReturnValueOnce(orgADetail.promise);
		const { Wrapper } = createWrapper();
		const { result, rerender } = renderHook(() => useLedgerQueryGate(), {
			wrapper: Wrapper,
		});
		expect(result.current).toBe("no-organization");

		act(() => {
			useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		});
		rerender();
		await waitFor(() => expect(result.current).toBe("loading"));

		await act(async () => {
			orgADetail.resolve(currentOf());
		});
		await waitFor(() => expect(result.current).toBe("ready"));

		vi.mocked(organizationsApi.current).mockResolvedValueOnce(
			currentOf({
				id: "org-c",
				dataRequestLock: { active: true, type: "DELETION" },
			}),
		);
		act(() => {
			useOrganizationStore.setState({ activeOrganizationId: "org-c" });
		});
		rerender();
		await waitFor(() => expect(result.current).toBe("deletion-locked"));
	});

	it("未建账组织 → not-onboarded；组织详情读取失败 → ready（回退）", async () => {
		vi.mocked(organizationsApi.current).mockResolvedValueOnce(
			currentOf({ onboardingCompleted: false }),
		);
		useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		const { Wrapper } = createWrapper();
		const { result, rerender } = renderHook(() => useLedgerQueryGate(), {
			wrapper: Wrapper,
		});
		await waitFor(() => expect(result.current).toBe("not-onboarded"));

		vi.mocked(organizationsApi.current).mockRejectedValueOnce(new Error("网络异常"));
		act(() => {
			useOrganizationStore.setState({ activeOrganizationId: "org-b" });
		});
		rerender();
		await waitFor(() => expect(result.current).toBe("ready"));
	});
});
