/**
 * 审计详情脱敏纯函数（技术方案 §13.2 / AUDIT-02；Goal #3A W16）。
 *
 * 规则：
 * - 敏感键（password/token/验证码/密钥/会话原文）一律替换为 [REDACTED]，
 *   保留键位以便审计读者知道「此处有被剥离的值」；
 * - 深度上限截断（防深嵌套对象撑爆 JSONB）；
 * - 序列化字节上限：超限时先做一轮有损压缩（字符串/数组/对象键数截断），
 *   仍超限则降级为 { truncated, preview } 结构，绝不抛错阻断业务写。
 */

/** 强制脱敏的敏感键（大小写不敏感；嵌套任意层均生效） */
export const SENSITIVE_DETAIL_KEYS = [
	"password",
	"passwordhash",
	"token",
	"tokenhash",
	"code",
	"codehash",
	"secret",
	"apikey",
	"messages",
] as const;

/** 最大嵌套深度（超出部分以 [TRUNCATED] 标记） */
export const AUDIT_DETAIL_MAX_DEPTH = 4;
/** 序列化字节上限（JSONB detail 安全网） */
export const AUDIT_DETAIL_MAX_BYTES = 4096;

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";

function isSensitiveKey(key: string): boolean {
	return (SENSITIVE_DETAIL_KEYS as readonly string[]).includes(
		key.toLowerCase(),
	);
}

function sanitizeValue(value: unknown, depth: number): unknown {
	if (depth >= AUDIT_DETAIL_MAX_DEPTH) {
		return TRUNCATED;
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
	}
	const source = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(source)) {
		if (isSensitiveKey(key)) {
			result[key] = REDACTED;
			continue;
		}
		result[key] = sanitizeValue(inner, depth + 1);
	}
	return result;
}

/** 有损压缩一轮：字符串 200 字符、数组 10 项、对象前 20 键（逐层递归） */
function compactValue(value: unknown, depth: number): unknown {
	if (typeof value === "string") {
		return value.length > 200 ? `${value.slice(0, 200)}…` : value;
	}
	if (value === null || typeof value !== "object" || depth >= 3) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.slice(0, 10).map((item) => compactValue(item, depth + 1));
	}
	const result: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(value).slice(0, 20)) {
		result[key] = compactValue(inner, depth + 1);
	}
	return result;
}

function serializedBytes(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "null");
	} catch {
		// 循环引用等不可序列化输入：以摘要占位（不阻断业务写）
		return Number.MAX_SAFE_INTEGER;
	}
}

/** 敏感剥离 + 深度截断 + 字节上限；纯函数、确定性、永不抛错 */
export function sanitizeAuditDetail(raw: unknown): unknown {
	const sanitized = sanitizeValue(raw, 0);
	if (serializedBytes(sanitized) <= AUDIT_DETAIL_MAX_BYTES) {
		return sanitized;
	}
	const compacted = compactValue(sanitized, 0);
	if (serializedBytes(compacted) <= AUDIT_DETAIL_MAX_BYTES) {
		return compacted;
	}
	// 仍超限：以预览结构降级（审计行本身仍落库，业务写不被阻断）
	let preview = "";
	try {
		preview = (JSON.stringify(compacted) ?? "").slice(0, 512);
	} catch {
		preview = "[UNSERIALIZABLE]";
	}
	return {
		truncated: true,
		preview,
	};
}
