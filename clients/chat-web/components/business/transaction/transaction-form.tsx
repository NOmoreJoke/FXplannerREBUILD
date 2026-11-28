"use client";

import { CURRENCY_OPTIONS } from "@/lib/api/currencies";
import type { PlanSummary } from "@/lib/api/contract";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	totalCostOf,
	utc8TodayYmd,
	type TransactionFormField,
	type TransactionFormValues,
} from "@/lib/hooks/use-transaction-form";

/**
 * 买入录入表单段（changes/transaction-entry/技术方案.md §5.1①②③④）
 *
 * 纯受控组件：值与错误均由 useTransactionForm 提供；
 * 两种填法（A：本金+汇率 → 到账 / B：本金+到账 → 汇率）的互算在 hook 内
 * 本地完成（money 包纯函数，零请求），非当前填法的值为只读回填展示；
 * 手续费三态（"0" 无 / 留空未知 / 数值）在 ③ 段内明示，费用未知时成本不完整。
 * 禁用提示一律用可见灰字/红字，不用原生 title（用户反馈 title 不可靠）。
 */

/**
 * 「不关联」选项的 sentinel 值：Radix Select.Item 禁止空字符串 value（运行时抛错），
 * 用非空哨兵承载「取消关联」，onValueChange 时映射回表单空串。
 */
const NO_PLAN_SELECT_VALUE = "__none__";

export interface TransactionFormProps {
	values: TransactionFormValues;
	setField: <K extends TransactionFormField>(
		field: K,
		value: TransactionFormValues[K],
		options?: { touch?: boolean },
	) => void;
	getError: (field: TransactionFormField | "form") => string | undefined;
	/** 本位币（未完成首次设置时为 null，展示 "—"） */
	baseCurrency: string | null;
	/** 可关联计划（页面经 GET /home/state 取得；仅标记不触发分配） */
	plans: PlanSummary[];
}

/** 单字段容器：label + 控件 + 错误红字 / 灰字旁注（错误优先） */
function FieldShell({
	label,
	htmlFor,
	error,
	hint,
	children,
}: {
	label: string;
	htmlFor?: string;
	error?: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="space-y-1.5">
			<Label htmlFor={htmlFor}>{label}</Label>
			{children}
			{error ? (
				<p className="text-xs text-red-600" role="alert">
					{error}
				</p>
			) : hint ? (
				<p className="text-xs text-muted-foreground">{hint}</p>
			) : null}
		</div>
	);
}

/** 填法两选项展示文案（值集见 use-transaction-form 的 TransactionFillMode） */
const FILL_MODE_CHOICES: ReadonlyArray<{
	value: TransactionFormValues["fillMode"];
	title: string;
	hint: string;
}> = [
	{
		value: "byRate",
		title: "按汇率算",
		hint: "填本金 + 汇率，自动算出到账数量",
	},
	{
		value: "byReceived",
		title: "按到账算",
		hint: "填本金 + 实际到账数量，自动反算成交汇率",
	},
];

export function TransactionForm({
	values,
	setField,
	getError,
	baseCurrency,
	plans,
}: TransactionFormProps) {
	const isByRate = values.fillMode === "byRate";
	// 币种精度（JPY/KRW 整数），用于到账只读回填与提示文案
	const quantityStep =
		values.currencyCode === "JPY" || values.currencyCode === "KRW"
			? "1"
			: "0.01";
	// 成本预览：费用未知（空串）→ null，UI 明示成本不完整，绝不当 0 计算
	const feeKnown = values.feeAmount.trim() !== "";
	const costPreview = totalCostOf(values.principalAmount, values.feeAmount, 2);
	// 关联计划仅显示与买入币种一致的计划（币种一致性服务端亦校验，前端提前过滤）
	const eligiblePlans = plans.filter(
		(plan) =>
			values.currencyCode !== "" && plan.targetCurrency === values.currencyCode,
	);

	return (
		<div className="space-y-6">
			{/* ① 币种 + 交易日期 */}
			<section className="rounded-2xl border border-border bg-white p-6">
				<h2 className="text-base font-bold text-foreground">交易信息</h2>
				<div className="mt-5 grid gap-5 md:grid-cols-3">
					<FieldShell label="买入币种" error={getError("currencyCode")}>
						<Select
							value={values.currencyCode}
							onValueChange={(next) => {
								setField("currencyCode", next);
								// 币种变更后已选计划可能不再匹配，自动解除关联（仅标记，可重选）
								const currentPlan = plans.find(
									(plan) => plan.id === values.planId,
								);
								if (currentPlan && currentPlan.targetCurrency !== next) {
									setField("planId", "");
								}
							}}
						>
							<SelectTrigger
								className="w-full"
								aria-label="买入币种"
								aria-invalid={getError("currencyCode") !== undefined}
							>
								<SelectValue placeholder="选择买入币种" />
							</SelectTrigger>
							<SelectContent>
								{CURRENCY_OPTIONS.map((currency) => (
									<SelectItem key={currency.code} value={currency.code}>
										{currency.code} · {currency.nameZh}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</FieldShell>

					<FieldShell
						label="交易日期"
						htmlFor="transaction-transacted-at"
						error={getError("transactedAt")}
						hint="可补录历史交易，不能晚于今天"
					>
						<Input
							id="transaction-transacted-at"
							type="date"
							max={utc8TodayYmd()}
							value={values.transactedAt}
							onChange={(event) => setField("transactedAt", event.target.value)}
						/>
					</FieldShell>

					<FieldShell
						label="本位币"
						htmlFor="transaction-base-currency"
						hint="完成首次设置后锁定"
					>
						<Input
							id="transaction-base-currency"
							value={baseCurrency ?? "—"}
							readOnly
							className="bg-muted/50 text-muted-foreground"
						/>
					</FieldShell>
				</div>
			</section>

			{/* ② 两种填法（本金 / 汇率 / 到账互算） */}
			<section className="rounded-2xl border border-border bg-white p-6">
				<h2 className="text-base font-bold text-foreground">买入金额</h2>
				<p className="mt-1 text-xs text-muted-foreground">
					两种填法任选其一，另一值自动算出；保存时三项一起提交核对。
				</p>
				<RadioGroup
					value={values.fillMode}
					onValueChange={(next) =>
						setField("fillMode", next as TransactionFormValues["fillMode"])
					}
					className="mt-4 grid gap-3 md:grid-cols-2"
				>
					{FILL_MODE_CHOICES.map((choice) => (
						<Label
							key={choice.value}
							className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 font-normal hover:bg-muted/40"
						>
							<RadioGroupItem value={choice.value} className="mt-0.5" />
							<span>
								<span className="block text-sm font-medium text-foreground">
									{choice.title}
								</span>
								<span className="mt-0.5 block text-xs font-normal text-muted-foreground">
									{choice.hint}
								</span>
							</span>
						</Label>
					))}
				</RadioGroup>

				<div className="mt-5 grid gap-5 md:grid-cols-3">
					<FieldShell
						label="本金（本位币）"
						htmlFor="transaction-principal"
						error={getError("principalAmount")}
					>
						<Input
							id="transaction-principal"
							inputMode="decimal"
							value={values.principalAmount}
							onChange={(event) =>
								setField("principalAmount", event.target.value)
							}
							placeholder="如 72480"
						/>
					</FieldShell>

					{isByRate ? (
						<FieldShell
							label="成交汇率"
							htmlFor="transaction-exchange-rate"
							error={getError("exchangeRate")}
							hint="1 外币 = X 本位币，最多 8 位小数"
						>
							<Input
								id="transaction-exchange-rate"
								inputMode="decimal"
								value={values.exchangeRate}
								onChange={(event) =>
									setField("exchangeRate", event.target.value)
								}
								placeholder="如 7.248"
							/>
						</FieldShell>
					) : (
						<FieldShell
							label="成交汇率（自动反算）"
							htmlFor="transaction-exchange-rate-derived"
							hint="由本金 ÷ 到账数量反算，最多 8 位小数"
						>
							<Input
								id="transaction-exchange-rate-derived"
								value={values.exchangeRate}
								readOnly
								className="bg-muted/50 text-muted-foreground"
								placeholder="填入本金与到账后自动算出"
							/>
						</FieldShell>
					)}

					{isByRate ? (
						<FieldShell
							label={`预计到账（${values.currencyCode || "外币"}）`}
							htmlFor="transaction-quantity-derived"
							hint="由本金 ÷ 汇率自动算出，保存时一并提交"
							error={getError("quantity")}
						>
							<Input
								id="transaction-quantity-derived"
								value={values.quantity}
								readOnly
								className="bg-muted/50 text-muted-foreground"
								placeholder="填入本金与汇率后自动算出"
							/>
						</FieldShell>
					) : (
						<FieldShell
							label={`实际到账（${values.currencyCode || "外币"}）`}
							htmlFor="transaction-quantity"
							error={getError("quantity")}
							hint={
								values.currencyCode === "JPY" || values.currencyCode === "KRW"
									? "该币种为整数币种，不能带小数位"
									: "最多 2 位小数"
							}
						>
							<Input
								id="transaction-quantity"
								inputMode="decimal"
								step={quantityStep}
								value={values.quantity}
								onChange={(event) => setField("quantity", event.target.value)}
								placeholder="如 10000.00"
							/>
						</FieldShell>
					)}
				</div>

				{getError("form") ? (
					<p
						className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600"
						role="alert"
					>
						{getError("form")}
					</p>
				) : null}
			</section>

			{/* ③ 手续费 + 关联计划 */}
			<section className="rounded-2xl border border-border bg-white p-6">
				<h2 className="text-base font-bold text-foreground">
					手续费与关联计划
				</h2>
				<div className="mt-5 grid gap-5 md:grid-cols-2">
					<FieldShell
						label="手续费（本位币）"
						htmlFor="transaction-fee"
						error={getError("feeAmount")}
						hint='填 "0" 表示无手续费；留空表示费用未知（未知 ≠ 0）'
					>
						<Input
							id="transaction-fee"
							inputMode="decimal"
							value={values.feeAmount}
							onChange={(event) => setField("feeAmount", event.target.value)}
							placeholder="留空 = 未知"
						/>
					</FieldShell>

					<FieldShell
						label="关联计划"
						error={getError("planId")}
						hint={
							values.currencyCode === ""
								? "先选择买入币种，再关联同币种计划"
								: "仅作标记，不会自动分配资金"
						}
					>
						{/* Radix Select.Item 禁止空字符串 value（运行时抛错），
								「不关联」用 sentinel 值承载，映射回表单空串 */}
						<Select
							value={
								values.planId === "" ? NO_PLAN_SELECT_VALUE : values.planId
							}
							onValueChange={(next) =>
								setField("planId", next === NO_PLAN_SELECT_VALUE ? "" : next)
							}
							disabled={values.currencyCode === ""}
						>
							<SelectTrigger className="w-full" aria-label="关联计划">
								<SelectValue placeholder="不关联" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={NO_PLAN_SELECT_VALUE}>不关联</SelectItem>
								{eligiblePlans.length === 0 ? (
									<p className="px-2 py-1.5 text-sm text-muted-foreground">
										暂无同币种计划，可先创建或稍后关联
									</p>
								) : (
									eligiblePlans.map((plan) => (
										<SelectItem key={plan.id} value={plan.id}>
											{plan.targetCurrency} · 剩余 {plan.remainingAmount}{" "}
											{plan.targetCurrency}
										</SelectItem>
									))
								)}
							</SelectContent>
						</Select>
					</FieldShell>
				</div>

				{/* 成本预览：费用未知时明示成本不完整（方案 §4.2，未知 ≠ 0） */}
				{feeKnown ? (
					costPreview !== null && (
						<p className="mt-4 text-sm text-ink-600">
							交易总成本：本金 {values.principalAmount} + 手续费{" "}
							{values.feeAmount} ={" "}
							<span className="font-semibold text-foreground">
								{costPreview} {baseCurrency ?? ""}
							</span>
						</p>
					)
				) : (
					<p className="mt-4 rounded-lg border border-caution bg-caution px-3 py-2 text-sm text-caution">
						手续费未知：交易总成本将不完整（未知 ≠ 0），可在了解费用后补录。
					</p>
				)}
			</section>
		</div>
	);
}
