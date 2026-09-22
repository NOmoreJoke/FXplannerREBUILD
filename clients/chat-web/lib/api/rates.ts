import { apiClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema.gen";

type Schemas = components["schemas"];

/** 单目标响应（后端 LatestRateResponseDto；GET /rates/latest/{base} 缺省 targets 时返回平铺结构） */
export type LatestRateResponse = Schemas["LatestRateResponseDto"];

/** 多目标响应项（后端 LatestRateItemDto；error 出现时本项无报价数据） */
export type LatestRateItem = Schemas["LatestRateItemDto"];

/** 多目标响应（后端 LatestRateGroupResponseDto；错误按项下沉到 items） */
export type LatestRateGroupResponse = Schemas["LatestRateGroupResponseDto"];

export const ratesApi = {
	/**
	 * 最新报价（GET /rates/latest/{base}，实时汇率升级 §4.2）
	 *
	 * 公开接口（skipAuth），只读幂等。targets 为空时不带参数（后端回落 USD，
	 * 返回单目标平铺结构）；多目标返回 items 结构且错误下沉到项。
	 * refresh=true 强制同步回源（换币种/确认页锁数等强一致场景），绕过后端
	 * 5 分钟有效期窗口；不传走窗口缓存——窗口内命中直接回显，超窗由后端
	 * 陈旧回显旧值（fresh=false）并后台刷新，进页不再阻塞「获取中」
	 * （changes/rate-stale-echo-fix）。
	 * history 本次不封装（留待报告波次）。
	 */
	async latest(
		base: string,
		targets: string[] = [],
		refresh = false,
	): Promise<LatestRateResponse | LatestRateGroupResponse> {
		const queries: string[] = [];
		if (targets.length > 0) {
			queries.push(`targets=${encodeURIComponent(targets.join(","))}`);
		}
		if (refresh) {
			queries.push("refresh=true");
		}
		const query = queries.length > 0 ? `?${queries.join("&")}` : "";

		return apiClient<LatestRateResponse | LatestRateGroupResponse>(
			`/rates/latest/${encodeURIComponent(base)}${query}`,
			{
				method: "GET",
				skipAuth: true,
			},
		);
	},
};
