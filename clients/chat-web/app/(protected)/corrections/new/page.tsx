"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useEffect } from "react";
import { ArrowLeft, CircleAlert } from "lucide-react";
import {
	CorrectionForm,
	CorrectionImpactPreview,
} from "@/components/business/correction";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageLoading, PermissionNotice } from "@/components/base";
import type { CorrectionTargetType } from "@/lib/api/contract";
import { useCorrectionForm } from "@/lib/hooks/use-correction-form";
import { useOrganizationCapabilities } from "@/lib/hooks/use-organization-capabilities";

/**
 * 更正页（corrections 技术方案 §6：/corrections/new）
 *
 * targetType/targetId 由查询参数进入；按类型渲染对应表单段（原因必填）→
 * 「查看影响」只读预览（blockers 非空禁用确认）→「确认更正」事务提交 →
 * 成功后跳回目标详情。认证守卫在 (protected)/layout.tsx（勿在此重复）。
 *
 * 能力门控（Goal #3B W28）：预演需 correction.preview、提交需 correction.apply
 * （后端对两个接口各自 @RequiresPermission 强制）。
 * - 两者都没有（Operator / Viewer）：整页只读提示，目标内容与表单都不加载；
 * - 只能预演不能提交：可查看影响，「确认更正」禁用并说明原因——
 *   不发必然 403 的请求。组织详情未返回前先加载，按钮不闪现。
 */

const TARGET_TYPES: CorrectionTargetType[] = [
	"TRANSACTION",
	"USAGE",
	"INITIAL_HOLDING",
];

/** 成功后跳回目标详情 */
function targetDetailPath(
	targetType: CorrectionTargetType,
	targetId: string,
	target: Record<string, unknown>,
): string {
	if (targetType === "TRANSACTION") return `/transactions/${targetId}`;
	if (targetType === "INITIAL_HOLDING") {
		const code =
			typeof target.currencyCode === "string" ? target.currencyCode : "";
		return `/accounts/${code}`;
	}
	const planId = target.planId;
	return typeof planId === "string" && planId !== ""
		? `/plans/${encodeURIComponent(planId)}`
		: "/plans";
}

export default function CorrectionNewPage() {
	const { can, isLoading } = useOrganizationCapabilities();
	const canPreview = can("correction.preview");
	const canApply = can("correction.apply");

	if (isLoading) {
		return (
			<PageShell>
				<PageLoading className="min-h-64" />
			</PageShell>
		);
	}

	if (!canPreview && !canApply) {
		return (
			<PageShell>
				<PermissionNotice
					testId="correction-no-permission"
					className="py-16"
					title="当前角色无权发起更正"
					description="当前角色无权发起更正：更正会改写组织的账本记录，需要财务及以上角色。如需更正，请联系组织所有者、管理员或财务。"
					action={
						<Button variant="outline" className="bg-white" asChild>
							<Link href="/home">返回首页</Link>
						</Button>
					}
				/>
			</PageShell>
		);
	}

	return <CorrectionEditor canPreview={canPreview} canApply={canApply} />;
}

function CorrectionEditor({
	canPreview,
	canApply,
}: {
	canPreview: boolean;
	canApply: boolean;
}) {
	const params = useSearchParams();
	const rawType = params.get("targetType");
	const targetId = params.get("targetId");
	const targetType =
		rawType !== null && TARGET_TYPES.includes(rawType as CorrectionTargetType)
			? (rawType as CorrectionTargetType)
			: null;
	const enabled = targetType !== null && targetId !== null && targetId !== "";

	const form = useCorrectionForm(targetType ?? "TRANSACTION", targetId ?? "");

	useEffect(() => {
		if (enabled) {
			void form.loadTarget();
		}
		// 挂载时加载一次目标内容
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled, targetType, targetId]);

	if (!enabled) {
		return (
			<PageShell>
				<InvalidParams message="缺少更正目标参数（targetType / targetId）。" />
			</PageShell>
		);
	}

	if (form.targetLoading) {
		return (
			<PageShell>
				<div className="space-y-4">
					<Skeleton className="h-8 w-64 rounded-xl" />
					<Skeleton className="h-96 w-full rounded-2xl" />
				</div>
			</PageShell>
		);
	}

	if (form.targetError) {
		const isNotFound = form.targetError.code === "CORRECTION_TARGET_NOT_FOUND";
		return (
			<PageShell>
				<InvalidParams
					message={
						isNotFound
							? "该记录不存在或不属于当前账号。"
							: form.targetError.message
					}
				/>
			</PageShell>
		);
	}

	if (!form.target) {
		return (
			<PageShell>
				<InvalidParams message="记录加载失败，请稍后重试。" />
			</PageShell>
		);
	}

	const original = form.target.target;
	const detailPath = targetDetailPath(
		form.target.targetType,
		form.target.targetId,
		original,
	);
	const hasBlockers = (form.preview?.blockers.length ?? 0) > 0;
	const canSubmit =
		canApply &&
		form.preview !== null &&
		!hasBlockers &&
		!form.applying &&
		!form.previewing;

	const onConfirm = async () => {
		// 按钮已按 canApply 禁用；这里再拦一道，保证无权时不会触达提交接口
		if (!canApply) return;
		const result = await form.confirm();
		if (result) {
			// 成功 → 跳回目标详情（版本历史在详情页可见）
			window.location.href = detailPath;
		}
	};

	return (
		<PageShell
			planPath={form.target.targetType === "USAGE" ? detailPath : undefined}
		>
			<div className="mx-auto max-w-3xl space-y-6">
				<header>
					<h1 className="text-xl font-bold text-foreground">
						{form.target.targetType === "TRANSACTION"
							? "更正换汇记录"
							: form.target.targetType === "INITIAL_HOLDING"
								? "更正初始持仓"
								: "更正使用记录"}
					</h1>
					<p className="mt-1 text-xs text-muted-foreground">
						原记录与每次修改都会保留；确认提交前请先查看影响。
					</p>
				</header>

				<section className="rounded-2xl border border-border bg-cream-50 p-5">
					<h2 className="text-sm font-bold text-foreground">原内容</h2>
					<OriginalSummary
						targetType={form.target.targetType}
						original={original}
					/>
				</section>

				<CorrectionForm
					targetType={form.target.targetType}
					original={original}
					form={form.form}
					errors={form.errors}
					onFieldChange={form.setField}
					onFeeModeChange={form.setFeeMode}
				/>

				{form.stale ? (
					<p
						className="flex items-center gap-2 rounded-xl bg-cream-100 px-4 py-3 text-xs text-ink-600"
						role="alert"
					>
						<CircleAlert className="size-4 shrink-0 text-cream-300" />
						{form.target.targetType === "USAGE"
							? "请重新查看影响，确认最新预览后再提交。"
							: "该记录刚被其他修改更新，已为您重新加载最新内容，请重新查看影响后再提交。"}
					</p>
				) : null}

				{form.preview ? (
					<CorrectionImpactPreview preview={form.preview} />
				) : null}

				{form.submitError ? (
					<p
						className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
						role="alert"
					>
						{form.submitError.message}
					</p>
				) : null}

				{!canApply && (
					<p
						data-testid="correction-readonly-note"
						className="flex items-center gap-2 rounded-xl border border-dashed border-border px-4 py-3 text-xs leading-5 text-muted-foreground"
					>
						当前角色只能查看更正影响，无权提交更正；如需提交，请联系组织所有者、管理员或财务。
					</p>
				)}

				<div className="flex items-center gap-3 pb-10">
					<Button
						variant="outline"
						onClick={() => void form.runPreview()}
						disabled={!canPreview || form.previewing || form.applying}
						data-testid="correction-preview-button"
					>
						{form.previewing ? "正在计算影响…" : "查看影响"}
					</Button>
					<Button
						className="bg-mint-700 text-white hover:bg-mint-700/90"
						onClick={() => void onConfirm()}
						disabled={!canSubmit}
						data-testid="correction-confirm-button"
					>
						{form.applying ? "正在提交…" : "确认更正"}
					</Button>
					<Link
					href={detailPath}
						className="text-sm text-muted-foreground hover:text-foreground"
					>
						取消
					</Link>
					{hasBlockers ? (
						<span className="text-xs text-destructive">
							存在不能提交的原因，请按上方提示调整
						</span>
					) : null}
				</div>
			</div>
		</PageShell>
	);
}

/** 原内容摘要（字段随 targetType；金额字符串原样渲染） */
function OriginalSummary({
	targetType,
	original,
}: {
	targetType: CorrectionTargetType;
	original: Record<string, unknown>;
}) {
	if (targetType === "TRANSACTION") {
		return (
			<dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-ink-600">
				<SummaryRow label="币种" value={String(original.currencyCode ?? "—")} />
				<SummaryRow
					label="记录版本"
					value={`v${String(original.version ?? 1)}`}
				/>
				<SummaryRow
					label="本金"
					value={String(original.principalAmount ?? "—")}
				/>
				<SummaryRow
					label="手续费"
					value={
						original.feeAmount === null
							? "未知（≠ 0）"
							: String(original.feeAmount)
					}
				/>
				<SummaryRow label="到账数量" value={String(original.quantity ?? "—")} />
				<SummaryRow
					label="交易日期"
					value={String(original.transactedAt ?? "—").slice(0, 10)}
				/>
			</dl>
		);
	}
	if (targetType === "INITIAL_HOLDING") {
		return (
			<dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-ink-600">
				<SummaryRow label="币种" value={String(original.currencyCode ?? "—")} />
				<SummaryRow label="初始金额" value={String(original.amount ?? "—")} />
				<SummaryRow label="采用汇率" value={String(original.rate ?? "—")} />
				<SummaryRow label="折算成本" value={String(original.cost ?? "—")} />
			</dl>
		);
	}
	return (
		<dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-ink-600">
			<SummaryRow label="使用金额" value={String(original.amount ?? "—")} />
			<SummaryRow
				label="使用日期"
				value={String(original.usedAt ?? "—").slice(0, 10)}
			/>
		</dl>
	);
}

function SummaryRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between gap-3">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="font-medium tabular-nums">{value}</dd>
		</div>
	);
}

function PageShell({
	children,
	planPath,
}: {
	children: React.ReactNode;
	planPath?: string;
}) {
	return (
		<div className="mx-auto max-w-5xl px-8 py-6">
			<Link
				href={planPath ?? "/home"}
				className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
			>
				<ArrowLeft className="size-4" />
				{planPath ? "返回计划" : "返回首页"}
			</Link>
			<div className="mt-4">{children}</div>
		</div>
	);
}

function InvalidParams({ message }: { message: string }) {
	return (
		<div className="mx-auto flex max-w-3xl flex-col items-center py-24 text-center">
			<CircleAlert className="size-10 text-cream-300" />
			<h2 className="mt-4 text-lg font-bold text-foreground">无法发起更正</h2>
			<p className="mt-2 text-sm text-muted-foreground">{message}</p>
			<Button
				className="mt-6 bg-mint-700 text-white hover:bg-mint-700/90"
				onClick={() => {
					window.location.href = "/home";
				}}
			>
				返回首页
			</Button>
		</div>
	);
}
