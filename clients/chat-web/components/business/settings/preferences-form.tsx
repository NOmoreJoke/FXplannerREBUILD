"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PermissionHint } from "@/components/base/permission-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ApiError, DATA_REQUESTS_PAGE_PATH } from "@/lib/api/client";
import type {
	PersonalSettingsView,
	SettingsView,
	UpdatePersonalSettingsReq,
} from "@/lib/api/contract";
import { getCurrencyName } from "@/lib/api/currencies";
import { invalidateBusinessKey, queryKeys } from "@/lib/api/query-keys";
import {
	settingsApi,
	type UpdateOrganizationSettingsReq,
} from "@/lib/api/settings";
import {
	ORGANIZATION_ROLE_LABEL,
	useOrganizationCapabilities,
	type OrganizationRole,
} from "@/lib/hooks/use-organization-capabilities";
import {
	useOrganizationSettings,
	type OrganizationSettingsResult,
} from "@/lib/hooks/use-organization-settings";

/**
 * 设置页两个偏好分区（技术方案 §10.2「拆分个人偏好与组织设置，不让用户误改其他组织」；
 * Goal #3B W28）：
 *
 * 1. 个人展示偏好（GET/PATCH /settings/personal）：邮箱只读、地区、语言。
 *    任何已登录用户任何时候可改——不依赖组织、建账状态或组织角色；
 * 2. 组织账本设置（GET/PATCH /settings）：本位币只读、准备偏好、准备提醒。
 *    仅当前组织已建账时加载；无 settings.update 权限（Finance / Operator / Viewer）
 *    只读并说明原因，不发必然 403 的请求。
 *
 * 两个分区各自暂存草稿，页面级只有一个「保存」：有改动的那一侧才发请求，个人字段与
 * 组织字段分别走各自的端点，绝不混送。
 *
 * 表单不写 useEffect：草稿是受控初始态，编辑器以「服务端当前值」为 key——服务端值变化
 * （保存后回读）即重新挂载并从新值初始化，天然对齐且不会把暂存的草稿用一次 effect
 * 覆盖掉。本文件此前靠一个存量 effect 同步表单，现已移除；它仍列在
 * eslint.config.mjs 的存量白名单里，白名单条目可随后续清理一并删除。
 */

/** 组织账本设置查询的业务键（保存成功后失效回读；查询本身见 useOrganizationSettings） */
const SETTINGS_QUERY_KEY = queryKeys.settings.detail();

type PersonalRegion = NonNullable<UpdatePersonalSettingsReq["region"]>;
type PersonalLocale = NonNullable<UpdatePersonalSettingsReq["locale"]>;

const REGION_OPTIONS = [
	{ value: "CN", label: "中国大陆" },
	{ value: "HK", label: "香港" },
] as const satisfies readonly { value: PersonalRegion; label: string }[];

const LOCALE_OPTIONS = [
	{ value: "zh-CN", label: "简体中文" },
	{ value: "en", label: "英文" },
] as const satisfies readonly { value: PersonalLocale; label: string }[];

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
	value: SettingsView["prepPreference"];
	label: string;
}[];

/**
 * 视图里的地区/语言在后端是宽类型字符串，写入 DTO 才是枚举：按选项收窄，
 * 不认识的值返回 ""（显示占位符，不替用户猜一个值，也不会被误提交）。
 */
function toOption<T extends string>(
	value: string,
	options: readonly { readonly value: T }[],
): T | "" {
	return options.find((option) => option.value === value)?.value ?? "";
}

/** 偏好数据层：个人偏好 + 组织设置 + 权限，数据齐备后交给受控编辑器 */
export function PreferencesForm() {
	const caps = useOrganizationCapabilities();
	const personalQuery = useQuery<PersonalSettingsView>({
		queryKey: queryKeys.settings.personal(),
		queryFn: settingsApi.getPersonalSettings,
		retry: false, // 401 由 apiClient 统一处理；其余失败交给下方错误态
	});
	const organizationSettings = useOrganizationSettings();

	// 组织详情未返回：建账态与权限未知，整块先加载（不闪现只读态或可写表单）
	if (caps.isLoading) {
		return <PanelLoading text="正在加载设置…" />;
	}

	if (!personalQuery.data) {
		if (personalQuery.isPending) {
			return <PanelLoading text="正在加载设置…" />;
		}
		return (
			<PanelError
				message={
					personalQuery.error instanceof ApiError
						? personalQuery.error.message
						: "无法获取当前设置，请检查网络后重试。"
				}
				onRetry={() => void personalQuery.refetch()}
			/>
		);
	}

	return (
		<SettingsEditor
			key={editorKey(personalQuery.data, organizationSettings.data)}
			personal={personalQuery.data}
			organizationSettings={organizationSettings}
			canEditOrganization={caps.can("settings.update")}
			organizationName={caps.organizationName}
			role={caps.role}
		/>
	);
}

/**
 * 编辑器的重新挂载依据：仅取「会被编辑」的服务端值。用值而不是 dataUpdatedAt，
 * 是为了让窗口聚焦等触发的、内容未变的回读不冲掉用户尚未保存的草稿。
 */
function editorKey(
	personal: PersonalSettingsView,
	organization: SettingsView | undefined,
): string {
	return JSON.stringify([
		personal.region,
		personal.locale,
		organization?.prepPreference ?? null,
		organization?.reminderEnabled ?? null,
	]);
}

interface SettingsEditorProps {
	personal: PersonalSettingsView;
	organizationSettings: OrganizationSettingsResult;
	/** 后端 capabilities 的 settings.update：false 时组织分区只读（建账同样需要它） */
	canEditOrganization: boolean;
	organizationName: string | null;
	role: OrganizationRole | null;
}

function SettingsEditor({
	personal,
	organizationSettings,
	canEditOrganization,
	organizationName,
	role,
}: SettingsEditorProps) {
	const queryClient = useQueryClient();
	const organization = organizationSettings.data;

	const [region, setRegion] = useState<PersonalRegion | "">(
		toOption(personal.region, REGION_OPTIONS),
	);
	const [locale, setLocale] = useState<PersonalLocale | "">(
		toOption(personal.locale, LOCALE_OPTIONS),
	);
	const [prepPreference, setPrepPreference] = useState<
		SettingsView["prepPreference"] | null
	>(organization?.prepPreference ?? null);
	const [reminderEnabled, setReminderEnabled] = useState<boolean | null>(
		organization?.reminderEnabled ?? null,
	);

	const personalPatch: UpdatePersonalSettingsReq = {
		...(region !== "" && region !== personal.region ? { region } : {}),
		...(locale !== "" && locale !== personal.locale ? { locale } : {}),
	};
	// 只读角色的组织草稿不参与：控件本就禁用，这里再拦一道，保证不会发出 403 请求
	const organizationPatch: UpdateOrganizationSettingsReq =
		canEditOrganization && organization
			? {
					...(prepPreference !== null &&
					prepPreference !== organization.prepPreference
						? { prepPreference }
						: {}),
					...(reminderEnabled !== null &&
					reminderEnabled !== organization.reminderEnabled
						? { reminderEnabled }
						: {}),
				}
			: {};
	const hasPersonalChanges = Object.keys(personalPatch).length > 0;
	const hasOrganizationChanges = Object.keys(organizationPatch).length > 0;
	const dirty = hasPersonalChanges || hasOrganizationChanges;

	const saveMutation = useMutation({
		mutationFn: async () => {
			// 先个人后组织：个人偏好不依赖组织与角色，任何登录用户都应成功；
			// 组织字段若被拒（权限变更 / 组织锁），已保存的个人偏好照常生效
			if (hasPersonalChanges) {
				await settingsApi.updatePersonalSettings(personalPatch);
			}
			if (hasOrganizationChanges) {
				await settingsApi.updateSettings(organizationPatch);
			}
		},
		onSuccess: () => {
			toast.success("设置已保存");
		},
		onError: (error) => {
			toast.error(
				error instanceof ApiError && error.message
					? error.message
					: "保存失败，请稍后重试",
			);
		},
		onSettled: () => {
			// 成功回读、失败也对齐服务端（部分成功时未保存的那侧回到服务端值）
			void queryClient.invalidateQueries({
				queryKey: queryKeys.settings.personal(),
			});
			invalidateBusinessKey(queryClient, SETTINGS_QUERY_KEY);
		},
	});

	return (
		<div className="space-y-6">
			{/* 1. 个人展示偏好：邮箱只读、地区/语言可改 */}
			<section
				data-testid="personal-preferences-section"
				className="rounded-2xl border border-border bg-white p-6"
			>
				<h2 className="text-base font-bold text-foreground">
					个人展示偏好
				</h2>
				<p className="mt-1 text-xs text-muted-foreground">
					属于你本人的账号偏好，在所有组织下生效，可随时修改。
				</p>
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
							value={personal.email ?? ""}
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
							value={region}
							onValueChange={(next) =>
								setRegion(toOption(next, REGION_OPTIONS))
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
							value={locale}
							onValueChange={(next) =>
								setLocale(toOption(next, LOCALE_OPTIONS))
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
				</div>
			</section>

			{/* 2. 组织账本设置：随当前组织变化；仅已建账时加载 */}
			<section
				data-testid="organization-settings-section"
				className="rounded-2xl border border-border bg-white p-6"
			>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div>
						<h2 className="text-base font-bold text-foreground">
							组织账本设置
						</h2>
						<p className="mt-1 text-xs text-muted-foreground">
							只对当前组织生效，不影响你所在的其他组织。
						</p>
					</div>
					{organizationName && (
						<span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-ink-600">
						{organizationName}
						{role ? ` · ${ORGANIZATION_ROLE_LABEL[role]}` : ""}
						</span>
					)}
				</div>

				<OrganizationSettingsBody
					settings={organizationSettings}
					canEdit={canEditOrganization}
					prepPreference={prepPreference}
					reminderEnabled={reminderEnabled}
					onPrepPreferenceChange={(next) => {
						const option = toOption(next, PREP_PREFERENCE_OPTIONS);
						if (option !== "") setPrepPreference(option);
					}}
					onReminderEnabledChange={setReminderEnabled}
				/>
			</section>

			<div className="flex justify-end">
				<Button
					type="button"
					data-testid="settings-save"
					disabled={!dirty || saveMutation.isPending}
					onClick={() => saveMutation.mutate()}
					className="bg-ink-900 text-white hover:bg-ink-900/90"
				>
					{saveMutation.isPending ? "保存中…" : "保存"}
				</Button>
			</div>
		</div>
	);
}

interface OrganizationSettingsBodyProps {
	settings: OrganizationSettingsResult;
	/** 后端 capabilities 的 settings.update：false 时只读，且不提供「去建账」入口 */
	canEdit: boolean;
	prepPreference: SettingsView["prepPreference"] | null;
	reminderEnabled: boolean | null;
	onPrepPreferenceChange: (next: string) => void;
	onReminderEnabledChange: (next: boolean) => void;
}

/**
 * 组织账本设置区的状态机（覆盖 loading / empty / error / readonly）：
 * 未建账 / 组织删除锁 → 说明原因（查询本身已被闸门静默，不会打 409 / 403）；
 * 加载中 → 行内加载；失败 → 行内错误 + 重试；就绪 → 表单（无权则只读）。
 */
function OrganizationSettingsBody({
	settings,
	canEdit,
	prepPreference,
	reminderEnabled,
	onPrepPreferenceChange,
	onReminderEnabledChange,
}: OrganizationSettingsBodyProps) {
	if (settings.gate === "not-onboarded") {
		return (
			<div
				data-testid="settings-not-onboarded"
				className="mt-5 rounded-xl border border-dashed border-border px-6 py-8 text-center"
			>
				<h3 className="text-sm font-bold text-foreground">
					当前组织尚未完成建账
				</h3>
				<p className="mt-2 text-sm text-muted-foreground">
					完成建账确定本位币后，即可设置准备偏好与准备提醒。
				</p>
				{canEdit && (
					<Button
						asChild
						className="mt-4 bg-ink-900 text-white hover:bg-ink-900/90"
					>
						<Link href="/onboarding">去建账</Link>
					</Button>
				)}
			</div>
		);
	}

	if (settings.gate === "deletion-locked") {
		return (
			<div
				data-testid="settings-data-locked"
				className="mt-5 rounded-xl border border-dashed border-border px-6 py-8 text-center"
			>
				<h3 className="text-sm font-bold text-foreground">
					组织正在删除处理中
				</h3>
				<p className="mt-2 text-sm text-muted-foreground">
					删除期内账本设置不可修改；到期前可以撤回。
				</p>
				<Button variant="outline" size="sm" className="mt-4 bg-white" asChild>
					<Link href={DATA_REQUESTS_PAGE_PATH}>查看处理进度</Link>
				</Button>
			</div>
		);
	}

	if (settings.isLoading || settings.gate === "loading") {
		return (
			<p
				data-testid="settings-organization-loading"
				className="mt-5 flex items-center gap-2 text-sm text-muted-foreground"
			>
				<Loader2 className="size-4 animate-spin" aria-hidden="true" />
				正在加载组织账本设置…
			</p>
		);
	}

	if (!settings.data) {
		return (
			<div
				data-testid="settings-organization-error"
				className="mt-5 flex flex-col items-center rounded-xl border border-border px-6 py-8 text-center"
			>
				<CircleAlert className="size-6 text-ink-300" aria-hidden="true" />
				<p className="mt-3 text-sm text-muted-foreground">
					{settings.error instanceof Error
						? settings.error.message
						: "组织账本设置加载失败，请稍后重试。"}
				</p>
				<Button
					variant="outline"
					size="sm"
					className="mt-4 bg-white"
					onClick={settings.refetch}
				>
					重试
				</Button>
			</div>
		);
	}

	const baseCurrency = settings.data.baseCurrency;

	return (
		<div className="mt-5 space-y-5">
			{!canEdit && (
				<PermissionHint testId="settings-organization-readonly" className="mb-5">
					当前角色只能查看组织账本设置；修改准备偏好与准备提醒需要组织所有者或管理员。
				</PermissionHint>
			)}

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
						value={`${baseCurrency} ${getCurrencyName(baseCurrency) ?? ""}`.trim()}
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

			<div>
				<label
					htmlFor="settings-prep-preference"
					className="mb-2 block text-sm font-medium text-foreground"
				>
					准备偏好
				</label>
				<Select
					value={prepPreference ?? ""}
					disabled={!canEdit}
					onValueChange={onPrepPreferenceChange}
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

			<div className="space-y-2">
				<label
					htmlFor="settings-reminder"
					className="flex items-center gap-2.5 text-sm text-foreground"
				>
					<input
						id="settings-reminder"
						type="checkbox"
						data-testid="reminder-toggle"
						checked={reminderEnabled === true}
						disabled={!canEdit}
						onChange={(event) => onReminderEnabledChange(event.target.checked)}
						className="size-4 cursor-pointer accent-ink-900 disabled:cursor-not-allowed"
					/>
					准备提醒
				</label>
				{/* 开关说明（reminders §8：需求 §7.3 补充文案，逻辑不改） */}
				<p className="ml-6 text-xs text-muted-foreground">
					关闭后不再弹出准备提醒，仍可在计划页查看日期与进度。
				</p>
			</div>
		</div>
	);
}

function PanelLoading({ text }: { text: string }) {
	return (
		<div className="flex items-center gap-2 rounded-2xl border border-border bg-white p-6 text-sm text-muted-foreground">
			<Loader2 className="size-4 animate-spin" aria-hidden="true" />
			{text}
		</div>
	);
}

function PanelError({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	return (
		<div className="flex flex-col items-center rounded-2xl border border-border bg-white px-8 py-12 text-center">
			<CircleAlert className="size-8 text-ink-300" />
			<h2 className="mt-3 text-base font-bold text-foreground">
				设置加载失败
			</h2>
			<p className="mt-2 text-sm text-muted-foreground">{message}</p>
			<Button
				className="mt-5 bg-ink-900 text-white hover:bg-ink-900/90"
				onClick={onRetry}
			>
				重试
			</Button>
		</div>
	);
}
