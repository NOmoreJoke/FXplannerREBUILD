import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { onboardingApi } from "@/lib/api/onboarding";
import { remindersApi } from "@/lib/api/reminders";
import { queryKeys } from "@/lib/api/query-keys";
import { settingsApi } from "@/lib/api/settings";
import type { ReminderItem } from "@/lib/api/contract";

/**
 * 提醒数据消费层（reminders 技术方案 §8）：一个 hook 对齐 use-home-state 范式。
 *
 * staleTime 30s：首页铃铛/今日提醒区/提醒中心页共享同一 Key 缓存，
 * 避免同一次会话内重复触发生成（读时懒生成的入口即本查询）；
 * 已读 mutation 成功后 invalidateQueries 精确刷新。
 */

/** 提醒列表查询 Key（[domain, action] 约定） */
export const REMINDERS_QUERY_KEY = queryKeys.reminders.list();

export interface UseRemindersOptions {
	/** 是否允许触发查询（未建账 / 数据锁路由 / 提醒关闭时传 false 避免无效请求） */
	enabled?: boolean;
}

export interface UseRemindersResult {
	/** 提醒列表（未读全量 + 已读近 30 天，scheduledFor 倒序；无数据为空数组） */
	items: ReminderItem[];
	/** 未读数（未读且事项成立且计划进行中的行数） */
	unreadCount: number;
	/** 首次请求进行中 */
	isLoading: boolean;
	/** 请求失败（401 由 apiClient 统一跳登录；409/其余交给消费方静默或错误态） */
	isError: boolean;
	/** 重试 */
	refetch: () => void;
}

/** 提醒列表查询（铃铛角标 / 首页今日提醒区 / 提醒中心页共用） */
export function useReminders(
	options?: UseRemindersOptions,
): UseRemindersResult {
	const enabled = options?.enabled ?? true;
	const query = useQuery({
		queryKey: REMINDERS_QUERY_KEY,
		queryFn: remindersApi.list,
		enabled,
		staleTime: 30 * 1000, // 容忍秒级陈旧；写操作后由已读 mutation invalidate 精确刷新
		retry: false, // 401 由 apiClient 统一处理；消费方（首页区块）静默降级
	});

	type Items = NonNullable<
		Awaited<ReturnType<typeof remindersApi.list>>["items"]
	>;
	const items = (query.data?.items ?? []) as Items;

	return {
		items,
		unreadCount: query.data?.unreadCount ?? 0,
		isLoading: query.isLoading,
		isError: query.isError,
		refetch: () => {
			void query.refetch();
		},
	};
}

/** 单条已读（点击提醒条目后调用；成功后失效列表缓存回读） */
export function useMarkReminderRead() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => remindersApi.markRead(id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: REMINDERS_QUERY_KEY });
		},
	});
}

/** 全部已读（提醒中心页「全部标为已读」；成功后失效列表缓存回读） */
export function useMarkAllRemindersRead() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => remindersApi.markAllRead(),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: REMINDERS_QUERY_KEY });
		},
	});
}

/** 建账向导与数据权利进度页为受控拦截路由，顶栏提醒铃铛禁止触发 settings/reminders 请求 */
export function isReminderBypassRoute(pathname: string | null | undefined): boolean {
	if (!pathname) return false;
	return (
		pathname.startsWith("/onboarding") || pathname.startsWith("/data-requests")
	);
}

/**
 * 顶栏提醒门控（F1-3 / DEBT-06）：
 * - /onboarding 与 /data-requests 路由直接静默跳过所有请求（0 409 / 0 403）；
 * - 其余路由先读取无 409 的 onboarding/status，仅 completed=true 时请求 /settings；
 * - 仅 completed=true 且 reminderEnabled=true 时请求 /reminders。
 */
export function useReminderGate(pathname: string | null | undefined) {
	const isBypassed = isReminderBypassRoute(pathname);

	const onboardingStatusQuery = useQuery({
		queryKey: queryKeys.onboarding.status(),
		queryFn: onboardingApi.getStatus,
		enabled: !isBypassed,
		staleTime: 5 * 60 * 1000,
		retry: false,
	});
	const isOnboarded = onboardingStatusQuery.data?.completed === true;

	const settingsQuery = useQuery({
		queryKey: queryKeys.settings.detail(),
		queryFn: settingsApi.getSettings,
		enabled: !isBypassed && isOnboarded,
		retry: false,
	});
	const reminderEnabled = settingsQuery.data?.reminderEnabled === true;

	const reminders = useReminders({
		enabled: !isBypassed && isOnboarded && reminderEnabled,
	});

	return {
		isBypassed,
		isOnboarded,
		settingsQuery,
		reminderEnabled,
		...reminders,
	};
}
