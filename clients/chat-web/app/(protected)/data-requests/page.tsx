"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	OrganizationRequestPanel,
	PersonalRequestPanel,
} from "@/components/business/account-data";

/**
 * 数据请求进度页（技术方案 §9.2；Goal #3B W28 双域）：个人数据请求与当前组织数据请求
 * 两个进度分区同页并列。认证守卫在 (protected)/layout.tsx，页面零校验代码。
 *
 * 这是两把锁的 403 跳转共同的目的地，也是「登录只进进度页」的落点：
 * - 403 ACCOUNT_PENDING_DELETION（本人注销处理中）→ 个人分区始终可读、可撤回；
 * - 403 ORGANIZATION_DATA_LOCKED（当前组织清空 / 删除处理中）→ 组织分区展示进度与撤回入口，
 *   组织选择不被清空，用户仍可从侧栏切到其他未锁定的组织。
 *
 * 本路由在 isOrglessRouteAllowed 中放行：0 组织 / 多组织未选 / 账号注销锁定的用户
 * 都必须进得来——否则会被组织路由分流挡在选择页外，落进「403 → 跳进度页 → 进不去」
 * 的死胡同。URL 保持纯 /data-requests（既有 E2E 精确匹配），不拼 ?scope=。
 */
export default function DataRequestsPage() {
	return (
		<div
			data-testid="data-requests-page"
			className="mx-auto max-w-3xl space-y-6 px-8 py-6"
		>
			<header className="flex items-center justify-between gap-4">
				<div>
					<h1 className="text-xl font-bold text-foreground">数据请求进度</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						导出、清空、注销与删除请求的处理状态与撤回入口；个人与组织分别处理。
					</p>
				</div>
				<Button variant="ghost" size="sm" asChild>
					<Link href="/settings">
						<ArrowLeft className="size-4" aria-hidden="true" />
						返回设置
					</Link>
				</Button>
			</header>

			<PersonalRequestPanel />
			<OrganizationRequestPanel />
		</div>
	);
}
