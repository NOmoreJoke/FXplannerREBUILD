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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuditLogTable } from "./audit-log-table";
import { OrganizationScopeBoundary } from "@/components/business/organization";
import { auditApi } from "@/lib/api/organizations";
import { clearOrganizationScopedQueries } from "@/lib/api/query-keys";
import { useOrganizationStore } from "@/lib/stores/organization-store";
import type React from "react";

/**
 * 审计日志表的组织隔离（评审 R2-I08）。
 *
 * 修复前查询键不含组织且无条件 keepPreviousData：从组织 A 切到组织 B（都有
 * audit.read）时，B 的请求返回前回显的是 A 的审计记录，并沿用 A 的筛选与页码。
 * 修复后：键按组织分桶；占位数据只在同一组织内沿用；筛选/页码等本地态由布局的
 * 组织作用域边界在切换时重新挂载来重置。
 */

type AuditList = Awaited<ReturnType<typeof auditApi.list>>;

vi.mock("@/lib/api/organizations", () => ({
	auditApi: { list: vi.fn() },
}));

// 组织详情（capabilities）：按 store 当前选中组织给出，且恒有 audit.read
vi.mock("@/lib/hooks/use-organizations", () => ({
	useCurrentOrganization: vi.fn(() => ({
		data: {
			id: useOrganizationStore.getState().activeOrganizationId,
			capabilities: { "audit.read": true },
		},
	})),
}));

const rowOf = (organization: string, index: number) => ({
	id: `log-${organization}-${index}`,
	organizationId: `org-${organization}`,
	actorUserId: `user-${organization}`,
	actorType: "USER",
	action: `organization.update`,
	targetType: "organization",
	targetId: `org-${organization}`,
	result: "SUCCESS",
	createdAt: "2026-11-20T08:00:00.000Z",
});

const pageOf = (organization: string, page: number): AuditList =>
	({
		items: [rowOf(organization, page)],
		page,
		pageSize: 20,
		total: 40, // 两页：可验证「下一页」与切换后的页码重置
	}) as AuditList;

let queryClient: QueryClient;

const wrapper = ({ children }: { children: React.ReactNode }) => (
	<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

/** 与 useSwitchOrganization 同序：清组织作用域缓存 → 切 store 选择 */
function switchTo(organizationId: string) {
	clearOrganizationScopedQueries(queryClient);
	act(() => {
		useOrganizationStore.getState().setActiveOrganization(organizationId);
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	useOrganizationStore.setState({
		activeOrganizationId: "a",
		activeOrganizationSetAt: 0,
		rejectedOrganizationIds: [],
	});
});

afterEach(() => {
	queryClient.clear();
});

describe("AuditLogTable 组织隔离（评审 R2-I08）", () => {
	it("直接挂载（不在作用域边界内）：切到组织 B 后，B 的请求返回前不回显组织 A 的审计记录", async () => {
		vi.mocked(auditApi.list)
			.mockResolvedValueOnce(pageOf("a", 1))
			.mockReturnValue(new Promise(() => {})); // 组织 B 的请求挂起

		render(<AuditLogTable />, { wrapper });
		await waitFor(() => expect(screen.getByText("user-a")).toBeTruthy());
		expect(auditApi.list).toHaveBeenCalledTimes(1);

		switchTo("b");

		// B 的请求已按新组织键发出；A 的记录不再出现在页面上（无跨组织占位数据）
		await waitFor(() => expect(auditApi.list).toHaveBeenCalledTimes(2));
		expect(screen.queryByText("user-a")).toBeNull();
	});

	it("在作用域边界内：组织 A 翻到第 2 页后切换组织 → B 从第 1 页、无筛选重新开始，且不残留 A 的记录", async () => {
		vi.mocked(auditApi.list)
			.mockResolvedValueOnce(pageOf("a", 1))
			.mockResolvedValueOnce(pageOf("a", 2))
			.mockReturnValue(new Promise(() => {}));

		render(
			<OrganizationScopeBoundary>
				<AuditLogTable />
			</OrganizationScopeBoundary>,
			{ wrapper },
		);
		await waitFor(() => expect(screen.getByText("user-a")).toBeTruthy());
		fireEvent.click(screen.getByTestId("audit-next-page"));
		await waitFor(() =>
			expect(auditApi.list).toHaveBeenLastCalledWith({ page: 2, pageSize: 20 }),
		);

		switchTo("b");

		// 此前沿用 A 的页码（第 2 页）并回显 A 的记录；现在整表重新挂载
		await waitFor(() =>
			expect(auditApi.list).toHaveBeenLastCalledWith({ page: 1, pageSize: 20 }),
		);
		expect(screen.queryByText("user-a")).toBeNull();
	});

	it("同一组织内翻页沿用上一次数据（不闪白）——占位行为未被误伤", async () => {
		vi.mocked(auditApi.list)
			.mockResolvedValueOnce(pageOf("a", 1))
			.mockReturnValue(new Promise(() => {}));

		render(<AuditLogTable />, { wrapper });
		await waitFor(() => expect(screen.getByText("user-a")).toBeTruthy());
		fireEvent.click(screen.getByTestId("audit-next-page"));

		await waitFor(() => expect(auditApi.list).toHaveBeenCalledTimes(2));
		// 第 2 页请求挂起期间仍显示第 1 页数据（同组织内 keepPreviousData 语义）
		expect(screen.getByText("user-a")).toBeTruthy();
	});
});
