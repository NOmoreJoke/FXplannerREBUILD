import { apiClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema.gen";

type Schemas = components["schemas"];

/** 单目标响应（后端 LatestRateResponseDto；GET /rates/latest/{base} 缺省 targets 时返回平铺结构） */
export type LatestRateResponse = Schemas["LatestRateResponseDto"];

/** 多目标响应项（后端 LatestRateItemDto；error 出现时本项无报价数据） */
export type LatestRateItem = Schemas["LatestRateItemDto"];

/** 多目标响应（后端 LatestRateGroupResponseDto；错误按项下沉到 items） */
export type LatestRateGroupResponse = Schemas["LatestRateGroupResponseDto"];

/**
 * history 单点（GET /rates/history 的 data_points 项；rate 为数据源原始精度字符串）。
 * MVP-F0-2 C2 起后端定义 RateHistoryPointDto（含逐点 source 来源标注）并重生成契约——
 * 手写影子类型已清零（DEBT-05 范围收敛），字段以后端 DTO 为唯一事实来源。
 * source：er-api/abc/frankfurter/identity = 原来源报价；frankfurter-v2-reference = 参考价（图表须区分）。
 */
export type RateHistoryPoint = Schemas["RateHistoryPointDto"];

/** history 响应 data（后端 RateHistoryResponseDto，generate:api 生成） */
export type RateHistoryData = Schemas["RateHistoryResponseDto"];

/** 图表参考价来源标识（与后端 REFERENCE_RATE_SOURCE 常量同值；展示层据此区分参考价） */
export const REFERENCE_RATE_SOURCE = "frankfurter-v2-reference";

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

	/**
	 * 历史汇率序列（GET /rates/history，方案 §4；公开接口 skipAuth，只读幂等）。
	 * period 枚举 7/30/90/365（后端 VALID_PERIODS，非法值 400）；不支持币对 422
	 * RATE_PAIR_UNSUPPORTED；数据源不可用 502。signal 供调用方做请求超时。
	 */
	async history(
		base: string,
		target: string,
		period: number,
		signal?: AbortSignal,
	): Promise<RateHistoryData> {
		const query =
			`?base=${encodeURIComponent(base)}` +
			`&target=${encodeURIComponent(target)}` +
			`&period=${period}`;

		return apiClient<RateHistoryData>(`/rates/history${query}`, {
			method: "GET",
			skipAuth: true,
			signal,
		});
	},

	/** 支持币种清单（GET /rates/supported；行情页币种选择器的清单来源，不硬编码） */
	async supported(): Promise<string[]> {
		return apiClient<string[]>("/rates/supported", {
			method: "GET",
			skipAuth: true,
		});
	},
};
