"use client";

import type { CorrectionTargetType } from "@/lib/api/contract";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { CURRENCIES } from "@fxplanner-new/money";
import type { FeeMode } from "@/lib/hooks/use-correction-form";
import type {
	CorrectionFormErrors,
	CorrectionFormValues,
} from "@/lib/hooks/use-correction-form";

/**
 * 更正表单段（corrections 技术方案 §6「correction-form」）
 *
 * 按 targetType 渲染可改字段（白名单语义：未填 = 沿用现值）+ 原因（必填）。
 * 手续费三态选择：不修改 / 补录金额 / 改回「未知」（null 语义，≠ 0，doc 05/09）。
 * 纯展示+回调组件：校验与状态在 use-correction-form（前端只测 hooks 约定）。
 */

export interface CorrectionFormProps {
	targetType: CorrectionTargetType;
	/** 原内容（表单 placeholder 与「沿用现值」提示） */
	original: Record<string, unknown>;
	form: CorrectionFormValues;
	errors: CorrectionFormErrors;
	onFieldChange: (field: keyof CorrectionFormValues, value: string) => void;
	onFeeModeChange: (mode: FeeMode) => void;
}

export function CorrectionForm({
	targetType,
	original,
	form,
	errors,
	onFieldChange,
	onFeeModeChange,
}: CorrectionFormProps) {
	return (
		<section className="space-y-5 rounded-2xl border border-border bg-white p-6">
			<h2 className="text-base font-bold text-foreground">修改内容</h2>
			<p className="-mt-3 text-xs text-muted-foreground">
				留空的字段表示不修改；提交前请先「查看影响」。
			</p>

			{targetType === "TRANSACTION" && (
				<>
					<CurrencyField
						label="买入币种"
						hint={`现值：${String(original.currencyCode ?? "—")}；更改将触发两个币种的成本重算`}
						value={form.currencyCode}
						error={errors.currencyCode}
						onChange={(value) => onFieldChange("currencyCode", value)}
					/>
					<AmountField
						label="本金金额"
						hint={`现值：${String(original.principalAmount ?? "—")}`}
						value={form.principalAmount}
						error={errors.principalAmount}
						onChange={(value) => onFieldChange("principalAmount", value)}
					/>
					<AmountField
						label="到账数量"
						hint={`现值：${String(original.quantity ?? "—")}`}
						value={form.quantity}
						error={errors.quantity}
						onChange={(value) => onFieldChange("quantity", value)}
					/>
					<FeeField
						original={original}
						form={form}
						error={errors.feeAmount}
						onFeeModeChange={onFeeModeChange}
						onFieldChange={onFieldChange}
					/>
					<TextField
						label="交易日期"
						type="date"
						hint={`现值：${displayDate(original.transactedAt)}`}
						value={form.transactedAt}
						error={errors.transactedAt}
						onChange={(value) => onFieldChange("transactedAt", value)}
					/>
				</>
			)}

			{targetType === "INITIAL_HOLDING" && (
				<>
					<AmountField
						label="初始金额"
						hint={`现值：${String(original.amount ?? "—")}（可改为 0）`}
						value={form.amount}
						error={errors.amount}
						onChange={(value) => onFieldChange("amount", value)}
					/>
					<CurrencyField
						label="币种"
						hint={`现值：${String(original.currencyCode ?? "—")}；更改需要原确认时点的同源报价，通常不可得`}
						value={form.currencyCode}
						error={errors.currencyCode}
						onChange={(value) => onFieldChange("currencyCode", value)}
					/>
				</>
			)}

			{targetType === "USAGE" && (
				<>
					<AmountField
						label="使用金额"
						hint={`现值：${String(original.amount ?? "—")}`}
						value={form.amount}
						error={errors.amount}
						onChange={(value) => onFieldChange("amount", value)}
					/>
					<TextField
						label="使用日期"
						type="date"
						hint={`现值：${displayDate(original.usedAt)}`}
						value={form.usedAt}
						error={errors.usedAt}
						onChange={(value) => onFieldChange("usedAt", value)}
					/>
				</>
			)}

			<div className="space-y-1.5">
				<Label htmlFor="correction-reason">
					修改原因 <span className="text-destructive">*</span>
				</Label>
				<Textarea
					id="correction-reason"
					value={form.reason}
					onChange={(event) => onFieldChange("reason", event.target.value)}
					placeholder="请说明更正缘由（必填；失败尝试也会随原因一起留痕）"
					rows={3}
					aria-invalid={errors.reason ? true : undefined}
				/>
				{errors.reason ? (
					<p className="text-xs text-destructive" role="alert">
						{errors.reason}
					</p>
				) : null}
			</div>
		</section>
	);
}

function CurrencyField(props: {
	label: string;
	hint: string;
	value: string;
	error?: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="space-y-1.5">
			<Label htmlFor={`correction-${props.label}`}>{props.label}</Label>
			<NativeSelect
				id={`correction-${props.label}`}
				value={props.value}
				onChange={(event) => props.onChange(event.target.value)}
				aria-invalid={props.error ? true : undefined}
			>
				<NativeSelectOption value="">沿用现值（不修改）</NativeSelectOption>
				{CURRENCIES.map((currency) => (
					<NativeSelectOption key={currency.code} value={currency.code}>
						{currency.code} · {currency.nameZh}
					</NativeSelectOption>
				))}
			</NativeSelect>
			<p className="text-xs text-muted-foreground">{props.hint}</p>
			{props.error ? (
				<p className="text-xs text-destructive" role="alert">
					{props.error}
				</p>
			) : null}
		</div>
	);
}

function AmountField(props: {
	label: string;
	hint: string;
	value: string;
	error?: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="space-y-1.5">
			<Label htmlFor={`correction-${props.label}`}>{props.label}</Label>
			<Input
				id={`correction-${props.label}`}
				inputMode="decimal"
				value={props.value}
				onChange={(event) => props.onChange(event.target.value)}
				placeholder="留空表示不修改"
				aria-invalid={props.error ? true : undefined}
			/>
			<p className="text-xs text-muted-foreground">{props.hint}</p>
			{props.error ? (
				<p className="text-xs text-destructive" role="alert">
					{props.error}
				</p>
			) : null}
		</div>
	);
}

function TextField(props: {
	label: string;
	type: "date" | "text";
	hint: string;
	value: string;
	error?: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="space-y-1.5">
			<Label htmlFor={`correction-${props.label}`}>{props.label}</Label>
			<Input
				id={`correction-${props.label}`}
				type={props.type}
				value={props.value}
				onChange={(event) => props.onChange(event.target.value)}
				aria-invalid={props.error ? true : undefined}
			/>
			<p className="text-xs text-muted-foreground">{props.hint}</p>
			{props.error ? (
				<p className="text-xs text-destructive" role="alert">
					{props.error}
				</p>
			) : null}
		</div>
	);
}

/** 手续费三态（keep / value / unknown）：未知 ≠ 0，绝不把「未知」当 0 处理 */
function FeeField(props: {
	original: Record<string, unknown>;
	form: CorrectionFormValues;
	error?: string;
	onFeeModeChange: (mode: FeeMode) => void;
	onFieldChange: (field: keyof CorrectionFormValues, value: string) => void;
}) {
	const feeKnown = props.original.feeKnown === true;
	const currentFee = props.original.feeAmount;
	return (
		<div className="space-y-1.5">
			<Label htmlFor="correction-fee-mode">手续费</Label>
			<NativeSelect
				id="correction-fee-mode"
				value={props.form.feeMode}
				onChange={(event) =>
					props.onFeeModeChange(event.target.value as FeeMode)
				}
			>
				<NativeSelectOption value="keep">沿用现值（不修改）</NativeSelectOption>
				<NativeSelectOption value="value">明确手续费金额</NativeSelectOption>
				<NativeSelectOption value="unknown">改回「未知」</NativeSelectOption>
			</NativeSelect>
			<p className="text-xs text-muted-foreground">
				现值：
				{feeKnown ? `${String(currentFee)}（已明确）` : "未知（未明确，≠ 0）"}
			</p>
			{props.form.feeMode === "value" ? (
				<>
					<Input
						id="correction-fee-amount"
						inputMode="decimal"
						value={props.form.feeAmount}
						onChange={(event) =>
							props.onFieldChange("feeAmount", event.target.value)
						}
						placeholder="如 20.00；填 0 表示确定没有手续费"
						aria-invalid={props.error ? true : undefined}
					/>
					{props.error ? (
						<p className="text-xs text-destructive" role="alert">
							{props.error}
						</p>
					) : null}
				</>
			) : null}
		</div>
	);
}

/** ISO 时间 → yyyy-MM-dd（对齐 transaction-detail 先例） */
function displayDate(value: unknown): string {
	const raw = typeof value === "string" ? value : "";
	return raw === "" ? "—" : raw.slice(0, 10);
}
