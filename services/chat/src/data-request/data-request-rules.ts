/**
 * 数据权利请求纯函数规则层（account-data 技术方案 §3.2/§3.3/§3.4；ToB R1 技术方案 §9）。
 *
 * 零 IO：状态流转、互斥、撤回可行性、展示映射、锁判定、dueAt 计算、
 * 验证凭证窗口、scope × type 合法性、最后 Owner 阻塞、审计清理策略
 * 全部在此判定，Service 只执行不决策。
 */

import type { Permission } from "../authorization/authorization.types";
import { isLastActiveOwner } from "../organization/organization-rules";

export type DataRequestType = "EXPORT" | "CLEAR" | "DELETION";
export type DataRequestStatus =
	| "PENDING"
	| "PROCESSING"
	| "COMPLETED"
	| "CANCELLED"
	| "FAILED";
export type DisplayStatus =
	| "SUBMITTED"
	| "WITHDRAWAL_PERIOD"
	| "PROCESSING"
	| "COMPLETED"
	| "CANCELLED"
	| "FAILED";
export type OtpPurpose = "LOGIN" | "EXPORT" | "CLEAR" | "DELETION";

/** 进行中状态：阻塞新请求创建（互斥，doc 01:142） */
export const ACTIVE_STATUSES: readonly DataRequestStatus[] = [
	"PENDING",
	"PROCESSING",
	"FAILED",
];

/** 验证通过后的确认窗口：10 分钟（doc 01:34） */
export const CONFIRM_WINDOW_MS = 10 * 60 * 1000;
/** 处理期限 / 注销撤回期：7 个自然日（doc 01:122/134） */
export const DUE_DAYS = 7;
export const DUE_MS = DUE_DAYS * 24 * 60 * 60 * 1000;
/** 导出下载期限：24 小时（doc 01:105） */
export const DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** 参与「读时推进」的类型：到期后执行清理（EXPORT 同步生成，不参与） */
const ADVANCABLE_TYPES: readonly DataRequestType[] = ["CLEAR", "DELETION"];

// ─────────────────────────────────────────────────────────────
// 双域拆分（技术方案 §9.1 / §9.2；Goal #3B W26）
// ─────────────────────────────────────────────────────────────

/**
 * 数据域：PERSONAL = 个人身份与个人数据（不挂组织）；
 * ORGANIZATION = 当前组织的共享账本与组织数据（必带 organizationId）。
 */
export type DataRequestScope = "PERSONAL" | "ORGANIZATION";

export const DATA_REQUEST_SCOPES: readonly DataRequestScope[] = [
	"PERSONAL",
	"ORGANIZATION",
];

export function isDataRequestScope(
	value: unknown,
): value is DataRequestScope {
	return (
		typeof value === "string" &&
		(DATA_REQUEST_SCOPES as readonly string[]).includes(value)
	);
}

/** scope → 允许的 type（与 DB CHECK data_requests_scope_type_org_check 同口径） */
export const SCOPE_ALLOWED_TYPES: Readonly<
	Record<DataRequestScope, readonly DataRequestType[]>
> = {
	PERSONAL: ["EXPORT", "DELETION"],
	ORGANIZATION: ["EXPORT", "CLEAR", "DELETION"],
};

export type ScopeTypeResolution =
	| { ok: true }
	| { ok: false; code: "SCOPE_TYPE_MISMATCH" | "ORGANIZATION_REQUIRED" };

/**
 * scope × type × organizationId 合法性矩阵（技术方案 §9.1）：
 * - PERSONAL：仅 EXPORT / DELETION，且不得挂组织；
 * - ORGANIZATION：EXPORT / CLEAR / DELETION，且必带 organizationId。
 * 与迁移 <ts>_tob_r1_data_request_scope_check 的 CHECK 逐项一致，改一处须同步另一处。
 */
export function resolveScopeType(input: {
	scope: string;
	type: string;
	organizationId: string | null;
}): ScopeTypeResolution {
	if (!isDataRequestScope(input.scope)) {
		return { ok: false, code: "SCOPE_TYPE_MISMATCH" };
	}
	if (input.scope === "PERSONAL") {
		if (input.organizationId !== null) {
			return { ok: false, code: "SCOPE_TYPE_MISMATCH" };
		}
		return SCOPE_ALLOWED_TYPES.PERSONAL.includes(input.type as DataRequestType)
			? { ok: true }
			: { ok: false, code: "SCOPE_TYPE_MISMATCH" };
	}
	if (input.organizationId === null) {
		return { ok: false, code: "ORGANIZATION_REQUIRED" };
	}
	return SCOPE_ALLOWED_TYPES.ORGANIZATION.includes(input.type as DataRequestType)
		? { ok: true }
		: { ok: false, code: "SCOPE_TYPE_MISMATCH" };
}

/**
 * 未显式指定 scope 时的归属（技术方案 §9.2）：原个人「清空业务记录」迁移为
 * 默认组织的 ORGANIZATION CLEAR（保留 7 日 / 撤回 / 记账起点 / OTP 语义）；
 * 导出与注销默认仍为个人域。
 */
export function defaultScopeForType(type: DataRequestType): DataRequestScope {
	return type === "CLEAR" ? "ORGANIZATION" : "PERSONAL";
}

/**
 * 组织域请求所需权限点（需求 DATA-01 / §7.3）：导出 Owner/Admin/Finance，
 * 清空 Owner/Admin，删除仅 Owner。个人域返回 null——仅本人 + 二次验证，
 * 不涉及组织角色。
 */
export function requiredPermission(
	scope: DataRequestScope,
	type: DataRequestType,
): Permission | null {
	if (scope === "PERSONAL") return null;
	switch (type) {
		case "EXPORT":
			return "data.export";
		case "CLEAR":
			return "data.clear";
		case "DELETION":
			return "organization.delete";
	}
}

/**
 * 审计清理策略：个人注销不删组织审计；组织清空保留既有审计并追加本次留痕；
 * 组织删除在删组织前统一清理该组织审计（保留最后一条删除留痕）。
 */
export type AuditCleanupPolicy = "KEEP" | "PURGE_BEFORE_ORG_DELETE";

export function resolveAuditCleanupPolicy(
	scope: DataRequestScope,
	type: DataRequestType,
): AuditCleanupPolicy {
	return scope === "ORGANIZATION" && type === "DELETION"
		? "PURGE_BEFORE_ORG_DELETE"
		: "KEEP";
}

/** 组织数据请求的生命周期动作：创建 / 撤回 / 到期执行 */
export type DataRequestAuditVerb = "create" | "cancel" | "execute";

/**
 * 审计动作名（<对象>.<动词>，与 organization.create / plan.cancel 同风格）：
 * - 组织导出同步完成，仅「创建」一个动作（data.export）；
 * - 组织清空 data.clear.* / 组织删除 organization.delete.*；
 * - 个人域请求不属于任何组织，不产生组织审计（AuditLog 必带 organizationId）→ null。
 */
export function auditActionOf(
	scope: DataRequestScope,
	type: DataRequestType,
	verb: DataRequestAuditVerb,
): string | null {
	if (scope === "PERSONAL") return null;
	if (type === "EXPORT") return verb === "create" ? "data.export" : null;
	return `${type === "CLEAR" ? "data.clear" : "organization.delete"}.${verb}`;
}

/** 阻塞个人注销的组织（须先转移所有权或删除组织） */
export interface BlockingOrganization {
	organizationId: string;
	organizationName: string;
	/** 本人在该组织的成员角色；无成员关系（仅持有共享行）时为 "NONE" */
	role: string;
}

/**
 * 个人注销资格快照（Service 在组织锁内读出后交本函数判定）。
 */
export interface OwnershipSnapshot {
	organizationId: string;
	organizationName: string;
	/** 本人在该组织的成员关系；无成员行为 null */
	membership: { role: string; status: string } | null;
	/** 该组织除本人外的 ACTIVE OWNER 数 */
	otherActiveOwnerCount: number;
	/** 本人在该组织是否持有需过户的共享行 */
	hasSharedRows: boolean;
}

/**
 * 最后 Owner 阻塞判定（需求 DATA-02.4 / 验收 27；技术方案 §9.2）：
 * - 本人是某组织的 ACTIVE OWNER 且该组织再无其他 ACTIVE OWNER → 阻塞
 *   （单活跃 Owner 不变量下即「唯一所有者」，规则真源 isLastActiveOwner）；
 * - 本人已非 ACTIVE OWNER（或无成员关系）但持有该组织共享行，而组织没有任何
 *   其他 ACTIVE OWNER → 无处过户，同样阻塞（fail-closed，不静默删共享账本）。
 * 返回全部阻塞组织，不替用户选择处置方式。
 */
export function resolveLastOwnerBlock(
	snapshot: readonly OwnershipSnapshot[],
): BlockingOrganization[] {
	return snapshot
		.filter((entry) => {
			const membership = entry.membership;
			if (membership?.role === "OWNER" && membership.status === "ACTIVE") {
				return isLastActiveOwner(
					entry.otherActiveOwnerCount + 1,
					membership.role,
					membership.status,
				);
			}
			return entry.hasSharedRows && entry.otherActiveOwnerCount === 0;
		})
		.map((entry) => ({
			organizationId: entry.organizationId,
			organizationName: entry.organizationName,
			role: entry.membership?.role ?? "NONE",
		}));
}

// ─────────────────────────────────────────────────────────────
// 互斥 / 幂等
// ─────────────────────────────────────────────────────────────

/** 创建请求时对既有请求的处置 */
export type CreationResolution =
	| { action: "allow" }
	/** 已有进行中请求 → 409 DATA_REQUEST_CONFLICT（data 附原请求视图） */
	| { action: "block" }
	/** 重复点击导出且原包仍可下载 → 幂等返回原请求（doc 01:107/6.1.5） */
	| { action: "return-existing" };

export interface ExistingRequestLike {
	type: string;
	status: string;
	downloadExpiresAt: Date | null;
}

/**
 * 互斥与幂等判定（方案 §3.2 / §10.1-1）：
 * - 任何进行中（PENDING/PROCESSING/FAILED）请求阻塞一切新请求；
 * - EXPORT COMPLETED 且未过下载期限时重复点击 → 返回原请求而非新建；
 * - 其余终态（COMPLETED/CANCELLED）不阻塞。
 */
export function resolveCreationConflict(
	type: DataRequestType,
	existing: ExistingRequestLike | null,
	now: Date,
): CreationResolution {
	if (!existing) return { action: "allow" };
	if ((ACTIVE_STATUSES as readonly string[]).includes(existing.status)) {
		return { action: "block" };
	}
	if (
		type === "EXPORT" &&
		existing.type === "EXPORT" &&
		existing.status === "COMPLETED" &&
		existing.downloadExpiresAt !== null &&
		existing.downloadExpiresAt.getTime() > now.getTime()
	) {
		return { action: "return-existing" };
	}
	return { action: "allow" };
}

/**
 * 截止时间：提交时刻 +7 自然日（UTC 无夏令时，自然日 = 24h 毫秒加法，
 * 跨月/闰日由 Date 承载）。EXPORT/CLEAR/DELETION 统一 +7d：
 * EXPORT 作为处理期限上限，CLEAR 为清理期限，DELETION 为撤回期截止。
 */
export function computeDueAt(requestedAt: Date): Date {
	return new Date(requestedAt.getTime() + DUE_MS);
}

/** 撤回方式（方案 §7.6）：CLEAR 直接撤；DELETION 需 DELETION 用途验证码；EXPORT 无取消窗口 */
export type CancelResolution =
	| "direct"
	| "requires-verification"
	| "not-allowed";

export function resolveCancel(existing: {
	type: string;
	status: string;
}): CancelResolution {
	if (existing.type === "CLEAR" && existing.status === "PENDING") {
		return "direct";
	}
	if (existing.type === "DELETION" && existing.status === "PENDING") {
		return "requires-verification";
	}
	return "not-allowed";
}

/** 展示映射（方案 §3.2：DELETION PENDING = 等待撤回期结束，CLEAR PENDING = 已提交） */
export function toDisplayStatus(
	type: string,
	status: string,
): DisplayStatus {
	if (status === "FAILED") return "FAILED";
	if (status === "CANCELLED") return "CANCELLED";
	if (status === "COMPLETED") return "COMPLETED";
	if (status === "PROCESSING") return "PROCESSING";
	// PENDING：
	if (type === "DELETION") return "WITHDRAWAL_PERIOD";
	return "SUBMITTED";
}

/**
 * 下载入口（方案 §7.3）：仅 EXPORT COMPLETED 且未过期可下载，过期后为 null。
 *
 * URL 按数据域分流（技术方案 §9.1 物理拆分）：
 * - PERSONAL → `/api/data-requests/{id}/download`（个人域下载端点）；
 * - ORGANIZATION → `/api/organizations/current/data-requests/{id}/download`
 *   （组织域下载端点：实时复验成员资格与权限——**降权为 Operator / Viewer → 403
 *   PERMISSION_DENIED**（权限点丢失）；**被移出组织（DISABLED）或切错组织 → 404**
 *   （组织上下文不可达 / 组织绑定校验失败））。
 */
export function resolveDownload(
	existing: {
		id: string;
		scope: string;
		type: string;
		status: string;
		downloadExpiresAt: Date | null;
	},
	now: Date,
): { url: string; expiresAt: Date } | null {
	if (existing.type !== "EXPORT" || existing.status !== "COMPLETED") {
		return null;
	}
	if (
		!existing.downloadExpiresAt ||
		existing.downloadExpiresAt.getTime() <= now.getTime()
	) {
		return null;
	}
	return {
		url:
			existing.scope === "ORGANIZATION"
				? `/api/organizations/current/data-requests/${existing.id}/download`
				: `/api/data-requests/${existing.id}/download`,
		expiresAt: existing.downloadExpiresAt,
	};
}

/** 是否仍可下载（失效导出链接联动、惰性清理用） */
export function isDownloadable(existing: {
	type: string;
	status: string;
	downloadExpiresAt: Date | null;
	now: Date;
}): boolean {
	return (
		existing.type === "EXPORT" &&
		existing.status === "COMPLETED" &&
		existing.downloadExpiresAt !== null &&
		existing.downloadExpiresAt.getTime() > existing.now.getTime()
	);
}

/**
 * 读时推进判定（方案 §3.1 决策一 / §10.1-3）：
 * - CLEAR/DELETION 且 (PENDING|FAILED) 且 now ≥ dueAt → 推进（FAILED 为重试）；
 * - 其余（含 EXPORT、未到期）→ none。
 */
export function resolveAdvance(
	existing: { type: string; status: string; dueAt: Date } | null,
	now: Date,
): "advance" | "none" {
	if (!existing) return "none";
	if (!ADVANCABLE_TYPES.includes(existing.type as DataRequestType)) {
		return "none";
	}
	if (existing.status !== "PENDING" && existing.status !== "FAILED") {
		return "none";
	}
	if (existing.dueAt.getTime() > now.getTime()) return "none";
	return "advance";
}

// ─────────────────────────────────────────────────────────────
// 锁判定（双守卫：个人账号锁 / 组织数据锁；技术方案 §9.1–§9.3）
// ─────────────────────────────────────────────────────────────

/**
 * 锁判定结果：null = 放行。
 *
 * 两个错误码严格区分（技术方案 §7.1）：
 * - `ACCOUNT_PENDING_DELETION`：**本人**账号注销处理中（个人锁）；
 * - `ORGANIZATION_DATA_LOCKED`：**当前组织**账本被清空 / 删除处理中（组织锁）。
 */
export type LockResolution =
	| null
	| "ACCOUNT_PENDING_DELETION"
	| "ORGANIZATION_DATA_LOCKED";

/**
 * 个人锁判定结果（只可能出现 ACCOUNT_PENDING_DELETION）。
 * 命名纪律（评审 N-6）：与契约层 authorization/guards/organization-lock.guard.ts 的
 * `PersonalLockErrorCode` / `OrganizationLockErrorCode` / `CombinedLockResolution`
 * 区隔，两层不出现同名类型。
 */
export type PersonalLockResolution = null | "ACCOUNT_PENDING_DELETION";

/** 组织锁判定结果（只可能出现 ORGANIZATION_DATA_LOCKED） */
export type OrganizationLockResolution = null | "ORGANIZATION_DATA_LOCKED";

/**
 * 个人账号锁判定（PersonalAccountLockGuard；技术方案 §9.1–§9.3）：
 * - PERSONAL DELETION 进行中（PENDING / PROCESSING / FAILED）→ 锁本人账号
 *   （`403 ACCOUNT_PENDING_DELETION`），除白名单端点外全端点拦截；
 * - PERSONAL EXPORT 是只读快照，不锁业务；
 * - 未知类型 fail-closed 上锁（库内出现未预期组合时不得放行）。
 */
export function resolvePersonalLock(
	lock: { type: string; status: string } | null,
): PersonalLockResolution {
	if (!lock) return null;
	if (!(ACTIVE_STATUSES as readonly string[]).includes(lock.status)) {
		return null;
	}
	if (lock.type === "EXPORT") return null;
	return "ACCOUNT_PENDING_DELETION";
}

/**
 * 组织数据锁判定（OrganizationLockGuard；技术方案 §9.1–§9.3）：
 * - CLEAR PENDING（冷静期）：停写不停看——仅拦非 GET（doc 01:122）；
 * - CLEAR PROCESSING / FAILED 与 DELETION 任意进行中状态：全端点拦截
 *   （`403 ORGANIZATION_DATA_LOCKED`；残留数据不当作正常账本，doc 01:124）；
 * - EXPORT 不锁写（只读快照）；未知类型 fail-closed 上锁。
 */
export function resolveOrganizationLock(
	lock: { type: string; status: string } | null,
	method: string,
): OrganizationLockResolution {
	if (!lock) return null;
	if (!(ACTIVE_STATUSES as readonly string[]).includes(lock.status)) {
		return null;
	}
	if (lock.type === "EXPORT") return null;
	if (
		lock.type === "CLEAR" &&
		lock.status === "PENDING" &&
		method.toUpperCase() === "GET"
	) {
		return null;
	}
	return "ORGANIZATION_DATA_LOCKED";
}

// ─────────────────────────────────────────────────────────────
// 验证凭证
// ─────────────────────────────────────────────────────────────

/** 凭证校验失败细分（方案 §7.8） */
export type VerificationErrorCode =
	| "VERIFICATION_INVALID"
	| "VERIFICATION_EXPIRED"
	| "VERIFICATION_USED"
	| "VERIFICATION_PURPOSE_MISMATCH";

export type VerificationResolution =
	| { ok: true; confirmDeadline: Date }
	| { ok: false; code: VerificationErrorCode };

export interface ChallengeLike {
	target: string;
	purpose: string;
	consumedAt: Date | null;
}

/**
 * 验证凭证校验（方案 §3.4 第 2/3 步）：
 * - purpose 必须与操作匹配且 ≠ LOGIN（用途隔离，登录码不放行数据操作）；
 * - 必须已消费（verify 消费后才成为凭证）且距 now ≤ 10 分钟；
 * - target 必须等于当前用户邮箱（不得用他人/其他邮箱凭证）。
 * 「未被任何请求引用」（一次性）由 verifiedChallengeId unique 在创建事务内兜底。
 */
export function verifyChallengeCredential(
	challenge: ChallengeLike,
	expected: { purpose: OtpPurpose; userEmail: string | null },
	now: Date,
): VerificationResolution {
	if (
		expected.purpose === "LOGIN" ||
		challenge.purpose !== expected.purpose
	) {
		return { ok: false, code: "VERIFICATION_PURPOSE_MISMATCH" };
	}
	if (!challenge.consumedAt) {
		return { ok: false, code: "VERIFICATION_INVALID" };
	}
	if (
		now.getTime() - challenge.consumedAt.getTime() > CONFIRM_WINDOW_MS
	) {
		return { ok: false, code: "VERIFICATION_EXPIRED" };
	}
	if (
		!expected.userEmail ||
		challenge.target !== expected.userEmail.toLowerCase()
	) {
		return { ok: false, code: "VERIFICATION_INVALID" };
	}
	return {
		ok: true,
		confirmDeadline: new Date(
			challenge.consumedAt.getTime() + CONFIRM_WINDOW_MS,
		),
	};
}

/** 创建请求时的凭证复验：与 verify 相同口径 + confirmDeadline 仍在窗口内（此时钟即 now） */
export function assertCredentialUsable(
	challenge: ChallengeLike,
	expected: { purpose: OtpPurpose; userEmail: string | null },
	now: Date,
): VerificationResolution {
	return verifyChallengeCredential(challenge, expected, now);
}
