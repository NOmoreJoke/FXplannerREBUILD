"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RequestProgress } from "@/components/business/account-data";
import { useCurrentRequest } from "@/lib/hooks/use-data-request";

/**
 * 数据请求进度页（account-data 技术方案 §8）：request-progress 全屏态。
 * 认证守卫在 (protected)/layout.tsx，页面零校验代码；
 * 注销/清空锁定时业务端点被 403 拦到本页，即「登录只进进度页」的目的地。
 */
export default function DataRequestsPage() {
	const current = useCurrentRequest();

	return (
		<div data-testid="data-requests-page" className="mx-auto max-w-3xl px-8 py-6">
			<header className="mb-6 flex items-center justify-between">
				<div>
					<h1 className="text-xl font-bold text-foreground">数据请求进度</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						导出、清空与注销请求的处理状态与撤回入口。
					</p>
				</div>
				<Button variant="ghost" size="sm" asChild>
					<Link href="/settings">
						<ArrowLeft className="size-4" aria-hidden="true" />
						返回设置
					</Link>
				</Button>
			</header>

			{current.isPending && (
				<div className="rounded-2xl border border-border bg-white p-6 text-sm text-muted-foreground">
					正在加载…
				</div>
			)}
			{current.data && <RequestProgress view={current.data} />}
			{!current.isPending && !current.data && (
				<div
					data-testid="data-requests-empty"
					className="rounded-2xl border border-dashed border-border bg-white px-8 py-12 text-center"
				>
					<p className="text-base font-bold text-foreground">暂无进行中的请求</p>
					<p className="mt-2 text-sm text-muted-foreground">
						可在设置页的「账号与数据」区发起导出、清空或注销。
					</p>
				</div>
			)}
		</div>
	);
}
