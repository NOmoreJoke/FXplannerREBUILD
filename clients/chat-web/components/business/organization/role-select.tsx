"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { membersApi, type MemberView } from "@/lib/api/organizations";
import { queryKeys } from "@/lib/api/query-keys";

/** 可分配角色（禁 OWNER——所有权只走转移，MEM-02.2） */
const ASSIGNABLE_ROLES = ["ADMIN", "FINANCE", "OPERATOR", "VIEWER"] as const;

const ROLE_LABELS: Record<string, string> = {
	OWNER: "所有者",
	ADMIN: "管理员",
	FINANCE: "财务",
	OPERATOR: "操作员",
	VIEWER: "查看者",
};

/**
 * 角色选择器（需求 MEM-02.1；W21）：调整即调 PATCH（Owner 管全部非 Owner；
 * Admin 仅普通角色——资格由后端 canManage 强制，前端只按 capabilities 显隐）。
 */
export function RoleSelect({
	member,
	disabled,
}: {
	member: MemberView;
	disabled: boolean;
}) {
	const queryClient = useQueryClient();
	const [error, setError] = useState<string | null>(null);

	const mutation = useMutation({
		mutationFn: (role: string) => membersApi.updateRole(member.id, role),
		onSuccess: () => {
			setError(null);
			void queryClient.invalidateQueries({
				queryKey: queryKeys.members.list(),
			});
		},
		onError: (err: Error) => setError(err.message),
	});

	if (member.role === "OWNER") {
		return <span className="text-foreground">{ROLE_LABELS.OWNER}</span>;
	}

	return (
		<div className="flex flex-col items-start gap-1">
			<select
				value={member.role}
				disabled={disabled || mutation.isPending}
				onChange={(e) => mutation.mutate(e.target.value)}
				aria-label={`调整 ${member.name ?? member.email ?? "成员"} 的角色`}
				className="rounded-lg border border-border bg-background px-2 py-1 text-sm disabled:opacity-60"
				data-testid="role-select"
			>
				{ASSIGNABLE_ROLES.map((role) => (
					<option key={role} value={role}>
						{ROLE_LABELS[role]}
					</option>
				))}
			</select>
			{error && (
				<span role="alert" className="text-xs text-red-600">
					{error}
				</span>
			)}
		</div>
	);
}
