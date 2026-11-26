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
	BlockingOrganization,
	CancelDataRequestReq,
	DataRequestScope,
	DataRequestView,
	DataRequestVerifyResult,
	ImpactView,
	OrganizationDeletionRequest,
} from "@/lib/api/contract";

/**
 * 数据权利请求封装（技术方案 §9.1–§9.2；Goal #3B W26/W27 后端双域物理拆分、W28 前端拆分）。
 *
 * 个人与组织是两个数据域，各有独立端点，**绝不混用**：
 *
 * 个人域 `/data-requests/*`（只挂 JwtAuthGuard，不要求组织上下文）：
 * - 仅受理 PERSONAL 的 EXPORT / DELETION；清空账本属于组织数据，个人域没有 CLEAR；
 * - 请求不带 X-Organization-Id（skipOrganizationScope）——0 组织 / 多组织未选 /
 *   个人注销锁定的用户都必须能读进度、撤回、下载；
 * - 注销提交遇本人仍是某组织唯一所有者 → 409 LAST_OWNER_REQUIRED（附阻塞组织列表）。
 *
 * 组织域 `/organizations/current/data-requests/*`（JwtAuthGuard → OrganizationContextGuard →
 * OrganizationLockGuard → PermissionGuard）：
 * - 仅受理 ORGANIZATION 的 EXPORT / CLEAR / DELETION；目标组织取 X-Organization-Id；
 * - 进度 / 验证 / 撤回 / 下载在组织清空或删除的冷静期内仍可达（锁守卫白名单）；
 * - 删除当前组织走 OrganizationController 的 DELETE /organizations/current（仅 Owner）。
 *
 * 类型全部取 schema.gen 生成别名，禁止手写结构；入参用 Pick 自生成 DTO 的字段拼装，
 * 并把 scope 固定为所在域的字面量——请求体与端点数据域不一致时后端一律 400
 * SCOPE_TYPE_MISMATCH，类型层面先杜绝。
 */

type Schemas = components["schemas"];

export type CreateDataRequestInput = Schemas["CreateDataRequestDto"];

export type VerifyDataRequestInput = Schemas["VerifyDataRequestDto"];

/** 服务端请求 id 的形状白名单（cuid：字母数字；路径段内不做其他拼接） */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;

/** 数据域（服务端请求视图的 scope；别名见 contract.ts，此处转出便于调用方按域选择端点） */
export type { DataRequestScope };

/** 个人域可提交的请求类型（PERSONAL 仅支持 EXPORT / DELETION） */
export type PersonalRequestType = Extract<
	CreateDataRequestInput["type"],
	"EXPORT" | "DELETION"
>;

/** 组织域可提交的请求类型（EXPORT / CLEAR / DELETION） */
export type OrganizationRequestType = CreateDataRequestInput["type"];

/** 提交个人请求入参（scope 固定 PERSONAL；CLEAR 不在其中） */
export type CreatePersonalRequestInput = Pick<
	CreateDataRequestInput,
	"challengeId"
> & {
	type: PersonalRequestType;
	scope: "PERSONAL";
};

/** 提交组织请求入参（scope 固定 ORGANIZATION；CLEAR 必带 confirmedTotals） */
export type CreateOrganizationRequestInput = Pick<
	CreateDataRequestInput,
	"challengeId" | "confirmedTotals"
> & {
	type: OrganizationRequestType;
	scope: "ORGANIZATION";
};

/** 个人域数据请求端点前缀（不要求组织上下文） */
const PERSONAL_REQUESTS_PATH = "/data-requests";

/** 组织域数据请求端点前缀 */
const ORGANIZATION_REQUESTS_PATH = "/organizations/current/data-requests";

/** 下载失败时的错误体形状（与 apiClient 的错误协议一致） */
interface DownloadErrorBody {
	code?: string;
	message?: string;
}

/** 进入 URL 路径段的请求 id 一律先过形状白名单（不把任意输入拼进 URL） */
function assertRequestId(requestId: string): void {
	if (!REQUEST_ID_PATTERN.test(requestId)) {
		throw new ApiError("无效的请求标识", 400, "INVALID_REQUEST_ID");
	}
}

/**
 * 导出包下载（需 Authorization，绕过 apiClient 的 JSON 解析）：fetch blob → 触发浏览器
 * 保存；410/404 抛 ApiError。个人域与组织域共用，仅端点前缀与组织头不同。
 *
 * 与 apiClient 对齐的三处（评审 I-18 + 安全钩子复核）：
 * - 地址经 buildApiUrl 构造（base 启动时校验、endpoint 仅站内相对路径），
 *   requestId 先按服务端 id 形状做白名单校验，不把任意输入拼进 URL；
 * - 组织域下载携带 X-Organization-Id：导出按当前组织绑定校验（切错组织 → 404）；
 *   个人域下载不带组织头，也不参与组织上下文失效处理——个人导出与组织无关；
 * - 401 走统一会话重置，组织域的组织上下文失效走同一处理。
 */
async function downloadRequest(
	requestId: string,
	requestsPath: string,
	organizationScope: boolean,
): Promise<void> {
	assertRequestId(requestId);
	const { getToken } = await import("@/lib/auth/token");
	const headers: Record<string, string> = {};
	const token = getToken();
	if (token) {
		headers["Authorization"] = `Bearer ${token}`;
	}
	const sentOrganizationId = organizationScope
		? getActiveOrganizationId()
		: null;
	if (sentOrganizationId) {
		headers["X-Organization-Id"] = sentOrganizationId;
	}
	const response = await fetch(
		buildApiUrl(`${requestsPath}/${requestId}/download`),
		{ headers },
	);
	if (response.status === 401) {
		handleUnauthorized();
		throw new ApiError("Token 无效或已过期", 401);
	}
	if (organizationScope) {
		const orgError = await consumeOrganizationContextError(
			response,
			sentOrganizationId,
		);
		if (orgError) {
			throw orgError;
		}
	}
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as DownloadErrorBody;
		throw new ApiError(
			body.message ?? "下载失败",
			response.status,
			body.code,
			body as Record<string, unknown>,
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
}

export const dataRequestsApi = {
	// ───────────────────────── 个人域（不依赖组织）─────────────────────────

	/** 个人当前请求（进度页）；无进行中请求返回 null */
	async getPersonalCurrent(): Promise<DataRequestView | null> {
		return apiClient<DataRequestView | null>(
			`${PERSONAL_REQUESTS_PATH}/current`,
			{ method: "GET", skipOrganizationScope: true },
		);
	},

	/** 个人数据操作验证码校验（消费验证码，返回 10 分钟确认凭证） */
	async verifyPersonal(
		input: VerifyDataRequestInput,
	): Promise<DataRequestVerifyResult> {
		return apiClient<DataRequestVerifyResult>(
			`${PERSONAL_REQUESTS_PATH}/verify`,
			{
				method: "POST",
				body: JSON.stringify(input),
				skipOrganizationScope: true,
			},
		);
	},

	/**
	 * 提交个人请求：EXPORT 同步生成即完成；DELETION 进入 7 日撤回期。
	 * 本人仍是某组织唯一所有者时注销被拒：409 LAST_OWNER_REQUIRED，
	 * ApiError.body.blockingOrganizations 为阻塞组织列表（见 getBlockingOrganizations）。
	 */
	async createPersonal(
		input: CreatePersonalRequestInput,
	): Promise<DataRequestView> {
		return apiClient<DataRequestView>(PERSONAL_REQUESTS_PATH, {
			method: "POST",
			body: JSON.stringify(input),
			skipOrganizationScope: true,
		});
	},

	/** 撤回个人请求（DELETION 撤回需携带 purpose=DELETION 的已验证凭证） */
	async cancelPersonal(
		requestId: string,
		input: CancelDataRequestReq = {},
	): Promise<DataRequestView> {
		assertRequestId(requestId);
		return apiClient<DataRequestView>(
			`${PERSONAL_REQUESTS_PATH}/${requestId}/cancel`,
			{
				method: "POST",
				body: JSON.stringify(input),
				skipOrganizationScope: true,
			},
		);
	},

	/** 下载个人导出包（本人个人域 EXPORT COMPLETED 且 24 小时内） */
	downloadPersonal(requestId: string): Promise<void> {
		return downloadRequest(requestId, PERSONAL_REQUESTS_PATH, false);
	},

	// ───────────────────────── 组织域（依赖当前组织）─────────────────────────

	/** 组织当前请求（进度页，任意有效成员可查）；无进行中请求返回 null */
	async getOrganizationCurrent(): Promise<DataRequestView | null> {
		return apiClient<DataRequestView | null>(
			`${ORGANIZATION_REQUESTS_PATH}/current`,
			{ method: "GET" },
		);
	},

	/** 组织清空确认页数据：记录数量 + 可下载导出提示（需 data.clear 权限） */
	async getOrganizationImpact(): Promise<ImpactView> {
		return apiClient<ImpactView>(`${ORGANIZATION_REQUESTS_PATH}/impact`, {
			method: "GET",
		});
	},

	/** 组织数据操作验证码校验（导出 / 清空 / 删除组织共用的凭证签发） */
	async verifyOrganization(
		input: VerifyDataRequestInput,
	): Promise<DataRequestVerifyResult> {
		return apiClient<DataRequestVerifyResult>(
			`${ORGANIZATION_REQUESTS_PATH}/verify`,
			{ method: "POST", body: JSON.stringify(input) },
		);
	},

	/**
	 * 提交组织请求：EXPORT 同步生成即完成；CLEAR / DELETION 进入 7 日流程。
	 * 权限由后端按类型判定（data.export / data.clear / organization.delete），
	 * 调用方须先按 capabilities 门控。
	 */
	async createOrganizationRequest(
		input: CreateOrganizationRequestInput,
	): Promise<DataRequestView> {
		return apiClient<DataRequestView>(ORGANIZATION_REQUESTS_PATH, {
			method: "POST",
			body: JSON.stringify(input),
		});
	},

	/**
	 * 发起删除当前组织（仅 Owner；进入 7 日撤回期，到期才真正删除）。
	 * 只删除该组织与共享账本，不删除任何成员的个人账号。
	 */
	async deleteOrganization(
		input: OrganizationDeletionRequest,
	): Promise<DataRequestView> {
		return apiClient<DataRequestView>("/organizations/current", {
			method: "DELETE",
			body: JSON.stringify(input),
		});
	},

	/** 撤回组织请求（CLEAR 直接撤；DELETION 需携带 DELETION 用途的已验证凭证） */
	async cancelOrganizationRequest(
		requestId: string,
		input: CancelDataRequestReq = {},
	): Promise<DataRequestView> {
		assertRequestId(requestId);
		return apiClient<DataRequestView>(
			`${ORGANIZATION_REQUESTS_PATH}/${requestId}/cancel`,
			{ method: "POST", body: JSON.stringify(input) },
		);
	},

	/** 下载组织导出包（本人发起、当前组织绑定；降权或被移出后后端实时拒绝） */
	downloadOrganization(requestId: string): Promise<void> {
		return downloadRequest(requestId, ORGANIZATION_REQUESTS_PATH, true);
	},
};

/**
 * 阻塞组织项的形状校验（网络数据不可信：缺字段 / 类型不符的项直接丢弃，不渲染）
 */
function isBlockingOrganization(value: unknown): value is BlockingOrganization {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.organizationId === "string" &&
		typeof item.organizationName === "string" &&
		typeof item.role === "string"
	);
}

/**
 * 取出 409 LAST_OWNER_REQUIRED 的阻塞组织列表（个人注销被拒：本人仍是这些组织的唯一
 * 所有者，须先转移所有权或删除组织）。非该错误返回 null，UI 据此渲染处置入口；
 * 列表字段逐项校验，不把未校验的响应体直接渲染成链接。
 */
export function getBlockingOrganizations(
	error: unknown,
): BlockingOrganization[] | null {
	if (
		!(error instanceof ApiError) ||
		error.status !== 409 ||
		error.code !== "LAST_OWNER_REQUIRED"
	) {
		return null;
	}
	const list: unknown = error.body?.blockingOrganizations;
	if (!Array.isArray(list)) return [];
	return list.filter(isBlockingOrganization);
}
