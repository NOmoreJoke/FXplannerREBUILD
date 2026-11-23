"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useCreateOrganization } from "@/lib/hooks/use-organizations";

/**
 * 新建组织卡片（需求 ORG-01.2；外部评审前端批次补入口）：
 * 此前「新建组织」只在 0 组织的选择页出现，已有组织的用户没有任何创建入口。
 * 创建成功后由 useCreateOrganization 切换到新组织；草稿随当前组织重置
 * （父级以 key={activeOrganizationId} 挂载）。
 */
export function CreateOrganizationCard() {
	const create = useCreateOrganization();
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);

	const submit = () => {
		setError(null);
		create.mutate(
			{ name: name.trim() },
			{
				onSuccess: () => {
					setName("");
				},
				onError: (err: Error) => setError(err.message),
			},
		);
	};

	return (
		<section
			data-testid="create-organization-card"
			className="space-y-3 rounded-xl border border-dashed border-border p-4"
		>
			<h2 className="text-sm font-semibold text-foreground">新建组织</h2>
			<p className="text-xs text-muted-foreground">
				为另一家公司或团队另建一个工作台；各组织的账本、成员与审计相互独立。
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					maxLength={100}
					placeholder="组织名称（1~100 字符）"
					className="min-w-0 flex-1 rounded-lg border border-border px-3 py-1.5 text-sm"
					data-testid="create-organization-name"
				/>
				<button
					type="button"
					disabled={!name.trim() || create.isPending}
					onClick={submit}
					className="inline-flex items-center gap-1.5 rounded-lg bg-mint-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
					data-testid="create-organization-submit"
				>
					<Plus className="size-4" aria-hidden />
					{create.isPending ? "创建中…" : "创建组织"}
				</button>
			</div>
			{error && (
				<p role="alert" className="text-xs text-red-600">
					{error}
				</p>
			)}
		</section>
	);
}
