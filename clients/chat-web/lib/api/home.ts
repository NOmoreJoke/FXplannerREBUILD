import { apiClient } from "@/lib/api/client";
import type { HomeState } from "@/lib/api/contract";
import type { components } from "@/lib/api/schema.gen";

type Schemas = components["schemas"];

/**
 * 持仓成本聚合（后端 PortfolioDto，GET /home/portfolio 的 data）。
 *
 * 类型唯一来源：后端 DTO 经 generate:api 生成（schema.gen.ts），此处仅做业务别名。
 *
 * 口径假设（契约 §2，必须随实现保持一致）：CostLot.unitCost 以用户当前
 * baseCurrency 计价（本位币/外币买入价）；本位币历史变更不做重算。
 */
export type HomePortfolioData = Schemas["PortfolioDto"];

export const homeApi = {
	/**
	 * 查询首页状态（分流三布尔 + 账户/计划摘要 + 最新汇率观测时间）
	 *
	 * 需登录（JwtAuthGuard），只读、无副作用、幂等。
	 * 一次请求返回 /home 分流所需的全部判断依据。
	 */
	async getState(): Promise<HomeState> {
		return apiClient<HomeState>("/home/state", {
			method: "GET",
		});
	},
};

/**
 * 查询持仓成本聚合（首页仪表盘数据源之二，与 /home/state 并行消费）。
 *
 * 需登录（JwtAuthGuard），只读、无副作用、幂等。
 * 失败由消费方（use-home-state）降级处理：totalRemainingCost/avgUnitCost/baseCurrency
 * 置 null、卡片显示 "—"，不阻塞首页整页。
 */
export async function fetchHomePortfolio(): Promise<HomePortfolioData> {
	return apiClient<HomePortfolioData>("/home/portfolio", {
		method: "GET",
	});
}
