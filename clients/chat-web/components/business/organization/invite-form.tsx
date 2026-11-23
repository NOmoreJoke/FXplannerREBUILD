"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invitationsApi } from "@/lib/api/organizations";
import { queryKeys } from "@/lib/api/query-keys";
import { useCurrentOrganization } from "@/lib/hooks/use-organizations";

const INVITABLE_ROLES = ["ADMIN", "FINANCE", "OPERATOR", "VIEWER"] as const;
const ROLE_LABELS: Record<string, string> = {
	ADMIN: "管理员",
	FINANCE: "财务",
	OPERATOR: "操作员",
	VIEWER: "查看者",
};

/**
 * 邀请表单（需求 MEM-01.1/01.2；W21）：邮箱 + 角色下拉（禁 OWNER）；
 * 成功响应含一次性邀请链接（token 仅本次出现——复制后服务端只存 hash）。
 */
export function InviteForm() {
	const { data: current } = useCurrentOrganization();
	const queryClient = useQueryClient();
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<string>("FINANCE");
	const [inviteUrl, setInviteUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const canInvite = current?.capabilities["member.invite"] === true;

	const mutation = useMutation({
		mutationFn: () => invitationsApi.create(email.trim(), role),
		onSuccess: (created) => {
			setError(null);
			setInviteUrl(
				created.reused
					? null
					: `${window.location.origin}/invitations/${created.token}`,
			);
			setEmail("");
			void queryClient.invalidateQueries({
				queryKey: queryKeys.invitations.list(),
			});
		},
		onError: (err: Error) => {
			setError(err.message);
			setInviteUrl(null);
		},
	});

	if (!canInvite) {
		return null; // 按钮显隐以服务端 capabilities 为准（后端仍强制校验）
	}

	return (
		<section
			data-testid="invite-form"
			className="space-y-3 rounded-xl border border-border p-4"
		>
			<h2 className="text-sm font-semibold text-foreground">邀请新成员</h2>
			<div className="flex flex-wrap items-center gap-2">
				<input
					type="email"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					placeholder="受邀成员邮箱"
					className="min-w-0 flex-1 rounded-lg border border-border px-3 py-1.5 text-sm"
					data-testid="invite-email"
				/>
				<select
					value={role}
					onChange={(e) => setRole(e.target.value)}
					aria-label="受邀角色"
					className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
					data-testid="invite-role"
				>
					{INVITABLE_ROLES.map((r) => (
						<option key={r} value={r}>
							{ROLE_LABELS[r]}
						</option>
					))}
				</select>
				<button
					type="button"
					disabled={!email.trim() || mutation.isPending}
					onClick={() => mutation.mutate()}
					className="rounded-lg bg-mint-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
					data-testid="invite-submit"
				>
					{mutation.isPending ? "邀请中…" : "发送邀请"}
				</button>
			</div>
			{error && (
				<p role="alert" className="text-xs text-red-600">
					{error}
				</p>
			)}
			{inviteUrl && (
				<div className="space-y-1 rounded-lg bg-muted/50 p-3">
					<p className="text-xs text-muted-foreground">
						邀请链接（仅本次显示，请立即复制发送；7 天内有效）：
					</p>
					<div className="flex items-center gap-2">
						<code
							className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-xs"
							data-testid="invite-link"
						>
							{inviteUrl}
						</code>
						<button
							type="button"
							onClick={() => {
								void navigator.clipboard?.writeText(inviteUrl);
							}}
							className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-ink-500"
						>
							复制
						</button>
					</div>
				</div>
			)}
		</section>
	);
}
