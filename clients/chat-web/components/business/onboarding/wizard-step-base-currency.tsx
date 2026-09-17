"use client";

import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { CURRENCY_OPTIONS } from "@/lib/api/currencies";

/**
 * 建账向导第一步：确认所在地区、本位币与语言（规格模块 2）
 *
 * 地区选择后本位币随地区预填（HK→HKD、CN→CNY），用户仍可改；
 * 页面明示「本位币完成建账后不可更换」。本组件只承载选择交互，
 * 建账提交由父页面向导页完成。
 */

const REGION_OPTIONS = [
	{ value: "CN", label: "中国大陆" },
	{ value: "HK", label: "香港" },
] as const;

const LOCALE_OPTIONS = [
	{ value: "zh-CN", label: "简体中文" },
	{ value: "en", label: "英文" },
] as const;

/** 地区 → 默认本位币预填映射 */
const REGION_DEFAULT_BASE_CURRENCY: Record<string, string> = {
	HK: "HKD",
	CN: "CNY",
};

export interface WizardStepBaseCurrencyProps {
	/** 所在地区（HK / CN） */
	region: string;
	/** 语言（zh-CN / en） */
	locale: string;
	/** 本位币（15 币种内；完成建账后锁定） */
	baseCurrency: string;
	/** 任一字段变化回调（patch 只含变化字段） */
	onChange: (patch: {
		region?: string;
		locale?: string;
		baseCurrency?: string;
	}) => void;
	/** 点击「下一步」进入第二步 */
	onNext: () => void;
}

export function WizardStepBaseCurrency({
	region,
	locale,
	baseCurrency,
	onChange,
	onNext,
}: WizardStepBaseCurrencyProps) {
	const canProceed = region !== "" && locale !== "" && baseCurrency !== "";

	return (
		<div className="space-y-5">
			<div>
				<label
					htmlFor="onboarding-region"
					className="mb-2 block text-sm font-medium text-foreground"
				>
					所在地区
				</label>
				<Select
					value={region}
					onValueChange={(next) =>
						onChange({
							region: next,
							// 本位币随地区预填（用户仍可手动改）
							baseCurrency: REGION_DEFAULT_BASE_CURRENCY[next] ?? baseCurrency,
						})
					}
				>
					<SelectTrigger
						id="onboarding-region"
						data-testid="region-select"
						className="w-full"
						aria-label="所在地区"
					>
						<SelectValue placeholder="选择所在地区" />
					</SelectTrigger>
					<SelectContent>
						{REGION_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div>
				<label
					htmlFor="onboarding-base-currency"
					className="mb-2 block text-sm font-medium text-foreground"
				>
					本位币
				</label>
				<Select
					value={baseCurrency}
					onValueChange={(next) => onChange({ baseCurrency: next })}
				>
					<SelectTrigger
						id="onboarding-base-currency"
						data-testid="base-currency-select"
						className="w-full"
						aria-label="本位币"
					>
						<SelectValue placeholder="选择本位币" />
					</SelectTrigger>
					<SelectContent>
						{CURRENCY_OPTIONS.map((currency) => (
							<SelectItem key={currency.code} value={currency.code}>
								{currency.code} · {currency.nameZh}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p
					data-testid="base-currency-lock-hint"
					className="mt-2 flex items-center gap-2 rounded-lg bg-mint-50 px-3 py-2 text-sm font-medium text-mint-700"
				>
					<Info className="size-4 shrink-0" aria-hidden="true" />
					本位币完成建账后不可更换
				</p>
			</div>

			<div>
				<label
					htmlFor="onboarding-locale"
					className="mb-2 block text-sm font-medium text-foreground"
				>
					语言
				</label>
				<Select
					value={locale}
					onValueChange={(next) => onChange({ locale: next })}
				>
					<SelectTrigger
						id="onboarding-locale"
						data-testid="locale-select"
						className="w-full"
						aria-label="语言"
					>
						<SelectValue placeholder="选择语言" />
					</SelectTrigger>
					<SelectContent>
						{LOCALE_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<Button
				type="button"
				data-testid="wizard-next"
				disabled={!canProceed}
				onClick={onNext}
				className="w-full bg-mint-700 text-white hover:bg-mint-700/90"
			>
				下一步
			</Button>
		</div>
	);
}
