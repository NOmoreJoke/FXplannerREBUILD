/**
 * 审计详情脱敏纯函数（技术方案 §13.2 / AUDIT-02；Goal #3A W16；评审 I-14 重写）。
 *
 * 规则：
 * - 敏感键（密码/令牌/验证码/密钥/授权头/会话原文）一律替换为 [REDACTED]，
 *   保留键位以便审计读者知道「此处有被剥离的值」；
 * - 敏感键按**词**匹配而非全等：键先切成词（驼峰 + 分隔符），任一词命中敏感词、
 *   或相邻两词组成敏感短语即判敏感——覆盖仓内真实字段名 accessToken /
 *   refreshToken / password_hash / token_hash / api_key / authorization /
 *   devCode / otpCode 等（此前的全等表全部漏网），同时不误伤 currencyCode、
 *   errorCode、inputTokens 这类业务字段；
 * - 值按 JSON 语义显式序列化：Date → ISO 字符串、BigInt → 字符串、带 toJSON 的
 *   对象取其 JSON 值、二进制 → [BINARY]（此前 Date 被 Object.entries 抹成 {}，
 *   BigInt 令整条 detail 崩为不可序列化）；
 * - 深度上限截断（防深嵌套对象撑爆 JSONB；循环引用由此终止）；
 * - 序列化字节上限：超限时先做一轮有损压缩，仍超限则降级为 { truncated, preview }
 *   ——压缩与预览都作用在**已脱敏**的值上，降级路径同样不泄露原文；
 * - 纯函数、确定性、永不抛错（兜底返回占位结构，不阻断业务写）。
 */

/** 敏感单词（键切词后任一词命中即脱敏；含无分隔符的整词写法） */
const SENSITIVE_WORDS: readonly string[] = [
	"password",
	"passwd",
	"passphrase",
	"pwd",
	"secret",
	"token",
	"apikey",
	"authorization",
	"cookie",
	"cvv",
	"otp",
	"pin",
	"credential",
	"credentials",
	"passcode",
	"privatekey",
	"sessionid",
	"sessionkey",
	"codehash",
	"tokenhash",
	"passwordhash",
];

/** 敏感短语（相邻两词拼接后命中即脱敏） */
const SENSITIVE_PHRASES: readonly string[] = [
	"api key",
	"private key",
	"session id",
	"session key",
	"otp code",
	"dev code",
	"auth code",
	"sms code",
	"email code",
	"verify code",
	"verification code",
	"invite code",
	"invitation code",
	"login code",
	"security code",
	"access token",
	"refresh token",
	"id token",
	"auth token",
	"bearer token",
	// 哈希/盐形态的凭据（切词后成为两个词，必须按短语匹配）
	"password hash",
	"token hash",
	"code hash",
	"secret hash",
	"password salt",
	"token salt",
];

/** 整键精确命中才脱敏的键（单词本身过于常见，不能按词匹配） */
const SENSITIVE_EXACT_KEYS: readonly string[] = [
	"code", // 验证码本体（currencyCode/errorCode/statusCode 等复合词不受影响）
	"messages", // 模型会话原文（AUDIT-02）
];

/** 最大嵌套深度（超出部分以 [TRUNCATED] 标记） */
export const AUDIT_DETAIL_MAX_DEPTH = 4;
/** 序列化字节上限（JSONB detail 安全网） */
export const AUDIT_DETAIL_MAX_BYTES = 4096;

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const BINARY = "[BINARY]";
const UNSERIALIZABLE = "[UNSERIALIZABLE]";

/** 键切词：驼峰边界 + 非字母数字分隔符，全部小写 */
function keyWords(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map((word) => word.toLowerCase());
}

/**
 * 敏感键判定（按词匹配）：
 * - 任一词 ∈ 敏感单词；或相邻两词组成敏感短语；或规范化整键 ∈ 精确表。
 */
export function isSensitiveKey(key: string): boolean {
	const words = keyWords(key);
	if (words.length === 0) return false;
	const normalized = words.join("");
	if ((SENSITIVE_EXACT_KEYS as readonly string[]).includes(normalized)) {
		return true;
	}
	if (words.some((word) => (SENSITIVE_WORDS as readonly string[]).includes(word))) {
		return true;
	}
	for (let index = 0; index + 1 < words.length; index += 1) {
		const phrase = `${words[index]} ${words[index + 1]}`;
		if ((SENSITIVE_PHRASES as readonly string[]).includes(phrase)) {
			return true;
		}
	}
	return false;
}

function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function sanitizeValue(value: unknown, depth: number): unknown {
	if (value === null || value === undefined) return null;
	if (depth >= AUDIT_DETAIL_MAX_DEPTH) return TRUNCATED;

	// 标量：BigInt 不可 JSON 序列化 → 十进制字符串；其余原样
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "object") return value;

	// 二进制：可能是原始密钥/令牌字节，不尝试解码
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
		return BINARY;
	}
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value.toISOString();
	}

	// 类实例/内置对象（Decimal、URL…）：取其 JSON 值，避免枚举内部状态
	if (!isPlainObject(value) && !Array.isArray(value)) {
		const toJSON = (value as { toJSON?: unknown }).toJSON;
		if (typeof toJSON === "function") {
			return sanitizeValue(
				(toJSON as () => unknown).call(value),
				depth + 1,
			);
		}
		return String(value);
	}

	if (Array.isArray(value)) {
		return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
	}

	const result: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (inner === undefined) continue; // JSON 语义：undefined 属性不落库
		result[key] = isSensitiveKey(key)
			? REDACTED
			: sanitizeValue(inner, depth + 1);
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

/** 敏感剥离 + 类型安全序列化 + 深度截断 + 字节上限；纯函数、确定性、永不抛错 */
export function sanitizeAuditDetail(raw: unknown): unknown {
	try {
		const sanitized = sanitizeValue(raw, 0);
		if (serializedBytes(sanitized) <= AUDIT_DETAIL_MAX_BYTES) {
			return sanitized;
		}
		const compacted = compactValue(sanitized, 0);
		if (serializedBytes(compacted) <= AUDIT_DETAIL_MAX_BYTES) {
			return compacted;
		}
		// 仍超限：以预览结构降级（审计行本身仍落库，业务写不被阻断）
		return {
			truncated: true,
			preview: (JSON.stringify(compacted) ?? "").slice(0, 512),
		};
	} catch {
		return { truncated: true, preview: UNSERIALIZABLE };
	}
}
