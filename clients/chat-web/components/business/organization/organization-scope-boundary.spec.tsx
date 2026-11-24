// Node ≥26 localStorage 回填（vitest#8757；use-chat.spec 先例）——organization-store
// 使用 persist，模块求值期需要可用的 window.localStorage
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

import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { OrganizationScopeBoundary } from "./organization-scope-boundary";
import { accountsApi } from "@/lib/api/accounts";
import {
	clearOrganizationScopedQueries,
	queryKeys,
} from "@/lib/api/query-keys";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { useOrganizationStore } from "@/lib/stores/organization-store";
import type React from "react";

/**
 * 组织作用域边界（评审 R2-I07 回归）。
 *
 * 复现口径：页面组件不订阅组织 store、查询键不含组织（审查列出的 20 个无前缀查询的
 * 形态）。切换组织时 useSwitchOrganization 只做 removeQueries——它不通知挂载态的
 * QueryObserver，组件也不会重渲染，于是页面永久停在旧组织数据且零请求发往新组织。
 * 边界以组织 id 为 key：切换 = 子树重新挂载，观察者重新订阅、本地状态与命令式
 * effect 一并重来。
 */

vi.mock("@/lib/api/accounts", () => ({
	accountsApi: {
		list: vi.fn(),
	},
}));

let queryClient: QueryClient;

const wrapper = ({ children }: { children: React.ReactNode }) => (
	<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

/**
 * 带本地状态的页面：累计点击次数（组织切换后应清零）；每个实例的首次渲染计入挂载次数。
 * 探针用 ref / 惰性初始化表达「挂载时只执行一次」——本目录的架构护栏禁止裸写
 * useEffect，测试文件不豁免（也不应由被审改动去放宽护栏）
 */
let mountCount = 0;
function LocalStatePage() {
	const [count, setCount] = useState(0);
	const mounted = useRef(false);
	if (!mounted.current) {
		mounted.current = true;
		mountCount += 1;
	}
	return (
		<button type="button" onClick={() => setCount((value) => value + 1)}>
			clicks:{count}
		</button>
	);
}

/** 账户列表响应（契约字段取自 schema.gen；balance 用来区分是哪个组织的数据） */
const accountList = (balance: string) => ({
	baseCurrency: "CNY",
	accounts: [
		{
			currencyCode: "USD",
			balance,
			allocatedAmount: "0.0000",
			unallocatedAmount: balance,
		},
	],
});

/** 无前缀键的挂载态查询：不订阅组织 store，形态同审查列出的页面查询 */
function UnscopedQueryPage() {
	const { data } = useQuery({
		queryKey: queryKeys.accounts.list(),
		queryFn: () => accountsApi.list(),
	});
	return <div>balance:{data?.accounts[0]?.balance ?? "loading"}</div>;
}

/**
 * 命令式拉取（不走 React Query，缓存清理触达不到）的页面：挂载时按当时的组织拉取一次。
 * 惰性初始化 = 每个实例只执行一次，与「挂载时 effect 拉取」的触发时机相同
 */
const fetchOrgs: Array<string | null> = [];
function ImperativeFetchPage() {
	const orgId = useActiveOrgId();
	const [fetchedFor] = useState(() => {
		fetchOrgs.push(orgId);
		return orgId;
	});
	return <div>imperative:{fetchedFor ?? "none"}</div>;
}

/** 与 useSwitchOrganization 同序的两步：清组织作用域缓存 → 切 store 选择 */
function switchTo(organizationId: string) {
	clearOrganizationScopedQueries(queryClient);
	act(() => {
		useOrganizationStore.getState().setActiveOrganization(organizationId);
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mountCount = 0;
	fetchOrgs.length = 0;
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	useOrganizationStore.setState({
		activeOrganizationId: "org-a",
		activeOrganizationSetAt: 0,
		rejectedOrganizationIds: [],
	});
});

afterEach(() => {
	queryClient.clear();
});

describe("OrganizationScopeBoundary（评审 R2-I07）", () => {
	it("切换组织 → 子树重新挂载：页面本地状态清零", () => {
		const { rerender } = render(
			<OrganizationScopeBoundary>
				<LocalStatePage />
			</OrganizationScopeBoundary>,
			{ wrapper },
		);
		fireEvent.click(screen.getByText("clicks:0"));
		expect(screen.getByText("clicks:1")).toBeTruthy();
		expect(mountCount).toBe(1);

		switchTo("org-b");

		expect(screen.getByText("clicks:0")).toBeTruthy();
		expect(mountCount).toBe(2);
		// 同一组织内的普通重渲染不重新挂载（状态保留）
		fireEvent.click(screen.getByText("clicks:0"));
		rerender(
			<OrganizationScopeBoundary>
				<LocalStatePage />
			</OrganizationScopeBoundary>,
		);
		expect(screen.getByText("clicks:1")).toBeTruthy();
		expect(mountCount).toBe(2);
	});

	it("挂载态的无前缀查询：清缓存 + 切组织后重新拉取并显示新组织数据（此前冻结在旧组织数据）", async () => {
		vi.mocked(accountsApi.list)
			.mockResolvedValueOnce(accountList("A-100.0000"))
			.mockResolvedValue(accountList("B-200.0000"));

		render(
			<OrganizationScopeBoundary>
				<UnscopedQueryPage />
			</OrganizationScopeBoundary>,
			{ wrapper },
		);
		await waitFor(() => expect(screen.getByText("balance:A-100.0000")).toBeTruthy());
		expect(accountsApi.list).toHaveBeenCalledTimes(1);

		switchTo("org-b");

		// 新组织的请求发出、页面显示新组织的数据——旧组织数据不再残留
		await waitFor(() => expect(screen.getByText("balance:B-200.0000")).toBeTruthy());
		expect(accountsApi.list).toHaveBeenCalledTimes(2);
		expect(screen.queryByText("balance:A-100.0000")).toBeNull();
	});

	it("命令式拉取：切换后按新组织重新执行", () => {
		const { rerender } = render(
			<OrganizationScopeBoundary>
				<ImperativeFetchPage />
			</OrganizationScopeBoundary>,
			{ wrapper },
		);
		expect(screen.getByText("imperative:org-a")).toBeTruthy();
		expect(fetchOrgs).toEqual(["org-a"]);

		switchTo("org-b");

		expect(screen.getByText("imperative:org-b")).toBeTruthy();
		expect(fetchOrgs).toEqual(["org-a", "org-b"]);
		rerender(
			<OrganizationScopeBoundary>
				<ImperativeFetchPage />
			</OrganizationScopeBoundary>,
		);
		expect(fetchOrgs).toEqual(["org-a", "org-b"]); // 同组织重渲染不重复执行
	});
});

/**
 * 豁免路由（评审 R3-I01）：/invitations/* 的页面自己切换组织——接受邀请时
 * switchOrganization 进入新组织。按组织重挂载会在同一次提交里清掉页面本地状态
 * （「已加入组织 / 进入工作台」永不出现，页面回弹成未接受的表单）。
 */
describe("OrganizationScopeBoundary：豁免路由不随组织变化重挂载（评审 R3-I01）", () => {
	it("bypass：组织选择变化时子树保留本地状态，且不重新挂载", () => {
		render(
			<OrganizationScopeBoundary bypass>
				<LocalStatePage />
			</OrganizationScopeBoundary>,
			{ wrapper },
		);
		fireEvent.click(screen.getByText("clicks:0"));
		expect(mountCount).toBe(1);

		switchTo("org-b");

		// 页面在结果态期间完成了组织切换：结果态必须原样保留
		expect(screen.getByText("clicks:1")).toBeTruthy();
		expect(mountCount).toBe(1);
		expect(useOrganizationStore.getState().activeOrganizationId).toBe("org-b");
	});

	it("组织选择被清空（退出组织）同样不重挂载", () => {
		render(
			<OrganizationScopeBoundary bypass>
				<LocalStatePage />
			</OrganizationScopeBoundary>,
			{ wrapper },
		);
		fireEvent.click(screen.getByText("clicks:0"));
		act(() => {
			useOrganizationStore.getState().clearActiveOrganization();
		});
		expect(screen.getByText("clicks:1")).toBeTruthy();
		expect(mountCount).toBe(1);
	});

	it("离开豁免路由（bypass 撤销）：恢复按组织重挂载", () => {
		const { rerender } = render(
			<OrganizationScopeBoundary bypass>
				<LocalStatePage />
			</OrganizationScopeBoundary>,
			{ wrapper },
		);
		fireEvent.click(screen.getByText("clicks:0"));
		switchTo("org-b");
		expect(screen.getByText("clicks:1")).toBeTruthy();
		expect(mountCount).toBe(1);

		rerender(
			<OrganizationScopeBoundary>
				<LocalStatePage />
			</OrganizationScopeBoundary>,
		);

		// 非豁免路由照常以当前组织为 key：旧组织子树的本地状态不带入
		expect(screen.getByText("clicks:0")).toBeTruthy();
		expect(mountCount).toBe(2);
	});
});
