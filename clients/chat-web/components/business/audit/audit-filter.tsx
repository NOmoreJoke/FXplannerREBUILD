"use client";

import { useState } from "react";
import type { AuditLogsQuery } from "@/lib/api/organizations";
import { formatAuditResultLabel } from "./audit-labels";

/** 结果枚举（与后端 AUDIT_RESULTS 同源） */
const RESULT_OPTIONS = ["", "SUCCESS", "DENIED", "FAILED"] as const;

/**
 * 审计筛选草稿（表单态：日期为 YYYY-MM-DD，提交时转换为完整 ISO 日期时间）。
 * 应用到查询的条件类型派生自 OpenAPI 生成的 ListAuditLogsQueryDto（零手写）。
 */
export interface AuditFilterDraft {
	fromDate: string;
	toDate: string;
	actorUserId: string;
	action: string;
	result: (typeof RESULT_OPTIONS)[number];
}

export type AuditFilterQuery = Omit<AuditLogsQuery, "page" | "pageSize">;

export const EMPTY_AUDIT_FILTER: AuditFilterDraft = {
	fromDate: "",
	toDate: "",
	actorUserId: "",
	action: "",
	result: "",
};

/**
 * 草稿 → 查询条件（评审 I-20：后端按完整 ISO 日期时间做闭区间比较，
 * 直接传 YYYY-MM-DD 会被解析为当日 00:00:00.000Z 而截掉结束日当天全部记录；
 * 这里把结束日补到 23:59:59.999Z。审计表按 UTC 展示时间，日界同样取 UTC，
 * 与用户在表里看到的时间一致）。
 */
export function toAuditFilterQuery(draft: AuditFilterDraft): AuditFilterQuery {
	const query: AuditFilterQuery = {};
	if (draft.fromDate) query.from = `${draft.fromDate}T00:00:00.000Z`;
	if (draft.toDate) query.to = `${draft.toDate}T23:59:59.999Z`;
	const actorUserId = draft.actorUserId.trim();
	if (actorUserId) query.actorUserId = actorUserId;
	const action = draft.action.trim();
	if (action) query.action = action;
	if (draft.result) query.result = draft.result;
	return query;
}

/**
 * 审计筛选条（AUDIT-03.1：时间起止/成员/动作/结果；W21）：
 * 受控组件——筛选变化由父层重置页码后重查。
 */
export function AuditFilter({
	onChange,
}: {
	onChange: (query: AuditFilterQuery) => void;
}) {
	const [draft, setDraft] = useState<AuditFilterDraft>(EMPTY_AUDIT_FILTER);

	const apply = () => onChange(toAuditFilterQuery(draft));

	return (
		<div
			data-testid="audit-filter"
			className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-3"
		>
			<input
				type="date"
				aria-label="起始日期"
				value={draft.fromDate}
				onChange={(e) => setDraft((d) => ({ ...d, fromDate: e.target.value }))}
				className="rounded-lg border border-border px-2 py-1 text-xs"
			/>
			<span className="text-xs text-muted-foreground">至</span>
			<input
				type="date"
				aria-label="截止日期（含当日）"
				value={draft.toDate}
				onChange={(e) => setDraft((d) => ({ ...d, toDate: e.target.value }))}
				className="rounded-lg border border-border px-2 py-1 text-xs"
			/>
			<input
				value={draft.actorUserId}
				onChange={(e) =>
					setDraft((d) => ({ ...d, actorUserId: e.target.value }))
				}
				placeholder="操作者 ID"
				aria-label="操作者 ID"
				className="min-w-36 flex-1 rounded-lg border border-border px-2 py-1 text-xs"
				data-testid="audit-filter-actor"
			/>
			<input
				value={draft.action}
				onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value }))}
				placeholder="动作编码（如 plan.create）"
				aria-label="动作"
				className="min-w-40 flex-1 rounded-lg border border-border px-2 py-1 text-xs"
				data-testid="audit-filter-action"
			/>
			<select
				aria-label="结果筛选"
				value={draft.result}
				onChange={(e) =>
					setDraft((d) => ({
						...d,
						result: e.target.value as AuditFilterDraft["result"],
					}))
				}
				className="rounded-lg border border-border bg-background px-2 py-1 text-xs"
			>
				{RESULT_OPTIONS.map((option) => (
					<option key={option} value={option}>
						{option === "" ? "全部结果" : formatAuditResultLabel(option)}
					</option>
				))}
			</select>
			<button
				type="button"
				onClick={apply}
				className="rounded-lg bg-ink-900 px-3 py-1 text-xs font-medium text-white hover:bg-ink-900/90"
				data-testid="audit-filter-apply"
			>
				应用筛选
			</button>
			<button
				type="button"
				onClick={() => {
					setDraft(EMPTY_AUDIT_FILTER);
					onChange({});
				}}
				className="rounded-lg border border-border px-3 py-1 text-xs text-ink-500"
				data-testid="audit-filter-reset"
			>
				清除
			</button>
		</div>
	);
}
