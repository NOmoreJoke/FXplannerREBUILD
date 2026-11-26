"use client";

import { Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { ComplianceDisclaimer, PermissionHint } from "@/components/base";
import { Button } from "@/components/ui/button";
import { useOrganizationCapabilities } from "@/lib/hooks/use-organization-capabilities";

const STEPS = [
	"建立本币与外币账户",
	"创建换汇计划并分配资金",
	"按计划执行并持续复查",
] as const;

/**
 * 空状态引导首页（完成首次设置但无账户且无计划时渲染）
 *
 * 「创建第一个目标」跳转 /plans/new 创建页（技术方案 §6）；
 * 「录入已有持仓」暂未开放，禁用态 + 可见灰字提示。
 *
 * 能力门控（Goal #3B W28）：创建计划需 plan.create 权限。Viewer 不渲染「创建第一个目标」，
 * 改为一行只读提示——否则点进去只会看到无权限页。首页只在组织详情就绪后才渲染本组件。
 */
export function HomeEmptyState() {
	const router = useRouter();
	const { can } = useOrganizationCapabilities();

	return (
		<div className="mx-auto max-w-5xl px-8 py-6">
			{/* 顶部引导区 */}
			<header className="pb-8 pt-6 text-center">
				<h1 className="text-2xl font-bold text-foreground">
					先建立第一笔跨币种资金准备
				</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					你的去海外配置的第一步：目标建立后，可让每笔换汇工作快速开始。
				</p>
			</header>

			<div className="grid gap-4 lg:grid-cols-3">
				{/* 中央大卡片：从目标或持仓开始 */}
				<section className="flex flex-col items-center justify-center rounded-2xl border border-border bg-white p-10 text-center lg:col-span-2">
					<div className="flex size-16 items-center justify-center rounded-full bg-mint-100">
						<Wallet className="size-8 text-mint-700" />
					</div>
					<h2 className="mt-5 text-lg font-bold text-foreground">
						从目标或持仓开始
					</h2>
					<p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
						先准备好你的账户与换汇目标数据，一切从零开始、没有历史包袱；所有数据仅做记录与展示，不会自动发起任何实际操作。
					</p>
					<div className="mt-6 flex flex-col items-center gap-3">
						<div className="flex items-center gap-3">
							{can("plan.create") && (
								<Button
									data-testid="home-empty-create-plan"
									className="bg-mint-700 text-white hover:bg-mint-700/90"
									onClick={() => router.push("/plans/new")}
								>
									创建第一个目标
								</Button>
							)}
							<div className="flex flex-col items-center gap-1">
								<Button variant="outline" className="bg-white" disabled>
									录入已有持仓
								</Button>
								<span className="text-xs text-muted-foreground">功能开发中</span>
							</div>
						</div>
						{!can("plan.create") && (
							<PermissionHint testId="home-empty-plan-readonly-note">
								当前角色无权创建换汇计划，请联系组织所有者或管理员
							</PermissionHint>
						)}
					</div>
				</section>

				{/* 右侧栏：三步引导 */}
				<aside className="rounded-2xl border border-border bg-white p-6">
					<h3 className="text-base font-bold text-foreground">最快开始方式</h3>
					<ol className="mt-5 space-y-5">
						{STEPS.map((step, index) => (
							<li key={step} className="flex items-start gap-3">
								<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-mint-700 text-xs font-semibold text-white">
									{index + 1}
								</span>
								<span className="pt-0.5 text-sm text-ink-600">{step}</span>
							</li>
						))}
					</ol>
				</aside>
			</div>

			<div className="mt-6">
				<ComplianceDisclaimer />
			</div>
		</div>
	);
}
