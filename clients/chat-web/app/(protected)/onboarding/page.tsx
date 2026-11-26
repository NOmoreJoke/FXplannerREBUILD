"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { toast } from "sonner";
import {
	WizardStepBaseCurrency,
	WizardStepHoldings,
	type HoldingRow,
} from "@/components/business/onboarding";
import { Button } from "@/components/ui/button";
import { onboardingApi } from "@/lib/api/onboarding";
import {
	invalidateAfterLedgerMutation,
	invalidateAfterOnboarding,
} from "@/lib/api/query-keys";
import { ApiError } from "@/lib/api/client";
import { safeRedirectPath } from "@/lib/auth/safe-redirect-path";
import { PageLoading, PermissionNotice } from "@/components/base";
import { useOrganizationCapabilities } from "@/lib/hooks/use-organization-capabilities";
import type { InitialHoldingItem } from "@/lib/api/contract";

/**
 * 建账向导页（未建账分流到此；已建账经 ?backfill=1 进入补录初始持仓）
 *
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。
 * 挂载时查询 onboarding 状态分流：
 * - 请求失败 → 整页错误态 + 重试（风格对齐首页 HomeError）；
 * - 已建账 + ?backfill=1 → 补录模式（提交 POST /onboarding/initial-holdings）；
 * - 已建账 → 回首页或登录前来源页（向导不重复进）；
 * - 未建账 → 两步向导：①地区/本位币/语言 ②选填初始持仓（可跳过）。
 *
 * 向导无草稿（规格 2.3-2）：状态全部在内存，中断即丢弃、无任何持久化。
 * 改本位币重核（需求场景 3）：返回第一步改币后再进第二步，金额保留、
 * 核对区按新本位币重新取价（wizard-step-holdings 取价签名含 baseCurrency）。
 *
 * 能力门控（Goal #3B W28）：完成建账与补录初始持仓都需 settings.update
 * （后端 @RequiresPermission 强制）。无权角色（Finance / Operator / Viewer）看到的是
 * 只读提示，向导根本不挂载——否则一挂载就去查状态、取报价，对一个注定 403 的用户
 * 毫无意义。组织详情未返回前先加载，不闪现向导再收回。
 */
export default function OnboardingPage() {
	// useSearchParams 需要 Suspense 边界（Next.js App Router 要求）
	return (
		<Suspense fallback={<PageLoading />}>
			<OnboardingGate />
		</Suspense>
	);
}

/** 建账权限闸门：有 settings.update 才挂载向导 */
function OnboardingGate() {
	const { can, isLoading, onboardingCompleted } = useOrganizationCapabilities();

	if (isLoading) {
		return <PageLoading />;
	}

	if (can("settings.update")) {
		return <OnboardingWizard />;
	}

	return (
		<PermissionNotice
			testId="onboarding-no-permission"
			title="当前角色无权完成建账"
			description="当前角色无权完成建账或补录初始持仓，请联系组织所有者或管理员。"
			action={
				// 组织已建账：回首页即可；尚未建账：首页会再次分流回本页，改为去成员页
				// 找到所有者 / 管理员（那里也能看到自己该联系谁）
				onboardingCompleted ? (
					<Button variant="outline" className="bg-white" asChild>
						<Link href="/home">返回首页</Link>
					</Button>
				) : (
					<Button variant="outline" className="bg-white" asChild>
						<Link href="/organization/members">前往组织成员页</Link>
					</Button>
				)
			}
		/>
	);
}

type WizardPhase = "checking" | "error" | "wizard" | "backfill" | "redirecting";

function OnboardingWizard() {
	const router = useRouter();
	const queryClient = useQueryClient();
	const searchParams = useSearchParams();
	const redirect = searchParams.get("redirect");
	const backfillParam = searchParams.get("backfill") === "1";

	const [phase, setPhase] = useState<WizardPhase>("checking");
	// 向导模式状态（无草稿：中断即丢弃）
	const [step, setStep] = useState<1 | 2>(1);
	const [region, setRegion] = useState("CN");
	const [locale, setLocale] = useState("zh-CN");
	const [baseCurrency, setBaseCurrency] = useState("CNY");
	const [submitting, setSubmitting] = useState(false);
	// 第二步填写状态提升到页面层：跨步返回（改本位币）再进第二步时金额保留（需求场景 3）
	const [wizardView, setWizardView] = useState<"choice" | "fill">("choice");
	const [wizardRows, setWizardRows] = useState<HoldingRow[]>([
		{ currencyCode: "", amount: "" },
	]);

	const refreshAfterOnboarding = useCallback(() => {
		invalidateAfterOnboarding(queryClient);
	}, [queryClient]);

	const refreshAfterBackfill = useCallback(() => {
		invalidateAfterLedgerMutation(queryClient);
	}, [queryClient]);

	const loadStatus = useCallback(async () => {
		setPhase("checking");
		try {
			const status = await onboardingApi.getStatus();
			if (status.completed) {
				// 补录核对区按用户真实本位币取价（未建账用户不会进入此分支，中性兼防御）
				const onboardedBase = status.settings?.baseCurrency;
				if (onboardedBase) setBaseCurrency(onboardedBase);
				if (backfillParam) {
					setPhase("backfill");
				} else {
					// 已建账用户访问向导页：回首页或来源页
					setPhase("redirecting");
					router.replace(safeRedirectPath(redirect) ?? "/home");
				}
			} else {
				setPhase("wizard");
			}
		} catch {
			setPhase("error");
		}
		// 仅挂载与手动重试时触发；redirect/backfillParam/router 首渲染后不变
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		void loadStatus();
	}, [loadStatus]);

	/** 向导模式：第二步提交（complete；跳过时不传 initialHoldings，走后端缺省） */
	const handleWizardSubmit = async (holdings: InitialHoldingItem[]) => {
		setSubmitting(true);
		try {
			await onboardingApi.complete({
				region,
				locale,
				baseCurrency,
				...(holdings.length > 0 ? { initialHoldings: holdings } : {}),
			});
			toast.success("建账完成");
			refreshAfterOnboarding();
			// 与上方「已建账」分支同口径：回登录前来源页（如 /invitations/<token>）。
			// 此前硬编码 /home——未建账的受邀者建账完成后就丢失了邀请页（评审 R2-I11）
			router.replace(safeRedirectPath(redirect) ?? "/home");
		} catch (error) {
			toast.error(
				error instanceof ApiError ? error.message : "建账失败，请稍后重试",
			);
		} finally {
			setSubmitting(false);
		}
	};

	/**
	 * 补录模式：提交 saveInitialHoldings，成功回首页。
	 * 用 replace 而非 push：避免返回键重入补录表单重复提交（同币种 409）。
	 */
	const handleBackfillSubmit = async (holdings: InitialHoldingItem[]) => {
		setSubmitting(true);
		try {
			await onboardingApi.saveInitialHoldings({ holdings });
			toast.success("初始持仓已入账");
			refreshAfterBackfill();
			router.replace("/home");
		} catch (error) {
			toast.error(
				error instanceof ApiError ? error.message : "补录失败，请稍后重试",
			);
		} finally {
			setSubmitting(false);
		}
	};

	if (phase === "checking" || phase === "redirecting") {
		return <PageLoading />;
	}

	if (phase === "error") {
		return (
			<div
				data-testid="onboarding-wizard"
				className="mx-auto flex max-w-5xl flex-col items-center justify-center px-8 py-24 text-center"
			>
				<CircleAlert className="size-10 text-cream-300" />
				<h1 className="mt-4 text-lg font-bold text-foreground">状态加载失败</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					无法获取账号当前状态，请检查网络后重试。
				</p>
				<Button
					className="mt-6 bg-mint-700 text-white hover:bg-mint-700/90"
					onClick={() => void loadStatus()}
				>
					重试
				</Button>
			</div>
		);
	}

	if (phase === "backfill") {
		return (
			<div
				data-testid="onboarding-wizard"
				className="mx-auto max-w-2xl px-8 py-6"
			>
				<header className="mb-6">
					<h1
						data-testid="backfill-title"
						className="text-xl font-bold text-foreground"
					>
						补录初始持仓
					</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						以下是记账起点当日已持有的金额，按当前有效报价折算初始成本。
					</p>
				</header>
				<section className="rounded-2xl border border-border bg-white p-6">
					<WizardStepHoldings
						mode="backfill"
						baseCurrency={baseCurrency}
						submitting={submitting}
						onSubmit={(holdings) => void handleBackfillSubmit(holdings)}
					/>
				</section>
			</div>
		);
	}

	return (
		<div
			data-testid="onboarding-wizard"
			className="mx-auto max-w-2xl px-8 py-6"
		>
			<header className="mb-6">
				<h1 className="text-xl font-bold text-foreground">完成初始设置</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					确认本位币即可开始记账，初始持仓可跳过后补录。
				</p>
			</header>

			<section className="rounded-2xl border border-border bg-white p-6">
				{step === 1 ? (
					<div data-testid="wizard-step-1">
						<WizardStepBaseCurrency
							region={region}
							locale={locale}
							baseCurrency={baseCurrency}
							onChange={(patch) => {
								if (patch.region !== undefined) setRegion(patch.region);
								if (patch.locale !== undefined) setLocale(patch.locale);
								if (patch.baseCurrency !== undefined)
									setBaseCurrency(patch.baseCurrency);
							}}
							onNext={() => setStep(2)}
						/>
					</div>
				) : (
					<div data-testid="wizard-step-2">
						<WizardStepHoldings
							mode="init"
							baseCurrency={baseCurrency}
							submitting={submitting}
							view={wizardView}
							onViewChange={setWizardView}
							rows={wizardRows}
							onRowsChange={setWizardRows}
							onBack={() => setStep(1)}
							onSubmit={(holdings) => void handleWizardSubmit(holdings)}
						/>
					</div>
				)}
			</section>
		</div>
	);
}
