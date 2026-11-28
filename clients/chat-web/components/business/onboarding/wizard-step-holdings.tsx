"use client";

import { useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import {
	assertAmountLimit,
	AmountLimitExceededError,
	getCurrency,
} from "@fxplanner-new/money";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { CURRENCY_OPTIONS } from "@/lib/api/currencies";
import { useHoldingsReview } from "@/lib/hooks/use-holdings-review";
import type { InitialHoldingItem } from "@/lib/api/contract";

/**
 * 建账向导第二步 / 初始持仓补录（规格模块 2/3 共用）
 *
 * mode="init"：先二选一——「没有，直接开始」（跳过提交）或「有，填写」进入填写态；
 * mode="backfill"：直接进入填写态（无跳过）。
 *
 * 填写态：动态行列表（初始 1 行，最多 14 行 = 15 币种减本位币），每行币种 + 金额
 * （金额字符串，前端用 money 包 assertAmountLimit + 小数位校验即时校验）。
 * 核对区取价/成本计算内聚在 use-holdings-review hook：按「1 外币 = X 本位币」
 * 口径取价（sellRate ?? rate，rate-reference-card 先例），成本按【本位币精度】
 * 舍入一次，与后端入账（onboarding.service）一致；金额变化复用窗口缓存报价
 * 本地重算，仅首次/币种集合变化强制回源（refresh=true）。取价失败（请求级或
 * 项级 error）显示失败提示，绝不用 0 或手填价顶替。
 *
 * 改本位币重核（需求场景 3）：hook 输入含 baseCurrency，改币后核对区清空并
 * 按新本位币重新取价，已填金额保留；同时本组件联动清空与新本位币冲突的行币种
 * （该币种已不属于可选清单，保留会导致「下拉空白但核对区照算」的矛盾态）。
 *
 * 空金额行（N3）：已选币种但金额留空的行给行内提示并阻断提交，不再静默丢弃。
 */

/** 单用户初始持仓行数上限（15 币种 - 1 本位币，与后端校验一致） */
const MAX_HOLDING_ROWS = 14;

/** 金额格式（纯数字，至多一个小数点；具体小数位按币种校验） */
const AMOUNT_BASE_PATTERN = /^\d+(\.\d+)?$/;

/** 单行持仓输入（导出：向导页提升状态时复用同形） */
export interface HoldingRow {
	currencyCode: string;
	amount: string;
}

export interface WizardStepHoldingsProps {
	/** 本位币（核对区取价 base；排除在本位币选项外） */
	baseCurrency: string;
	/** 提交：init 跳过时为空数组，填写态为「币种已选且金额合法」的行 */
	onSubmit: (holdings: InitialHoldingItem[]) => void;
	/** 提交请求进行中（父页面 mutation pending） */
	submitting: boolean;
	/** init = 建账向导第二步；backfill = 建账后补录（直接填写态、无跳过与返回） */
	mode: "init" | "backfill";
	/** 返回上一步（init 模式提供：回建账向导第一步） */
	onBack?: () => void;
	/** 受控视图状态（init 向导跨步保持填写状态：回第一步改币再进第二步时金额保留，
	 * 需求场景 3；不传 = 组件内部 state，补录模式缺省即可） */
	view?: "choice" | "fill";
	/** 视图状态变化回调（与 view 配套使用） */
	onViewChange?: (view: "choice" | "fill") => void;
	/** 受控持仓行（与 view 配套；不传 = 组件内部 state） */
	rows?: HoldingRow[];
	/** 持仓行变化回调（与 rows 配套使用） */
	onRowsChange?: (rows: HoldingRow[]) => void;
}

/** 金额行内校验：空串 = 未填（不标错，提交时阻断）；非法返回错误文案 */
function validateAmount(code: string, amount: string): string | null {
	if (amount.trim() === "") return null;
	if (!AMOUNT_BASE_PATTERN.test(amount)) return "金额格式不正确";
	const decimalPlaces = getCurrency(code)?.decimalPlaces ?? 2;
	if (decimalPlaces === 0 && amount.includes(".")) {
		return "该币种金额须为整数";
	}
	if (decimalPlaces === 2 && !/^\d+(\.\d{1,2})?$/.test(amount)) {
		return "最多 2 位小数";
	}
	try {
		assertAmountLimit(amount);
	} catch (error) {
		if (error instanceof AmountLimitExceededError) return "金额超出单笔上限";
		return "金额必须大于 0";
	}
	return null;
}

/** 报价来源展示文案移至 use-holdings-review（随取价状态机内聚） */

export function WizardStepHoldings({
	baseCurrency,
	onSubmit,
	submitting,
	mode,
	onBack,
	view: propsView,
	onViewChange,
	rows: propsRows,
	onRowsChange,
}: WizardStepHoldingsProps) {
	// backfill 默认直接进入填写态；init 先二选一。
	// view/rows 支持受控（向导页提升状态）：跨步 unmount/remount 后金额不丢（需求场景 3）
	const [internalView, setInternalView] = useState<"choice" | "fill">(
		mode === "backfill" ? "fill" : "choice",
	);
	const view = propsView ?? internalView;
	const setView = (next: "choice" | "fill") => {
		setInternalView(next);
		onViewChange?.(next);
	};
	const [internalRows, setInternalRows] = useState<HoldingRow[]>([
		{ currencyCode: "", amount: "" },
	]);
	const rawRows = propsRows ?? internalRows;
	// 改本位币派生防护（UI-P1）：与新本位币冲突的行（币种 = 本位币）不再属于可选清单，
	// 渲染与提交视图统一视为未选币种（金额保留），受控模式另在事件回调同步清空。
	const rows = useMemo(
		() =>
			rawRows.map((row) =>
				row.currencyCode === baseCurrency ? { ...row, currencyCode: "" } : row,
			),
		[rawRows, baseCurrency],
	);
	const setRows = (
		next: HoldingRow[] | ((prev: HoldingRow[]) => HoldingRow[]),
	) => {
		const sanitize = (list: HoldingRow[]) =>
			list.map((row) =>
				row.currencyCode === baseCurrency ? { ...row, currencyCode: "" } : row,
			);
		if (propsRows !== undefined) {
			onRowsChange?.(
				typeof next === "function"
					? (next as (prev: HoldingRow[]) => HoldingRow[])(rows)
					: next,
			);
		} else {
			setInternalRows((prev) => {
				const sanitizedPrev = sanitize(prev);
				return typeof next === "function"
					? (next as (prev: HoldingRow[]) => HoldingRow[])(sanitizedPrev)
					: next;
			});
		}
	};

	/** 有效行：币种已选、金额已填且合法（参与取价与提交；空金额行仅提示不取价） */
	const validRows = useMemo(
		() =>
			rows.filter(
				(row) =>
					row.currencyCode !== "" &&
					row.amount.trim() !== "" &&
					validateAmount(row.currencyCode, row.amount) === null,
			),
		[rows],
	);

	// 核对区取价状态机（含 N1 本位币精度、N2 refresh 决策、防抖与竞态丢弃）；
	// 输入引用必须 memo 稳定（hook effect 依赖 rows 引用，内联 map 会无限重跑）
	const reviewInput = useMemo(
		() =>
			validRows.map((row) => ({
				currencyCode: row.currencyCode,
				amount: row.amount,
			})),
		[validRows],
	);
	const review = useHoldingsReview(baseCurrency, reviewInput);

	/** 存在「已选币种但金额非法」的行（阻断填写态提交） */
	const hasInvalidRow = rows.some((row) => {
		if (row.currencyCode === "") return false;
		return validateAmount(row.currencyCode, row.amount) !== null;
	});

	/** 存在「已选币种但金额留空」的行（N3：行内提示并阻断提交，不再静默丢弃） */
	const hasEmptyAmountRow = rows.some(
		(row) => row.currencyCode !== "" && row.amount.trim() === "",
	);

	/** 填写态可提交：有效行非空、无非法/空金额行、核对区对当前输入已成功且无舍 0 拦截 */
	const canSubmitFill =
		!submitting &&
		validRows.length > 0 &&
		!hasInvalidRow &&
		!hasEmptyAmountRow &&
		review.status === "success" &&
		review.rows.every((row) => row.costError === undefined);

	const setRow = (index: number, patch: Partial<HoldingRow>) => {
		setRows((prev) =>
			prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
		);
	};

	const addRow = () => {
		setRows((prev) =>
			prev.length >= MAX_HOLDING_ROWS
				? prev
				: [...prev, { currencyCode: "", amount: "" }],
		);
	};

	const removeRow = (index: number) => {
		setRows((prev) =>
			prev.length <= 1 ? prev : prev.filter((_, i) => i !== index),
		);
	};

	/** 某行币种可选清单：非本位币，且排除其他行已选币种（本行自身已选保留） */
	const currencyOptionsFor = (index: number) => {
		const taken = new Set(
			rows
				.filter((_, i) => i !== index)
				.map((row) => row.currencyCode)
				.filter(Boolean),
		);
		return CURRENCY_OPTIONS.filter(
			(currency) => currency.code !== baseCurrency && !taken.has(currency.code),
		);
	};

	const submitFill = () => {
		onSubmit(
			validRows.map((row) => ({
				currencyCode: row.currencyCode,
				amount: row.amount,
			})),
		);
	};

	const backButton = mode === "init" && onBack && (
		<Button
			type="button"
			variant="outline"
			data-testid="wizard-back"
			className="bg-white"
			disabled={submitting}
			onClick={onBack}
		>
			返回上一步
		</Button>
	);

	return (
		<div className="space-y-5">
			{mode === "init" && (
				<h2 className="text-base font-bold text-foreground">
					是否现在持有外币？
				</h2>
			)}

			{view === "choice" ? (
				<>
					{/* 二选一：跳过或填写（init 模式专属） */}
					<div className="grid gap-3 sm:grid-cols-2">
						<button
							type="button"
							data-testid="holdings-skip"
							disabled={submitting}
							onClick={() => onSubmit([])}
							className="rounded-2xl border border-border bg-white p-5 text-left transition-colors hover:border-ink-300 disabled:cursor-not-allowed disabled:opacity-50"
						>
							<p className="text-sm font-semibold text-foreground">
								没有，直接开始
							</p>
							<p className="mt-1 text-xs text-muted-foreground">
								之后可从首页补录初始持仓
							</p>
						</button>
						<button
							type="button"
							data-testid="holdings-fill"
							disabled={submitting}
							onClick={() => setView("fill")}
							className="rounded-2xl border border-border bg-white p-5 text-left transition-colors hover:border-ink-300 disabled:cursor-not-allowed disabled:opacity-50"
						>
							<p className="text-sm font-semibold text-foreground">有，填写</p>
							<p className="mt-1 text-xs text-muted-foreground">
								填写现在持有的外币金额并核对初始成本
							</p>
						</button>
					</div>
					<div className="flex gap-3">
						<Button
							type="button"
							data-testid="holdings-submit"
							className="flex-1 bg-commit text-white hover:bg-commit-hover"
							disabled={submitting}
							onClick={() => onSubmit([])}
						>
							直接开始
						</Button>
						{backButton}
					</div>
				</>
			) : (
				<>
					{/* 填写态：动态行列表 */}
					<div className="space-y-3">
						{rows.map((row, index) => {
							// N3：已选币种但金额留空的行给行内提示，不再静默丢弃
							const amountError =
								row.currencyCode === ""
									? null
									: row.amount.trim() === ""
										? "请填写持有金额，或删除该行"
										: validateAmount(row.currencyCode, row.amount);
							return (
								<div
									key={index}
									className="flex flex-col gap-2 rounded-xl border border-border bg-white p-4 sm:flex-row sm:items-start"
								>
									<div className="sm:w-56">
										<label
											htmlFor={`holding-currency-${index}`}
											className="mb-1 block text-xs font-medium text-muted-foreground"
										>
											币种
										</label>
										<Select
											value={row.currencyCode}
											onValueChange={(next) =>
												setRow(index, { currencyCode: next })
											}
										>
											<SelectTrigger
												id={`holding-currency-${index}`}
												data-testid={`holding-currency-${index}`}
												className="w-full"
												aria-label={`第 ${index + 1} 行币种`}
											>
												<SelectValue placeholder="选择币种" />
											</SelectTrigger>
											<SelectContent>
												{currencyOptionsFor(index).map((currency) => (
													<SelectItem key={currency.code} value={currency.code}>
														{currency.code} · {currency.nameZh}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									<div className="flex-1">
										<label
											htmlFor={`holding-amount-${index}`}
											className="mb-1 block text-xs font-medium text-muted-foreground"
										>
											持有金额
										</label>
										<Input
											id={`holding-amount-${index}`}
											data-testid={`holding-amount-${index}`}
											inputMode="decimal"
											value={row.amount}
											onChange={(event) =>
												setRow(index, {
													amount: event.target.value.replace(/[^\d.]/g, ""),
												})
											}
											placeholder={
												getCurrency(row.currencyCode)?.decimalPlaces === 0
													? "整数金额"
													: "最多 2 位小数"
											}
										/>
										{amountError && (
											<p className="mt-1 text-xs text-destructive">
												{amountError}
											</p>
										)}
									</div>
									{rows.length > 1 && (
										<button
											type="button"
											aria-label={`删除第 ${index + 1} 行`}
											className="mt-6 self-start rounded-md p-1.5 text-ink-500 transition-colors hover:bg-muted hover:text-foreground"
											onClick={() => removeRow(index)}
										>
											<Trash2 className="size-4" aria-hidden="true" />
										</button>
									)}
								</div>
							);
						})}
						<Button
							type="button"
							variant="outline"
							className="bg-white"
							disabled={rows.length >= MAX_HOLDING_ROWS}
							onClick={addRow}
						>
							<Plus className="size-4" aria-hidden="true" />
							再填一种币种
						</Button>
					</div>

					{/* 核对区：按当前有效报价折算初始成本（失败绝不用 0 或手填价） */}
					<section
						data-testid="holding-review"
						className="rounded-2xl border border-border bg-white p-5"
					>
						<h3 className="text-sm font-bold text-foreground">核对初始持仓</h3>
						<p className="mt-1 text-xs text-muted-foreground">
							按当前有效报价折算初始成本，确认后一起入账。
						</p>

						{review.status === "loading" && (
							<p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2 className="size-4 animate-spin" aria-hidden="true" />
								正在获取报价…
							</p>
						)}
						{review.status === "error" && (
							<p
								className="mt-4 rounded-lg border border-caution bg-caution px-3 py-2 text-sm text-caution"
								role="alert"
							>
								汇率获取失败，请稍后重试
							</p>
						)}
						{review.status === "idle" && (
							<p className="mt-4 text-sm text-muted-foreground">
								填写币种与金额后显示报价与预计初始成本。
							</p>
						)}
						{review.status === "success" && (
							<ul className="mt-4 space-y-3">
								{review.rows.map((row) => (
									<li
										key={row.target}
										data-testid={`review-row-${row.target}`}
										className="rounded-xl border border-border px-4 py-3"
									>
										<div className="flex flex-wrap items-baseline justify-between gap-2">
											<p className="text-base font-semibold text-foreground">
												1 {row.target} = {row.rateDisplay} {baseCurrency}
											</p>
											<p className="text-sm text-foreground tabular-nums">
												持有 {row.amount} {row.target}
											</p>
										</div>
										<p className="mt-1 text-xs text-muted-foreground">
											来源 {row.source} · 报价时间 {row.observedDate}
										</p>
										<p className="mt-1 text-sm font-medium text-foreground">
											{row.costDisplay !== null
												? `预计初始成本 ${row.costDisplay} ${baseCurrency}`
												: (row.costError ?? "成本计算失败，请稍后重试")}
										</p>
									</li>
								))}
							</ul>
						)}
					</section>

					<div className="flex gap-3">
						<Button
							type="button"
							data-testid="holdings-submit"
							className="flex-1 bg-commit text-white hover:bg-commit-hover"
							disabled={!canSubmitFill}
							onClick={submitFill}
						>
							{submitting ? "提交中..." : "确认入账"}
						</Button>
						{backButton}
					</div>
				</>
			)}
		</div>
	);
}
