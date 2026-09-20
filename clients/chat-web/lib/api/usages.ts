import { apiClient } from "@/lib/api/client";
import type {
	CreateUsageReq,
	PlanFundSummary,
	UsageListResp,
	UsageRecord,
} from "@/lib/api/contract";

/**
 * 资金使用 API（usage-recording M7）：挂在计划下的使用记录读写。
 * 类型来自 schema.gen 生成物经 contract.ts 别名层，禁止手写结构。
 */
export const usagesApi = {
	/**
	 * 记录使用（POST /plans/:id/usages）
	 *
	 * 非幂等：一次确认 = 一笔新使用；服务端五步事务（条件扣分配 → 条件扣
	 * 余额 → 插记录 → FIFO 分摊 → 写分摊明细），任一失败整体回滚。
	 * 失败：400 INVALID_USAGE_PARAMS / 404 PLAN_NOT_FOUND（防枚举）/
	 * 409 PLAN_INVALID_TRANSITION / 409 INSUFFICIENT_PLAN_ALLOCATION
	 * （data.remainingAllocation 为当前剩余，供内联提示）。
	 * 成功 data.usage 为新记录、data.plan 为提交后资金面快照（一次往返刷新进度区）。
	 */
	async create(
		planId: string,
		req: CreateUsageReq,
	): Promise<{ usage: UsageRecord; plan: PlanFundSummary }> {
		return apiClient(`/plans/${encodeURIComponent(planId)}/usages`, {
			method: "POST",
			body: JSON.stringify(req),
		});
	},

	/**
	 * 使用记录列表（GET /plans/:id/usages）
	 *
	 * usedAt 倒序、同刻按录入先后倒序，服务端 limit 100 兑底。
	 * 失败：404 PLAN_NOT_FOUND（计划不存在或不属于本人，防枚举）。
	 */
	async list(planId: string): Promise<UsageListResp> {
		return apiClient(`/plans/${encodeURIComponent(planId)}/usages`, {
			method: "GET",
		});
	},
};
