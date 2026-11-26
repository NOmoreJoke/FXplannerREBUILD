import { apiClient } from "@/lib/api/client";
import type {
	PersonalSettingsView,
	SettingsView,
	UpdatePersonalSettingsReq,
	UpdateSettingsReq,
} from "@/lib/api/contract";

/**
 * 设置读写封装（技术方案 §10.2；Goal #3B W22 后端分离、W28 前端拆分）。
 *
 * 两套端点、两个数据域，调用方不得混用：
 * - 个人展示偏好 /settings/personal：仅要求登录。任何已登录用户任何时候可改
 *   （不受组织建账或组织角色影响），请求不带组织头（skipOrganizationScope）；
 * - 组织账本设置 /settings：需组织上下文且当前组织已建账（否则 409
 *   ONBOARDING_NOT_COMPLETED）。改 prepPreference / reminderEnabled 需 settings.update
 *   权限（否则 403 PERMISSION_DENIED）——调用方须先按 capabilities 门控，不发必然 403
 *   的请求。baseCurrency 只读：建账时锁定，无任何更新通道。
 */

/** 组织账本设置的可更新字段（入参类型层面就不含地区/语言——那是个人展示偏好） */
export type UpdateOrganizationSettingsReq = Pick<
	UpdateSettingsReq,
	"prepPreference" | "reminderEnabled"
>;

export const settingsApi = {
	/** 查询个人展示偏好（GET /settings/personal）；无个人设置行时后端回落产品默认值 */
	async getPersonalSettings(): Promise<PersonalSettingsView> {
		return apiClient<PersonalSettingsView>("/settings/personal", {
			method: "GET",
			skipOrganizationScope: true,
		});
	},

	/**
	 * 更新个人展示偏好（PATCH /settings/personal）；全可选至少一项，空 body → 400
	 * SETTINGS_UPDATE_EMPTY。返回更新后的个人展示偏好。
	 */
	async updatePersonalSettings(
		dto: UpdatePersonalSettingsReq,
	): Promise<PersonalSettingsView> {
		return apiClient<PersonalSettingsView>("/settings/personal", {
			method: "PATCH",
			body: JSON.stringify(dto),
			skipOrganizationScope: true,
		});
	},

	/** 查询组织账本设置（GET /settings）；未建账 → 409 ONBOARDING_NOT_COMPLETED */
	async getSettings(): Promise<SettingsView> {
		return apiClient<SettingsView>("/settings", {
			method: "GET",
		});
	},

	/**
	 * 更新组织账本设置（PATCH /settings）；全可选至少一项，空 body → 400
	 * SETTINGS_UPDATE_EMPTY；无 settings.update 权限 → 403 PERMISSION_DENIED。
	 * 返回更新后的完整设置视图。
	 */
	async updateSettings(
		dto: UpdateOrganizationSettingsReq,
	): Promise<SettingsView> {
		return apiClient<SettingsView>("/settings", {
			method: "PATCH",
			body: JSON.stringify(dto),
		});
	},
};
