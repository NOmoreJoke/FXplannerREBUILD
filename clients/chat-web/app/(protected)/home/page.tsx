"use client";

import Link from "next/link";
import {
	ArrowRight,
	Bell,
	CalendarClock,
	CircleAlert,
	ShieldCheck,
	TrendingUp,
	Wallet,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

/**
 * 工作台首页（静态 mock 版）
 *
 * TODO: 所有数据均为硬编码占位，待接入后端统计接口后替换。
 */
export default function HomePage() {
	return (
		<div className="mx-auto max-w-5xl px-8 py-6">
			{/* 顶栏 */}
			<header className="mb-6 flex items-start justify-between">
				<div>
					<h1 className="text-xl font-bold text-foreground">首页</h1>
					<p className="mt-1 text-xs text-muted-foreground">
						2026-05-08 · 你距离目标还差一步换汇
					</p>
				</div>
				<div className="flex items-center gap-3">
					<span className="flex items-center gap-1.5 rounded-full bg-mint-50 px-3 py-1.5 text-xs font-medium text-mint-700">
						<span className="size-1.5 rounded-full bg-mint-500" />
						监控时间 08:30
					</span>
					<button
						type="button"
						className="flex size-8 items-center justify-center rounded-full text-ink-500 hover:bg-muted"
						aria-label="通知"
					>
						<Bell className="size-4" />
					</button>
				</div>
			</header>

			{/* 同步失败提示横幅 */}
			<div className="mb-6 flex items-center justify-between rounded-xl bg-cream-100 px-5 py-4">
				<div className="flex items-center gap-3">
					<CircleAlert className="size-5 shrink-0 text-cream-300" />
					<div>
						<p className="text-sm font-semibold text-foreground">
							评分数据同步失败
						</p>
						<p className="mt-0.5 text-xs text-muted-foreground">
							过去 24 小时没有成功任何数据项。请求将保留同步至正常为止。
						</p>
					</div>
				</div>
				<button
					type="button"
					className="shrink-0 rounded-lg border border-cream-300 bg-white px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
				>
					重新同步
				</button>
			</div>

			{/* 统计卡片 */}
			<div className="mb-8 grid grid-cols-4 gap-4">
				<StatCard
					icon={Wallet}
					label="外汇账户"
					value="3 个"
					sub="USD · CAD · JPY"
				/>
				<StatCard
					icon={TrendingUp}
					label="持仓总成本"
					value="HK$246,380"
					sub="锁定换汇汇率"
				/>
				<StatCard
					icon={ShieldCheck}
					label="最近自动检查"
					value="68%"
					sub="偏离安全评分"
				/>
				<StatCard
					icon={CalendarClock}
					label="最晚安全日期"
					value="2026-08-12"
					sub="低于 20 天"
				/>
			</div>

			{/* 我的外汇账户 */}
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
					每个账户显示余额、待收利息和当前持平换汇率；点击账户卡查看换汇建议。
				</p>

				<div className="grid grid-cols-3 gap-4">
					<AccountCard
						flag="US"
						name="USD 账户"
						balance="$18,420"
						currency="USD"
						rows={[
							["待收利息", "HK$13,872 HKD"],
							["按时平均成本", "HK$7.1160 HKD/USD"],
						]}
					/>
					<AccountCard
						flag="CA"
						name="CAD 账户"
						balance="$8,650"
						currency="CAD"
						rows={[
							["待收利息", "HK$49,451 HKD"],
							["按时平均成本", "HK$5.7898 HKD/CAD"],
						]}
					/>
					<AccountCard
						flag="JP"
						name="JPY 账户"
						balance="¥980,000"
						currency="JPY"
						rows={[
							["待收利息", "HK$52,367 HKD"],
							["按时平均成本", "HK$0.0532 HKD/JPY"],
						]}
					/>
				</div>
			</section>

			{/* 计划提醒横幅 */}
			<section className="mt-8 rounded-2xl bg-mint-50 p-6">
				<div className="flex items-center gap-2">
					<ShieldCheck className="size-5 text-mint-700" />
					<h3 className="text-base font-bold text-mint-700">
						加拿大秋季学费需要补下一批资金
					</h3>
				</div>
				<p className="mt-2 text-sm leading-6 text-ink-600">
					当前准备进度 68%。便于平衡够时间维持达 75%，需在 2026-08-18 前补齐
					$8,200 CAD。
				</p>
				<div className="mt-5 flex items-center justify-between">
					<p className="text-xs text-muted-foreground">
						官方参考汇率：更新时间 2026-05-07 12:05 HKT · 非全部安全预期
					</p>
					<Link
						href="/plans"
						className={buttonVariants({
							className: "bg-mint-700 text-white hover:bg-mint-700/90",
						})}
					>
						查看计划并确认
					</Link>
				</div>
			</section>
		</div>
	);
}

function StatCard({
	icon: Icon,
	label,
	value,
	sub,
}: {
	icon: typeof Wallet;
	label: string;
	value: string;
	sub: string;
}) {
	return (
		<div className="rounded-xl border border-border p-4">
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<Icon className="size-3.5" />
				{label}
			</div>
			<p className="mt-2 text-lg font-bold text-foreground">{value}</p>
			<p className="mt-1 text-xs text-muted-foreground">{sub}</p>
		</div>
	);
}

function AccountCard({
	flag,
	name,
	balance,
	currency,
	rows,
}: {
	flag: string;
	name: string;
	balance: string;
	currency: string;
	rows: [string, string][];
}) {
	return (
		<div className="rounded-xl border border-border p-5">
			<div className="flex items-center gap-2.5">
				<span className="flex items-center justify-center rounded-md bg-ink-100 px-1.5 py-0.5 text-xs font-semibold text-ink-600">
					{flag}
				</span>
				<span className="text-sm text-ink-600">{name}</span>
			</div>
			<p className="mt-4 text-2xl font-bold text-foreground">
				{balance}{" "}
				<span className="text-sm font-medium text-muted-foreground">
					{currency}
				</span>
			</p>
			<dl className="mt-4 space-y-2 border-t border-border pt-3">
				{rows.map(([label, value]) => (
					<div
						key={label}
						className="flex items-center justify-between text-xs"
					>
						<dt className="text-muted-foreground">{label}</dt>
						<dd className="font-medium text-foreground">{value}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}
