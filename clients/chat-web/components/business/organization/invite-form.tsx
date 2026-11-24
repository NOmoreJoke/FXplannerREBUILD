"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invitationsApi } from "@/lib/api/organizations";
import type { components } from "@/lib/api/schema.gen";
import { invalidateBusinessKey, queryKeys } from "@/lib/api/query-keys";
import { useCurrentOrganization } from "@/lib/hooks/use-organizations";

type InvitableRole = components["schemas"]["CreateInvitationDto"]["role"];

const INVITABLE_ROLES = [
	"ADMIN",
	"FINANCE",
	"OPERATOR",
	"VIEWER",
] as const satisfies readonly InvitableRole[];

const ROLE_LABELS: Record<string, string> = {
	ADMIN: "管理员",
	FINANCE: "财务",
	OPERATOR: "操作员",
	VIEWER: "查看者",
};

/**
 * 操作者可邀请的角色（与后端 canManage 同口径）：Owner 可邀全部可分配角色；
 * Admin 仅可邀普通角色（不可邀 Admin，评审 N-10：不暴露后端必 403 的选项）。
 */
export function invitableRolesFor(actorRole: string): readonly InvitableRole[] {
	return INVITABLE_ROLES.filter(
		(role) => actorRole === "OWNER" || role !== "ADMIN",
	);
}

/**
 * 邀请表单（需求 MEM-01.1/01.2；W21）：邮箱 + 角色下拉（禁 OWNER）；
 * 成功响应含一次性邀请链接（token 仅本次出现——复制后服务端只存 hash）。
 * 同邮箱已有有效邀请时后端幂等复用（reused=true，不重发 token），此处显式提示而非静默清表。
 * 父级以 key={activeOrganizationId} 挂载：切换组织即重置草稿与上一个组织的邀请链接
 * （需求 ORG-02.4：旧组织未保存表单不得带入新组织）。
 */
export function InviteForm() {
	const { data: current } = useCurrentOrganization();
	const queryClient = useQueryClient();
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<InvitableRole>("FINANCE");
	const [inviteUrl, setInviteUrl] = useState<string | null>(null);
	const [reusedNotice, setReusedNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const canInvite = current?.capabilities["member.invite"] === true;
	const actorRole = current?.role ?? "";
	const roleOptions = invitableRolesFor(actorRole);
	// 当前选中项不在可邀请范围内（如 Admin 的默认值回落）时取第一个可选项
	const selectedRole = roleOptions.includes(role) ? role : (roleOptions[0] ?? "VIEWER");

	const mutation = useMutation({
		mutationFn: () =>
			invitationsApi.create({ email: email.trim(), role: selectedRole }),
		onSuccess: (created) => {
			setError(null);
			setEmail("");
			if (created.reused) {
				// 幂等复用：原链接仍有效且只在首次创建时发放，提示邀请人直接转发原链接
				setInviteUrl(null);
				setReusedNotice(
					`${created.email} 已有一条有效邀请（${created.expiresAt.slice(0, 10)} 到期），未重复发送；请转发此前生成的邀请链接，或先在下方撤回后再重新邀请。`,
				);
			} else {
				setReusedNotice(null);
				setInviteUrl(
					`${window.location.origin}/invitations/${created.token}`,
				);
			}
			invalidateBusinessKey(queryClient, queryKeys.invitations.list());
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
					value={selectedRole}
					onChange={(e) => setRole(e.target.value as InvitableRole)}
					aria-label="受邀角色"
					className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
					data-testid="invite-role"
				>
					{roleOptions.map((r) => (
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
			{reusedNotice && (
				<p
					role="status"
					className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground"
					data-testid="invite-reused-notice"
				>
					{reusedNotice}
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
