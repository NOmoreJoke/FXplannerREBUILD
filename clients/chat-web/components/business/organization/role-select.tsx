"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { membersApi, type MemberView } from "@/lib/api/organizations";
import type { components } from "@/lib/api/schema.gen";
import { queryKeys } from "@/lib/api/query-keys";

type AssignableRole = components["schemas"]["UpdateMemberDto"]["role"];

/** 可分配角色（禁 OWNER——所有权只走转移，MEM-02.2） */
const ASSIGNABLE_ROLES = [
	"ADMIN",
	"FINANCE",
	"OPERATOR",
	"VIEWER",
] as const satisfies readonly AssignableRole[];

const ROLE_LABELS: Record<string, string> = {
	OWNER: "所有者",
	ADMIN: "管理员",
	FINANCE: "财务",
	OPERATOR: "操作员",
	VIEWER: "查看者",
};

/**
 * 操作者可把成员调整成哪些角色（与后端 canManage 的新角色侧同口径）：
 * Owner 可设全部可分配角色；Admin 仅能在普通角色之间调整，不可把人设为 Admin
 * （评审 N-10：不向前端暴露后端必 403 的选项）。
 */
export function adjustableRolesFor(actorRole: string): readonly AssignableRole[] {
	return ASSIGNABLE_ROLES.filter(
		(role) => actorRole === "OWNER" || role !== "ADMIN",
	);
}

/**
 * 角色选择器（需求 MEM-02.1；W21）：调整即调 PATCH（Owner 管全部非 Owner；
 * Admin 仅普通角色——资格由后端 canManage 强制，前端只按 capabilities 与角色显隐）。
 */
export function RoleSelect({
	member,
	actorRole,
	disabled,
}: {
	member: MemberView;
	actorRole: string;
	disabled: boolean;
}) {
	const queryClient = useQueryClient();
	const [error, setError] = useState<string | null>(null);

	const mutation = useMutation({
		mutationFn: (role: AssignableRole) =>
			membersApi.updateRole(member.id, { role }),
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

	// Admin 不可管理 Admin：目标为 Admin 时只读展示
	if (member.role === "ADMIN" && actorRole !== "OWNER") {
		return <span className="text-foreground">{ROLE_LABELS.ADMIN}</span>;
	}

	const options = adjustableRolesFor(actorRole);

	return (
		<div className="flex flex-col items-start gap-1">
			<select
				value={member.role}
				disabled={disabled || mutation.isPending}
				onChange={(e) => mutation.mutate(e.target.value as AssignableRole)}
				aria-label={`调整 ${member.name ?? member.email ?? "成员"} 的角色`}
				className="rounded-lg border border-border bg-background px-2 py-1 text-sm disabled:opacity-60"
				data-testid="role-select"
			>
				{options.map((role) => (
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
