"use client";

import Link from "next/link";
import { BellOff, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ReminderCard } from "@/components/business/reminder";
import { DATA_REQUESTS_PAGE_PATH } from "@/lib/api/client";
import {
	useMarkAllRemindersRead,
	useReminders,
} from "@/lib/hooks/use-reminders";
import { useOrganizationSettings } from "@/lib/hooks/use-organization-settings";

/**
 * 提醒中心页（reminders 技术方案 §8；需求 §7.2）。
 *
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。
 * - 列表未读在前（组内 scheduledFor 倒序，后端已保证），未读条目带视觉标记；
 * - 「全部标为已读」仅在有未读时显示；
 * - 空态「暂无提醒」；开关关闭显示关闭说明与设置入口（settings 查询失败按开启态
 *   降级为普通列表，不误报「已关闭」）；
 * - GET 失败（401 已由 apiClient 统一处理）→ 整页错误态 + 重试；
 * - 组织未建账 / 组织删除处理中（账本查询闸门未放行）：不发任何设置与提醒请求，
 *   如实提示原因——未建账时这两个请求必然 409（查询降噪，Goal #3B W28）。
 */
export default function RemindersPage() {
	const markAllRead = useMarkAllRemindersRead();
	const settings = useOrganizationSettings();

	const reminderEnabled = settings.data?.reminderEnabled === true;
	const settingsLoading = settings.isLoading || settings.gate === "loading";
	// 闸门未放行的两种「有明确原因」状态（未建账 / 组织删除锁），与「加载失败」区分开
	const deletionLocked = settings.gate === "deletion-locked";
	const gateBlocked = deletionLocked || settings.gate === "not-onboarded";
	// settings 查询失败（闸门放行但没拿到数据）→ 按开启态降级，不误报「已关闭」
	const reminderDisabled = settings.data ? !reminderEnabled : false;
	const { items, unreadCount, isLoading, isError, refetch } = useReminders({
		enabled:
			settings.gate === "ready" && !settingsLoading && !reminderDisabled,
	});

	return (
		<div data-testid="reminders-page" className="mx-auto max-w-3xl px-8 py-6">
			<header className="mb-6 flex items-center justify-between">
				<div>
					<h1 className="text-xl font-bold text-foreground">提醒中心</h1>
					<p className="mt-1 text-xs text-muted-foreground">
						集中查看待办提醒；点击条目进入对应计划并记为已读。
					</p>
				</div>
				{!reminderDisabled && unreadCount > 0 && (
					<Button
						type="button"
						data-testid="reminder-read-all"
						disabled={markAllRead.isPending}
						onClick={() => markAllRead.mutate()}
						variant="outline"
						className="border-mint-300 text-mint-700 hover:bg-mint-50"
					>
						{markAllRead.isPending ? "处理中…" : "全部标为已读"}
					</Button>
				)}
			</header>

			{gateBlocked ? (
				<div
					data-testid="reminders-gate-blocked"
					className="rounded-2xl border border-dashed border-border bg-white px-8 py-14 text-center"
				>
					<BellOff className="mx-auto size-8 text-cream-300" />
					<h2 className="mt-4 text-base font-bold text-foreground">
						{deletionLocked ? "组织正在删除处理中" : "当前组织尚未完成建账"}
					</h2>
					<p className="mt-2 text-sm text-muted-foreground">
						{deletionLocked
							? "账本数据暂不可查看，可在数据请求进度页查看处理状态或撤回。"
							: "完成建账后，到了准备日或使用日，提醒会出现在这里。"}
					</p>
					{deletionLocked && (
						<Button
							className="mt-6 bg-mint-700 text-white hover:bg-mint-700/90"
							asChild
						>
							<Link href={DATA_REQUESTS_PAGE_PATH}>查看处理进度</Link>
						</Button>
					)}
				</div>
			) : settingsLoading || isLoading ? (
				<div className="space-y-3">
					<Skeleton className="h-24 w-full rounded-xl" />
					<Skeleton className="h-24 w-full rounded-xl" />
				</div>
			) : reminderDisabled ? (
				<div
					data-testid="reminders-disabled"
					className="rounded-2xl border border-dashed border-border bg-white px-8 py-14 text-center"
				>
					<BellOff className="mx-auto size-8 text-cream-300" />
					<h2 className="mt-4 text-base font-bold text-foreground">
						站内提醒已关闭
					</h2>
					<p className="mt-2 text-sm text-muted-foreground">
						关闭期间不再产生新提醒；计划页仍会显示日期、缺口与进度。
					</p>
					<Button
						className="mt-6 bg-mint-700 text-white hover:bg-mint-700/90"
						asChild
					>
						<Link href="/settings">前往偏好设置</Link>
					</Button>
				</div>
			) : isError ? (
				<div className="flex flex-col items-center justify-center px-8 py-24 text-center">
					<CircleAlert className="size-10 text-cream-300" />
					<h2 className="mt-4 text-lg font-bold text-foreground">
						提醒加载失败
					</h2>
					<p className="mt-2 text-sm text-muted-foreground">
						无法获取提醒列表，请检查网络后重试。
					</p>
					<Button
						className="mt-6 bg-mint-700 text-white hover:bg-mint-700/90"
						onClick={() => refetch()}
					>
						重试
					</Button>
				</div>
			) : items.length === 0 ? (
				<div
					data-testid="reminders-empty"
					className="rounded-2xl border border-dashed border-border bg-white px-8 py-14 text-center"
				>
					<BellOff className="mx-auto size-8 text-cream-300" />
					<h2 className="mt-4 text-base font-bold text-foreground">暂无提醒</h2>
					<p className="mt-2 text-sm text-muted-foreground">
						到了准备日或使用日，提醒会出现在这里。
					</p>
				</div>
			) : (
				<div className="space-y-3">
					{sortUnreadFirst(items).map((item) => (
						<ReminderCard key={item.id} item={item} />
					))}
				</div>
			)}
		</div>
	);
}

/** 未读在前（组内保持后端 scheduledFor 倒序不变；需求 §7.2「未读排在前面」） */
function sortUnreadFirst<T extends { readAt: string | null }>(items: T[]): T[] {
	return [...items].sort((a, b) => {
		const aUnread = a.readAt === null ? 0 : 1;
		const bUnread = b.readAt === null ? 0 : 1;
		return aUnread - bUnread;
	});
}
