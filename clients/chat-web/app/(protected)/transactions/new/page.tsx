"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { Suspense, useEffect } from "react";
import { toast } from "sonner";
import {
	RateReferenceCard,
	TransactionForm,
} from "@/components/business/transaction";
import { Button } from "@/components/ui/button";
import type { CreateTransactionReq } from "@/lib/api/contract";
import { onboardingApi } from "@/lib/api/onboarding";
import { invalidateAfterLedgerMutation, queryKeys } from "@/lib/api/query-keys";
import { transactionsApi } from "@/lib/api/transactions";
import { useHomeState } from "@/lib/hooks/use-home-state";
import {
	findCurrency,
	toCreateRequest,
	useTransactionForm,
} from "@/lib/hooks/use-transaction-form";

/**
 * 快速录入页（买入交易，changes/transaction-entry/技术方案.md §6）
 *
 * 单页瘦壳：汇率参考卡 + 表单三段（交易信息 / 两种填法互算 / 手续费与关联计划）。
 * 装配：useTransactionForm（表单状态、本地互算、校验）+ react-query 取
 * onboarding 本位币与计划摘要（关联下拉）+ createMutation 提交。
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。
 *
 * URL 预填（换汇计划详情页「录入买入」入口）：?planId=…&currency=… 自动关联计划
 * 并预填买入币种（默认选好、仍可修改）；参数无效时静默降级为空白表单。
 * useSearchParams 需 Suspense 边界（Next.js App Router 静态渲染要求）。
 */
export default function NewTransactionPage() {
	return (
		<Suspense fallback={null}>
			<NewTransactionPageContent />
		</Suspense>
	);
}

function NewTransactionPageContent() {
	const router = useRouter();
	const queryClient = useQueryClient();
	const searchParams = useSearchParams();

	// URL 预填：planId 直填；币种取 URL currency（非法代码忽略），
	// 未带 currency 时待计划摘要到达后从关联计划反查补填
	const urlPlanId = searchParams.get("planId") ?? "";
	const urlCurrency = searchParams.get("currency") ?? "";
	const initialCurrency = findCurrency(urlCurrency)?.code;
	const form = useTransactionForm(
		undefined,
		urlPlanId
			? {
					planId: urlPlanId,
					...(initialCurrency ? { currencyCode: initialCurrency } : {}),
				}
			: undefined,
	);

	// 本位币（参考汇率的 base；完成首次设置后锁定）
	const statusQuery = useQuery({
		queryKey: queryKeys.onboarding.status(),
		queryFn: () => onboardingApi.getStatus(),
		retry: false, // 401 由 apiClient 统一跳登录，其余失败静默用默认值
	});
	const baseCurrency = statusQuery.data?.settings?.baseCurrency ?? null;

	// 关联计划下拉数据：复用首页状态缓存（只读摘要，staleTime 5 分钟）
	const { state } = useHomeState();
	const plans = state?.plans ?? [];

	// 预填防御：planId 不在计划摘要中（已删除/他人计划）时自动解除关联；
	// URL 只带 planId 未带 currency 时，从计划反查币种补填（只跑一次）
	const planId = form.values.planId;
	useEffect(() => {
		if (planId === "") return;
		const matched = plans.find((plan) => plan.id === planId);
		if (matched) {
			if (form.values.currencyCode === "") {
				form.setField("currencyCode", matched.targetCurrency, { touch: false });
			}
		} else if (plans.length > 0) {
			form.setField("planId", "");
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在计划摘要首次到达时对预填值做一次校正
	}, [plans.length]);

	const createMutation = useMutation({
		mutationFn: (req: CreateTransactionReq) => transactionsApi.create(req),
		onSuccess: (data) => {
			toast.success("买入记录已保存");
			invalidateAfterLedgerMutation(queryClient);
			router.replace(`/transactions/${data.id}`);
		},
		onError: (error: unknown) => {
			// 服务端为权威防线：400/404 文案（自洽/舍 0/计划归属等）直接透出
			toast.error(
				error instanceof Error ? error.message : "保存失败，请稍后重试",
			);
		},
	});

	const canCreate = form.isValid && !createMutation.isPending;

	function handleCreate() {
		// 金额全程 string；请求组装含防御层（按钮已由 isValid 禁用）
		const req = toCreateRequest(form.values);
		if (req === null) {
			toast.error("表单尚未填写完整，请检查标红字段");
			return;
		}
		createMutation.mutate(req);
	}

	return (
		<div className="mx-auto max-w-3xl px-8 py-6">
			<header className="mb-6">
				<h1 className="text-xl font-bold text-foreground">录入买入</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					记录一笔本位币买入外币的账本记录，保存后自动累计到对应外币账户。
				</p>
			</header>

			<div className="mb-6">
				<RateReferenceCard
					baseCurrency={baseCurrency}
					targetCurrency={form.values.currencyCode}
					onApply={(rate) =>
						form.setField("exchangeRate", rate, { touch: false })
					}
					canApply={form.values.fillMode === "byRate"}
				/>
			</div>

			<TransactionForm
				values={form.values}
				setField={form.setField}
				getError={form.getError}
				baseCurrency={baseCurrency}
				plans={plans}
			/>

			<div className="mt-6">
				<Button
					className="bg-mint-700 text-white hover:bg-mint-700/90"
					disabled={!canCreate}
					onClick={handleCreate}
				>
					{createMutation.isPending ? "保存中…" : "保存"}
				</Button>
				<span className="ml-3 text-xs text-muted-foreground">
					保存后将自动建立/累计对应外币账户余额
				</span>
			</div>
		</div>
	);
}
