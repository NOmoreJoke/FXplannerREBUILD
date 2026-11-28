"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invitationsApi } from "@/lib/api/organizations";
import { queryKeys } from "@/lib/api/query-keys";
import { getToken } from "@/lib/auth/token";
import { useSwitchOrganization } from "@/lib/hooks/use-organizations";

/**
 * 受邀摘要与接受/拒绝页（需求 MEM-01.3/01.6；§13 邀请接受页；W21）：
 * - 未登录 → 跳 /login?redirect=/invitations/:token 完成后回跳接受；
 * - 展示脱敏摘要（组织名/角色/邀请人/有效期，无任何业务明细，MEM-01.7）；
 * - 邮箱不匹配（403）/ 状态冲突（409）如实展示服务端文案。
 * 摘要加载走 react-query（enabled 门控登录态），不裸写 useEffect。
 *
 * 接受成功后（外部评审前端批次）：经完整切换序列进入新组织（列表随之失效重拉）——
 * 否则 30s staleTime 内「进入工作台」仍看不到刚加入的组织。
 */
export default function InvitationTokenPage({
	params,
}: {
	params: Promise<{ token: string }>;
}) {
	const { token } = use(params);
	const [resolved, setResolved] = useState<"accepted" | "declined" | null>(null);
	const hasToken = Boolean(getToken());
	const queryClient = useQueryClient();
	const switchOrganization = useSwitchOrganization();

	const summaryQuery = useQuery({
		queryKey: queryKeys.organizationInvitation.summary(token),
		queryFn: () => invitationsApi.summary(token),
		enabled: hasToken, // 未登录：保护区 layout 守卫统一跳 /login?redirect=…
		retry: false,
	});

	const decide = useMutation({
		mutationFn: async (decision: "accept" | "decline") => {
			if (decision === "accept") {
				await invitationsApi.accept(token);
				return decision;
			}
			await invitationsApi.decline(token);
			return decision;
		},
		onSuccess: (decision) => {
			if (decision === "accept") {
				const organizationId = summaryQuery.data?.organizationId;
				if (organizationId) {
					// 完整的切换序列（清旧组织缓存/中止在途请求与流 → 切选择 →
					// 列表失效重拉），不得只写 store——否则旧组织的无前缀缓存会被带入
					switchOrganization(organizationId);
				} else {
					void queryClient.invalidateQueries({
						queryKey: queryKeys.organizations.list(),
					});
				}
			}
			setResolved(decision === "accept" ? "accepted" : "declined");
		},
	});

	// 未登录兜底（layout 守卫已挡；此处仅渲染等待态兜底登出竞态，不重复跳转）
	if (!hasToken) {
		return (
			<div className="flex min-h-screen items-center justify-center bg-background">
				<p className="text-sm text-muted-foreground">登录校验中…</p>
			</div>
		);
	}

	const summary = summaryQuery.data;

	return (
		<div className="flex min-h-screen items-center justify-center bg-background px-4">
			<div className="w-full max-w-md space-y-4">
				{resolved === "accepted" ? (
					<div className="space-y-3 rounded-xl border border-border p-6 text-center">
						<h1 className="text-lg font-semibold text-foreground">已加入组织</h1>
						<p className="text-sm text-muted-foreground">
							你已成为「{summary?.organizationName ?? "该组织"}」的成员。
						</p>
						<Link
							href="/home"
							className="inline-block rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-900/90"
						>
							进入工作台
						</Link>
					</div>
				) : resolved === "declined" ? (
					<div className="space-y-2 rounded-xl border border-border p-6 text-center">
						<h1 className="text-lg font-semibold text-foreground">已拒绝邀请</h1>
						<p className="text-sm text-muted-foreground">
							你未加入该组织，可关闭本页。
						</p>
					</div>
				) : (
					<div
						data-testid="invitation-summary"
						className="space-y-4 rounded-xl border border-border p-6"
					>
						<h1 className="text-lg font-semibold text-foreground">组织协作邀请</h1>
						{summary ? (
							<dl className="space-y-2 text-sm">
								<div className="flex justify-between gap-3">
									<dt className="text-muted-foreground">组织</dt>
									<dd className="font-medium text-foreground">
										{summary.organizationName}
									</dd>
								</div>
								<div className="flex justify-between gap-3">
									<dt className="text-muted-foreground">邀请邮箱</dt>
									<dd className="text-foreground">{summary.email}</dd>
								</div>
								<div className="flex justify-between gap-3">
									<dt className="text-muted-foreground">角色</dt>
									<dd className="text-foreground">{summary.role}</dd>
								</div>
								<div className="flex justify-between gap-3">
									<dt className="text-muted-foreground">邀请人</dt>
									<dd className="text-foreground">
										{summary.invitedByName ?? "—"}
									</dd>
								</div>
								<div className="flex justify-between gap-3">
									<dt className="text-muted-foreground">有效期至</dt>
									<dd className="text-foreground">
										{summary.expiresAt.slice(0, 10)}
									</dd>
								</div>
							</dl>
						) : summaryQuery.isError ? (
							<div className="space-y-2">
								<p role="alert" className="text-sm text-red-600">
									{(summaryQuery.error as Error).message}
								</p>
								<button
									type="button"
									onClick={() => void summaryQuery.refetch()}
									className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-500"
								>
									重试
								</button>
							</div>
						) : (
							<p className="text-sm text-muted-foreground">邀请加载中…</p>
						)}
						{summary && summary.status === "OPEN" && (
							<div className="space-y-2">
								<div className="flex gap-2">
									<button
										type="button"
										disabled={decide.isPending}
										onClick={() => decide.mutate("accept")}
										className="flex-1 rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-900/90 disabled:opacity-50"
										data-testid="invitation-accept"
									>
										{decide.isPending ? "处理中…" : "接受邀请"}
									</button>
									<button
										type="button"
										disabled={decide.isPending}
										onClick={() => decide.mutate("decline")}
										className="rounded-lg border border-border px-4 py-2 text-sm text-ink-500 disabled:opacity-50"
										data-testid="invitation-decline"
									>
										拒绝
									</button>
								</div>
								{decide.isError && (
									<p role="alert" className="text-xs text-red-600">
										{(decide.error as Error).message}
										（受邀邮箱须与当前登录邮箱一致）
									</p>
								)}
							</div>
						)}
						{summary && summary.status !== "OPEN" && (
							<p className="text-sm text-muted-foreground">
								该邀请当前状态：{summary.status}（不可再接受）。
							</p>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
