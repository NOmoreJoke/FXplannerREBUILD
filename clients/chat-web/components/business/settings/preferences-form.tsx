"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api/client";
import type { SettingsView, UpdateSettingsReq } from "@/lib/api/contract";
import { getCurrencyName } from "@/lib/api/currencies";
import { settingsApi } from "@/lib/api/settings";

/**
 * 偏好设置表单（规格模块 4：个人设置 + 偏好两分区，数据逻辑承载组件）
 *
 * 数据自取（GET /settings）：
 * - 未建账（409 ONBOARDING_NOT_COMPLETED）→「尚未完成建账」提示卡；
 * - 加载失败 → 错误态 + 重试；
 * - 表单：地区/语言/准备偏好/准备提醒可改（PATCH /settings），保存成功
 *   toast「设置已保存」并失效 settings 缓存回读；
 * - 邮箱与本位币只读（本位币无更新通道，规格 2.3-1：任何页面无修改入口）。
 */

/** 设置查询 Key（保存成功后失效回读） */
export const SETTINGS_QUERY_KEY = ["settings"] as const;

const REGION_OPTIONS = [
	{ value: "CN", label: "中国大陆" },
	{ value: "HK", label: "香港" },
] as const;

const LOCALE_OPTIONS = [
	{ value: "zh-CN", label: "简体中文" },
	{ value: "en", label: "英文" },
] as const;

/**
 * 准备偏好选项（值集单一来源 = 后端 settings DTO @IsIn/OpenAPI 契约）。
 * satisfies 锁定：后端值集变更 → 此处编译报错强制同步（FE-03 根治，防漂移）；
 * label 为纯前端展示文案，不入契约。
 */
const PREP_PREFERENCE_OPTIONS = [
	{ value: "cautious", label: "安心" },
	{ value: "balanced", label: "均衡" },
	{ value: "proactive", label: "主动" },
] as const satisfies readonly {
	value: NonNullable<UpdateSettingsReq["prepPreference"]>;
	label: string;
}[];

/** 可编辑表单值（与 PATCH 入参同形；枚举字面量取自生成契约，防漂移） */
interface PreferencesFormState {
	region: NonNullable<UpdateSettingsReq["region"]>;
	locale: NonNullable<UpdateSettingsReq["locale"]>;
	prepPreference: SettingsView["prepPreference"];
	reminderEnabled: boolean;
}

export function PreferencesForm() {
	const queryClient = useQueryClient();
	const [form, setForm] = useState<PreferencesFormState | null>(null);

	const query = useQuery({
		queryKey: SETTINGS_QUERY_KEY,
		queryFn: settingsApi.getSettings,
		retry: false, // 401 由 apiClient 统一处理；409/其余失败交给下方分支
	});

	// 服务器数据到达/回读时同步表单（保存成功 invalidate 后自动对齐）。
	// region/locale 后端存值为白名单内字面量（IsIn 校验保证），此处安全收窄。
	useEffect(() => {
		if (!query.data) return;
		setForm({
			region: query.data.region as PreferencesFormState["region"],
			locale: query.data.locale as PreferencesFormState["locale"],
			prepPreference: query.data.prepPreference,
			reminderEnabled: query.data.reminderEnabled,
		});
	}, [query.data]);

	const saveMutation = useMutation({
		mutationFn: settingsApi.updateSettings,
		onSuccess: () => {
			toast.success("设置已保存");
			void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
		},
		onError: (error) => {
			toast.error(
				error instanceof ApiError ? error.message : "保存失败，请稍后重试",
			);
		},
	});

	if (query.isPending) {
		return (
			<div className="flex items-center gap-2 rounded-2xl border border-border bg-white p-6 text-sm text-muted-foreground">
				<Loader2 className="size-4 animate-spin" aria-hidden="true" />
				正在加载设置…
			</div>
		);
	}

	// 未建账：设置读写依赖 UserSettings，提示去完成建账
	if (
		query.error instanceof ApiError &&
		query.error.code === "ONBOARDING_NOT_COMPLETED"
	) {
		return (
			<div
				data-testid="settings-not-onboarded"
				className="rounded-2xl border border-dashed border-border bg-white px-8 py-12 text-center"
			>
				<h2 className="text-base font-bold text-foreground">尚未完成建账</h2>
				<p className="mt-2 text-sm text-muted-foreground">
					完成建账后即可在这里修改地区、语言与偏好设置。
				</p>
			</div>
		);
	}

	if (query.error || !query.data || !form) {
		return (
			<div className="flex flex-col items-center rounded-2xl border border-border bg-white px-8 py-12 text-center">
				<CircleAlert className="size-8 text-cream-300" />
				<h2 className="mt-3 text-base font-bold text-foreground">
					设置加载失败
				</h2>
				<p className="mt-2 text-sm text-muted-foreground">
					{query.error instanceof ApiError
						? query.error.message
						: "无法获取当前设置，请检查网络后重试。"}
				</p>
				<Button
					className="mt-5 bg-mint-700 text-white hover:bg-mint-700/90"
					onClick={() => void query.refetch()}
				>
					重试
				</Button>
			</div>
		);
	}

	const dirty =
		form.region !== query.data.region ||
		form.locale !== query.data.locale ||
		form.prepPreference !== query.data.prepPreference ||
		form.reminderEnabled !== query.data.reminderEnabled;

	const patchForm = (patch: Partial<PreferencesFormState>) =>
		setForm((prev) => (prev === null ? prev : { ...prev, ...patch }));

	return (
		<div className="space-y-6">
			{/* 个人设置：邮箱只读、地区/语言可改、本位币只读（规格模块 4 分区表） */}
			<section className="rounded-2xl border border-border bg-white p-6">
				<h2 className="text-base font-bold text-foreground">个人设置</h2>
				<div className="mt-5 space-y-5">
					<div>
						<label
							htmlFor="settings-email"
							className="mb-2 block text-sm font-medium text-foreground"
						>
							邮箱
						</label>
						<Input
							id="settings-email"
							data-testid="settings-email"
							value={query.data.email ?? ""}
							readOnly
							className="bg-muted/50 text-muted-foreground"
						/>
					</div>

					<div>
						<label
							htmlFor="settings-region"
							className="mb-2 block text-sm font-medium text-foreground"
						>
							地区
						</label>
						<Select
							value={form.region}
							onValueChange={(next) =>
								patchForm({
									region: next as NonNullable<UpdateSettingsReq["region"]>,
								})
							}
						>
							<SelectTrigger
								id="settings-region"
								data-testid="settings-region-select"
								className="w-full"
								aria-label="地区"
							>
								<SelectValue placeholder="选择地区" />
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
							htmlFor="settings-locale"
							className="mb-2 block text-sm font-medium text-foreground"
						>
							语言
						</label>
						<Select
							value={form.locale}
							onValueChange={(next) =>
								patchForm({
									locale: next as NonNullable<UpdateSettingsReq["locale"]>,
								})
							}
						>
							<SelectTrigger
								id="settings-locale"
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

					<div>
						<label
							htmlFor="settings-base-currency"
							className="mb-2 block text-sm font-medium text-foreground"
						>
							本位币
						</label>
						<div className="flex items-center gap-3">
							<Input
								id="settings-base-currency"
								data-testid="settings-base-currency"
								value={`${query.data.baseCurrency} ${getCurrencyName(query.data.baseCurrency) ?? ""}`.trim()}
								readOnly
								className="w-56 bg-muted/50 text-muted-foreground"
							/>
							<span
								data-testid="base-currency-readonly-note"
								className="text-xs text-muted-foreground"
							>
								建账时确定，不可更换
							</span>
						</div>
					</div>
				</div>
			</section>

			{/* 偏好：准备偏好 + 准备提醒（随时可改，无记账后果） */}
			<section className="rounded-2xl border border-border bg-white p-6">
				<h2 className="text-base font-bold text-foreground">偏好</h2>
				<div className="mt-5 space-y-5">
					<div>
						<label
							htmlFor="settings-prep-preference"
							className="mb-2 block text-sm font-medium text-foreground"
						>
							准备偏好
						</label>
						<Select
							value={form.prepPreference}
							onValueChange={(next) =>
								patchForm({
									prepPreference: next as NonNullable<
										UpdateSettingsReq["prepPreference"]
									>,
								})
							}
						>
							<SelectTrigger
								id="settings-prep-preference"
								data-testid="prep-preference-select"
								className="w-full"
								aria-label="准备偏好"
							>
								<SelectValue placeholder="选择准备偏好" />
							</SelectTrigger>
							<SelectContent>
								{PREP_PREFERENCE_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<label
						htmlFor="settings-reminder"
						className="flex items-center gap-2.5 text-sm text-foreground"
					>
						<input
							id="settings-reminder"
							type="checkbox"
							data-testid="reminder-toggle"
							checked={form.reminderEnabled}
							onChange={(event) =>
								patchForm({ reminderEnabled: event.target.checked })
							}
							className="size-4 cursor-pointer accent-mint-700"
						/>
						准备提醒
					</label>
					{/* 开关说明（reminders §8：需求 §7.3 补充文案，逻辑不改） */}
					<p className="ml-6 text-xs text-muted-foreground">
						关闭后不再弹出准备提醒，仍可在计划页查看日期与进度。
					</p>
				</div>

				<div className="mt-6 flex justify-end">
					<Button
						type="button"
						data-testid="settings-save"
						disabled={!dirty || saveMutation.isPending}
						onClick={() =>
							saveMutation.mutate({
								region: form.region,
								locale: form.locale,
								prepPreference: form.prepPreference,
								reminderEnabled: form.reminderEnabled,
							})
						}
						className="bg-mint-700 text-white hover:bg-mint-700/90"
					>
						{saveMutation.isPending ? "保存中…" : "保存"}
					</Button>
				</div>
			</section>
		</div>
	);
}
