"use client";

import { useQuery } from "@tanstack/react-query";
import type { SettingsView } from "@/lib/api/contract";
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import { settingsApi } from "@/lib/api/settings";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import {
	useLedgerQueryGate,
	type LedgerQueryGate,
} from "@/lib/hooks/use-organization-capabilities";

/**
 * 组织账本设置查询（GET /settings）的唯一入口（技术方案 §10.3 查询降噪；Goal #3B W28）。
 *
 * 请求受账本查询闸门（useLedgerQueryGate）约束：未选组织、组织详情未返回、未建账、
 * 组织删除处理中，一律不发请求——这些状态下 GET /settings 必然 409 / 403。
 * 顶栏铃铛、首页提醒区、提醒中心、行情页与设置页都经此读取 reminderEnabled / 本位币，
 * 不得再各自手写一份查询（此前四处各写一份，未建账组织每次都吃一个 409）。
 *
 * 键经 withOrgScope 按组织分桶：不同组织的准备偏好、提醒开关、本位币各不相同。
 */

export interface UseOrganizationSettingsOptions {
	/**
	 * 调用方追加的开关（如提醒铃铛在拦截路由传 false）；与闸门同时为真才发请求。
	 * 缺省 true——是否该发由闸门判定。
	 */
	enabled?: boolean;
}

export interface OrganizationSettingsResult {
	/** 组织账本设置；未放行 / 加载中 / 失败时为 undefined */
	data: SettingsView | undefined;
	/** 闸门已放行且首次请求进行中。闸门未放行时为 false——那不是「加载中」，是不该发 */
	isLoading: boolean;
	isError: boolean;
	error: Error | null;
	/** 重试（仅闸门放行时才真的发请求：refetch 会绕过 enabled，这里补上闸门） */
	refetch: () => void;
	/** 账本查询闸门当前状态，供页面区分「未建账 / 删除锁 / 未选组织」与「加载失败」 */
	gate: LedgerQueryGate;
}

export function useOrganizationSettings(
	options: UseOrganizationSettingsOptions = {},
): OrganizationSettingsResult {
	const orgId = useActiveOrgId();
	const gate = useLedgerQueryGate();
	const query = useQuery<SettingsView>({
		queryKey: withOrgScope(orgId, queryKeys.settings.detail()),
		queryFn: settingsApi.getSettings,
		enabled: (options.enabled ?? true) && gate === "ready",
		retry: false, // 401 由 apiClient 统一处理；其余失败交给调用方的错误态
	});

	return {
		data: query.data,
		isLoading: query.isLoading,
		isError: query.isError,
		error: query.error,
		refetch: () => {
			if (gate === "ready") void query.refetch();
		},
		gate,
	};
}
