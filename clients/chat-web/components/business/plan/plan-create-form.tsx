"use client";

import { CURRENCY_OPTIONS } from "@/lib/api/currencies";
import type { PacePreference, PlanCaps } from "@/lib/api/contract";
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
	localTodayYmd,
	type PlanFormField,
	type PlanFormValues,
} from "@/lib/hooks/use-plan-form";

/**
 * 创建计划表单段（目标信息 + 资金准备节奏，changes/plan-creation/技术方案.md §6①②）
 *
 * 纯受控组件：值与错误均由 usePlanForm 提供；禁用提示一律用可见灰字/旁注，
 * 不用原生 title（用户反馈 title 不可靠）。
 */

/** 节奏三档展示文案（值集见 use-plan-form 的 PACE_PREFERENCES） */
const PACE_CHOICES: ReadonlyArray<{
	value: PacePreference;
	title: string;
	hint: string;
}> = [
	{
		value: "conservative",
		title: "安心 · 首批 50%",
		hint: "前期多准备：按 50% / 30% / 20% 分批安排",
	},
	{
		value: "balanced",
		title: "均衡 · 三等分",
		hint: "三批平均分配，节奏平稳省心",
	},
	{
		value: "aggressive",
		title: "主动 · 首批 20%",
		hint: "后期多准备：按 20% / 30% / 50% 分批安排（仅调整资金分布，不预测汇率）",
	},
];

export interface PlanCreateFormProps {
	values: PlanFormValues;
	setField: <K extends PlanFormField>(
		field: K,
		value: PlanFormValues[K],
		options?: { touch?: boolean },
	) => void;
	getError: (field: PlanFormField) => string | undefined;
	/** 排期预览返回的分配上限（未就绪时为 null） */
	caps: PlanCaps | null;
	/** 本位币（未完成首次设置时为 null，展示 "—"） */
	baseCurrency: string | null;
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
				<p className="text-xs text-danger" role="alert">
					{error}
				</p>
			) : hint ? (
				<p className="text-xs text-muted-foreground">{hint}</p>
			) : null}
		</div>
	);
}

export function PlanCreateForm({
	values,
	setField,
	getError,
	caps,
	baseCurrency,
}: PlanCreateFormProps) {
	return (
		<div className="space-y-6">
			{/* ① 目标信息 */}
			<section className="rounded-2xl border border-border bg-white p-6">
				<h2 className="text-base font-bold text-foreground">目标信息</h2>
				<div className="mt-5 grid gap-5 md:grid-cols-2">
					<FieldShell
						label="目标名称"
						htmlFor="plan-name"
						hint="选填，便于日后识别"
					>
						<Input
							id="plan-name"
							value={values.name}
							onChange={(event) => setField("name", event.target.value)}
							placeholder="如：加拿大秋季学费"
							maxLength={50}
						/>
					</FieldShell>

					<FieldShell label="目标币种" error={getError("targetCurrency")}>
						<Select
							value={values.targetCurrency}
							onValueChange={(next) => setField("targetCurrency", next)}
						>
							<SelectTrigger
								className="w-full"
								aria-label="目标币种"
								aria-invalid={getError("targetCurrency") !== undefined}
							>
								<SelectValue placeholder="选择目标币种" />
							</SelectTrigger>
							<SelectContent>
								{CURRENCY_OPTIONS.map((currency) => (
									<SelectItem
										key={currency.code}
										value={currency.code}
										disabled={currency.code === baseCurrency}
									>
										{currency.code} · {currency.nameZh}
										{currency.code === baseCurrency ? "（本位币）" : ""}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</FieldShell>

					<FieldShell
						label="净到账金额"
						htmlFor="plan-target-amount"
						error={getError("targetAmount")}
						hint="最终需要准备的外币总额"
					>
						<Input
							id="plan-target-amount"
							inputMode="decimal"
							value={values.targetAmount}
							onChange={(event) => setField("targetAmount", event.target.value)}
							placeholder="如 50000"
						/>
					</FieldShell>

					<FieldShell
						label="用途日期"
						htmlFor="plan-expect-use-date"
						error={getError("expectUseDate")}
						hint="计划用上这笔外币的日期，须晚于今天"
					>
						<Input
							id="plan-expect-use-date"
							type="date"
							min={localTodayYmd()}
							value={values.expectUseDate}
							onChange={(event) =>
								setField("expectUseDate", event.target.value)
							}
						/>
					</FieldShell>

					<FieldShell
						label="提前准备天数"
						htmlFor="plan-prep-lead-days"
						error={getError("prepLeadDays")}
						hint="在用途日期前提前备齐的天数（1~30 天）"
					>
						<Input
							id="plan-prep-lead-days"
							type="number"
							min={1}
							max={30}
							step={1}
							value={values.prepLeadDays}
							onChange={(event) => setField("prepLeadDays", event.target.value)}
						/>
					</FieldShell>

					<FieldShell
						label="计入已有外币"
						htmlFor="plan-allocated-amount"
						error={getError("allocatedAmount")}
						hint={`可分配上限 ${caps ? caps.maxAllocatable : "待排期预览生成"}`}
					>
						<Input
							id="plan-allocated-amount"
							inputMode="decimal"
							value={values.allocatedAmount}
							onChange={(event) =>
								setField("allocatedAmount", event.target.value)
							}
							placeholder="0"
						/>
					</FieldShell>

					<FieldShell
						label="本位币"
						htmlFor="plan-base-currency"
						hint="完成首次设置后锁定"
					>
						<Input
							id="plan-base-currency"
							value={baseCurrency ?? "—"}
							readOnly
							className="bg-muted/50 text-muted-foreground"
						/>
					</FieldShell>
				</div>
			</section>

			{/* ② 资金准备节奏 */}
			<section className="rounded-2xl border border-border bg-white p-6">
				<h2 className="text-base font-bold text-foreground">资金准备节奏</h2>
				<p className="mt-1 text-xs text-muted-foreground">
					决定 3 批资金的前后分布，创建后仍可调整。
				</p>
				<RadioGroup
					value={values.pacePreference}
					onValueChange={(next) =>
						setField("pacePreference", next as PacePreference)
					}
					className="mt-4 gap-3"
				>
					{PACE_CHOICES.map((choice) => (
						<Label
							key={choice.value}
							className="flex cursor-pointer items-start gap-3 rounded-lg p-1 font-normal hover:bg-muted/40"
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
			</section>
		</div>
	);
}
