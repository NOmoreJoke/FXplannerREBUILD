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
 *   BigInt 令整条 detail 崩为不可序列化）；产出必须是合法 JSON 值——NaN / Infinity /
 *   function / Symbol 不是 JSON 值，原样交给 Prisma 会被 JSONB 校验拒绝并回滚整个
 *   业务事务（评审 R2-I04）；
 * - 自有 "__proto__" 键直接跳过：对普通对象赋值该键会改写原型而非创建属性（R2-I04）；
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
	// 凭据头名与无分隔整词（评审 R2-I04：下列键此前全部漏网）
	"jwt",
	"bearer",
	"xapikey",
	// 复数形态（词表按整词精确匹配，不复数归一——tokens / keys 在本仓是模型用量等业务字段）
	"passwords",
	"secrets",
	"cookies",
	"passcodes",
];

/** 敏感短语（相邻两词拼接后命中即脱敏；导出供属性测试枚举） */
export const SENSITIVE_PHRASES: readonly string[] = [
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
	// 凭据类复合词（切词后成为两个词，按短语匹配；评审 R2-I04）
	"access key",
	"secret key",
	"client secret",
	"signing secret",
	// X-API-Key 的驼峰缩写形态 XAPIKey 切词为 xapi + key
	"xapi key",
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

/**
 * 键切词：驼峰边界 + 缩写边界 + 非字母数字分隔符，全部小写。
 * 缩写边界（评审 R2-I04）：只拆 ([a-z0-9])([A-Z]) 时，OTPCode / JWTToken / HTTPSecret
 * 这类「大写缩写 + 首字母大写的词」不会被拆开，整词 otpcode / jwttoken 不在词表里
 * 而全部漏网。
 */
function keyWords(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map((word) => word.toLowerCase());
}

/**
 * 去掉词尾序号（评审 R3-N4）：键名带序号是常见写法（apiKey2 / secretKey3），
 * 序号不改变词本身的含义。
 */
function withoutOrdinal(word: string): string {
	return word.replace(/[0-9]+$/, "");
}

/**
 * 短语匹配用的词形候选（评审 R3-N4）：原词、去复数（s / es）、去序号及其组合。
 * 只用于**短语**匹配——apiKeys / accessKey2 的第二个词不再是词表里的 key，整个
 * 短语随之漏网。单词表不做复数归一：tokens / keys 在本仓是模型用量等业务字段。
 */
function phraseForms(word: string): string[] {
	const forms = new Set<string>();
	for (const base of [word, withoutOrdinal(word)]) {
		forms.add(base);
		if (base.endsWith("es")) forms.add(base.slice(0, -2));
		if (base.endsWith("s")) forms.add(base.slice(0, -1));
	}
	// 复数在前、序号在后（keys2）：去复数之后还要再去一次序号
	for (const form of [...forms]) {
		const stripped = withoutOrdinal(form);
		if (stripped) forms.add(stripped);
	}
	return [...forms].filter(Boolean);
}

/**
 * 无分隔符的整词写法（accesstoken / authcode）：切词切不开，短语规则匹配不到。
 * 词表只手工收录了其中一部分（apikey / privatekey …），这里按敏感短语拼接派生全集，
 * 不再手工同步两处。
 */
const SENSITIVE_COMPOUNDS: ReadonlySet<string> = new Set(
	SENSITIVE_PHRASES.map((phrase) => phrase.replaceAll(" ", "")),
);

/**
 * 敏感键判定（按词匹配）：
 * - 任一词 ∈ 敏感单词；或相邻两词组成敏感短语；或规范化整键 ∈ 精确表；
 * - 整键（去分隔符、去词尾序号）是敏感短语的无分隔符写法。
 * 词尾序号不参与比对（评审 R3-N4）；整键精确表例外——带序号的 code2 是否算
 * 验证码本体不做推断，按原样比对。
 */
export function isSensitiveKey(key: string): boolean {
	const rawWords = keyWords(key);
	if (rawWords.length === 0) return false;
	const joined = rawWords.join("");
	if ((SENSITIVE_EXACT_KEYS as readonly string[]).includes(joined)) {
		return true;
	}
	if (phraseForms(joined).some((form) => SENSITIVE_COMPOUNDS.has(form))) {
		return true;
	}
	const words = rawWords.map(withoutOrdinal);
	if (words.some((word) => (SENSITIVE_WORDS as readonly string[]).includes(word))) {
		return true;
	}
	for (let index = 0; index + 1 < words.length; index += 1) {
		const head = words[index];
		const tail = words[index + 1];
		if (head === undefined || tail === undefined) continue;
		for (const headForm of phraseForms(head)) {
			for (const tailForm of phraseForms(tail)) {
				const phrase = `${headForm} ${tailForm}`;
				if ((SENSITIVE_PHRASES as readonly string[]).includes(phrase)) {
					return true;
				}
			}
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

	// 标量：产出必须是合法 JSON 值（评审 R2-I04「永不阻断业务写」）
	// - BigInt 不可 JSON 序列化 → 十进制字符串
	// - NaN / ±Infinity：JSON 语义下就是 null；原样交给 Prisma 会被 JSONB 校验拒绝
	// - function / symbol 不是 JSON 值 → null
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "function" || typeof value === "symbol") {
		return null;
	}
	if (typeof value !== "object") return value;

	// 二进制：Buffer / 任何 ArrayBuffer 视图（含 DataView、各类 TypedArray）/
	// ArrayBuffer——可能是原始密钥/令牌字节，不尝试解码。只拦 Buffer/Uint8Array 时，
	// 其余视图会被下面的 String(value) 以十进制明文串化（评审 R2-I04）
	if (
		Buffer.isBuffer(value) ||
		value instanceof ArrayBuffer ||
		ArrayBuffer.isView(value)
	) {
		return BINARY;
	}
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value.toISOString();
	}

	// 类实例/内置对象（Decimal、URL…）：取其 JSON 值，避免枚举内部状态
	if (!isPlainObject(value) && !Array.isArray(value)) {
		const toJSON = (value as { toJSON?: unknown }).toJSON;
		if (typeof toJSON === "function") {
			try {
				const json = (toJSON as () => unknown).call(value);
				// 标量就是该对象的 JSON 值，不额外占一层（深度上限 − 1 处的 Decimal
				// 此前被多计一层而截断）；仍是容器则占一层——toJSON 返回自身时靠
				// 深度上限终止，不会无限递归
				return sanitizeValue(
					json,
					typeof json === "object" && json !== null ? depth + 1 : depth,
				);
			} catch {
				return UNSERIALIZABLE;
			}
		}
		try {
			return String(value);
		} catch {
			// 无原型对象等不可转原始值的输入：单值占位，不拖垮整条 detail
			return UNSERIALIZABLE;
		}
	}

	if (Array.isArray(value)) {
		return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
	}

	const result: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (inner === undefined) continue; // JSON 语义：undefined 属性不落库
		// 原型污染防线（评审 R2-I04）：JSON.parse 产生的自有 "__proto__" 键，
		// 对普通对象赋值会改写其原型而非创建属性。审计 detail 不存在合法的该键
		if (key === "__proto__") continue;
		result[key] = isSensitiveKey(key)
			? REDACTED
			: sanitizeValue(inner, depth + 1);
	}
	return result;
}

/**
 * 按码点截断（评审 R3-P1）：不把 4 字节字符的代理对截成两半。落单的代理项不是合法
 * Unicode 文本，PostgreSQL JSONB 会拒绝，审计写失败连带着整条业务事务回滚。
 */
function truncateCodePoints(value: string, maxCodePoints: number): string {
	const codePoints = Array.from(value);
	if (codePoints.length <= maxCodePoints) return value;
	return codePoints.slice(0, maxCodePoints).join("");
}

/** 有损压缩一轮：字符串 200 码点、数组 10 项、对象前 20 键（逐层递归） */
function compactValue(value: unknown, depth: number): unknown {
	if (typeof value === "string") {
		const codePoints = Array.from(value);
		return codePoints.length > 200
			? `${codePoints.slice(0, 200).join("")}…`
			: value;
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
			preview: truncateCodePoints(JSON.stringify(compacted) ?? "", 512),
		};
	} catch {
		return { truncated: true, preview: UNSERIALIZABLE };
	}
}
