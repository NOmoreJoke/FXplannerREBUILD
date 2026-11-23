import { apiClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema.gen";

/**
 * 组织 API 封装（ToB R1 W20；技术方案 §7.2）。
 * 类型全部取 schema.gen 别名（后端 DTO 唯一事实，零手写影子 DTO）；
 * 组织头注入统一在 apiClient（读 organization-store），此处不重复拼装。
 */

type Schemas = components["schemas"];

/** GET /organizations 列表项 */
export type OrganizationSummary = Schemas["OrganizationViewDto"];

/** GET /organizations/current 详情（capabilities 为后端权限真源） */
export type OrganizationCurrent = Schemas["OrganizationCurrentDto"];

export const organizationsApi = {
	/** 本人全部有效组织（个人端点，单/多组织路由依据） */
	async list(): Promise<OrganizationSummary[]> {
		return apiClient<OrganizationSummary[]>("/organizations", {
			method: "GET",
		});
	},

	/** 当前组织详情 + capabilities + 建账状态（组织上下文端点） */
	async current(): Promise<OrganizationCurrent> {
		return apiClient<OrganizationCurrent>("/organizations/current", {
			method: "GET",
		});
	},
};
