"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import {
	PlanCreateForm,
	SchedulePreviewCard,
} from "@/components/business/plan";
import { Button } from "@/components/ui/button";
import type { CreatePlanReq } from "@/lib/api/contract";
import { onboardingApi } from "@/lib/api/onboarding";
import { plansApi } from "@/lib/api/plans";
import { toPacePreference, usePlanForm } from "@/lib/hooks/use-plan-form";
import { useSchedulePreview } from "@/lib/hooks/use-schedule-preview";

/**
 * 创建换汇计划页（单页三段瘦壳，changes/plan-creation/技术方案.md §6）
 *
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。
 * 装配：usePlanForm（表单状态与校验）+ useSchedulePreview（防抖预览）+
 * react-query 取 onboarding 偏好回填默认节奏 + createMutation 提交。
 */
const ONBOARDING_STATUS_QUERY_KEY = ["onboarding", "status"] as const;

export default function NewPlanPage() {
	const router = useRouter();
	const form = usePlanForm();

	const preview = useSchedulePreview({
		targetCurrency: form.values.targetCurrency,
		targetAmount: form.values.targetAmount,
		expectUseDate: form.values.expectUseDate,
		prepLeadDays: form.values.prepLeadDays,
		pacePreference: form.values.pacePreference,
	});

	// 预览返回的分配上限 → 表单实时预检「计入已有外币」
	useEffect(() => {
		form.setCaps(preview.caps);
	}, [preview.caps, form.setCaps]);

	// 首次设置的节奏偏好回填为默认节奏；用户已手动改过（touched）则不覆盖
	const statusQuery = useQuery({
		queryKey: ONBOARDING_STATUS_QUERY_KEY,
		queryFn: () => onboardingApi.getStatus(),
		retry: false, // 401 由 apiClient 统一跳登录，其余失败静默用默认节奏
	});
	// 首次设置的节奏偏好回填为默认节奏；用户已手动改过（touched）则不覆盖。
	// FE-03：settings prep 域（cautious 系）与 plan pace 域（conservative 系）
	// 词集不同，回填须经 toPacePreference 同义桥映射，直接赋值会静默失效。
	const prepPreference = statusQuery.data?.settings?.prepPreference;
	const backfillPace = toPacePreference(prepPreference);
	useEffect(() => {
		if (!backfillPace) return;
		if (form.touched.pacePreference) return;
		if (form.values.pacePreference === backfillPace) return;
		form.setField("pacePreference", backfillPace, { touch: false });
	}, [
		backfillPace,
		form.touched.pacePreference,
		form.values.pacePreference,
		form.setField,
	]);

	const createMutation = useMutation({
		mutationFn: (req: CreatePlanReq) => plansApi.create(req),
		onSuccess: () => {
			toast.success("计划创建成功");
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
		});
	}

	return (
		<div className="mx-auto max-w-3xl px-8 py-6">
			<header className="mb-6">
				<h1 className="text-xl font-bold text-foreground">创建换汇计划</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					设定目标与准备节奏，系统将自动生成分批排期预览。
				</p>
			</header>

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
					className="bg-mint-700 text-white hover:bg-mint-700/90"
					disabled={!canCreate}
					onClick={handleCreate}
				>
					{createMutation.isPending ? "创建中…" : "创建计划"}
				</Button>
				<Button variant="outline" className="bg-white" disabled>
					保存草稿
				</Button>
				<span className="text-xs text-muted-foreground">草稿功能开发中</span>
			</div>
		</div>
	);
}
