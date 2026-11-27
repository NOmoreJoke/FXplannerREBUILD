"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo } from "react";
import { toast } from "sonner";
import {
	PlanCreateForm,
	SchedulePreviewCard,
} from "@/components/business/plan";
import { Button } from "@/components/ui/button";
import { PageLoading, PermissionNotice } from "@/components/base";
import type { CreatePlanReq } from "@/lib/api/contract";
import { onboardingApi } from "@/lib/api/onboarding";
import { plansApi } from "@/lib/api/plans";
import {
	invalidateAfterLedgerMutation,
	queryKeys,
	withOrgScope,
} from "@/lib/api/query-keys";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";
import { useOrganizationCapabilities } from "@/lib/hooks/use-organization-capabilities";
import {
	parsePlanDraftQuery,
	toPacePreference,
	usePlanForm,
} from "@/lib/hooks/use-plan-form";
import { useSchedulePreview } from "@/lib/hooks/use-schedule-preview";

/**
 * 创建换汇计划页（单页三段瘦壳，changes/plan-creation/技术方案.md §6 + ToB R2 P8）
 *
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。
 * 装配：usePlanForm（表单状态与校验，支持 AI 计划草稿参数预填）+
 * useSchedulePreview（按当前组织最新余额防抖实时重算）+
 * react-query 取 onboarding 偏好回填默认节奏 + createMutation 提交（透传 agentRunId 写入审计）。
 *
 * 能力门控（Goal #3B W28）：创建计划需 plan.create（Viewer 无）。无权时整页换成
 * 只读提示与返回入口，表单根本不挂载——否则防抖预览会替一个注定 403 的用户
 * 持续请求排期接口。组织详情未返回前先加载，不闪现表单再收回。
 */
export default function NewPlanPage() {
	const { can, isLoading } = useOrganizationCapabilities();

	if (isLoading) {
		return <PageLoading />;
	}

	if (!can("plan.create")) {
		return (
			<PermissionNotice
				testId="plan-create-no-permission"
				title="当前角色无权创建换汇计划"
				description="当前角色无权创建换汇计划。如需新建目标，请联系组织所有者、管理员或财务。"
				action={
					<Button variant="outline" className="bg-white" asChild>
						<Link href="/plans">返回计划列表</Link>
					</Button>
				}
			/>
		);
	}

	return (
		<Suspense fallback={<PageLoading />}>
			<NewPlanFormWithDraft />
		</Suspense>
	);
}

function NewPlanFormWithDraft() {
	const searchParams = useSearchParams();
	const activeOrgId = useActiveOrgId();
	const draftContext = useMemo(
		() => parsePlanDraftQuery(searchParams, activeOrgId),
		[searchParams, activeOrgId],
	);
	// 草稿参数或无草稿模式切换时按 key 重新挂载受控初始态（无需额外 useEffect 同步）
	const formKey = draftContext.fromDraft
		? `draft:${draftContext.agentRunId ?? "none"}:${draftContext.initialValues.targetCurrency ?? ""}:${draftContext.initialValues.targetAmount ?? ""}:${draftContext.initialValues.expectUseDate ?? ""}`
		: "manual";

	return (
		<NewPlanForm
			key={formKey}
			fromDraft={draftContext.fromDraft}
			agentRunId={draftContext.agentRunId}
			initialValues={draftContext.initialValues}
		/>
	);
}

function NewPlanForm({
	fromDraft,
	agentRunId,
	initialValues,
}: {
	fromDraft: boolean;
	agentRunId: string | null;
	initialValues: ReturnType<typeof parsePlanDraftQuery>["initialValues"];
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const form = usePlanForm(fromDraft ? initialValues : undefined);
	const { setCaps, setField } = form;

	const preview = useSchedulePreview({
		targetCurrency: form.values.targetCurrency,
		targetAmount: form.values.targetAmount,
		expectUseDate: form.values.expectUseDate,
		prepLeadDays: form.values.prepLeadDays,
		pacePreference: form.values.pacePreference,
		allocatedAmount: form.values.allocatedAmount,
	});

	// 预览返回的分配上限 → 表单实时预检「计入已有外币」
	useEffect(() => {
		setCaps(preview.caps);
	}, [preview.caps, setCaps]);

	// 首次设置的节奏偏好回填为默认节奏；用户已手动改过（或草稿预填 touched）则不覆盖
	const orgId = useActiveOrgId();
	const statusQuery = useQuery({
		queryKey: withOrgScope(orgId, queryKeys.onboarding.status()),
		queryFn: () => onboardingApi.getStatus(),
		enabled: orgId !== null,
		retry: false, // 401 由 apiClient 统一跳登录，其余失败静默用默认节奏
	});
	// FE-03：settings prep 域（cautious 系）与 plan pace 域（conservative 系）
	// 词集不同，回填须经 toPacePreference 同义桥映射，直接赋值会静默失效。
	const prepPreference = statusQuery.data?.settings?.prepPreference;
	const backfillPace = toPacePreference(prepPreference);
	useEffect(() => {
		if (!backfillPace) return;
		if (form.touched.pacePreference) return;
		if (form.values.pacePreference === backfillPace) return;
		setField("pacePreference", backfillPace, { touch: false });
	}, [
		backfillPace,
		form.touched.pacePreference,
		form.values.pacePreference,
		setField,
	]);

	const createMutation = useMutation({
		mutationFn: (req: CreatePlanReq) => plansApi.create(req),
		onSuccess: () => {
			toast.success("计划创建成功");
			// 创建可携带分配：账户、计划、报告、首页与提醒缓存一并失效，避免回看旧缓存
			invalidateAfterLedgerMutation(queryClient);
			router.replace("/home"); // hasPlans=true 自动切换正常首页
		},
		onError: (error: unknown) => {
			toast.error(
				error instanceof Error ? error.message : "计划创建失败，请稍后重试",
			);
		},
	});

	const canCreate =
		form.isValid &&
		preview.installments.length > 0 &&
		!preview.isPreviewing &&
		!preview.previewError &&
		!createMutation.isPending;

	const allocExceededLatestCap =
		fromDraft &&
		preview.caps !== null &&
		Number(form.values.allocatedAmount || "0") >
			Number(preview.caps.maxAllocatable);

	function handleCreate() {
		const values = form.values;
		// 金额全程 string 传递；日期转 ISO UTC；空值按约定归一
		createMutation.mutate({
			name: values.name.trim() || undefined,
			targetCurrency: values.targetCurrency,
			targetAmount: values.targetAmount.trim(),
			expectUseDate: new Date(
				`${values.expectUseDate}T00:00:00.000Z`,
			).toISOString(),
			prepLeadDays: Number(values.prepLeadDays.trim()),
			pacePreference: values.pacePreference,
			allocatedAmount: values.allocatedAmount.trim() || "0",
			...(agentRunId ? { agentRunId } : {}),
		});
	}

	return (
		<div className="mx-auto max-w-3xl px-8 py-6">
			<header className="mb-6">
				<h1 className="text-xl font-bold text-foreground">
					{fromDraft ? "确认并创建换汇计划" : "创建换汇计划"}
				</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					设定目标与准备节奏，系统将自动生成分批排期预览。
				</p>
			</header>

			{fromDraft && (
				<div
					data-testid="plan-draft-confirm-banner"
					className="mb-6 rounded-2xl border border-mint-300 bg-mint-50 px-4 py-3 text-sm text-foreground"
				>
					<div className="font-semibold text-mint-700">
						正在复核 AI 助手生成的计划草稿（尚未入账）
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						系统已按当前组织最新余额和已有分配实时重算排期与可分配上限，确认无误后再点击「创建计划」。
					</p>
					{allocExceededLatestCap && preview.caps && (() => {
						const latestMaxAllocatable = preview.caps.maxAllocatable;
						return (
							<div
								data-testid="plan-draft-caps-warning"
								role="alert"
								className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
							>
								<span>
									组织余额已变化：草稿原计入已有外币高于当前可分配上限（
									{latestMaxAllocatable}），无法按原草稿直接保存。
								</span>
								<Button
									type="button"
									size="sm"
									variant="outline"
									className="h-7 bg-white text-xs text-foreground"
									data-testid="plan-draft-apply-max-alloc"
									onClick={() =>
										form.setField("allocatedAmount", latestMaxAllocatable)
									}
								>
									按最新上限填入
								</Button>
							</div>
						);
					})()}
				</div>
			)}

			<PlanCreateForm
				values={form.values}
				setField={form.setField}
				getError={form.getError}
				caps={preview.caps}
				baseCurrency={statusQuery.data?.settings?.baseCurrency ?? null}
			/>

			<div className="mt-6">
				<SchedulePreviewCard
					installments={preview.installments}
					latestPrepDate={preview.latestPrepDate}
					isPreviewing={preview.isPreviewing}
					previewError={preview.previewError}
					targetCurrency={form.values.targetCurrency}
				/>
			</div>

			<div className="mt-6 flex items-center gap-3">
				<Button
					data-testid="plan-create-submit"
					className="bg-mint-700 text-white hover:bg-mint-700/90"
					disabled={!canCreate}
					onClick={handleCreate}
				>
					{createMutation.isPending ? "创建中…" : "创建计划"}
				</Button>
				{fromDraft ? (
					<Button
						type="button"
						variant="outline"
						className="bg-white"
						data-testid="plan-draft-cancel"
						onClick={() => router.push("/chat")}
					>
						取消草稿
					</Button>
				) : (
					<>
						<Button variant="outline" className="bg-white" disabled>
							保存草稿
						</Button>
						<span className="text-xs text-muted-foreground">草稿功能开发中</span>
					</>
				)}
			</div>
		</div>
	);
}
