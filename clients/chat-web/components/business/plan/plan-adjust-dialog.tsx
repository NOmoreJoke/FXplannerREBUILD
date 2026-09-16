"use client";

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import type { PacePreference, PlanDetail } from "@/lib/api/contract";
import {
	InstallmentScheduleList,
	formatDisplayAmount,
	formatDisplayDate,
} from "@/components/business/plan/schedule-preview-card";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	usePlanAdjust,
	type UsePlanAdjustResult,
} from "@/lib/hooks/use-plan-adjust";

/**
 * 计划修改两段式对话框（changes/plan-management/技术方案.md §2 方案 A + §前端错误态交互规格）
 *
 * 编辑表单 →（生成预览）→ 预览影响确认 →（确认提交）→ 成功回详情。
 * 错误态（E8gWF 模式）：
 * - PLAN_ALLOCATION_LIMIT：内联提示 caps 三值，分配总额已预填 caps.limit（不清空已填表单）；
 * - PLAN_STATE_CHANGED：提示 +「重新预览」按钮，用最新数据重开预览且已填参数保留；
 * - PLAN_TARGET_BELOW_USED / PLAN_ALLOCATION_BELOW_USED：红色内联提示并焦点定位字段；
 * - 提交结果不明：自动重新 GET 详情核对，不盲目重发。
 *
 * 重新开启场景（已完成计划，入口为「重新开启」）：仅可修改目标金额
 * （后端拒绝重开携带分配/节奏/准备缓冲参数），预览带 reopen 标记，
 * 提交由 hook 自动携带 confirmReopen。
 */

/** 节奏三档展示（官方术语：安心/均衡/主动） */
const PACE_CHOICES: ReadonlyArray<{ value: PacePreference; label: string }> = [
	{ value: "conservative", label: "安心 · 首批 50%" },
	{ value: "balanced", label: "均衡 · 三等分" },
	{ value: "aggressive", label: "主动 · 首批 20%" },
];

export interface PlanAdjustDialogProps {
	/** 当前计划详情（打开时预填现值与乐观锁值） */
	plan: PlanDetail;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** 提交成功（返回提交后详情，页面刷新数据并关闭） */
	onSuccess: (detail: PlanDetail) => void;
	/** 提交结果不明核对完成（页面刷新数据，对话框保持打开供核对） */
	onUnknownOutcome?: (detail: PlanDetail) => void;
}

export function PlanAdjustDialog({
	plan,
	open,
	onOpenChange,
	onSuccess,
	onUnknownOutcome,
}: PlanAdjustDialogProps) {
	const adjust = usePlanAdjust();
	const targetInputRef = useRef<HTMLInputElement>(null);
	const allocInputRef = useRef<HTMLInputElement>(null);

	// 重新开启场景：COMPLETED 且 canReopen，仅允许改目标金额
	const isReopen = plan.status === "COMPLETED" && plan.canReopen;

	// 打开时从详情预填；关闭时复位（下一次打开重新预填）。
	// 依赖只留 open：打开期间详情被外部刷新（如结果不明核对）时不得重置用户已填内容。
	useEffect(() => {
		if (open) {
			adjust.startEditing(plan);
		} else {
			adjust.reset();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// 提交结果不明核对完成：把最新详情交给页面刷新，对话框保持打开展示提示
	useEffect(() => {
		if (adjust.unknownOutcome && adjust.reconciledDetail) {
			onUnknownOutcome?.(adjust.reconciledDetail);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [adjust.unknownOutcome, adjust.reconciledDetail]);

	// 目标/分配低于已使用：焦点定位到对应字段（交互规格表）
	const belowUsed = adjust.error?.kind === "belowUsed" ? adjust.error : null;
	useEffect(() => {
		if (!belowUsed) return;
		const input =
			belowUsed.field === "target"
				? targetInputRef.current
				: allocInputRef.current;
		input?.focus();
	}, [belowUsed]);

	const handleSuccess = (detail: PlanDetail) => {
		onOpenChange(false);
		onSuccess(detail);
	};

	const isEditing = adjust.phase === "editing";
	const isConfirming =
		adjust.phase === "confirming" || adjust.phase === "submitting";
	const isBusy = adjust.phase === "previewing" || adjust.phase === "submitting";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						{isReopen ? "重新开启计划" : "修改换汇计划"}
					</DialogTitle>
					<DialogDescription>
						{isReopen
							? "提高目标金额后计划将回到进行中，新增部分体现为资金缺口。"
							: "先生成影响预览，确认后才会保存修改。"}
					</DialogDescription>
				</DialogHeader>

				{/* 提交结果不明提示（核对完成后展示，供用户核对最新数据） */}
				{adjust.unknownOutcome ? (
					<p
						className="rounded-lg bg-cream-100 px-3 py-2 text-sm text-foreground"
						role="alert"
					>
						刚才的提交结果不明（网络异常），已为你核对最新数据，请确认计划当前状态后再操作。
					</p>
				) : null}

				{isEditing ? (
					<AdjustEditForm
						plan={plan}
						adjust={adjust}
						isReopen={isReopen}
						targetInputRef={targetInputRef}
						allocInputRef={allocInputRef}
					/>
				) : isConfirming && adjust.preview ? (
					<AdjustPreviewView
						plan={plan}
						preview={adjust.preview}
						reopen={isReopen || adjust.preview.reopen}
					/>
				) : null}

				<DialogFooter className="gap-2">
					{isEditing ? (
						<>
							<Button variant="outline" onClick={() => onOpenChange(false)}>
								取消
							</Button>
							<Button
								className="bg-mint-700 text-white hover:bg-mint-700/90"
								disabled={isBusy}
								onClick={() => {
									void adjust.runPreview();
								}}
							>
								{adjust.phase === "previewing" ? (
									<>
										<Loader2 className="size-4 animate-spin" />
										生成中…
									</>
								) : (
									"生成预览"
								)}
							</Button>
						</>
					) : isConfirming ? (
						<>
							<Button
								variant="outline"
								disabled={isBusy}
								onClick={() => {
									// 回到编辑态改参数（保留已填内容）
									adjust.backToEditing();
								}}
							>
								返回修改
							</Button>
							<Button
								className="bg-mint-700 text-white hover:bg-mint-700/90"
								disabled={isBusy}
								onClick={() => {
									void adjust.confirm().then((detail) => {
										if (detail) handleSuccess(detail);
									});
								}}
							>
								{adjust.phase === "submitting" ? (
									<>
										<Loader2 className="size-4 animate-spin" />
										提交中…
									</>
								) : adjust.preview?.reopen || isReopen ? (
									"确认重新开启"
								) : (
									"确认修改"
								)}
							</Button>
						</>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * 编辑表单段（第一段）：目标金额 / 分配总额 / 资金准备节奏 / 准备缓冲 +
 * 提交类错误内联提示。重开场景仅可改目标金额。
 */
function AdjustEditForm({
	plan,
	adjust,
	isReopen,
	targetInputRef,
	allocInputRef,
}: {
	plan: PlanDetail;
	adjust: UsePlanAdjustResult;
	isReopen: boolean;
	targetInputRef: React.RefObject<HTMLInputElement | null>;
	allocInputRef: React.RefObject<HTMLInputElement | null>;
}) {
	const belowUsed = adjust.error?.kind === "belowUsed" ? adjust.error : null;

	return (
		<div className="space-y-5">
			{/* 目标金额（所有场景可改；重开场景唯一可改项） */}
			<div className="space-y-1.5">
				<Label htmlFor="plan-adjust-target">目标金额</Label>
				<div className="flex items-center gap-2">
					<Input
						id="plan-adjust-target"
						ref={targetInputRef}
						inputMode="decimal"
						value={adjust.form.targetAmount}
						onChange={(event) =>
							adjust.setField("targetAmount", event.target.value)
						}
						aria-invalid={adjust.formErrors.targetAmount !== undefined}
					/>
					<span className="text-xs text-muted-foreground">
						{plan.targetCurrency}
					</span>
				</div>
				{belowUsed?.field === "target" ? (
					<p className="text-xs text-red-600" role="alert">
						{belowUsed.message}（差额 {formatDisplayAmount(belowUsed.shortfall)}{" "}
						{plan.targetCurrency}）
					</p>
				) : adjust.formErrors.targetAmount ? (
					<p className="text-xs text-red-600" role="alert">
						{adjust.formErrors.targetAmount}
					</p>
				) : (
					<p className="text-xs text-muted-foreground">
						现值 {formatDisplayAmount(plan.targetAmount)} {plan.targetCurrency}
						；不改请保持原值
					</p>
				)}
			</div>

			{/* 分配总额（重开场景不可改：后端拒绝重开携带分配参数） */}
			{!isReopen ? (
				<div className="space-y-1.5">
					<Label htmlFor="plan-adjust-allocation">分配总额</Label>
					<div className="flex items-center gap-2">
						<Input
							id="plan-adjust-allocation"
							ref={allocInputRef}
							inputMode="decimal"
							value={adjust.form.allocatedAmount}
							onChange={(event) =>
								adjust.setField("allocatedAmount", event.target.value)
							}
							aria-invalid={adjust.formErrors.allocatedAmount !== undefined}
						/>
						<span className="text-xs text-muted-foreground">
							{plan.targetCurrency}
						</span>
					</div>
					{belowUsed?.field === "allocation" ? (
						<p className="text-xs text-red-600" role="alert">
							{belowUsed.message}（差额{" "}
							{formatDisplayAmount(belowUsed.shortfall)} {plan.targetCurrency}）
						</p>
					) : adjust.formErrors.allocatedAmount ? (
						<p className="text-xs text-red-600" role="alert">
							{adjust.formErrors.allocatedAmount}
						</p>
					) : (
						<p className="text-xs text-muted-foreground">
							现值 {formatDisplayAmount(plan.allocatedAmount)}{" "}
							{plan.targetCurrency}；调低目标将自动释放多余分配
						</p>
					)}
				</div>
			) : null}

			{/* 资金准备节奏（重开场景不可改） */}
			{!isReopen ? (
				<div className="space-y-1.5">
					<Label>资金准备节奏</Label>
					<RadioGroup
						value={adjust.form.pacePreference}
						onValueChange={(next) =>
							adjust.setField("pacePreference", next as PacePreference)
						}
						className="gap-2"
					>
						{PACE_CHOICES.map((choice) => (
							<Label
								key={choice.value}
								className="flex cursor-pointer items-center gap-3 rounded-lg p-1 font-normal hover:bg-muted/40"
							>
								<RadioGroupItem value={choice.value} />
								<span className="text-sm">{choice.label}</span>
							</Label>
						))}
					</RadioGroup>
				</div>
			) : null}

			{/* 准备缓冲（重开场景不可改） */}
			{!isReopen ? (
				<div className="space-y-1.5">
					<Label htmlFor="plan-adjust-prep-lead-days">准备缓冲</Label>
					<div className="flex items-center gap-2">
						<Input
							id="plan-adjust-prep-lead-days"
							type="number"
							min={1}
							max={30}
							step={1}
							value={adjust.form.prepLeadDays}
							onChange={(event) =>
								adjust.setField("prepLeadDays", event.target.value)
							}
							aria-invalid={adjust.formErrors.prepLeadDays !== undefined}
						/>
						<span className="text-xs text-muted-foreground">个工作日</span>
					</div>
					{adjust.formErrors.prepLeadDays ? (
						<p className="text-xs text-red-600" role="alert">
							{adjust.formErrors.prepLeadDays}
						</p>
					) : (
						<p className="text-xs text-muted-foreground">
							最晚准备日期 = 预计使用日期往前数缓冲天数
						</p>
					)}
				</div>
			) : null}

			{/* 提交类错误内联提示（交互规格表）：超限预填引导 / 409 附重新预览按钮 / 其余透出 */}
			{adjust.error && adjust.error.kind !== "belowUsed" ? (
				<div
					className="flex items-start justify-between gap-3 rounded-lg bg-red-50 px-3 py-2"
					role="alert"
				>
					<p className="text-sm text-red-600">
						{adjust.error.kind === "overLimit"
							? `当前未分配余额为 ${adjust.error.caps.unallocatedBalance}，最多可分配 ${adjust.error.caps.limit}（还需使用 ${adjust.error.caps.stillNeeded}），已为你预填分配总额上限，可在此基础上调整。`
							: adjust.error.message}
					</p>
					{adjust.error.kind === "conflict" ? (
						<Button
							variant="outline"
							className="shrink-0 bg-white"
							onClick={() => {
								void adjust.retryPreview();
							}}
						>
							重新预览
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/** 预览影响确认视图：修改前 → 修改后对比 + 释放额/新缺口/新排期 */
function AdjustPreviewView({
	plan,
	preview,
	reopen,
}: {
	plan: PlanDetail;
	preview: NonNullable<ReturnType<typeof usePlanAdjust>["preview"]>;
	reopen: boolean;
}) {
	return (
		<div className="space-y-4">
			{reopen ? (
				<p
					className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-700"
					role="status"
				>
					本次调整将重新开启已完成计划：目标调高后计划回到进行中，新增部分体现为资金缺口。
				</p>
			) : null}

			<div className="grid grid-cols-2 gap-3 text-sm">
				<SnapshotBlock
					title="修改前"
					snapshot={preview.before}
					currency={plan.targetCurrency}
				/>
				<SnapshotBlock
					title="修改后"
					snapshot={preview.after}
					currency={plan.targetCurrency}
					highlight
				/>
			</div>

			<dl className="space-y-1.5 rounded-xl bg-muted/40 px-4 py-3 text-sm">
				<div className="flex items-center justify-between">
					<dt className="text-muted-foreground">释放分配（回到未分配余额）</dt>
					<dd className="font-semibold text-foreground">
						{formatDisplayAmount(preview.impact.releasedAmount)}{" "}
						{plan.targetCurrency}
					</dd>
				</div>
				<div className="flex items-center justify-between">
					<dt className="text-muted-foreground">新资金缺口</dt>
					<dd className="font-semibold text-foreground">
						{formatDisplayAmount(preview.impact.newGap)} {plan.targetCurrency}
					</dd>
				</div>
				<div className="flex items-center justify-between">
					<dt className="text-muted-foreground">新最晚准备日期</dt>
					<dd className="font-semibold text-foreground">
						{formatDisplayDate(preview.newLatestPrepDate)}
					</dd>
				</div>
			</dl>

			<div>
				<h4 className="text-sm font-bold text-foreground">
					新排期（准备节点）
				</h4>
				{preview.impact.newSchedule && preview.impact.newSchedule.length > 0 ? (
					<div className="mt-2">
						<InstallmentScheduleList
							installments={preview.impact.newSchedule}
							targetCurrency={plan.targetCurrency}
						/>
					</div>
				) : (
					<p className="mt-2 text-sm text-muted-foreground">
						{preview.impact.scheduleDropped
							? "资金缺口为 0，现有排期将被清空（钱已备齐）。"
							: "排期保持不变。"}
					</p>
				)}
			</div>
		</div>
	);
}

/** 修改前/后快照块（目标金额/分配总额/计划剩余分配/资金缺口） */
function SnapshotBlock({
	title,
	snapshot,
	currency,
	highlight,
}: {
	title: string;
	snapshot: {
		targetAmount: string;
		allocAmount: string;
		remainingAllocation: string;
		gap: string;
	};
	currency: string;
	highlight?: boolean;
}) {
	const rows: [string, string][] = [
		["目标金额", formatDisplayAmount(snapshot.targetAmount)],
		["分配总额", formatDisplayAmount(snapshot.allocAmount)],
		["计划剩余分配", formatDisplayAmount(snapshot.remainingAllocation)],
		["资金缺口", formatDisplayAmount(snapshot.gap)],
	];
	return (
		<div
			className={`rounded-xl border px-3 py-2.5 ${
				highlight ? "border-mint-300 bg-mint-50/60" : "border-border bg-white"
			}`}
		>
			<h5 className="text-xs font-semibold text-muted-foreground">{title}</h5>
			<dl className="mt-1.5 space-y-1">
				{rows.map(([label, value]) => (
					<div
						key={label}
						className="flex items-center justify-between text-xs"
					>
						<dt className="text-muted-foreground">{label}</dt>
						<dd className="font-semibold text-foreground">
							{value}
							<span className="ml-0.5 font-normal text-muted-foreground">
								{currency}
							</span>
						</dd>
					</div>
				))}
			</dl>
		</div>
	);
}
