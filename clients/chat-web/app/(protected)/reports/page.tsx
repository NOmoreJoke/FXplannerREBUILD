"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { accountsApi } from "@/lib/api/accounts";
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import {
	AccountCostCard,
	ReportPlanList,
	PlanReportPrintDialog,
} from "@/components/business/report";
import { ComplianceDisclaimer } from "@/components/base";

/**
 * 我的报告（报告中心，reports 技术方案 §6 reports/page）。
 *
 * 账户成本卡（复用 GET /accounts 与逐币种 GET /accounts/:currencyCode，零后端改动）
 * + 计划成本列表（状态/币种筛选、行内下载入口、空状态引导）。
 * 下载 = 打开打印浮层（数据同源 GET /reports/plans/:id）→ 浏览器「另存为 PDF」。
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。
 */

export default function ReportsPage() {
	// 组织作用域缓存键 + 未选组织不发业务请求（评审 R2-I07）
	const orgId = useActiveOrgId();
	// 账户成本：先取账户列表（币种集合），再逐币种并发取详情（个人数据 ≤15 币种，方案 §5.3）
	const accountsQuery = useQuery({
		queryKey: withOrgScope(orgId, queryKeys.accounts.list()),
		queryFn: () => accountsApi.list(),
		enabled: orgId !== null,
		staleTime: 15 * 1000,
		retry: false,
	});
	const accounts = accountsQuery.data?.accounts ?? [];
	const [printPlanId, setPrintPlanId] = useState<string | null>(null);

	const accountDetails = useQuery({
		queryKey: withOrgScope(
			orgId,
			queryKeys.accounts.reportDetails(
				accounts.map((a) => a.currencyCode).join(","),
			),
		),
		queryFn: async () => {
			const details = await Promise.all(
				accounts.map((account) => accountsApi.detail(account.currencyCode)),
			);
			return details.map((detail) => ({
				currencyCode: detail.currencyCode,
				balance: detail.balance,
				remainingTotalCost: detail.remainingTotalCost,
				averageUnitCost: detail.averageUnitCost,
			}));
		},
		enabled: orgId !== null && accounts.length > 0,
		staleTime: 15 * 1000,
		retry: false,
	});

	return (
		<div className="mx-auto max-w-5xl px-8 py-6">
			<header className="mb-6">
				<h1 className="text-xl font-bold text-foreground">我的报告</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					按计划查看换汇成本，支持一键下载单计划成本报告。
				</p>
			</header>

			{accounts.length > 0 ? (
				<AccountCostCard
					baseCurrency={accountsQuery.data?.baseCurrency ?? null}
					items={accountDetails.data ?? []}
				/>
			) : null}

			<ReportPlanList onDownload={setPrintPlanId} />

			<PlanReportPrintDialog
				planId={printPlanId ?? ""}
				open={printPlanId !== null}
				onClose={() => setPrintPlanId(null)}
			/>

			{/* 最小合规免责声明（P0-5）：报告页固定展示（成本数据仅记录口径） */}
			<div className="mt-6">
				<ComplianceDisclaimer />
			</div>
		</div>
	);
}
