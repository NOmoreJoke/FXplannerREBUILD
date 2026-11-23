"use client";

import { useState } from "react";

/** 审计筛选状态（AUDIT-03.1：时间起止/成员/动作/结果） */
export interface AuditFilterState {
	from?: string;
	to?: string;
	actorUserId?: string;
	action?: string;
	result?: string;
}

const RESULT_OPTIONS = ["", "SUCCESS", "DENIED", "FAILED"] as const;

/**
 * 审计筛选条（W21）：受控组件——筛选变化由父层重置页码后重查。
 */
export function AuditFilter({
	value,
	onChange,
}: {
	value: AuditFilterState;
	onChange: (next: AuditFilterState) => void;
}) {
	const [draft, setDraft] = useState<AuditFilterState>(value);

	const apply = () => onChange(draft);

	return (
		<div
			data-testid="audit-filter"
			className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-3"
		>
			<input
				type="date"
				aria-label="起始日期"
				value={draft.from ?? ""}
				onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value || undefined }))}
				className="rounded-lg border border-border px-2 py-1 text-xs"
			/>
			<span className="text-xs text-muted-foreground">至</span>
			<input
				type="date"
				aria-label="截止日期"
				value={draft.to ?? ""}
				onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value || undefined }))}
				className="rounded-lg border border-border px-2 py-1 text-xs"
			/>
			<input
				value={draft.action ?? ""}
				onChange={(e) =>
					setDraft((d) => ({ ...d, action: e.target.value.trim() || undefined }))
				}
				placeholder="动作（如 member.update）"
				className="min-w-40 flex-1 rounded-lg border border-border px-2 py-1 text-xs"
				data-testid="audit-filter-action"
			/>
			<select
				aria-label="结果筛选"
				value={draft.result ?? ""}
				onChange={(e) =>
					setDraft((d) => ({ ...d, result: e.target.value || undefined }))
				}
				className="rounded-lg border border-border bg-background px-2 py-1 text-xs"
			>
				{RESULT_OPTIONS.map((option) => (
					<option key={option} value={option}>
						{option === "" ? "全部结果" : option}
					</option>
				))}
			</select>
			<button
				type="button"
				onClick={apply}
				className="rounded-lg bg-mint-700 px-3 py-1 text-xs font-medium text-white"
				data-testid="audit-filter-apply"
			>
				应用筛选
			</button>
		</div>
	);
}
