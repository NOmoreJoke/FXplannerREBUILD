import { apiClient } from "@/lib/api/client";
import type { OnboardingStatus } from "@/lib/api/contract";

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
};
