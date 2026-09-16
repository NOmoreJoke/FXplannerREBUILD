import { apiClient } from "@/lib/api/client";
import type {
	AdjustPlanParams,
	AdjustPlanReq,
	AdjustPreviewResult,
	CreatePlanReq,
	PlanDetail,
	PlanDto,
	PlanListResp,
	PlanListStatus,
	PlanSchedulePreviewReq,
	PlanSchedulePreviewResp,
} from "@/lib/api/contract";

export const plansApi = {
	/**
	 * 排期预览（POST /plans/schedule-preview）
	 *
	 * 只读不落库，随表单输入防抖调用；返回 3 批日期金额 + caps
	 * （可分配余额上限，供前端对「计入已有外币」做实时预检）。
	 * 失败：400 INVALID_PLAN_PARAMS / NO_AVAILABLE_DATES / AMOUNT_TOO_SMALL。
	 */
	async preview(req: PlanSchedulePreviewReq): Promise<PlanSchedulePreviewResp> {
		return apiClient<PlanSchedulePreviewResp>("/plans/schedule-preview", {
			method: "POST",
			body: JSON.stringify(req),
		});
	},

	/**
	 * 创建计划（POST /plans）
	 *
	 * 服务端事务内重检余额（409 INSUFFICIENT_ALLOCATABLE_BALANCE 附 caps 现值），
	 * latestPrepDate 由服务端重算，不信任前端。
	 */
	async create(req: CreatePlanReq): Promise<PlanDto> {
		return apiClient<PlanDto>("/plans", {
			method: "POST",
			body: JSON.stringify(req),
		});
	},

	// ────────────── M5 计划管理（plan-management §4.1~4.6）──────────────

	/**
	 * 计划列表（GET /plans?status=）
	 *
	 * 本人全部计划，updatedAt 倒序，服务端 limit 100 兑底；
	 * status 缺省返回全部（非法值 400）。
	 */
	async list(status?: PlanListStatus): Promise<PlanListResp> {
		const query = status ? `?status=${encodeURIComponent(status)}` : "";
		return apiClient<PlanListResp>(`/plans${query}`, { method: "GET" });
	},

	/**
	 * 计划详情（GET /plans/:id）
	 *
	 * 含准备节点 / 修改记录 / canModify、canCancel、canComplete、canReopen
	 * 操作标记（服务端计算，前端据此显隐按钮）；updatedAt 为乐观锁原值来源。
	 * 不存在或不属于本人均 404（防枚举）。
	 */
	async getDetail(id: string): Promise<PlanDetail> {
		return apiClient<PlanDetail>(`/plans/${encodeURIComponent(id)}`, {
			method: "GET",
		});
	},

	/**
	 * 修改预览（POST /plans/:id/adjust-preview，只读不落库）
	 *
	 * 两段式修改第一段：按新目标/新分配/节奏/准备缓冲计算影响；
	 * 至少一项，否则 400 INVALID_PLAN_PARAMS。已完成计划提高目标返回
	 * reopen 标记（提交须带 confirmReopen: true）。
	 */
	async adjustPreview(
		id: string,
		params: AdjustPlanParams,
	): Promise<AdjustPreviewResult> {
		return apiClient<AdjustPreviewResult>(
			`/plans/${encodeURIComponent(id)}/adjust-preview`,
			{ method: "POST", body: JSON.stringify(params) },
		);
	},

	/**
	 * 提交修改 / 重新开启（PATCH /plans/:id）
	 *
	 * 两段式第二段：expectedUpdatedAt 乐观锁不匹配返回 409 PLAN_STATE_CHANGED
	 * （前端引导重新预览）；事务内重算重校验，预览结果不作为提交依据。
	 * 返回提交后详情。
	 */
	async adjust(id: string, req: AdjustPlanReq): Promise<PlanDetail> {
		return apiClient<PlanDetail>(`/plans/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(req),
		});
	},

	/**
	 * 完成确认（POST /plans/:id/complete）
	 *
	 * 仅进行中且已使用 = 目标且剩余分配 = 0 可完成（PLAN_COMPLETE_NOT_READY
	 * 400 附差值）；并发取消 + 完成恰一成功（另一 409）。返回完成后的详情。
	 */
	async complete(id: string): Promise<PlanDetail> {
		return apiClient<PlanDetail>(`/plans/${encodeURIComponent(id)}/complete`, {
			method: "POST",
		});
	},

	/**
	 * 取消计划（POST /plans/:id/cancel，终态）
	 *
	 * 释放全部剩余分配回未分配余额，准备节点清空；已用金额不恢复。
	 * 仅进行中可取消（409 PLAN_INVALID_TRANSITION）。返回取消后的详情。
	 */
	async cancel(id: string): Promise<PlanDetail> {
		return apiClient<PlanDetail>(`/plans/${encodeURIComponent(id)}/cancel`, {
			method: "POST",
		});
	},
};
