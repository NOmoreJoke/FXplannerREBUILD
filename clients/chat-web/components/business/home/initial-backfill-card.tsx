"use client";

import Link from "next/link";
import { ArrowRight, PiggyBank } from "lucide-react";
import { PermissionHint } from "@/components/base/permission-notice";
import { useOrganizationCapabilities } from "@/lib/hooks/use-organization-capabilities";

/**
 * 补录初始持仓引导卡（规格模块 3）
 *
 * 已建账但从未录入初始持仓（HomeState.hasInitialHoldings=false）时展示，
 * 引导进入 /onboarding?backfill=1 补录流程；补录完成后引导卡消失
 * （E2E 场景 10：空账本→补录→引导卡消失）。卡片根元素即 testid 落点，
 * 由消费方（home-dashboard / 首页空状态）决定挂载位置与容器。
 *
 * 能力门控（Goal #3B W28）：补录走 POST /onboarding/initial-holdings，需 settings.update
 * 权限（仅 Owner / Admin）。Finance / Operator / Viewer 看到的是只读提示而不是一个点下去
 * 必然 403 的入口——他们仍能知道「初始持仓尚未录入」并转告有权限的人。
 * 组织详情未返回时不渲染入口（fail-closed，防权限闪烁）。
 */
export function InitialBackfillCard() {
	const { can, isLoading } = useOrganizationCapabilities();

	return (
		<section
			data-testid="initial-backfill-card"
			className="rounded-2xl border border-border bg-white p-6"
		>
			<div className="flex items-start justify-between gap-4">
				<div className="flex items-start gap-3">
					<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-ink-100">
						<PiggyBank className="size-5 text-ink-700" aria-hidden="true" />
					</div>
					<div>
						<h3 className="text-base font-bold text-foreground">
							补录初始持仓
						</h3>
						<p className="mt-1 text-sm leading-6 text-muted-foreground">
							记录您在记账起点当日已持有的外币金额，便于成本计算。
						</p>
					</div>
				</div>
				{can("settings.update") ? (
					<Link
						href="/onboarding?backfill=1"
						data-testid="initial-backfill-cta"
						className="flex shrink-0 items-center gap-1.5 rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-900/90"
					>
						去补录
						<ArrowRight className="size-4" aria-hidden="true" />
					</Link>
				) : isLoading ? null : (
					<PermissionHint
						testId="initial-backfill-readonly-note"
						className="max-w-64 shrink-0"
					>
						当前角色无权补录初始持仓，请联系组织所有者或管理员
					</PermissionHint>
				)}
			</div>
		</section>
	);
}
