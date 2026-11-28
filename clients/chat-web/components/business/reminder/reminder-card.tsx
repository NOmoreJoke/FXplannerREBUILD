"use client";

import { useRouter } from "next/navigation";
import { BellRing } from "lucide-react";
import { format, parseISO } from "date-fns";
import { getCurrencyName } from "@/lib/api/currencies";
import type { ReminderItem, ReminderMatter } from "@/lib/api/contract";
import { useMarkReminderRead } from "@/lib/hooks/use-reminders";
import { cn } from "@/lib/utils";

/**
 * 单条提醒卡（reminders 技术方案 §8 组件层）。
 *
 * - matters 并列渲染事项行（同计划同日合并后可多条，后端读时派生）；
 * - 未读圆点 + 未读底色区分；点击整卡跳 /plans/:id 并调 markRead（后台失效缓存，
 *   不阻塞导航——返回提醒中心时已读已生效）；
 * - planName 为 null 回退「{币种} 换汇计划」（对齐 home 先例）。
 */

/** 事项 → 白话文案（后端只回结构化事实，前端组装文案；i18n 接入时仅改本层） */
export function matterText(
	matter: ReminderMatter,
	targetCurrency: string,
): string {
	switch (matter.kind) {
		case "PREP_DUE":
			return `今天到了本次准备日期，本次建议准备 ${matter.installmentAmount ?? "—"} ${targetCurrency}`;
		case "PREP_OVERDUE":
			return `准备已逾期 ${matter.daysOverdue ?? 1} 天，仍未备齐`;
		case "USE_DUE":
			return "今天是预计使用日，请核对实际使用金额";
		case "COMPLETE_READY":
			return "钱已备齐，可以确认完成计划";
		default:
			return "";
	}
}

export interface ReminderCardProps {
	item: ReminderItem;
	/** 点击跳转目标（缺省 /plans/:planId；测试可覆盖） */
	href?: string;
}

export function ReminderCard({ item, href }: ReminderCardProps) {
	const router = useRouter();
	const markRead = useMarkReminderRead();
	const unread = item.readAt === null;
	const target = href ?? `/plans/${item.planId}`;

	const handleClick = async () => {
		if (unread) {
			// 先落已读再导航（失败静默不阻塞跳转；返回提醒中心时已读已生效）
			try {
				await markRead.mutateAsync(item.id);
			} catch {
				// 已读失败不阻塞导航（404/网络异常；下次进入仍可标读）
			}
		}
		router.push(target);
	};

	return (
		<button
			type="button"
			data-testid="reminder-card"
			data-read={unread ? "false" : "true"}
			onClick={handleClick}
			className={cn(
				"w-full rounded-xl border p-4 text-left transition-colors",
				unread
					? "border-caution bg-caution hover:border-caution-rule"
					: "border-border bg-white hover:border-ink-300",
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex items-center gap-2">
					{unread && (
						<span
							data-testid="reminder-unread-dot"
							aria-label="未读"
							className="size-2 rounded-full bg-caution-rule"
						/>
					)}
					<span className="text-sm font-semibold text-foreground">
						{item.planName ?? `${item.targetCurrency} 换汇计划`}
					</span>
					<span className="flex items-center gap-1 rounded bg-ink-100 px-1.5 py-0.5 text-xs font-medium text-ink-600">
						{item.targetCurrency}
						<span className="font-normal">
							{getCurrencyName(item.targetCurrency)}
						</span>
					</span>
				</div>
				<span className="shrink-0 text-xs text-muted-foreground">
					{formatDisplayDate(item.scheduledFor)}
				</span>
			</div>
			<ul className="mt-2 space-y-1">
				{item.matters.map((matter, index) => (
					<li
						key={`${matter.kind}-${index}`}
						className="flex items-start gap-1.5 text-sm leading-6 text-ink-600"
					>
						<BellRing className="mt-1 size-3.5 shrink-0 text-caution" />
						{matterText(matter, item.targetCurrency)}
					</li>
				))}
			</ul>
		</button>
	);
}

/** ISO 8601 → yyyy-MM-dd（解析失败回退原文） */
function formatDisplayDate(iso: string): string {
	const date = parseISO(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return format(date, "yyyy-MM-dd");
}
