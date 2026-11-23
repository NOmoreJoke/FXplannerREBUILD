"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCurrentOrganization } from "@/lib/hooks/use-organizations";
import { organizationsApi } from "@/lib/api/organizations";
import { queryKeys } from "@/lib/api/query-keys";
import { PageLoading } from "@/components/base";

/**
 * 组织信息与改名表单（需求 ORG-01.3/ORG-03；W21）：
 * organization.update 权限（Owner/Admin）可见编辑入口，其余角色只读展示
 * （按钮显隐以服务端 capabilities 为准，后端仍强制校验）。
 */
export function OrganizationForm() {
	const { data: current, isLoading } = useCurrentOrganization();
	const queryClient = useQueryClient();
	const [name, setName] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const renameMutation = useMutation({
		mutationFn: () => organizationsApi.rename((name ?? "").trim()),
		onSuccess: () => {
			setName(null);
			setError(null);
			void queryClient.invalidateQueries({
				queryKey: queryKeys.organizations.current(),
			});
			void queryClient.invalidateQueries({
				queryKey: queryKeys.organizations.list(),
			});
		},
		onError: (err: Error) => setError(err.message),
	});

	if (isLoading || !current) {
		return <PageLoading />;
	}

	const canUpdate = current.capabilities["organization.update"] === true;
	const editing = name !== null;

	return (
		<section
			data-testid="organization-form"
			className="space-y-3 rounded-xl border border-border p-4"
		>
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="text-xs text-muted-foreground">组织名称</p>
					{editing ? (
						<input
							value={name}
							onChange={(e) => setName(e.target.value)}
							maxLength={100}
							placeholder="组织名称（1~100 字符）"
							className="mt-1 w-full max-w-sm rounded-lg border border-border px-3 py-1.5 text-sm"
							data-testid="organization-rename-input"
						/>
					) : (
						<p className="truncate text-base font-semibold text-foreground">
							{current.name}
						</p>
					)}
				</div>
				{canUpdate &&
					(editing ? (
						<div className="flex shrink-0 gap-2">
							<button
								type="button"
								disabled={!name.trim() || renameMutation.isPending}
								onClick={() => renameMutation.mutate()}
								className="rounded-lg bg-mint-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
								data-testid="organization-rename-submit"
							>
								{renameMutation.isPending ? "保存中…" : "保存"}
							</button>
							<button
								type="button"
								onClick={() => {
									setName(null);
									setError(null);
								}}
								className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-500"
							>
								取消
							</button>
						</div>
					) : (
						<button
							type="button"
							onClick={() => setName(current.name)}
							className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm text-ink-500 transition-colors hover:bg-muted"
							data-testid="organization-rename-entry"
						>
							改名
						</button>
					))}
			</div>
			{error && (
				<p role="alert" className="text-xs text-red-600">
					{error}
				</p>
			)}
			<dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3 text-sm">
				<div>
					<dt className="text-xs text-muted-foreground">我的角色</dt>
					<dd className="text-foreground">{current.role}</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">建账状态</dt>
					<dd className="text-foreground">
						{current.onboardingCompleted
							? `已建账（本位币 ${current.baseCurrency ?? "-"}）`
							: "待建账"}
					</dd>
				</div>
			</dl>
		</section>
	);
}
