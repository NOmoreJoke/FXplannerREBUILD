import { apiClient, ApiError } from "@/lib/api/client";
import type {
	DataRequestView,
	DataRequestPurpose,
	DataRequestVerifyResult,
	ImpactTotals,
	ImpactView,
} from "@/lib/api/contract";

/**
 * 数据权利请求封装（account-data 技术方案 §8）：进度/影响/验证/创建/撤回/下载。
 * 类型取 schema.gen.ts 生成别名（contract.ts），禁止手写结构。
 */

export interface CreateDataRequestInput {
	type: DataRequestView["type"];
	challengeId: string;
	/** CLEAR 必带：确认页数量快照（与服务端重算不一致 → 409 IMPACT_CHANGED） */
	confirmedTotals?: ImpactTotals;
}

export interface VerifyDataRequestInput {
	challengeId: string;
	code: string;
	purpose: DataRequestPurpose;
}

export const dataRequestsApi = {
	/** 当前请求（进度页）；无进行中请求返回 null */
	async getCurrent(): Promise<DataRequestView | null> {
		return apiClient<DataRequestView | null>("/data-requests/current", {
			method: "GET",
		});
	},

	/** CLEAR 确认页数据：记录数量 + 可下载导出提示 */
	async getImpact(): Promise<ImpactView> {
		return apiClient<ImpactView>("/data-requests/impact", {
			method: "GET",
		});
	},

	/** 数据操作验证码校验（消费验证码，返回 10 分钟确认凭证） */
	async verify(input: VerifyDataRequestInput): Promise<DataRequestVerifyResult> {
		return apiClient<DataRequestVerifyResult>("/data-requests/verify", {
			method: "POST",
			body: JSON.stringify(input),
		});
	},

	/** 提交请求：EXPORT 同步生成即完成；CLEAR/DELETION 进入 7 日流程 */
	async create(input: CreateDataRequestInput): Promise<DataRequestView> {
		return apiClient<DataRequestView>("/data-requests", {
			method: "POST",
			body: JSON.stringify(input),
		});
	},

	/** 撤回：CLEAR 直接撤；DELETION 需携带 purpose=DELETION 的已验证凭证 */
	async cancel(
		requestId: string,
		challengeId?: string,
	): Promise<DataRequestView> {
		return apiClient<DataRequestView>(
			`/data-requests/${requestId}/cancel`,
			{
				method: "POST",
				body: JSON.stringify(challengeId ? { challengeId } : {}),
			},
		);
	},

	/**
	 * 下载导出包（需 Authorization，绕过 apiClient 的 JSON 解析）：
	 * fetch blob → 触发浏览器保存；410/404 抛 ApiError。
	 */
	async download(requestId: string): Promise<void> {
		const { getToken } = await import("@/lib/auth/token");
		const token = getToken();
		const response = await fetch(
			`${process.env.NEXT_PUBLIC_API_BASE_URL}/data-requests/${requestId}/download`,
			{
				headers: token ? { Authorization: `Bearer ${token}` } : undefined,
			},
		);
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as {
				code?: string;
				message?: string;
			};
			throw new ApiError(
				body.message ?? "下载失败",
				response.status,
				body.code,
			);
		}
		const blob = await response.blob();
		const disposition =
			response.headers.get("Content-Disposition") ?? "attachment";
		const match = disposition.match(/filename="([^"]+)"/);
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = match?.[1] ?? "fxplanner-export.zip";
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		URL.revokeObjectURL(url);
	},
};
