"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	DataRequestView,
	ImpactView,
	DataRequestVerifyResult,
	DataRequestPurpose,
	ImpactTotals,
} from "@/lib/api/contract";
import { dataRequestsApi } from "@/lib/api/data-requests";
import {
	invalidateAfterDataRequestMutation,
	queryKeys,
} from "@/lib/api/query-keys";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";

/**
 * 数据权利请求 hook（account-data 技术方案 §8）：前端唯一带单测的层。
 * - useCurrentRequest：进度页/设置页共用（staleTime 30s，锁状态变化靠失效回读）；
 * - useImpact：CLEAR 确认页记录数量；
 * - 创建/撤回 mutation：成功即失效缓存回读。
 * ToB W20：端点语义为个人数据权利（Goal #3B 拆分组织 scope），键不加组织
 * 前缀；未选组织时仍门控（GOAL-3A W20：未选组织不乱发业务请求）。
 */

/** 当前数据请求查询 Key（提交/撤回后失效） */
export const DATA_REQUEST_QUERY_KEY = queryKeys.dataRequests.current();

/** 清空影响查询 Key */
export const DATA_REQUEST_IMPACT_KEY = queryKeys.dataRequests.impact();

export function useCurrentRequest() {
	const orgId = useActiveOrgId();
	return useQuery<DataRequestView | null>({
		queryKey: DATA_REQUEST_QUERY_KEY,
		queryFn: dataRequestsApi.getCurrent,
		enabled: orgId !== null,
		staleTime: 30 * 1000,
		retry: false,
	});
}

export function useImpact() {
	const orgId = useActiveOrgId();
	return useQuery<ImpactView>({
		queryKey: DATA_REQUEST_IMPACT_KEY,
		queryFn: dataRequestsApi.getImpact,
		enabled: orgId !== null,
		staleTime: 10 * 1000,
		retry: false,
	});
}

export function useVerifyDataRequest() {
	return useMutation<
		DataRequestVerifyResult,
		Error,
		{ challengeId: string; code: string; purpose: DataRequestPurpose }
	>({
		mutationFn: (input) => dataRequestsApi.verify(input),
	});
}

export interface CreateDataRequestVars {
	type: DataRequestView["type"];
	challengeId: string;
	confirmedTotals?: ImpactTotals;
}

export function useCreateDataRequest() {
	const queryClient = useQueryClient();
	return useMutation<DataRequestView, Error, CreateDataRequestVars>({
		mutationFn: (vars) => dataRequestsApi.create(vars),
		onSuccess: () => {
			invalidateAfterDataRequestMutation(queryClient);
		},
	});
}

export function useCancelDataRequest() {
	const queryClient = useQueryClient();
	return useMutation<
		DataRequestView,
		Error,
		{ requestId: string; challengeId?: string }
	>({
		mutationFn: ({ requestId, challengeId }) =>
			dataRequestsApi.cancel(requestId, challengeId),
		onSuccess: () => {
			invalidateAfterDataRequestMutation(queryClient);
		},
	});
}
