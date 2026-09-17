import { apiClient } from "@/lib/api/client";
import type { SettingsView, UpdateSettingsReq } from "@/lib/api/contract";

/**
 * 设置读写封装（GET/PATCH /settings）：偏好类设置（地区/语言/准备偏好/提醒）的唯一
 * 修改通道；baseCurrency 只读（PATCH 无该字段，后端白名单拒绝）。
 */
export const settingsApi = {
	/** 查询当前用户设置（GET /settings）；未建账 → 409 ONBOARDING_NOT_COMPLETED */
	async getSettings(): Promise<SettingsView> {
		return apiClient<SettingsView>("/settings", {
			method: "GET",
		});
	},

	/**
	 * 更新偏好设置（PATCH /settings）；全可选至少一项，空 body → 400
	 * SETTINGS_UPDATE_EMPTY；返回更新后的完整设置。
	 */
	async updateSettings(dto: UpdateSettingsReq): Promise<SettingsView> {
		return apiClient<SettingsView>("/settings", {
			method: "PATCH",
			body: JSON.stringify(dto),
		});
	},
};
