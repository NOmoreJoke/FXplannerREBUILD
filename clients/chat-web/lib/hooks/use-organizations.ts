"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { organizationsApi } from "@/lib/api/organizations";
import {
	clearOrganizationScopedQueries,
	queryKeys,
} from "@/lib/api/query-keys";
import { useOrganizationStore } from "@/lib/stores/organization-store";

/**
 * 组织上下文消费层（ToB R1 W20；技术方案 §10.1；需求 ORG-02）。
 *
 * 职责：
 * - useOrganizations：本人组织列表 + 当前组织详情（capabilities）；
 * - switchOrganization：Abort（cancelQueries 中止在途旧组织请求）→
 *   Remove（清组织作用域缓存，防迟到响应回写新组织）→ 切 store →
 *   Invalidate（组织详情按新组织重拉）；
 * - 单组织用户由调用方（W21 layout）自动直达；未选择组织时 current 查询
 *   不发（enabled 门控，与 W10 降噪一脉相承）。
 */

/** 组织列表（个人端点，始终可拉——登录后路由依据） */
export function useOrganizations() {
	return useQuery({
		queryKey: queryKeys.organizations.list(),
		queryFn: () => organizationsApi.list(),
		staleTime: 30_000,
		retry: false,
	});
}

/** 当前组织详情（含 capabilities；未选组织时不发请求） */
export function useCurrentOrganization() {
	const activeOrganizationId = useOrganizationStore(
		(s) => s.activeOrganizationId,
	);
	return useQuery({
		queryKey: queryKeys.organizations.current(),
		queryFn: () => organizationsApi.current(),
		enabled: activeOrganizationId !== null,
		staleTime: 30_000,
		retry: false,
	});
}

/**
 * 切换组织（需求 15.1.3/15.1.4）：顺序保证「先中止在途、再清缓存、
 * 后切选择」——新组织首屏数据全部重新拉取，旧组织迟到响应无缓存可写。
 */
export function useSwitchOrganization() {
	const queryClient = useQueryClient();
	const setActiveOrganization = useOrganizationStore(
		(s) => s.setActiveOrganization,
	);
	return useCallback(
		(nextOrganizationId: string) => {
			// 1. 中止旧组织在途请求（cancel 触发 fetch Abort）
			// 2. 清组织作用域缓存（公共汇率/认证/建账态保留；含成员/邀请/审计
			//    工作台键——对抗审 R1 [Important] 修复）
			clearOrganizationScopedQueries(queryClient);
			// 3. 切换选择（persist 落 localStorage，仅存选择不构成凭证）
			setActiveOrganization(nextOrganizationId);
			// 4. 组织详情失效重拉（新组织的 capabilities/建账态）；工作台页面键
			//    已被 remove，被观察查询自动按新组织头重拉，此处 invalidate 兜底
			void queryClient.invalidateQueries({
				queryKey: queryKeys.organizations.current(),
			});
			void queryClient.invalidateQueries({
				queryKey: queryKeys.organizations.list(),
			});
			void queryClient.invalidateQueries({
				queryKey: queryKeys.members.all,
			});
			void queryClient.invalidateQueries({
				queryKey: queryKeys.invitations.all,
			});
			void queryClient.invalidateQueries({
				queryKey: queryKeys.auditLogs.all,
			});
		},
		[queryClient, setActiveOrganization],
	);
}
