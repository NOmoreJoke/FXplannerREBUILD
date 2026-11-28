"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { auditApi } from "@/lib/api/organizations";
import { queryKeys, withOrgScope } from "@/lib/api/query-keys";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { useCurrentOrganization } from "@/lib/hooks/use-organizations";
import { AuditFilter, type AuditFilterQuery } from "./audit-filter";
import { PageLoading } from "@/components/base";

/**
 * 审计日志表（需求 AUDIT-03；W21）：
 * - 只读分页（分页 + 时间/成员/动作/结果筛选；永不一次返回全组织历史）；
 * - 无任何编辑/删除入口（AUDIT-03.3）；
 * - 无 audit.read capability（Operator/Viewer）显示无权限提示。
 * 组织上下文（capabilities）加载完成前先渲染加载态——评审 I-20：此前 capabilities
 * 尚为 undefined 时即判「无权」，每次进入页面都闪现一次无权限提示。
 *
 * 组织隔离（评审 R2-I08）：查询键按当前组织分桶，且占位数据只在**同一组织内**沿用
 * （翻页/改筛选不闪白）。此前键不含组织且无条件 keepPreviousData：从组织 A 切到
 * 组织 B（都有 audit.read）期间，回显的是 A 的审计记录并沿用 A 的筛选与页码。
 * 筛选/页码等本地态的重置由布局的组织作用域边界（切换即重新挂载）保证。
 */
export function AuditLogTable() {
	const { data: current } = useCurrentOrganization();
	const orgId = useActiveOrgId();
	const [page, setPage] = useState(1);
	const [filter, setFilter] = useState<AuditFilterQuery>({});

	const canRead = current?.capabilities["audit.read"] === true;

	const { data, isLoading, isError, refetch } = useQuery({
		queryKey: withOrgScope(orgId, [...queryKeys.auditLogs.list(), page, filter]),
		queryFn: () => auditApi.list({ page, pageSize: 20, ...filter }),
		enabled: orgId !== null && Boolean(current) && canRead,
		// 仅同一组织内沿用上一次数据：跨组织不把上一个组织的审计记录当占位
		placeholderData: (previousData, previousQuery) =>
			previousQuery?.queryKey[1] === orgId ? previousData : undefined,
		retry: false,
	});

	// 组织详情未就绪：加载态（不能据此判定无权）
	if (!current) {
		return <PageLoading />;
	}

	if (!canRead) {
		return (
			<p
				data-testid="audit-no-permission"
				className="rounded-xl border border-border p-6 text-center text-sm text-muted-foreground"
			>
				当前角色无权查看组织审计记录
			</p>
		);
	}

	if (isError && !data) {
		return (
			<div
				role="alert"
				className="space-y-2 rounded-xl border border-border p-6 text-center text-sm text-muted-foreground"
			>
				<p>审计记录加载失败</p>
				<button
					type="button"
					onClick={() => void refetch()}
					className="rounded-lg border border-border px-3 py-1.5 text-xs text-ink-500"
				>
					重试
				</button>
			</div>
		);
	}

	if (isLoading && !data) {
		return <PageLoading />;
	}

	const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

	return (
		<div className="space-y-3" data-testid="audit-log-table">
			<AuditFilter
				onChange={(next) => {
					setFilter(next);
					setPage(1);
				}}
			/>
			<div className="overflow-x-auto rounded-xl border border-border">
				<table className="w-full text-sm">
					<thead className="bg-muted/50 text-left text-xs text-muted-foreground">
						<tr>
							<th className="px-4 py-2.5 font-medium">时间</th>
							<th className="px-4 py-2.5 font-medium">操作者</th>
							<th className="px-4 py-2.5 font-medium">动作</th>
							<th className="px-4 py-2.5 font-medium">目标</th>
							<th className="px-4 py-2.5 font-medium">结果</th>
						</tr>
					</thead>
					<tbody>
						{(data?.items ?? []).map((log) => (
							<tr key={log.id} className="border-t border-border">
								<td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
									{log.createdAt.slice(0, 19).replace("T", " ")}
								</td>
								<td className="px-4 py-2.5 text-xs">
									{log.actorUserId?.slice(0, 8) ?? "系统"}
								</td>
								<td className="px-4 py-2.5 text-xs text-foreground">
									{log.action}
								</td>
								<td className="px-4 py-2.5 text-xs text-muted-foreground">
									{log.targetType ?? "—"}
								</td>
								<td className="px-4 py-2.5 text-xs">
									<span
										className={
											log.result === "SUCCESS"
												? "text-commit"
												: log.result === "DENIED"
													? "text-amber-600"
													: "text-red-600"
										}
									>
										{log.result}
									</span>
								</td>
							</tr>
						))}
						{data?.items.length === 0 && (
							<tr>
								<td
									colSpan={5}
									className="px-4 py-8 text-center text-sm text-muted-foreground"
								>
									暂无审计记录
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
			<div className="flex items-center justify-between text-sm">
				<span className="text-xs text-muted-foreground">
					共 {data?.total ?? 0} 条 · 第 {page}/{totalPages} 页
				</span>
				<div className="flex gap-2">
					<button
						type="button"
						disabled={page <= 1}
						onClick={() => setPage((p) => p - 1)}
						className="rounded-lg border border-border px-3 py-1.5 text-xs text-ink-500 disabled:opacity-50"
						data-testid="audit-prev-page"
					>
						上一页
					</button>
					<button
						type="button"
						disabled={page >= totalPages}
						onClick={() => setPage((p) => p + 1)}
						className="rounded-lg border border-border px-3 py-1.5 text-xs text-ink-500 disabled:opacity-50"
						data-testid="audit-next-page"
					>
						下一页
					</button>
				</div>
			</div>
		</div>
	);
}
