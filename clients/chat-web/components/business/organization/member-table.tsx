"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { membersApi, type MemberView } from "@/lib/api/organizations";
import { queryKeys } from "@/lib/api/query-keys";
import { useCurrentOrganization } from "@/lib/hooks/use-organizations";
import { RoleSelect } from "./role-select";
import { TransferOwnershipDialog } from "./transfer-ownership-dialog";
import { PageLoading } from "@/components/base";

/** 行内移除操作（高危：显式确认后调 DELETE；MEM-02.3 立即失去访问权） */
function RemoveMemberButton({ member }: { member: MemberView }) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const mutation = useMutation({
		mutationFn: () => membersApi.remove(member.id),
		onSuccess: () => {
			setConfirming(false);
			setError(null);
			void queryClient.invalidateQueries({
				queryKey: queryKeys.members.list(),
			});
		},
		onError: (err: Error) => setError(err.message),
	});

	if (!confirming) {
		return (
			<button
				type="button"
				onClick={() => setConfirming(true)}
				className="rounded-lg border border-border px-2.5 py-1 text-xs text-ink-500 transition-colors hover:bg-muted"
				data-testid="member-remove-entry"
			>
				移除
			</button>
		);
	}
	return (
		<span className="inline-flex items-center gap-1">
			<button
				type="button"
				disabled={mutation.isPending}
				onClick={() => mutation.mutate()}
				className="rounded-lg bg-red-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
				data-testid="member-remove-confirm"
			>
				{mutation.isPending ? "移除中…" : "确认移除"}
			</button>
			<button
				type="button"
				onClick={() => {
					setConfirming(false);
					setError(null);
				}}
				className="rounded-lg border border-border px-2 py-1 text-xs text-ink-500"
			>
				取消
			</button>
			{error && (
				<span role="alert" className="text-xs text-red-600">
					{error}
				</span>
			)}
		</span>
	);
}

/**
 * 成员表（需求 MEM-02；技术方案 §10.2；W21）：
 * - 角色调整/移除/转移/退出的按钮显隐全部按服务端 capabilities（后端真源）；
 * - DISABLED 成员保留展示（历史归属可审计，MEM-02.4）；
 * - 移除/转移为高危操作：行内二次确认（对话框内显式确认，键盘可达）。
 */
export function MemberTable() {
	const { data: current } = useCurrentOrganization();
	const { data: members, isLoading } = useQuery({
		queryKey: queryKeys.members.list(),
		queryFn: () => membersApi.list(),
		enabled: Boolean(current),
	});

	if (isLoading) {
		return <PageLoading />;
	}

	const canUpdate = current?.capabilities["member.update"] === true;
	const canRemove = current?.capabilities["member.remove"] === true;
	const canTransfer = current?.capabilities["owner.transfer"] === true;

	return (
		<div
			data-testid="member-table"
			className="overflow-hidden rounded-xl border border-border"
		>
			<table className="w-full text-sm">
				<thead className="bg-muted/50 text-left text-xs text-muted-foreground">
					<tr>
						<th className="px-4 py-2.5 font-medium">成员</th>
						<th className="px-4 py-2.5 font-medium">角色</th>
						<th className="px-4 py-2.5 font-medium">状态</th>
						<th className="px-4 py-2.5 font-medium">加入时间</th>
						<th className="px-4 py-2.5 text-right font-medium">操作</th>
					</tr>
				</thead>
				<tbody>
					{(members ?? []).map((member: MemberView) => (
						<tr
							key={member.id}
							className="border-t border-border"
							data-testid="member-row"
						>
							<td className="px-4 py-2.5">
								<p className="font-medium text-foreground">
									{member.name ?? member.email ?? "（未命名成员）"}
								</p>
								{member.name && member.email && (
									<p className="text-xs text-muted-foreground">{member.email}</p>
								)}
							</td>
							<td className="px-4 py-2.5">
								<RoleSelect
									member={member}
									actorRole={current?.role ?? ""}
									disabled={
										!canUpdate ||
										member.status !== "ACTIVE" ||
										member.role === "OWNER"
									}
								/>
							</td>
							<td className="px-4 py-2.5">
								<span
									className={
										member.status === "ACTIVE"
											? "text-mint-700"
											: "text-muted-foreground"
									}
								>
									{member.status === "ACTIVE" ? "有效" : "已移除"}
								</span>
							</td>
							<td className="px-4 py-2.5 text-xs text-muted-foreground">
								{member.joinedAt.slice(0, 10)}
							</td>
							<td className="px-4 py-2.5 text-right">
								<div className="flex justify-end gap-2">
									{canRemove &&
										member.status === "ACTIVE" &&
										member.role !== "OWNER" && (
											<RemoveMemberButton member={member} />
										)}
									{canTransfer && member.role !== "OWNER" && member.status === "ACTIVE" && (
										<TransferOwnershipDialog target={member} />
									)}
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
