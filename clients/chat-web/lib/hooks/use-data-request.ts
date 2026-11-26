"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	DataRequestPurpose,
	DataRequestVerifyResult,
	DataRequestView,
	ImpactView,
	OrganizationDeletionRequest,
} from "@/lib/api/contract";
import {
	dataRequestsApi,
	type CreateOrganizationRequestInput,
	type CreatePersonalRequestInput,
} from "@/lib/api/data-requests";
import {
	invalidateAfterDataRequestMutation,
	queryKeys,
	withOrgScope,
} from "@/lib/api/query-keys";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import {
	resolveLedgerQueryGate,
	useOrganizationCapabilities,
} from "@/lib/hooks/use-organization-capabilities";

/**
 * 数据权利请求 hook（技术方案 §9.1–§9.2；Goal #3B W28 双域拆分）：前端唯一带单测的层。
 *
 * 个人域与组织域是两套端点、两组键、两组 hook，不共享任何查询键：
 *
 * - 个人域（usePersonal*）：键不加组织前缀、查询不依赖 orgId 门控。
 *   个人数据权利与组织无关——0 组织 / 多组织未选 / 个人注销锁定的用户都必须能读
 *   进度并撤回。此前个人进度查询被 `enabled: orgId !== null` 挡住，无组织用户被
 *   403 账号锁跳到进度页后拿不到进度，落进死胡同。
 * - 组织域（useOrganization*）：键一律经 withOrgScope(orgId, …) 按组织分桶，
 *   `enabled: orgId !== null`；需要权限的端点再按 capabilities 门控（影响快照需
 *   data.clear），不为无权角色发必然 403 的请求。
 *
 * 提交 / 撤回成功后统一走 invalidateAfterDataRequestMutation（个人域 + 组织域 +
 * 当前组织锁摘要一起回读）。锁状态变化靠失效回读，staleTime 30s。
 */

/** 个人域当前请求键（不加组织前缀：切换组织时保留，个人进度不丢） */
export const PERSONAL_REQUEST_QUERY_KEY =
	queryKeys.dataRequests.personalCurrent();

/** 组织域当前请求的业务键（使用时必须经 withOrgScope 分桶） */
export const ORGANIZATION_REQUEST_QUERY_KEY =
	queryKeys.dataRequests.organizationCurrent();

/** 组织域清空影响的业务键（使用时必须经 withOrgScope 分桶） */
export const ORGANIZATION_IMPACT_QUERY_KEY =
	queryKeys.dataRequests.organizationImpact();

/** 撤回入参 */
export interface CancelRequestVars {
	requestId: string;
	/** DELETION 撤回必带：purpose=DELETION 的已验证凭证 */
	challengeId?: string;
}

type VerifyVars = {
	challengeId: string;
	code: string;
	purpose: DataRequestPurpose;
};

// ───────────────────────── 个人域（不依赖组织）─────────────────────────

/** 本人当前个人请求（设置页 / 进度页共用）；无进行中请求返回 null */
export function usePersonalCurrentRequest() {
	return useQuery<DataRequestView | null>({
		queryKey: PERSONAL_REQUEST_QUERY_KEY,
		queryFn: dataRequestsApi.getPersonalCurrent,
		staleTime: 30 * 1000,
		retry: false,
	});
}

/** 个人数据操作验证码校验（导出 / 注销） */
export function useVerifyPersonalDataRequest() {
	return useMutation<DataRequestVerifyResult, Error, VerifyVars>({
		mutationFn: (input) => dataRequestsApi.verifyPersonal(input),
	});
}

/**
 * 提交个人请求（EXPORT / DELETION）。失败时 ApiError 原样抛出：
 * 409 LAST_OWNER_REQUIRED 的阻塞组织列表取自 error.body.data.blockingOrganizations
 * （见 data-requests.ts 的 getBlockingOrganizations），UI 据此渲染处置入口。
 */
export function useCreatePersonalDataRequest() {
	const queryClient = useQueryClient();
	return useMutation<DataRequestView, Error, CreatePersonalRequestInput>({
		mutationFn: (vars) => dataRequestsApi.createPersonal(vars),
		onSuccess: () => {
			invalidateAfterDataRequestMutation(queryClient);
		},
	});
}

/** 撤回个人请求 */
export function useCancelPersonalDataRequest() {
	const queryClient = useQueryClient();
	return useMutation<DataRequestView, Error, CancelRequestVars>({
		mutationFn: ({ requestId, challengeId }) =>
			dataRequestsApi.cancelPersonal(
				requestId,
				challengeId ? { challengeId } : {},
			),
		onSuccess: () => {
			invalidateAfterDataRequestMutation(queryClient);
		},
	});
}

// ───────────────────────── 组织域（依赖当前组织）─────────────────────────

/** 当前组织的组织域请求（任意有效成员可查）；未选组织不发请求 */
export function useOrganizationCurrentRequest() {
	const orgId = useActiveOrgId();
	return useQuery<DataRequestView | null>({
		queryKey: withOrgScope(orgId, ORGANIZATION_REQUEST_QUERY_KEY),
		queryFn: dataRequestsApi.getOrganizationCurrent,
		enabled: orgId !== null,
		staleTime: 30 * 1000,
		retry: false,
	});
}

/**
 * 组织清空影响（确认页记录数量）。端点需 data.clear 权限且组织已建账，任一不满足
 * 都不发请求（不为 Finance / Operator / Viewer 发必然 403，不为未建账组织发必然
 * 409）；调用方再按「对话框是否打开」收一道——不必为每个打开设置页的人都统计一遍。
 */
export function useOrganizationImpact(options: { enabled: boolean }) {
	const orgId = useActiveOrgId();
	const caps = useOrganizationCapabilities();
	return useQuery<ImpactView>({
		queryKey: withOrgScope(orgId, ORGANIZATION_IMPACT_QUERY_KEY),
		queryFn: dataRequestsApi.getOrganizationImpact,
		enabled:
			options.enabled &&
			resolveLedgerQueryGate(caps) === "ready" &&
			caps.can("data.clear"),
		staleTime: 10 * 1000,
		retry: false,
	});
}

/** 组织数据操作验证码校验（导出 / 清空 / 删除组织的凭证签发） */
export function useVerifyOrganizationDataRequest() {
	return useMutation<DataRequestVerifyResult, Error, VerifyVars>({
		mutationFn: (input) => dataRequestsApi.verifyOrganization(input),
	});
}

/** 提交组织请求（EXPORT / CLEAR）；调用方须先按 capabilities 门控入口 */
export function useCreateOrganizationDataRequest() {
	const queryClient = useQueryClient();
	return useMutation<DataRequestView, Error, CreateOrganizationRequestInput>({
		mutationFn: (vars) => dataRequestsApi.createOrganizationRequest(vars),
		onSuccess: () => {
			invalidateAfterDataRequestMutation(queryClient);
		},
	});
}

/**
 * 发起删除当前组织（仅 Owner）。成功即进入 7 日撤回期并锁定整个组织，
 * 失效回读后各页面的锁门控随之生效。
 */
export function useDeleteOrganization() {
	const queryClient = useQueryClient();
	return useMutation<DataRequestView, Error, OrganizationDeletionRequest>({
		mutationFn: (vars) => dataRequestsApi.deleteOrganization(vars),
		onSuccess: () => {
			invalidateAfterDataRequestMutation(queryClient);
		},
	});
}

/** 撤回组织请求（CLEAR 直接撤；DELETION 需携带已验证凭证） */
export function useCancelOrganizationDataRequest() {
	const queryClient = useQueryClient();
	return useMutation<DataRequestView, Error, CancelRequestVars>({
		mutationFn: ({ requestId, challengeId }) =>
			dataRequestsApi.cancelOrganizationRequest(
				requestId,
				challengeId ? { challengeId } : {},
			),
		onSuccess: () => {
			invalidateAfterDataRequestMutation(queryClient);
		},
	});
}
