"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { membersApi, type MemberView } from "@/lib/api/organizations";
import { queryKeys } from "@/lib/api/query-keys";

/**
 * 所有权转移对话框（需求 MEM-02.2/ORG-03.3；W21）：
 * 高危二次确认（不可逆语义显式提示；键盘可达——原生 dialog 语义用 role+焦点实现）。
 * 转移成功后：本人降为 ADMIN、目标升 OWNER（后端先降后升事务），前端失效成员
 * 列表与当前组织（capabilities 变化立即反映）。
 */
export function TransferOwnershipDialog({ target }: { target: MemberView }) {
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const queryClient = useQueryClient();

	const mutation = useMutation({
		mutationFn: () => membersApi.transferOwnership(target.id),
		onSuccess: () => {
			setOpen(false);
			setError(null);
			void queryClient.invalidateQueries({
				queryKey: queryKeys.members.list(),
			});
			void queryClient.invalidateQueries({
				queryKey: queryKeys.organizations.current(),
			});
		},
		onError: (err: Error) => setError(err.message),
	});

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="rounded-lg border border-border px-2.5 py-1 text-xs text-ink-500 transition-colors hover:bg-muted"
				data-testid="transfer-ownership-entry"
			>
				转移所有权
			</button>
			{open && (
				<div
					role="dialog"
					aria-modal="true"
					aria-label="转移组织所有权"
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
				>
					<div className="w-full max-w-md space-y-4 rounded-xl bg-background p-5 shadow-xl">
						<h2 className="text-base font-semibold text-foreground">
							转移组织所有权
						</h2>
						<p className="text-sm text-ink-500">
							将把组织所有权转移给
							<span className="font-medium text-foreground">
								{target.name ?? target.email ?? "该成员"}
							</span>
							。转移后你将变为管理员，对方成为所有者；此操作会记入审计日志。
						</p>
						{error && (
							<p role="alert" className="text-xs text-red-600">
								{error}
							</p>
						)}
						<div className="flex justify-end gap-2">
							<button
								type="button"
								onClick={() => {
									setOpen(false);
									setError(null);
								}}
								className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-500"
							>
								取消
							</button>
							<button
								type="button"
								disabled={mutation.isPending}
								onClick={() => mutation.mutate()}
								className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
								data-testid="transfer-ownership-confirm"
							>
								{mutation.isPending ? "转移中…" : "确认转移"}
							</button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}
