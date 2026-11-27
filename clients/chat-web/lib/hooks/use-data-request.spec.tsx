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

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { organizationsApi } from "@/lib/api/organizations";
import { dataRequestsApi } from "@/lib/api/data-requests";
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import { useOrganizationStore } from "@/lib/stores/organization-store";
import type {
	DataRequestView,
	ImpactView,
	LastOwnerRequiredBody,
} from "@/lib/api/contract";
import {
	ORGANIZATION_IMPACT_QUERY_KEY,
	ORGANIZATION_REQUEST_QUERY_KEY,
	PERSONAL_REQUEST_QUERY_KEY,
	useCancelOrganizationDataRequest,
	useCancelPersonalDataRequest,
	useCreateOrganizationDataRequest,
	useCreatePersonalDataRequest,
	useDeleteOrganization,
	useOrganizationCurrentRequest,
	useOrganizationImpact,
	usePersonalCurrentRequest,
	useVerifyOrganizationDataRequest,
	useVerifyPersonalDataRequest,
} from "./use-data-request";

// mock API 层（hook 只测缓存编排、门控与 mutation 失效逻辑）
vi.mock("@/lib/api/data-requests", () => ({
	dataRequestsApi: {
		getPersonalCurrent: vi.fn(),
		getOrganizationCurrent: vi.fn(),
		getOrganizationImpact: vi.fn(),
		verifyPersonal: vi.fn(),
		verifyOrganization: vi.fn(),
		createPersonal: vi.fn(),
		createOrganizationRequest: vi.fn(),
		deleteOrganization: vi.fn(),
		cancelPersonal: vi.fn(),
		cancelOrganizationRequest: vi.fn(),
		downloadPersonal: vi.fn(),
		downloadOrganization: vi.fn(),
	},
}));

// 真实 client.ts 在模块求值期校验 API 地址环境变量并引入 Sentry；本文件只借 ApiError
// 构造一个带 body 的错误实例（构造签名与真实类一致），错误协议本身在 client.spec 覆盖
vi.mock("@/lib/api/client", () => {
	class MockApiError extends Error {
		constructor(
			message: string,
			readonly status: number,
			readonly code?: string,
			readonly body?: Record<string, unknown>,
		) {
			super(message);
			this.name = "ApiError";
		}
	}
	return { ApiError: MockApiError };
});

// 当前组织详情（capabilities / 建账态 / 锁态）：组织域查询的门控依据
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

/** Owner：具备 data.clear / organization.delete 等全部权限 */
const OWNER_CAPABILITIES = Object.fromEntries(
	[
		"organization.read",
		"organization.delete",
		"settings.update",
		"plan.create",
		"plan.adjust",
		"transaction.create",
		"usage.create",
		"correction.preview",
		"correction.apply",
		"data.export",
		"data.clear",
	].map((permission) => [permission, true]),
);

/** Finance：有 data.export，没有 data.clear 与 organization.delete */
const FINANCE_CAPABILITIES: Record<string, boolean> = {
	...OWNER_CAPABILITIES,
	"data.clear": false,
	"organization.delete": false,
	"settings.update": false,
};

function currentOf(
	overrides: Partial<OrganizationCurrent> = {},
): OrganizationCurrent {
	return {
		id: "org-a",
		name: "组织 A",
		role: "OWNER",
		capabilities: OWNER_CAPABILITIES,
		onboardingCompleted: true,
		baseCurrency: "CNY",
		ledgerStartedAt: "2026-01-01T00:00:00.000Z",
		dataRequestLock: { active: false, type: null },
		...overrides,
	};
}

/** 本人发起的个人注销（撤回期内） */
const personalDeletion: DataRequestView = {
	id: "req-personal-1",
	scope: "PERSONAL",
	organizationId: null,
	type: "DELETION",
	status: "PENDING",
	requestedAt: "2026-09-17T00:00:00.000Z",
	dueAt: "2026-09-24T00:00:00.000Z",
	processedAt: null,
	displayStatus: "WITHDRAWAL_PERIOD",
	canCancel: true,
	isRequester: true,
	withdrawDeadline: "2026-09-24T00:00:00.000Z",
	download: null,
};

/** 当前组织的清空请求（待清理） */
const organizationClear: DataRequestView = {
	id: "req-org-1",
	scope: "ORGANIZATION",
	organizationId: "org-a",
	type: "CLEAR",
	status: "PENDING",
	requestedAt: "2026-09-17T00:00:00.000Z",
	dueAt: "2026-09-24T00:00:00.000Z",
	processedAt: null,
	displayStatus: "SUBMITTED",
	canCancel: true,
	isRequester: true,
	withdrawDeadline: null,
	download: null,
};

const impactView: ImpactView = {
	totals: {
		accounts: 1,
		transactions: 2,
		initialHoldings: 1,
		plans: 1,
		usageRecords: 1,
		corrections: 0,
	},
	hasDownloadableExport: false,
};

/** 让当前组织详情解析为给定角色的已建账组织 */
function mockCurrentOrganization(
	overrides: Partial<OrganizationCurrent> = {},
) {
	vi.mocked(organizationsApi.current).mockImplementation(async () =>
		currentOf({
			id: useOrganizationStore.getState().activeOrganizationId ?? "org-a",
			...overrides,
		}),
	);
}

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return { queryClient, Wrapper };
	function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
	}
}

function isInvalidated(queryClient: QueryClient, key: readonly unknown[]) {
	return queryClient.getQueryState(key)?.isInvalidated === true;
}

beforeEach(() => {
	vi.resetAllMocks();
	useOrganizationStore.setState({
		activeOrganizationId: "org-a",
		activeOrganizationSetAt: 0,
		rejectedOrganizationIds: [],
	});
	mockCurrentOrganization();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("use-data-request（个人域：不依赖组织）", () => {
	it("未选组织（0 组织 / 多组织未选 / 账号注销锁定）时照常请求并返回个人进度，零组织请求", async () => {
		useOrganizationStore.setState({ activeOrganizationId: null });
		vi.mocked(dataRequestsApi.getPersonalCurrent).mockResolvedValue(
			personalDeletion,
		);
		const { Wrapper } = createWrapper();

		const { result } = renderHook(() => usePersonalCurrentRequest(), {
			wrapper: Wrapper,
		});

		// 此前个人进度查询被 enabled: orgId !== null 挡住：被 403 账号锁跳到进度页的
		// 无组织用户拿不到进度、无法撤回——本用例是这个死胡同的回归
		await waitFor(() => expect(result.current.data).toEqual(personalDeletion));
		expect(dataRequestsApi.getPersonalCurrent).toHaveBeenCalledOnce();
		expect(organizationsApi.current).not.toHaveBeenCalled();
		expect(dataRequestsApi.getOrganizationCurrent).not.toHaveBeenCalled();
	});

	it("个人进度键不加组织前缀：切换组织后仍读同一份缓存，不重复请求、进度不丢", async () => {
		vi.mocked(dataRequestsApi.getPersonalCurrent).mockResolvedValue(
			personalDeletion,
		);
		const { Wrapper } = createWrapper();
		const { result } = renderHook(() => usePersonalCurrentRequest(), {
			wrapper: Wrapper,
		});
		await waitFor(() => expect(result.current.data).toEqual(personalDeletion));

		act(() => {
			useOrganizationStore.setState({ activeOrganizationId: "org-b" });
		});
		await waitFor(() => expect(result.current.data).toEqual(personalDeletion));
		expect(dataRequestsApi.getPersonalCurrent).toHaveBeenCalledOnce();
		expect(PERSONAL_REQUEST_QUERY_KEY).toEqual([
			"personal-data-request",
			"current",
		]);
		// 不带组织前缀（与组织域键永不碰撞）
		expect(PERSONAL_REQUEST_QUERY_KEY[0]).not.toBe("org");
	});

	it("个人请求缓存 30s（staleTime 内 observer 重挂不重复请求）", async () => {
		vi.mocked(dataRequestsApi.getPersonalCurrent).mockResolvedValue(
			personalDeletion,
		);
		const { queryClient, Wrapper } = createWrapper();

		const first = renderHook(() => usePersonalCurrentRequest(), { wrapper: Wrapper });
		await waitFor(() => expect(first.result.current.data).toEqual(personalDeletion));

		const second = renderHook(() => usePersonalCurrentRequest(), { wrapper: Wrapper });
		await waitFor(() => expect(second.result.current.data).toEqual(personalDeletion));
		expect(dataRequestsApi.getPersonalCurrent).toHaveBeenCalledOnce();
		expect(
			queryClient.getQueryState(PERSONAL_REQUEST_QUERY_KEY)?.dataUpdateCount,
		).toBe(1);
	});

	it("无进行中的个人请求时返回 null（入口恢复可用）", async () => {
		vi.mocked(dataRequestsApi.getPersonalCurrent).mockResolvedValue(null);
		const { Wrapper } = createWrapper();

		const { result } = renderHook(() => usePersonalCurrentRequest(), {
			wrapper: Wrapper,
		});
		await waitFor(() => expect(result.current.data).toBeNull());
	});

	it("useVerifyPersonalDataRequest 只调用个人域 verify", async () => {
		vi.mocked(dataRequestsApi.verifyPersonal).mockResolvedValue({
			challengeId: "ch-9",
			purpose: "DELETION",
			confirmDeadline: "2026-09-17T00:10:00.000Z",
		});
		const { Wrapper } = createWrapper();

		const { result } = renderHook(() => useVerifyPersonalDataRequest(), {
			wrapper: Wrapper,
		});
		result.current.mutate({ challengeId: "ch-9", code: "123456", purpose: "DELETION" });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(dataRequestsApi.verifyPersonal).toHaveBeenCalledWith({
			challengeId: "ch-9",
			code: "123456",
			purpose: "DELETION",
		});
		expect(dataRequestsApi.verifyOrganization).not.toHaveBeenCalled();
	});

	it("useCreatePersonalDataRequest 提交个人注销（scope 固定 PERSONAL），成功后失效两域的请求缓存与组织详情", async () => {
		vi.mocked(dataRequestsApi.createPersonal).mockResolvedValue(personalDeletion);
		const { queryClient, Wrapper } = createWrapper();
		// 预置各域缓存：个人请求、组织 A / B 的组织请求与影响快照、组织详情、公共缓存
		const keys = {
			personal: PERSONAL_REQUEST_QUERY_KEY,
			organizationA: withOrgScope("org-a", ORGANIZATION_REQUEST_QUERY_KEY),
			organizationB: withOrgScope("org-b", ORGANIZATION_REQUEST_QUERY_KEY),
			impactA: withOrgScope("org-a", ORGANIZATION_IMPACT_QUERY_KEY),
			organizationCurrent: queryKeys.organizations.current("org-a"),
			publicRates: queryKeys.rates.supported(),
			personalSettings: queryKeys.settings.personal(),
		};
		for (const key of Object.values(keys)) {
			queryClient.setQueryData(key, { seeded: true });
		}

		const { result } = renderHook(() => useCreatePersonalDataRequest(), {
			wrapper: Wrapper,
		});
		result.current.mutate({
			type: "DELETION",
			scope: "PERSONAL",
			challengeId: "ch-del",
		});
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(dataRequestsApi.createPersonal).toHaveBeenCalledWith({
			type: "DELETION",
			scope: "PERSONAL",
			challengeId: "ch-del",
		});
		expect(dataRequestsApi.createOrganizationRequest).not.toHaveBeenCalled();

		// 个人域 + 组织域（任意组织）+ 组织锁摘要所在的组织详情一起回读
		for (const key of [
			keys.personal,
			keys.organizationA,
			keys.organizationB,
			keys.impactA,
			keys.organizationCurrent,
		]) {
			expect(isInvalidated(queryClient, key), JSON.stringify(key)).toBe(true);
		}
		// 无关缓存不受波及
		expect(isInvalidated(queryClient, keys.publicRates)).toBe(false);
		expect(isInvalidated(queryClient, keys.personalSettings)).toBe(false);
	});

	it("提交被 409 LAST_OWNER_REQUIRED 拒绝：ApiError 原样抛出，UI 层能从 error.body.data 取出阻塞组织", async () => {
		const blockingOrganizations = [
			{ organizationId: "org-a", organizationName: "组织 A", role: "OWNER" },
		];
		// 后端 DataRequestLastOwnerRequiredException 的运行时包体：列表在 data 下
		// （以 OpenAPI 契约类型约束，契约与运行时包体错位会先在类型检查暴露）
		const lastOwnerBody: LastOwnerRequiredBody = {
			success: false,
			code: "LAST_OWNER_REQUIRED",
			message: "你仍是以下组织的唯一所有者，须先转移所有权或删除组织后才能注销账号",
			data: { blockingOrganizations },
		};
		const lastOwnerError = new ApiError(
			lastOwnerBody.message,
			409,
			"LAST_OWNER_REQUIRED",
			lastOwnerBody,
		);
		vi.mocked(dataRequestsApi.createPersonal).mockRejectedValue(lastOwnerError);
		const { Wrapper } = createWrapper();

		const { result } = renderHook(() => useCreatePersonalDataRequest(), {
			wrapper: Wrapper,
		});
		result.current.mutate({
			type: "DELETION",
			scope: "PERSONAL",
			challengeId: "ch-del",
		});
		await waitFor(() => expect(result.current.isError).toBe(true));
		// 同一个错误实例：hook 不吞错、不改写
		const error = result.current.error;
		expect(error).toBe(lastOwnerError);
		expect(error).toBeInstanceOf(ApiError);
		// UI 层据此渲染处置入口：本文件 mock 了 API 模块，这里取真实实现走一遍提取
		const { getBlockingOrganizations } = await vi.importActual<
			typeof import("@/lib/api/data-requests")
		>("@/lib/api/data-requests");
		expect(getBlockingOrganizations(error)).toEqual(blockingOrganizations);
	});

	it("useCancelPersonalDataRequest 撤回个人请求：走个人端点，注销撤回携带 DELETION 验证凭证", async () => {
		vi.mocked(dataRequestsApi.cancelPersonal).mockResolvedValue({
			...personalDeletion,
			status: "CANCELLED",
			displayStatus: "CANCELLED",
			canCancel: false,
		});
		const { queryClient, Wrapper } = createWrapper();
		queryClient.setQueryData(PERSONAL_REQUEST_QUERY_KEY, { seeded: true });
		const { result } = renderHook(() => useCancelPersonalDataRequest(), {
			wrapper: Wrapper,
		});

		result.current.mutate({ requestId: "req-personal-1", challengeId: "ch-del" });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(dataRequestsApi.cancelPersonal).toHaveBeenCalledWith("req-personal-1", {
			challengeId: "ch-del",
		});
		expect(dataRequestsApi.cancelOrganizationRequest).not.toHaveBeenCalled();
		// 撤回后进度回读（个人请求缓存被失效）
		expect(isInvalidated(queryClient, PERSONAL_REQUEST_QUERY_KEY)).toBe(true);
	});
});

describe("use-data-request（组织域：依赖当前组织、按组织分桶）", () => {
	it("未选组织时零组织域请求；选中后经组织分桶键拉取当前组织的请求", async () => {
		useOrganizationStore.setState({ activeOrganizationId: null });
		vi.mocked(dataRequestsApi.getOrganizationCurrent).mockResolvedValue(
			organizationClear,
		);
		const { queryClient, Wrapper } = createWrapper();
		const { result } = renderHook(() => useOrganizationCurrentRequest(), {
			wrapper: Wrapper,
		});
		await act(async () => {
			await Promise.resolve();
		});
		expect(dataRequestsApi.getOrganizationCurrent).not.toHaveBeenCalled();

		act(() => {
			useOrganizationStore.setState({ activeOrganizationId: "org-a" });
		});
		await waitFor(() => expect(result.current.data).toEqual(organizationClear));
		expect(
			queryClient.getQueryData(
				withOrgScope("org-a", ORGANIZATION_REQUEST_QUERY_KEY),
			),
		).toEqual(organizationClear);
		// 无前缀形态不落缓存：组织域键必须经 withOrgScope 分桶
		expect(queryClient.getQueryData(ORGANIZATION_REQUEST_QUERY_KEY)).toBeUndefined();
	});

	it("切换组织后按新组织的键重新拉取，不沿用上一个组织的进度", async () => {
		vi.mocked(dataRequestsApi.getOrganizationCurrent).mockResolvedValue(
			organizationClear,
		);
		const { queryClient, Wrapper } = createWrapper();
		const { result } = renderHook(() => useOrganizationCurrentRequest(), {
			wrapper: Wrapper,
		});
		await waitFor(() =>
			expect(dataRequestsApi.getOrganizationCurrent).toHaveBeenCalledOnce(),
		);

		const organizationExport: DataRequestView = {
			...organizationClear,
			id: "req-org-b",
			organizationId: "org-b",
			type: "EXPORT",
			status: "COMPLETED",
			displayStatus: "COMPLETED",
			canCancel: false,
		};
		vi.mocked(dataRequestsApi.getOrganizationCurrent).mockResolvedValue(
			organizationExport,
		);
		act(() => {
			useOrganizationStore.setState({ activeOrganizationId: "org-b" });
		});
		await waitFor(() => expect(result.current.data).toEqual(organizationExport));
		expect(dataRequestsApi.getOrganizationCurrent).toHaveBeenCalledTimes(2);
		expect(
			queryClient.getQueryData(
				withOrgScope("org-a", ORGANIZATION_REQUEST_QUERY_KEY),
			),
		).toEqual(organizationClear);
		expect(
			queryClient.getQueryData(
				withOrgScope("org-b", ORGANIZATION_REQUEST_QUERY_KEY),
			),
		).toEqual(organizationExport);
	});

	it("useOrganizationImpact：对话框未打开时不发请求（不为每个打开设置页的人都统计记录数）", async () => {
		vi.mocked(dataRequestsApi.getOrganizationImpact).mockResolvedValue(impactView);
		const { Wrapper } = createWrapper();
		const { result } = renderHook(
			() => useOrganizationImpact({ enabled: false }),
			{ wrapper: Wrapper },
		);
		await waitFor(() => expect(organizationsApi.current).toHaveBeenCalledOnce());
		await act(async () => {
			await Promise.resolve();
		});
		expect(dataRequestsApi.getOrganizationImpact).not.toHaveBeenCalled();
		expect(result.current.data).toBeUndefined();
	});

	it("useOrganizationImpact：已建账且有 data.clear 的角色在对话框打开后拉取影响快照", async () => {
		vi.mocked(dataRequestsApi.getOrganizationImpact).mockResolvedValue(impactView);
		const { Wrapper } = createWrapper();
		const { result } = renderHook(
			() => useOrganizationImpact({ enabled: true }),
			{ wrapper: Wrapper },
		);
		await waitFor(() => expect(result.current.data).toEqual(impactView));
		expect(dataRequestsApi.getOrganizationImpact).toHaveBeenCalledOnce();
	});

	it("useOrganizationImpact：无 data.clear 的角色（Finance）即使对话框打开也零请求——不发必然 403", async () => {
		mockCurrentOrganization({
			role: "FINANCE",
			capabilities: FINANCE_CAPABILITIES,
		});
		const { Wrapper } = createWrapper();
		const { result } = renderHook(
			() => useOrganizationImpact({ enabled: true }),
			{ wrapper: Wrapper },
		);
		await waitFor(() => expect(organizationsApi.current).toHaveBeenCalledOnce());
		await act(async () => {
			await Promise.resolve();
		});
		expect(dataRequestsApi.getOrganizationImpact).not.toHaveBeenCalled();
		expect(result.current.fetchStatus).toBe("idle");
	});

	it("useOrganizationImpact：未建账组织零请求——不发必然 409 ONBOARDING_NOT_COMPLETED", async () => {
		mockCurrentOrganization({ onboardingCompleted: false, baseCurrency: null });
		const { Wrapper } = createWrapper();
		const { result } = renderHook(
			() => useOrganizationImpact({ enabled: true }),
			{ wrapper: Wrapper },
		);
		await waitFor(() => expect(organizationsApi.current).toHaveBeenCalledOnce());
		await act(async () => {
			await Promise.resolve();
		});
		expect(dataRequestsApi.getOrganizationImpact).not.toHaveBeenCalled();
		expect(result.current.fetchStatus).toBe("idle");
	});

	it("useOrganizationImpact：组织删除处理中零请求——不发必然 403 ORGANIZATION_DATA_LOCKED", async () => {
		mockCurrentOrganization({
			dataRequestLock: { active: true, type: "DELETION" },
		});
		const { Wrapper } = createWrapper();
		const { result } = renderHook(
			() => useOrganizationImpact({ enabled: true }),
			{ wrapper: Wrapper },
		);
		await waitFor(() => expect(organizationsApi.current).toHaveBeenCalledOnce());
		await act(async () => {
			await Promise.resolve();
		});
		expect(dataRequestsApi.getOrganizationImpact).not.toHaveBeenCalled();
		expect(result.current.fetchStatus).toBe("idle");
	});

	it("useVerifyOrganizationDataRequest 只调用组织域 verify（与个人域端点不混用）", async () => {
		vi.mocked(dataRequestsApi.verifyOrganization).mockResolvedValue({
			challengeId: "ch-c",
			purpose: "CLEAR",
			confirmDeadline: "2026-09-17T00:10:00.000Z",
		});
		const { Wrapper } = createWrapper();
		const { result } = renderHook(() => useVerifyOrganizationDataRequest(), {
			wrapper: Wrapper,
		});
		result.current.mutate({ challengeId: "ch-c", code: "123456", purpose: "CLEAR" });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(dataRequestsApi.verifyOrganization).toHaveBeenCalledWith({
			challengeId: "ch-c",
			code: "123456",
			purpose: "CLEAR",
		});
		expect(dataRequestsApi.verifyPersonal).not.toHaveBeenCalled();
	});

	it("useCreateOrganizationDataRequest 提交组织清空（scope 固定 ORGANIZATION、带确认快照），成功后失效组织域缓存与组织详情", async () => {
		vi.mocked(dataRequestsApi.createOrganizationRequest).mockResolvedValue(
			organizationClear,
		);
		const { queryClient, Wrapper } = createWrapper();
		const organizationKey = withOrgScope("org-a", ORGANIZATION_REQUEST_QUERY_KEY);
		const impactKey = withOrgScope("org-a", ORGANIZATION_IMPACT_QUERY_KEY);
		const organizationDetailKey = queryKeys.organizations.current("org-a");
		for (const key of [organizationKey, impactKey, organizationDetailKey]) {
			queryClient.setQueryData(key, { seeded: true });
		}

		const { result } = renderHook(() => useCreateOrganizationDataRequest(), {
			wrapper: Wrapper,
		});
		result.current.mutate({
			type: "CLEAR",
			scope: "ORGANIZATION",
			challengeId: "ch-clear",
			confirmedTotals: impactView.totals,
		});
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(dataRequestsApi.createOrganizationRequest).toHaveBeenCalledWith({
			type: "CLEAR",
			scope: "ORGANIZATION",
			challengeId: "ch-clear",
			confirmedTotals: impactView.totals,
		});
		expect(dataRequestsApi.createPersonal).not.toHaveBeenCalled();
		// 组织锁摘要随请求状态变化：组织详情必须一起回读，各页面的锁门控才会切换
		expect(isInvalidated(queryClient, organizationKey)).toBe(true);
		expect(isInvalidated(queryClient, impactKey)).toBe(true);
		expect(isInvalidated(queryClient, organizationDetailKey)).toBe(true);
	});

	it("useDeleteOrganization 发起删除当前组织并失效缓存", async () => {
		const organizationDeletion: DataRequestView = {
			...organizationClear,
			id: "req-org-del",
			type: "DELETION",
			displayStatus: "WITHDRAWAL_PERIOD",
			withdrawDeadline: "2026-09-24T00:00:00.000Z",
		};
		vi.mocked(dataRequestsApi.deleteOrganization).mockResolvedValue(
			organizationDeletion,
		);
		const { queryClient, Wrapper } = createWrapper();
		const organizationDetailKey = queryKeys.organizations.current("org-a");
		queryClient.setQueryData(organizationDetailKey, { seeded: true });

		const { result } = renderHook(() => useDeleteOrganization(), { wrapper: Wrapper });
		result.current.mutate({ challengeId: "ch-del" });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(dataRequestsApi.deleteOrganization).toHaveBeenCalledWith({
			challengeId: "ch-del",
		});
		expect(isInvalidated(queryClient, organizationDetailKey)).toBe(true);
	});

	it("useCancelOrganizationDataRequest 走组织端点：CLEAR 直接撤、DELETION 撤回携带验证凭证", async () => {
		vi.mocked(dataRequestsApi.cancelOrganizationRequest).mockResolvedValue({
			...organizationClear,
			status: "CANCELLED",
			displayStatus: "CANCELLED",
			canCancel: false,
		});
		const { Wrapper } = createWrapper();
		const { result } = renderHook(() => useCancelOrganizationDataRequest(), {
			wrapper: Wrapper,
		});

		result.current.mutate({ requestId: "req-org-1" });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(dataRequestsApi.cancelOrganizationRequest).toHaveBeenCalledWith(
			"req-org-1",
			{},
		);

		vi.mocked(dataRequestsApi.cancelOrganizationRequest).mockClear();
		result.current.mutate({ requestId: "req-org-del", challengeId: "ch-del" });
		await waitFor(() =>
			expect(dataRequestsApi.cancelOrganizationRequest).toHaveBeenCalledWith(
				"req-org-del",
				{ challengeId: "ch-del" },
			),
		);
		expect(dataRequestsApi.cancelPersonal).not.toHaveBeenCalled();
	});
});
