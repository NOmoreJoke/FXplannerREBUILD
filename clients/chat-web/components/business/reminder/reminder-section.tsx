"use client";

import Link from "next/link";
import { BellOff } from "lucide-react";
import { useOrganizationSettings } from "@/lib/hooks/use-organization-settings";
import { useReminders } from "@/lib/hooks/use-reminders";
import { utcPlus8DayStart } from "@/lib/utils";
import { ReminderCard } from "./reminder-card";

/**
 * 首页「今日提醒」区块（reminders 技术方案 §8；需求 §7.1）。
 *
 * - 取列表中 scheduledFor 属于「业务今天」（UTC+8 日历天，对齐后端口径）的前 3 条
 *   + 「查看全部」；没有提醒时不渲染；
 * - 提醒开关关闭 → 改为一行关闭提示 + 设置页入口（角标/条目都不出现，且不发 /reminders 请求）；
 * - 设置加载中 / 接口失败 → 静默不渲染，首页不被提醒拖垮
 *   （「关闭提醒后页面仍显示状态」由既有焦点横幅天然承担）。
 *
 * 查询降噪（技术方案 §10.3）：设置与提醒都走带账本查询闸门的 hook——首页只在闸门
 * 放行后才渲染到这里，未建账 / 组织删除锁下零 409 / 403 请求。
 */

/** 今日提醒展示上限（需求 §7.1：最多 3 条） */
const TODAY_LIMIT = 3;

export function ReminderSection() {
	const settings = useOrganizationSettings();
	const reminderEnabled = settings.data?.reminderEnabled === true;
	const { items, isLoading, isError } = useReminders({ enabled: reminderEnabled });

	// 设置未就绪（加载中 / 闸门未放行）或失败不渲染（防「先出条目再闪成关闭提示」，
	// 也防把「拿不到设置」误显成「提醒已关闭」）
	if (!settings.data || settings.isError) {
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
					className="font-medium text-ink-700 underline-offset-2 hover:text-ink-900 hover:underline"
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
			className="mb-6 rounded-2xl border border-caution bg-surface-paper p-5"
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
