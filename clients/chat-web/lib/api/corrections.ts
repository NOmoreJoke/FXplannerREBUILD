import { apiClient } from "@/lib/api/client";
import type {
	CorrectionApplyResult,
	CorrectionLogList,
	CorrectionPreview,
	CorrectionRequest,
	CorrectionTarget,
	CorrectionTargetType,
} from "@/lib/api/contract";

/**
 * 更正与日志 API（corrections 技术方案 §6）。
 * 错误体 { code, message, details? } 由 apiClient 统一抛 ApiError（前端据此分支提示）。
 */
export const correctionsApi = {
	/**
	 * 影响预览（POST /corrections/preview，只读）
	 *
	 * 返回前后对比 + 余额/成本影响 + blockers；blockers 非空 = 不能提交。
	 * 400：INVALID_CORRECTION_PARAMS / CORRECTION_NOT_ALLOWED / RATE_QUOTE_UNAVAILABLE；
	 * 404：目标不存在或不属于本人；409：CORRECTION_TARGET_CHANGED。
	 * USAGE 自 MVP-F0-3 起支持改金额与改日期（此前 M7 未接线降级拦截已移除）。
	 */
	async preview(req: CorrectionRequest): Promise<CorrectionPreview> {
		return apiClient<CorrectionPreview>("/corrections/preview", {
			method: "POST",
			body: JSON.stringify(req),
		});
	},

	/**
	 * 提交更正（POST /corrections，事务）
	 *
	 * 复核不通过时原数据零变化（独立留痕 FAILED 尝试）；前端按 409/400 的
	 * code + details 展示不能提交的原因，并引导重新预览。
	 */
	async apply(req: CorrectionRequest): Promise<CorrectionApplyResult> {
		return apiClient<CorrectionApplyResult>("/corrections", {
			method: "POST",
			body: JSON.stringify(req),
		});
	},

	/**
	 * 目标当前内容（GET /corrections/target）：更正页表单初值与乐观校验基准数据源。
	 */
	async target(
		targetType: CorrectionTargetType,
		targetId: string,
	): Promise<CorrectionTarget> {
		const query = new URLSearchParams({ targetType, targetId });
		return apiClient<CorrectionTarget>(
			`/corrections/target?${query.toString()}`,
			{
				method: "GET",
			},
		);
	},

	/**
	 * 修改记录列表（GET /corrections）：createdAt 倒序分页，含 APPLIED 与 FAILED。
	 */
	async list(
		targetType: CorrectionTargetType,
		targetId: string,
		page = 1,
	): Promise<CorrectionLogList> {
		const query = new URLSearchParams({
			targetType,
			targetId,
			page: String(page),
		});
		return apiClient<CorrectionLogList>(`/corrections?${query.toString()}`, {
			method: "GET",
		});
	},
};
