"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { invitationsApi } from "@/lib/api/organizations";
import {
	invalidateBusinessKey,
	queryKeys,
	withOrgScope,
} from "@/lib/api/query-keys";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { useCurrentOrganization } from "@/lib/hooks/use-organizations";
import { formatOrganizationRole } from "./role-select";

const STATUS_LABELS: Record<string, string> = {
	OPEN: "待接受",
	ACCEPTED: "已接受",
	DECLINED: "已拒绝",
	REVOKED: "已撤回",
	EXPIRED: "已过期",
};

/**
 * 邀请列表（需求 MEM-01；W21）：状态归并展示 + 撤回（member.invite 才显示）；
 * 不含 token/tokenHash（token 仅创建响应一次性出现）。
 */
export function InvitationList() {
	const { data: current } = useCurrentOrganization();
	const queryClient = useQueryClient();
	// 组织作用域缓存键 + 未选组织不发业务请求（评审 R2-I07）
	const orgId = useActiveOrgId();
	const { data: invitations, isLoading } = useQuery({
		queryKey: withOrgScope(orgId, queryKeys.invitations.list()),
		queryFn: () => invitationsApi.list(),
		enabled: orgId !== null && Boolean(current),
	});

	const revokeMutation = useMutation({
		mutationFn: (id: string) => invitationsApi.revoke(id),
		onSuccess: () => {
			invalidateBusinessKey(queryClient, queryKeys.invitations.list());
		},
	});

	const canInvite = current?.capabilities["member.invite"] === true;

	if (isLoading) {
		return <p className="text-sm text-muted-foreground">邀请加载中…</p>;
	}

	if (!invitations || invitations.length === 0) {
		return (
			<p className="text-sm text-muted-foreground" data-testid="invitation-empty">
				暂无邀请记录
			</p>
		);
	}

	return (
		<ul
			data-testid="invitation-list"
			className="divide-y divide-border rounded-xl border border-border"
		>
			{invitations.map((invitation) => (
				<li
					key={invitation.id}
					className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm"
					data-testid="invitation-row"
				>
					<span className="min-w-0 flex-1 truncate font-medium text-foreground">
						{invitation.email}
					</span>
					<span
						className="text-xs text-muted-foreground"
						data-role={invitation.role}
					>
						{formatOrganizationRole(invitation.role)}
					</span>
					<span className="text-xs text-muted-foreground">
						{invitation.invitedByName ?? "—"}
					</span>
					<span className="text-xs text-muted-foreground">
						{invitation.expiresAt.slice(0, 10)} 到期
					</span>
					<span
						className={
							invitation.status === "OPEN"
								? "text-xs text-ink-700"
								: "text-xs text-muted-foreground"
						}
					>
						{STATUS_LABELS[invitation.status] ?? invitation.status}
					</span>
					{canInvite && invitation.status === "OPEN" && (
						<button
							type="button"
							disabled={revokeMutation.isPending}
							onClick={() => revokeMutation.mutate(invitation.id)}
							className="rounded-md border border-border px-2 py-1 text-xs text-ink-500 transition-colors hover:bg-muted"
							data-testid="invitation-revoke"
						>
							撤回
						</button>
					)}
				</li>
			))}
		</ul>
	);
}
