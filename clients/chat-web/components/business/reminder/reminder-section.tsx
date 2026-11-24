"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { BellOff } from "lucide-react";
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import { settingsApi } from "@/lib/api/settings";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { useReminders } from "@/lib/hooks/use-reminders";
import { utcPlus8DayStart } from "@/lib/utils";
import { ReminderCard } from "./reminder-card";

/**
 * 首页「今日提醒」区块（reminders 技术方案 §8；需求 §7.1）。
 *
 * - 取列表中 scheduledFor 属于「业务今天」（UTC+8 日历天，对齐后端口径）的前 3 条
 *   + 「查看全部」；没有提醒时不渲染；
 * - 提醒开关关闭 → 改为一行关闭提示 + 设置页入口（角标/条目都不出现，且不发 /reminders 请求）；
 * - 加载中 / 接口失败（含未建账 409）→ 静默不渲染，首页不被提醒拖垮
 *   （「关闭提醒后页面仍显示状态」由既有焦点横幅天然承担）。
 */

/** 今日提醒展示上限（需求 §7.1：最多 3 条） */
const TODAY_LIMIT = 3;

export function ReminderSection() {
	// 组织作用域缓存键 + 未选组织不发业务请求（评审 R2-I07）
	const orgId = useActiveOrgId();
	const settingsQuery = useQuery({
		queryKey: withOrgScope(orgId, queryKeys.settings.detail()),
		queryFn: settingsApi.getSettings,
		enabled: orgId !== null,
		retry: false,
	});
	const reminderEnabled = settingsQuery.data?.reminderEnabled === true;
	const { items, isLoading, isError } = useReminders({
		enabled: !settingsQuery.isPending && !settingsQuery.isError && reminderEnabled,
	});

	// settings 未就绪或失败不渲染（防「先出条目再闪成关闭提示」或 409 误显关闭提示）
	if (settingsQuery.isPending || settingsQuery.isError) {
		return null;
	}

	// 开关关闭：一行关闭提示 + 设置入口（无条目、无角标）
	if (!reminderEnabled) {
		return (
			<section
				data-testid="reminder-disabled-note"
				className="mb-6 flex items-center gap-2 rounded-xl border border-dashed border-border bg-white px-4 py-3 text-sm text-muted-foreground"
			>
				<BellOff className="size-4 shrink-0" />
				<span>站内提醒已关闭，可在</span>
				<Link
					href="/settings"
					className="font-medium text-mint-700 underline-offset-2 hover:underline"
				>
					偏好设置
				</Link>
				<span>中重新开启；计划日期与进度仍正常显示。</span>
			</section>
		);
	}

	if (isLoading || isError) {
		return null; // 静默降级：提醒不阻塞首页
	}

	const todayStart = utcPlus8DayStart(new Date());
	const todayItems = items
		.filter(
			(item) =>
				utcPlus8DayStart(new Date(item.scheduledFor)).getTime() ===
				todayStart.getTime(),
		)
		.slice(0, TODAY_LIMIT);

	if (todayItems.length === 0) {
		return null; // 今日无提醒不渲染（需求 §7.1）
	}

	return (
		<section
			data-testid="reminder-section"
			className="mb-6 rounded-2xl border border-mint-200 bg-white p-5"
		>
			<div className="mb-3 flex items-center justify-between">
				<h2 className="text-base font-bold text-foreground">今日提醒</h2>
				<Link
					href="/reminders"
					data-testid="reminder-view-all"
					className="text-xs text-ink-500 hover:text-foreground"
				>
					查看全部
				</Link>
			</div>
			<div className="space-y-2">
				{todayItems.map((item) => (
					<ReminderCard key={item.id} item={item} />
				))}
			</div>
		</section>
	);
}
