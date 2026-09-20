"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { usagesApi } from "@/lib/api/usages";
import { ApiError } from "@/lib/api/client";
import type { PlanDetail } from "@/lib/api/contract";
import { utc8TodayYmd } from "@/lib/hooks/use-transaction-form";
import {
	HOME_PORTFOLIO_QUERY_KEY,
	HOME_STATE_QUERY_KEY,
} from "@/lib/hooks/use-home-state";
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

/**
 * 记录使用对话框（usage-recording 技术方案 §5.2）
 *
 * 表单（使用金额 / 使用日期 / 备注）+ 提交前变化摘要（余额减少多少、
 * 剩余分配变多少、还需使用剩多少），点确认才生效——填写过程不占用、
 * 不扣减任何金额（需求 §6.1）。409 分配不足时内联展示当前剩余
 * （data.remainingAllocation）。确认按钮 pending 置为处理中，处理期间
 * 不能再次提交（需求 §7 重复操作）。
 */

/** 金额校验（与后端 INVALID_USAGE_PARAMS 口径一致的前端预检） */
function validateAmount(raw: string, plan: PlanDetail): string | undefined {
	const trimmed = raw.trim();
	if (trimmed === "") return "请填写使用金额";
	const amount = Number(trimmed);
	if (!Number.isFinite(amount) || amount <= 0)
		return "使用金额必须是大于 0 的数字";
	if (amount >= 100_000_000_000)
		return "使用金额必须小于单笔上限 100,000,000,000";
	const decimals = trimmed.includes(".")
		? (trimmed.split(".")[1]?.length ?? 0)
		: 0;
	if (plan.targetCurrency === "JPY" || plan.targetCurrency === "KRW") {
		if (decimals > 0) return "该币种（如日元/韩元）为整数币种，不能带小数位";
	} else if (decimals > 2) {
		return "使用金额最多支持 2 位小数";
	}
	if (amount > Number(plan.remainingAllocation)) {
		// 与后端 409 INSUFFICIENT_PLAN_ALLOCATION 文案口径一致（预检为体验层，后端为权威防线）
		return `剩余分配不足，当前剩余 ${displayAmount(Number(plan.remainingAllocation))} ${plan.targetCurrency}，请先调整分配`;
	}
	return undefined;
}

/** 使用日期校验：不晚于今天（UTC+8 口径，与录入买入一致） */
function validateUsedAt(ymd: string): string | undefined {
	if (ymd === "") return "请选择使用日期";
	if (ymd > utc8TodayYmd()) return "使用日期不能晚于今天";
	return undefined;
}

/** 展示用金额（去尾零） */
function displayAmount(value: number): string {
	return Number.isInteger(value)
		? String(value)
		: String(Number(value.toFixed(4)));
}

export interface UsageRecordDialogProps {
	/** 当前计划详情（预填剩余分配 / 还需使用等摘要数据源） */
	plan: PlanDetail;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** 记账成功（返回新记录与提交后资金面快照，页面刷新数据并关闭） */
	onSuccess: (result: {
		usage: { id: string; amount: string };
		plan: { fundStatus: "PREPARING" | "READY" | "USED_UP" };
	}) => void;
}

export function UsageRecordDialog({
	plan,
	open,
	onOpenChange,
	onSuccess,
}: UsageRecordDialogProps) {
	const queryClient = useQueryClient();
	const [amount, setAmount] = useState("");
	const [usedAt, setUsedAt] = useState(utc8TodayYmd());
	const [remark, setRemark] = useState("");
	const [amountError, setAmountError] = useState<string | undefined>();
	const [dateError, setDateError] = useState<string | undefined>();
	const [conflictHint, setConflictHint] = useState<string | undefined>();

	// 变化摘要（需求 §6.1：确认前就地展示本次将产生的变化；填写过程不扣减）
	const amountNumber = Number(amount);
	const summary =
		Number.isFinite(amountNumber) && amountNumber > 0
			? {
					balance: amountNumber,
					remaining: Math.max(
						Number(plan.remainingAllocation) - amountNumber,
						0,
					),
					stillNeeded: Math.max(Number(plan.stillNeeded) - amountNumber, 0),
				}
			: null;

	const isIntegerCurrency =
		plan.targetCurrency === "JPY" || plan.targetCurrency === "KRW";

	const mutation = useMutation({
		mutationFn: () =>
			usagesApi.create(plan.id, {
				amount: amount.trim(),
				usedAt: new Date(`${usedAt}T00:00:00.000Z`).toISOString(),
				...(remark.trim() ? { remark: remark.trim() } : {}),
			}),
		onSuccess: (data) => {
			toast.success("使用记录已保存");
			// 缓存失效（UI-P0③ 真根因修复）：录使用改变 账户余额/首页持仓/成本报告
			// /计划详情，不失效则成本摘要卡保持「尚未使用」与使用记录同屏矛盾。
			// 前缀失效幂等，与调用方页面级刷新（plans/[id] refreshAfterUsage）重复无妨。
			void queryClient.invalidateQueries({ queryKey: ["reports"] }); // 成本摘要卡 + 报告中心（["reports","plan",id] / ["reports","plans",…]）
			void queryClient.invalidateQueries({ queryKey: ["accounts"] }); // 账户余额全系（list/detail/ledger）
			void queryClient.invalidateQueries({
				queryKey: HOME_PORTFOLIO_QUERY_KEY,
			}); // 首页持仓汇总
			void queryClient.invalidateQueries({ queryKey: HOME_STATE_QUERY_KEY }); // 首页状态汇总（含余额）
			void queryClient.invalidateQueries({ queryKey: ["plans"] }); // 计划详情 + 列表（剩余分配/已用）
			void queryClient.invalidateQueries({ queryKey: ["usages"] }); // 使用记录列表
			resetForm();
			onOpenChange(false);
			onSuccess(data);
		},
		onError: (error: unknown) => {
			if (error instanceof ApiError) {
				if (error.code === "INSUFFICIENT_PLAN_ALLOCATION") {
					const remaining = (error.body as { remainingAllocation?: string })
						?.remainingAllocation;
					setConflictHint(
						remaining
							? `剩余分配不足，当前剩余 ${displayAmount(Number(remaining))} ${plan.targetCurrency}，请先调整分配`
							: "剩余分配不足，请先调整分配",
					);
					return;
				}
				setConflictHint(undefined);
				toast.error(error.message || "记录使用失败，请稍后重试");
				return;
			}
			toast.error("记录使用失败，请稍后重试");
		},
	});

	function resetForm() {
		setAmount("");
		setUsedAt(utc8TodayYmd());
		setRemark("");
		setAmountError(undefined);
		setDateError(undefined);
		setConflictHint(undefined);
	}

	function handleSubmit() {
		const aError = validateAmount(amount, plan);
		const dError = validateUsedAt(usedAt);
		setAmountError(aError);
		setDateError(dError);
		setConflictHint(undefined);
		if (aError || dError) return;
		mutation.mutate();
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) resetForm();
				onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>记录使用</DialogTitle>
					<DialogDescription>
						把这笔外币的实际支出记到「{plan.name ?? "未命名计划"}
						」名下，系统将按先进先出自动算出本笔使用成本。
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="usage-amount">
							使用金额（{plan.targetCurrency}）
						</Label>
						<Input
							id="usage-amount"
							inputMode="decimal"
							step={isIntegerCurrency ? "1" : "0.01"}
							value={amount}
							onChange={(event) => {
								setAmount(event.target.value);
								setAmountError(undefined);
								setConflictHint(undefined);
							}}
							placeholder={isIntegerCurrency ? "如 4000" : "如 4000.00"}
							aria-invalid={amountError !== undefined}
						/>
						{amountError ? (
							<p className="text-xs text-red-600" role="alert">
								{amountError}
							</p>
						) : (
							<p className="text-xs text-muted-foreground">
								不能超过计划剩余分配{" "}
								{displayAmount(Number(plan.remainingAllocation))}{" "}
								{plan.targetCurrency}
							</p>
						)}
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="usage-used-at">使用日期</Label>
						<Input
							id="usage-used-at"
							type="date"
							max={utc8TodayYmd()}
							value={usedAt}
							onChange={(event) => {
								setUsedAt(event.target.value);
								setDateError(undefined);
							}}
							aria-invalid={dateError !== undefined}
						/>
						{dateError ? (
							<p className="text-xs text-red-600" role="alert">
								{dateError}
							</p>
						) : (
							<p className="text-xs text-muted-foreground">
								可补录过去的真实日期，不能晚于今天
							</p>
						)}
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="usage-remark">备注（可不填）</Label>
						<Input
							id="usage-remark"
							value={remark}
							onChange={(event) => setRemark(event.target.value)}
							placeholder="如 9 月学费"
							maxLength={200}
						/>
					</div>

					{summary ? (
						<div className="rounded-xl bg-cream-100 px-4 py-3 text-xs text-foreground">
							<p className="font-medium">确认后将产生以下变化：</p>
							<ul className="mt-1.5 space-y-1 text-muted-foreground">
								<li>
									账户余额减少 {displayAmount(summary.balance)}{" "}
									{plan.targetCurrency}
								</li>
								<li>
									计划剩余分配变为 {displayAmount(summary.remaining)}{" "}
									{plan.targetCurrency}
								</li>
								<li>
									还需使用变为 {displayAmount(summary.stillNeeded)}{" "}
									{plan.targetCurrency}
								</li>
							</ul>
						</div>
					) : null}

					{conflictHint ? (
						<p
							className="rounded-xl bg-red-50 px-4 py-3 text-xs text-red-600"
							role="alert"
						>
							{conflictHint}
						</p>
					) : null}
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						className="bg-white"
						disabled={mutation.isPending}
						onClick={() => {
							resetForm();
							onOpenChange(false);
						}}
					>
						取消
					</Button>
					<Button
						className="bg-mint-700 text-white hover:bg-mint-700/90"
						disabled={mutation.isPending}
						onClick={handleSubmit}
					>
						{mutation.isPending ? "记录中…" : "确认记录"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
