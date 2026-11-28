"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";
import { useReminderGate } from "@/lib/hooks/use-reminders";

/**
 * 工作台顶栏提醒入口（铃铛 + 未读角标；reminders 技术方案 §8 + F1-3 门控）。
 * 位置：(protected)/layout.tsx 面包屑行右侧，全站受保护页面共享；由 AppBreadcrumb 的 actions 插槽承载。
 *
 * - /onboarding、/data-requests、/invitations 路由 → 零 /settings、零 /reminders 请求，返回 null；
 * - 当前组织未建账、或组织详情未返回、或组织删除处理中（账本查询闸门未放行）→ 零请求，
 *   返回 null——不为未建账组织发必然 409 的请求，也不在删除锁下发必然 403 的请求；
 * - 已建账但提醒开关关闭（reminderEnabled=false）→ 保留铃铛入口但不渲染角标且零 /reminders 请求；
 * - 未读数为 0 / 提醒接口失败 → 不渲染角标，铃铛本身保留入口。
 */
export function ReminderBell() {
	const pathname = usePathname();
	const { isBypassed, isOpen, reminderEnabled, unreadCount } =
		useReminderGate(pathname);

	if (isBypassed || !isOpen) {
		return null;
	}

	const showBadge = reminderEnabled && unreadCount > 0;

	return (
		<Link
			href="/reminders"
			data-testid="reminder-bell"
			aria-label={`提醒中心${showBadge ? `（${unreadCount} 条未读）` : ""}`}
			className="relative flex size-9 items-center justify-center rounded-full border border-border bg-white text-ink-600 transition-colors hover:border-ink-300 hover:text-ink-900"
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
