"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { membersApi, organizationsApi } from "@/lib/api/organizations";
import {
	clearOrganizationScopedQueries,
	queryKeys,
} from "@/lib/api/query-keys";
import {
	abortActiveStream,
	useChatStore,
} from "@/lib/stores/chat-store";
import { useOrganizationStore } from "@/lib/stores/organization-store";

/**
 * 组织上下文消费层（ToB R1 W20；技术方案 §10.1；需求 ORG-02）。
 *
 * 职责：
 * - useOrganizations：本人组织列表（个人端点，始终可拉——登录后路由依据）；
 * - useCurrentOrganization：当前组织详情（capabilities），按组织 id 分桶缓存；
 * - useOrganizationRouting：受保护区的组织路由分流（受控副作用，供 layout 消费）；
 * - useSwitchOrganization：Abort（中止在途旧组织请求与 SSE 流）→ Remove（清组织
 *   作用域缓存，防迟到响应回写新组织）→ 切 store → Invalidate（列表重拉）。
 */

/** 组织列表（个人端点；enabled=false 时不发请求——认证未就绪/错误态重试由调用方控制） */
export function useOrganizations(options: { enabled?: boolean } = {}) {
	return useQuery({
		queryKey: queryKeys.organizations.list(),
		queryFn: () => organizationsApi.list(),
		enabled: options.enabled ?? true,
		staleTime: 30_000,
		retry: false,
	});
}

/** 当前组织详情（含 capabilities）；未选组织时不发请求，缓存按组织 id 分桶 */
export function useCurrentOrganization() {
	const activeOrganizationId = useOrganizationStore(
		(s) => s.activeOrganizationId,
	);
	return useQuery({
		queryKey: queryKeys.organizations.current(activeOrganizationId ?? ""),
		queryFn: () => organizationsApi.current(),
		enabled: activeOrganizationId !== null,
		staleTime: 30_000,
		retry: false,
	});
}

/**
 * 切换组织（需求 15.1.3/15.1.4）：顺序保证「先中止在途、再清缓存、
 * 后切选择」——新组织首屏数据全部重新拉取，旧组织迟到响应无缓存可写。
 *
 * 评审 I-18：SSE 流不走 React Query，cancelQueries 管不到它——显式中止当前流，
 * 并重置聊天运行时态（会话选择/流式态/错误态不得带入新组织）。
 */
export function useSwitchOrganization() {
	const queryClient = useQueryClient();
	const setActiveOrganization = useOrganizationStore(
		(s) => s.setActiveOrganization,
	);
	return useCallback(
		(nextOrganizationId: string) => {
			// 1. 中止旧组织在途请求 + 清组织作用域缓存（公共汇率/认证/组织列表保留）
			clearOrganizationScopedQueries(queryClient);
			// 2. 中止旧组织的 SSE 流并重置聊天运行时态
			abortActiveStream();
			useChatStore.getState().resetRuntime();
			// 3. 切换选择（persist 落 localStorage，仅存选择不构成凭证）
			setActiveOrganization(nextOrganizationId);
			// 4. 组织列表失效重拉（角色/建账态可能已变化）；工作台键已被移除，
			//    被观察查询自动按新组织头重拉，组织详情键按新组织 id 分桶天然无旧数据
			void queryClient.invalidateQueries({
				queryKey: queryKeys.organizations.list(),
			});
		},
		[queryClient, setActiveOrganization],
	);
}

/** 创建组织（个人端点）：成功后切换到新组织（列表随切换失效重拉） */
export function useCreateOrganization() {
	const switchOrganization = useSwitchOrganization();
	return useMutation({
		mutationFn: (input: { name: string }) => organizationsApi.create(input),
		onSuccess: (created) => {
			switchOrganization(created.id);
		},
	});
}

/**
 * 退出组织（成员自助；最后 Owner 由后端 409 LAST_OWNER_REQUIRED 拒绝）。
 * 成功后清空组织上下文并落到「未选择」：剩余单组织由路由分流自动选中，
 * 多组织进入选择页——与切换同序（清缓存 → 中止流 → 重置聊天态 → 清选择 → 列表重拉）。
 */
export function useLeaveOrganization() {
	const queryClient = useQueryClient();
	const clearActiveOrganization = useOrganizationStore(
		(s) => s.clearActiveOrganization,
	);
	return useMutation({
		mutationFn: () => membersApi.leave(),
		onSuccess: () => {
			clearOrganizationScopedQueries(queryClient);
			abortActiveStream();
			useChatStore.getState().resetRuntime();
			clearActiveOrganization();
			void queryClient.invalidateQueries({
				queryKey: queryKeys.organizations.list(),
			});
		},
	});
}

export type OrganizationRoutingStatus =
	/** 认证未就绪：不拉组织列表 */
	| "disabled"
	/** 组织列表加载中 */
	| "loading"
	/** 组织列表拉取失败（网络/5xx）：展示错误态与重试，不进入选择态 */
	| "error"
	/** 待选择（多组织未选）或待创建（0 组织） */
	| "pick"
	/** 组织上下文就绪，业务页面可渲染 */
	| "ready";

export interface OrganizationRouting {
	status: OrganizationRoutingStatus;
	retry: () => void;
}

/**
 * 受保护区的组织路由分流（需求 ORG-00.3/ORG-02.4；评审 I-18）。
 *
 * 选择校正是**受控副作用**（effect），不在渲染期写 store：
 * - 持久化的选择不属于本人任何组织（换账号登录、被移出组织）→ 清除；
 * - 恰好一个可选组织且未选 → 自动选中。
 * 仅在组织列表成功返回后执行；加载中/失败时不动既有选择。
 *
 * 可选组织 = 本人组织 − 本会话被服务端拒绝的组织（store.rejectedOrganizationIds）。
 * 被拒绝时列表会重拉：成员关系/角色可能已变化，缓存里的列表不可信。
 *
 * 单组织用户首帧的 status 直接派生为 ready（选择随后由 effect 落到 store），
 * 避免选择页闪现；业务查询在 store 选择落地前保持 enabled=false，不发空头请求。
 */
export function useOrganizationRouting(options: {
	enabled: boolean;
}): OrganizationRouting {
	const { enabled } = options;
	const queryClient = useQueryClient();
	const organizationsQuery = useOrganizations({ enabled });
	const organizations = organizationsQuery.data;
	const activeOrganizationId = useOrganizationStore(
		(s) => s.activeOrganizationId,
	);
	const rejectedOrganizationIds = useOrganizationStore(
		(s) => s.rejectedOrganizationIds,
	);
	const activeOrganizationSetAt = useOrganizationStore(
		(s) => s.activeOrganizationSetAt,
	);
	const setActiveOrganization = useOrganizationStore(
		(s) => s.setActiveOrganization,
	);
	const clearActiveOrganization = useOrganizationStore(
		(s) => s.clearActiveOrganization,
	);

	const selectable = useMemo(
		() =>
			organizations?.filter(
				(org) => !rejectedOrganizationIds.includes(org.id),
			),
		[organizations, rejectedOrganizationIds],
	);

	/**
	 * 列表数据是否早于当前选择的设置时刻。本会话内由应用设置的选择（切换 /
	 * 接受邀请 / 新建组织）在设置时列表缓存往往还不含该组织（已失效、重拉在途），
	 * 此刻不得把它当作失效选择清除——否则刚加入的组织会被立刻切走。
	 */
	const listPredatesSelection =
		activeOrganizationId !== null &&
		organizationsQuery.dataUpdatedAt <= activeOrganizationSetAt;

	useEffect(() => {
		if (!enabled || !selectable) return;
		if (
			activeOrganizationId !== null &&
			!selectable.some((org) => org.id === activeOrganizationId)
		) {
			if (listPredatesSelection) return; // 等列表重拉后再校验
			clearActiveOrganization();
			return;
		}
		if (activeOrganizationId === null && selectable.length === 1) {
			setActiveOrganization(selectable[0].id);
		}
	}, [
		enabled,
		selectable,
		activeOrganizationId,
		listPredatesSelection,
		setActiveOrganization,
		clearActiveOrganization,
	]);

	// 服务端拒绝过组织上下文 → 列表重拉（拒绝集合每新增一项触发一次）
	useEffect(() => {
		if (rejectedOrganizationIds.length === 0) return;
		void queryClient.refetchQueries({
			queryKey: queryKeys.organizations.list(),
		});
	}, [rejectedOrganizationIds, queryClient]);

	let status: OrganizationRoutingStatus;
	if (!enabled) {
		status = "disabled";
	} else if (organizationsQuery.isError && organizations === undefined) {
		status = "error";
	} else if (selectable === undefined) {
		status = "loading";
	} else if (
		activeOrganizationId !== null &&
		(selectable.some((org) => org.id === activeOrganizationId) ||
			listPredatesSelection)
	) {
		// 列表尚不含刚选中的组织（接受邀请/新建组织后）：按就绪处理，业务请求
		// 携带该组织头由服务端校验；列表重拉后再做选择校验
		status = "ready";
	} else if (activeOrganizationId === null && selectable.length === 1) {
		status = "ready";
	} else {
		status = "pick";
	}

	return {
		status,
		retry: () => {
			void organizationsQuery.refetch();
		},
	};
}
