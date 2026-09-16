"use client";

import Link from "next/link";
import {
	ArrowRight,
	CalendarClock,
	Plus,
	RefreshCw,
	ShieldCheck,
	TrendingUp,
	Wallet,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
	formatDisplayAmount,
	formatDisplayDate,
} from "@/components/business/plan/schedule-preview-card";
import { getCurrencyName } from "@/lib/api/currencies";
import type {
	HomeDashboardData,
	HomeDashboardFocusPlan,
} from "@/lib/hooks/use-home-state";
import { cn } from "@/lib/utils";

/**
 * 工作台首页仪表盘（真实数据版，changes/home-dashboard/接口契约.md §4）
 *
 * 数据全部来自 useHomeState 归一的 dashboard（页面分流后传入），页面无写死业务数字：
 * - 顶栏：当天日期 + 录入买入快捷入口 + 汇率监控角标（latestRateObservedAt 为 null 不显示）
 * - 统计卡：账户数 / 持仓总成本（portfolio 失败显示 "—" 不阻塞整页）/ 最新汇率刷新 / 最晚备汇日（无 ACTIVE 计划不出卡）
 * - 账户卡：余额 + 平均成本，整卡点击进 /accounts/:currencyCode
 * - 计划提醒横幅：焦点计划分配进度 + 备汇日倒计时（逾期红色），「查看计划」进 /plans/:id；无焦点计划不渲染
 *
 * 金额口径：接口金额字符串原样/去尾零展示（formatDisplayAmount），禁止前端精度裁剪与浮点换算
 * （对齐 account-module「原样渲染保障 E2E toContainText 精确断言」约定）；
 * baseCurrency 为 null（用户无 settings 记录）时币种标注退化省略（严禁硬编码本位币，对齐账户流水表先例）。
 */

export interface HomeDashboardProps {
	/** state + portfolio 双请求归一结果（useHomeState；页面已保证非 null） */
	dashboard: HomeDashboardData;
}

export function HomeDashboard({ dashboard }: HomeDashboardProps) {
	const {
		accountCount,
		currencies,
		accountCards,
		totalRemainingCost,
		baseCurrency,
		latestRateObservedAt,
		focusPlan,
	} = dashboard;

	return (
		<div className="mx-auto max-w-5xl px-8 py-6">
			{/* 顶栏：当天日期 + 快捷录入 + 汇率监控角标（无观测数据不显示） */}
			<header className="mb-6 flex items-start justify-between">
				<div>
					<h1 className="text-xl font-bold text-foreground">首页</h1>
					<p className="mt-1 text-xs text-muted-foreground">
						{format(new Date(), "yyyy-MM-dd")}
					</p>
				</div>
				<div className="flex items-center gap-3">
					{/* 快速录入入口（changes/transaction-entry/技术方案.md §6） */}
					<Link
						href="/transactions/new"
						className={buttonVariants({
							className: "bg-mint-700 text-white hover:bg-mint-700/90",
						})}
					>
						<Plus className="size-4" />
						录入买入
					</Link>
					{latestRateObservedAt !== null && (
						<span className="flex items-center gap-1.5 rounded-full bg-mint-50 px-3 py-1.5 text-xs font-medium text-mint-700">
							<span className="size-1.5 rounded-full bg-mint-500" />
							汇率监控 {formatDisplayDateTime(latestRateObservedAt)}
						</span>
					)}
				</div>
			</header>

			{/* 统计卡片：账户卡无账户不出、备汇日卡无 ACTIVE 计划不出；grid 按存在卡片自动排布 */}
			<div className="mb-8 grid grid-cols-4 gap-4">
				{accountCount > 0 && (
					<StatCard
						icon={Wallet}
						label="外汇账户"
						value={`${accountCount} 个`}
						sub={currencies.join(" · ")}
					/>
				)}
				<StatCard
					icon={TrendingUp}
					label="持仓总成本"
					value={
						totalRemainingCost === null
							? "—"
							: `${formatDisplayAmount(totalRemainingCost)}${baseCurrency ? ` ${baseCurrency}` : ""}`
					}
					sub="全部持仓买入成本合计"
				/>
				<StatCard
					icon={RefreshCw}
					label="最新汇率刷新"
					value={
						latestRateObservedAt === null
							? "—"
							: formatDisplayDateTime(latestRateObservedAt)
					}
					sub="汇率全表最新观测时间"
				/>
				{focusPlan && (
					<StatCard
						icon={CalendarClock}
						label="最晚备汇日"
						value={formatDisplayDate(focusPlan.latestPrepDate)}
						sub={deadlineText(focusPlan)}
						subClassName={focusPlan.isOverdue ? "text-red-600" : undefined}
					/>
				)}
			</div>

			{/* 我的外汇账户：每币种一卡（透传 state.accounts，按 currencyCode 升序） */}
			<section>
				<div className="mb-1 flex items-center justify-between">
					<h2 className="text-base font-bold text-foreground">我的外汇账户</h2>
					<Link
						href="/accounts"
						className="flex items-center gap-1 text-xs text-ink-500 hover:text-foreground"
					>
						查看全部账户 <ArrowRight className="size-3" />
					</Link>
				</div>
				<p className="mb-4 text-xs text-muted-foreground">
					每个账户显示余额与平均成本；点击账户卡进入账户详情。
				</p>

				<div className="grid grid-cols-3 gap-4">
					{accountCards.map((card) => (
						<AccountCard
							key={card.currencyCode}
							card={card}
							baseCurrency={baseCurrency}
						/>
					))}
				</div>
			</section>

			{/* 计划提醒横幅：焦点计划（ACTIVE 中最晚备汇日最早者）；无焦点计划不渲染 */}
			{focusPlan && (
				<section className="mt-8 rounded-2xl bg-mint-50 p-6">
					<div className="flex items-center gap-2">
						<ShieldCheck className="size-5 text-mint-700" />
						<h3 className="text-base font-bold text-mint-700">
							{focusPlan.name ?? `${focusPlan.targetCurrency} 换汇计划`}
						</h3>
					</div>
					<div className="mt-4">
						<div className="flex items-center justify-between text-xs text-ink-600">
							<span>分配进度</span>
							<span className="font-semibold tabular-nums">
								{focusPlan.progressPercent}%
							</span>
						</div>
						<Progress value={focusPlan.progressPercent} className="mt-1.5" />
					</div>
					<p
						className={cn(
							"mt-3 text-sm leading-6",
							focusPlan.isOverdue
								? "font-semibold text-red-600"
								: "text-ink-600",
						)}
					>
						已分配 {formatDisplayAmount(focusPlan.allocatedAmount)} / 目标{" "}
						{formatDisplayAmount(focusPlan.targetAmount)}{" "}
						{focusPlan.targetCurrency} · 最晚备汇日{" "}
						{formatDisplayDate(focusPlan.latestPrepDate)} ·{" "}
						{deadlineText(focusPlan)}
					</p>
					<div className="mt-5 flex justify-end">
						<Link
							href={`/plans/${focusPlan.id}`}
							className={buttonVariants({
								className: "bg-mint-700 text-white hover:bg-mint-700/90",
							})}
						>
							查看计划
						</Link>
					</div>
				</section>
			)}
		</div>
	);
}

/** 备汇日倒计时文案：未逾期「还有 X 天」；已逾期「已逾期 X 天」（天数取绝对值，不显示负数） */
function deadlineText(plan: HomeDashboardFocusPlan): string {
	return plan.isOverdue
		? `已逾期 ${Math.abs(plan.daysUntilPrepDeadline)} 天`
		: `还有 ${plan.daysUntilPrepDeadline} 天`;
}

/** ISO 8601 UTC 时间戳 → yyyy-MM-dd HH:mm（本地时区，对齐 plan-change-log-list 先例）；解析失败回退原文 */
function formatDisplayDateTime(iso: string): string {
	const date = parseISO(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return format(date, "yyyy-MM-dd HH:mm");
}

function StatCard({
	icon: Icon,
	label,
	value,
	sub,
	subClassName,
}: {
	icon: typeof Wallet;
	label: string;
	value: string;
	sub: string;
	/** 旁注覆盖色（如备汇日逾期红色）；缺省用 muted */
	subClassName?: string;
}) {
	return (
		<div className="rounded-xl border border-border p-4">
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<Icon className="size-3.5" />
				{label}
			</div>
			<p className="mt-2 text-lg font-bold text-foreground tabular-nums">
				{value}
			</p>
			<p className={cn("mt-1 text-xs text-muted-foreground", subClassName)}>
				{sub}
			</p>
		</div>
	);
}

/** 账户卡：币种徽标 + 中文名 + 余额 + 平均成本；整卡为链接点击进 /accounts/:currencyCode */
function AccountCard({
	card,
	baseCurrency,
}: {
	card: HomeDashboardData["accountCards"][number];
	/** 本位币（平均成本计价单位标注）；portfolio 失败或无 settings 时为 null，单位标注退化 */
	baseCurrency: string | null;
}) {
	// 平均成本非 null 时 portfolio 必已成功返回，但 baseCurrency 仍可能为 null（用户无 settings 记录），此时只显示数值
	const unit =
		baseCurrency !== null ? `${baseCurrency}/${card.currencyCode}` : null;

	return (
		<Link
			href={`/accounts/${card.currencyCode}`}
			className="block rounded-xl border border-border p-5 transition-colors hover:border-mint-300"
		>
			<div className="flex items-center gap-2.5">
				<span className="flex items-center justify-center rounded-md bg-ink-100 px-1.5 py-0.5 text-xs font-semibold text-ink-600">
					{card.currencyCode}
				</span>
				<span className="text-sm text-ink-600">
					{getCurrencyName(card.currencyCode)}
				</span>
			</div>
			<p className="mt-4 text-2xl font-bold text-foreground tabular-nums">
				{card.balance}{" "}
				<span className="text-sm font-medium text-muted-foreground">
					{card.currencyCode}
				</span>
			</p>
			<dl className="mt-4 space-y-2 border-t border-border pt-3">
				<div className="flex items-center justify-between text-xs">
					<dt className="text-muted-foreground">平均成本</dt>
					<dd className="font-medium text-foreground">
						{card.avgUnitCost === null
							? "—"
							: `${formatDisplayAmount(card.avgUnitCost)}${unit ? ` ${unit}` : ""}`}
					</dd>
				</div>
			</dl>
		</Link>
	);
}
