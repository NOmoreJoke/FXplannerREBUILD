import {
	apiClient,
	ApiError,
	buildApiUrl,
	consumeOrganizationContextError,
	getActiveOrganizationId,
	handleUnauthorized,
} from "@/lib/api/client";
import type { components } from "@/lib/api/schema.gen";
import type {
	DataRequestView,
	DataRequestVerifyResult,
	ImpactView,
} from "@/lib/api/contract";

/**
 * 数据权利请求封装（account-data 技术方案 §8；ToB R1 W27 双域物理拆分）。
 *
 * 后端已按数据域物理拆分为两套路由（技术方案 §9.1–§9.2）：
 * - 个人域 `/api/data-requests/*`：进度 / 验证 / 创建 / 撤回 / 下载；
 * - 组织域 `/api/organizations/current/data-requests/*`：进度 / 影响 / 验证 /
 *   创建 / 撤回 / 下载。
 *
 * 本封装按**请求类型与 scope** 选择端点（最小契约适配，双域页面拆分见 W28）：
 * - CLEAR 属组织域（清空的是当前组织账本）→ 组织端点；
 * - EXPORT / DELETION 属个人域 → 个人端点；
 * - 撤回与下载按请求的 scope 路由（组织域请求必须走组织端点）。
 * 类型取 schema.gen.ts 生成别名，禁止手写结构。
 */

type Schemas = components["schemas"];

export type CreateDataRequestInput = Schemas["CreateDataRequestDto"];

export type VerifyDataRequestInput = Schemas["VerifyDataRequestDto"];

/** 服务端请求 id 的形状白名单（cuid：字母数字；路径段内不做其他拼接） */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;

/** 数据域（服务端请求视图的 scope） */
export type DataRequestScope = Schemas["DataRequestViewDto"]["scope"];

/** 组织域数据请求端点前缀 */
const ORGANIZATION_REQUESTS_PATH = "/organizations/current/data-requests";

export const dataRequestsApi = {
	/** 当前请求（进度页）；无进行中请求返回 null */
	async getCurrent(): Promise<DataRequestView | null> {
		return apiClient<DataRequestView | null>("/data-requests/current", {
			method: "GET",
		});
	},

	/** CLEAR 确认页数据：记录数量 + 可下载导出提示（组织域端点） */
	async getImpact(): Promise<ImpactView> {
		return apiClient<ImpactView>(`${ORGANIZATION_REQUESTS_PATH}/impact`, {
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

	/**
	 * 提交请求：EXPORT 同步生成即完成；CLEAR/DELETION 进入 7 日流程。
	 * CLEAR 属组织域（清空当前组织账本），EXPORT / DELETION 属个人域。
	 */
	async create(input: CreateDataRequestInput): Promise<DataRequestView> {
		const path =
			input.type === "CLEAR" ? ORGANIZATION_REQUESTS_PATH : "/data-requests";
		return apiClient<DataRequestView>(path, {
			method: "POST",
			body: JSON.stringify(input),
		});
	},

	/**
	 * 撤回：CLEAR 直接撤；DELETION 需携带 purpose=DELETION 的已验证凭证。
	 * 按请求的数据域路由：组织域请求走组织端点，个人域走个人端点。
	 */
	async cancel(
		requestId: string,
		challengeId?: string,
		scope: DataRequestScope = "PERSONAL",
	): Promise<DataRequestView> {
		const base =
			scope === "ORGANIZATION" ? ORGANIZATION_REQUESTS_PATH : "/data-requests";
		return apiClient<DataRequestView>(`${base}/${requestId}/cancel`, {
			method: "POST",
			body: JSON.stringify(challengeId ? { challengeId } : {}),
		});
	},

	/**
	 * 下载导出包（需 Authorization，绕过 apiClient 的 JSON 解析）：
	 * fetch blob → 触发浏览器保存；410/404 抛 ApiError。
	 *
	 * 与 apiClient 对齐的三处（评审 I-18 + 安全钩子复核）：
	 * - 地址经 buildApiUrl 构造（base 启动时校验、endpoint 仅站内相对路径），
	 *   requestId 先按服务端 id 形状做白名单校验，不把任意输入拼进 URL；
	 * - 携带 X-Organization-Id：导出按当前组织解析，多组织用户不带头会被后端
	 *   400 拒绝或落到默认组织；
	 * - 401 / 组织上下文失效走同一处理。
	 */
	async download(
		requestId: string,
		scope: DataRequestScope = "PERSONAL",
	): Promise<void> {
		if (!REQUEST_ID_PATTERN.test(requestId)) {
			throw new ApiError("无效的请求标识", 400, "INVALID_REQUEST_ID");
		}
		const base =
			scope === "ORGANIZATION" ? ORGANIZATION_REQUESTS_PATH : "/data-requests";
		const { getToken } = await import("@/lib/auth/token");
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) {
			headers["Authorization"] = `Bearer ${token}`;
		}
		const sentOrganizationId = getActiveOrganizationId();
		if (sentOrganizationId) {
			headers["X-Organization-Id"] = sentOrganizationId;
		}
		const response = await fetch(
			buildApiUrl(`${base}/${requestId}/download`),
			{ headers },
		);
		if (response.status === 401) {
			handleUnauthorized();
			throw new ApiError("Token 无效或已过期", 401);
		}
		const orgError = await consumeOrganizationContextError(
			response,
			sentOrganizationId,
		);
		if (orgError) {
			throw orgError;
		}
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
