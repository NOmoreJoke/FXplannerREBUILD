/**
 * 数据权利请求纯函数规则层（account-data 技术方案 §3.2/§3.3/§3.4）。
 *
 * 零 IO：状态流转、互斥、撤回可行性、展示映射、锁判定、dueAt 计算、
 * 验证凭证窗口全部在此判定，Service 只执行不决策。
 */

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

/** 下载入口（方案 §7.3）：仅 EXPORT COMPLETED 且未过期可下载，过期后为 null */
export function resolveDownload(
	existing: {
		id: string;
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
		url: `/api/data-requests/${existing.id}/download`,
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

/** 锁判定结果：null = 放行 */
export type LockResolution = null | "ACCOUNT_PENDING_DELETION" | "DATA_REQUEST_LOCKED";

/**
 * 锁定判定（方案 §3.3）：
 * - DELETION 任何进行中状态 → 全端点拦截（除白名单）；
 * - CLEAR PROCESSING/FAILED → 全端点拦截（残留数据不当作正常账本，doc 01:124）；
 * - CLEAR PENDING → 仅拦非 GET（停写不停看，doc 01:122）。
 */
export function resolveLock(
	lock: { type: string; status: string } | null,
	method: string,
): LockResolution {
	if (!lock) return null;
	if (lock.type === "DELETION") {
		if ((ACTIVE_STATUSES as readonly string[]).includes(lock.status)) {
			return "ACCOUNT_PENDING_DELETION";
		}
		return null;
	}
	if (lock.type === "CLEAR") {
		if (lock.status === "PROCESSING" || lock.status === "FAILED") {
			return "DATA_REQUEST_LOCKED";
		}
		if (lock.status === "PENDING" && method.toUpperCase() !== "GET") {
			return "DATA_REQUEST_LOCKED";
		}
	}
	return null;
}

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
