import { apiClient } from "@/lib/api/client";
import type {
	PlanReport,
	ReportPlanList,
	ReportListStatus,
} from "@/lib/api/contract";

/**
 * 报告中心 API（reports 技术方案 §5/§6，风格对齐 plansApi）。
 *
 * 两个只读端点：报告中心列表（状态/币种筛选）与单计划报告
 * （页面摘要与打印视图共用数据源）。401 由 apiClient 统一跳登录；
 * 400 INVALID_REPORT_PARAMS / 404 PLAN_NOT_FOUND 抛 ApiError（code 可读）。
 */
export interface ReportListFilters {
	status?: ReportListStatus;
	currencyCode?: string;
}

export const reportsApi = {
	/**
	 * 报告中心列表（GET /reports/plans）
	 *
	 * 本人全部计划成本摘要，创建时间倒序；status/currencyCode 缺省全部。
	 * M7 未上线（无使用分摊）时 usedQuantity="0.0000"、成本与均价 null（「尚未使用」）。
	 */
	async listPlans(filters: ReportListFilters = {}): Promise<ReportPlanList> {
		const params = new URLSearchParams();
		if (filters.status) params.set("status", filters.status);
		if (filters.currencyCode) params.set("currencyCode", filters.currencyCode);
		const query = params.toString();
		return apiClient<ReportPlanList>(
			`/reports/plans${query ? `?${query}` : ""}`,
			{
				method: "GET",
			},
		);
	},

	/**
	 * 单计划报告（GET /reports/plans/:id）
	 *
	 * 成本摘要 + 来源拆分 + 收益占位 + meta（更新时间/生成时间）。
	 * id 格式非法 400；不存在或不属于本人均 404（防枚举）。
	 */
	async getPlanReport(id: string): Promise<PlanReport> {
		return apiClient<PlanReport>(`/reports/plans/${encodeURIComponent(id)}`, {
			method: "GET",
		});
	},
};
