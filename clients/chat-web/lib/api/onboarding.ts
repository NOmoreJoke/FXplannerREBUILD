import { apiClient } from "@/lib/api/client";
import type {
	CompleteOnboardingReq,
	ConsentsResult,
	InitialHoldingItem,
	InitialHoldingsResult,
	OnboardingStatus,
} from "@/lib/api/contract";
import type { components } from "@/lib/api/schema.gen";

type Schemas = components["schemas"];

/** complete 出参（后端 OnboardingCompleteResultDto：创建的 settings + 记账起点） */
type CompleteResult = Schemas["OnboardingCompleteResultDto"];

/** consents 入参（后端 SaveConsentsDto：两项确认均须为 true） */
export type SaveConsentsReq = Schemas["SaveConsentsDto"];

/**
 * 完成建账入参（后端 CompleteOnboardingDto）：region/locale/baseCurrency 必填，
 * prepPreference/reminderEnabled/initialHoldings 可选（缺省 balanced/true/不入仓），
 * 契约唯一来源为 schema.gen 别名（contract.ts CompleteOnboardingReq）。
 */
export type { CompleteOnboardingReq };

export const onboardingApi = {
	/**
	 * 查询首次设置状态（存量接口，只读无副作用）
	 *
	 * 创建换汇计划页消费 settings.prepPreference（默认节奏）
	 * 与 settings.baseCurrency（只读本位币）；取不到时页面静默用默认值。
	 */
	async getStatus(): Promise<OnboardingStatus> {
		return apiClient<OnboardingStatus>("/onboarding/status", {
			method: "GET",
		});
	},

	/**
	 * 提交年龄与条款确认（POST /onboarding/consents）
	 *
	 * 登录成功后由登录表单自动提交（技术方案 §3.1：失败不阻塞，
	 * 未建账用户由建账后端校验兜底）；幂等，记版本与时间。
	 */
	async saveConsents(dto: SaveConsentsReq): Promise<ConsentsResult> {
		return apiClient<ConsentsResult>("/onboarding/consents", {
			method: "POST",
			body: JSON.stringify(dto),
		});
	},

	/**
	 * 完成建账（POST /onboarding/complete，扩展版：可选初始持仓一次事务入账）
	 *
	 * 出参 { settings, ledgerStartedAt }；已建账 409 ONBOARDING_ALREADY_COMPLETED；
	 * 任一币种无有效报价 → 400 RATE_UNAVAILABLE，整单回滚。
	 */
	async complete(dto: CompleteOnboardingReq): Promise<CompleteResult> {
		return apiClient<CompleteResult>("/onboarding/complete", {
			method: "POST",
			body: JSON.stringify(dto),
		});
	},

	/**
	 * 补录初始持仓（POST /onboarding/initial-holdings）
	 *
	 * 已建账但从未录入初始持仓时使用；错误码：未建账 409 ONBOARDING_NOT_COMPLETED、
	 * 币种已有初始记录 409 INITIAL_HOLDING_EXISTS、无有效报价 400 RATE_UNAVAILABLE、
	 * 金额非法 400 INVALID_AMOUNT / INVALID_HOLDINGS；整单拒绝，不做部分成功。
	 */
	async saveInitialHoldings(dto: {
		holdings: InitialHoldingItem[];
	}): Promise<InitialHoldingsResult> {
		return apiClient<InitialHoldingsResult>("/onboarding/initial-holdings", {
			method: "POST",
			body: JSON.stringify(dto),
		});
	},
};
