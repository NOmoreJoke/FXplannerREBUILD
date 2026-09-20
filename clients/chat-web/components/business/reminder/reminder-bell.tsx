"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SETTINGS_QUERY_KEY } from "@/components/business/settings/preferences-form";
import { settingsApi } from "@/lib/api/settings";
import { useReminders } from "@/lib/hooks/use-reminders";

/**
 * 首页顶栏提醒入口（铃铛 + 未读角标；reminders 技术方案 §8）。
 *
 * - 提醒开关关闭（reminderEnabled=false）→ 不渲染角标（需求 §7.1）；
 * - 未读数为 0 / 提醒接口失败（含未建账 409）→ 不渲染角标，铃铛本身保留入口；
 * - settings 查询复用设置页同 Key（SETTINGS_QUERY_KEY），跨组件共享缓存。
 */
export function ReminderBell() {
	const { unreadCount } = useReminders();
	const settingsQuery = useQuery({
		queryKey: SETTINGS_QUERY_KEY,
		queryFn: settingsApi.getSettings,
		retry: false, // 未建账 409 / 失败 → 按「角标不显示」降级
	});

	const reminderEnabled = settingsQuery.data?.reminderEnabled === true;
	const showBadge = reminderEnabled && unreadCount > 0;

	return (
		<Link
			href="/reminders"
			data-testid="reminder-bell"
			aria-label={`提醒中心${showBadge ? `（${unreadCount} 条未读）` : ""}`}
			className="relative flex size-9 items-center justify-center rounded-full border border-border bg-white text-ink-600 transition-colors hover:border-mint-300 hover:text-mint-700"
		>
			<Bell className="size-4" />
			{showBadge && (
				<span
					data-testid="reminder-badge"
					className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-4 text-white"
				>
					{unreadCount > 99 ? "99+" : unreadCount}
				</span>
			)}
		</Link>
	);
}
