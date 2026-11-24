import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Prisma } from "@prisma/client";

import {
	AUDIT_DETAIL_MAX_BYTES,
	isSensitiveKey,
	sanitizeAuditDetail,
	SENSITIVE_PHRASES,
} from "./audit-sanitizer";

/** 是否含落单的 UTF-16 代理项（PostgreSQL JSONB 会拒绝，整条业务事务随之回滚） */
function hasLoneSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return true;
		}
	}
	return false;
}

/**
 * 取出产出值里的全部字符串并断言良构。必须检查值本身而不是 JSON.stringify 的结果：
 * JSON.stringify 会把落单代理项转义成 \\udXXX 文本，先序列化再检查永远查不到缺陷。
 */
function expectWellFormedUtf16(value: unknown, label: string): void {
	const strings: string[] = [];
	const collect = (node: unknown) => {
		if (typeof node === "string") strings.push(node);
		else if (Array.isArray(node)) node.forEach(collect);
		else if (node !== null && typeof node === "object") {
			Object.values(node).forEach(collect);
		}
	};
	collect(value);
	for (const text of strings) {
		expect(hasLoneSurrogate(text), `${label}：${JSON.stringify(text.slice(0, 40))}…`).toBe(
			false,
		);
	}
}

/**
 * 审计脱敏防愚弄测试（AUDIT-02 / §13.2；W16 必配；评审 I-14 词根匹配）。
 * 夹具里的「凭据值」全部是工厂生成的占位样本（非真实凭据）。
 */
const sample = (label: string): string => `sample-${label}`;

describe("isSensitiveKey：按词匹配（覆盖仓内真实字段名，不误伤业务字段）", () => {
	it("真实敏感字段名全部命中（全等表此前全部漏网）", () => {
		for (const key of [
			"accessToken",
			"refreshToken",
			"password_hash",
			"token_hash",
			"code_hash",
			"codeHash",
			"api_key",
			"x-api-key",
			"Authorization",
			"HTTP_AUTHORIZATION",
			"devCode",
			"otpCode",
			"verificationCode",
			"sessionId",
			"session_id",
			"clientSecret",
			"cookie",
			"Set-Cookie",
			"privateKey",
			"credentials",
			"otp",
			"messages",
			"code",
		]) {
			expect(isSensitiveKey(key), `键 ${key} 应判敏感`).toBe(true);
		}
	});

	it("业务字段不误伤", () => {
		for (const key of [
			"currencyCode",
			"errorCode",
			"statusCode",
			"httpCode",
			"postalCode",
			"inputTokens",
			"outputTokens",
			"message",
			"planId",
			"baseCurrency",
			"requestedAt",
			"actorUserId",
			"organizationId",
			"targetType",
		]) {
			expect(isSensitiveKey(key), `键 ${key} 不应判敏感`).toBe(false);
		}
	});

	it("R2-I04：缩写 + 大写词、复数、凭据头名此前全部漏网，现全部命中", () => {
		for (const key of [
			// 缩写边界未拆：otpcode / smscode / devcode / jwttoken / httpsecret 不在词表
			"OTPCode",
			"SMSCode",
			"DEVCode",
			"JWTToken",
			"HTTPSecret",
			"IDToken",
			"APIKey",
			"XAPIKey",
			// 复数形态
			"cookies",
			"secrets",
			"passwords",
			"passcodes",
			// 凭据头名 / 复合词
			"bearer",
			"AuthorizationBearer",
			"accessKey",
			"secretKey",
			"clientSecret",
			"signingSecret",
			"X-API-Key",
			"jwt",
			"JWT",
			"jwtToken",
			"otpCode",
			"xapikey",
		]) {
			expect(isSensitiveKey(key), `键 ${key} 应判敏感`).toBe(true);
		}
	});

	it("R2-I04：补缩写切词后，业务键不被误伤（缩写 + 词 / *Key / *Code / *Count）", () => {
		for (const key of [
			"currencyCode",
			"errorCode",
			"httpStatus",
			"UTCOffset",
			"ISOCode",
			"FXRate",
			"USDAmount",
			"dedupKey",
			"idempotencyKey",
			"sortKey",
			"keyName",
			"changeCount",
			"planCode",
			"inviteCount",
			"smsProvider",
		]) {
			expect(isSensitiveKey(key), `键 ${key} 不应判敏感`).toBe(false);
		}
	});

	// 评审 R3-N4：切词后「key2 / keys」不是词表里的「key」，带序号 / 复数的复合键漏网
	it("R3-N4：带序号后缀 / 名词复数的复合键命中", () => {
		for (const key of [
			"apiKey2",
			"apiKey_2",
			"API_KEY2",
			"apiKeys",
			"accessKeys",
			"accessKey3",
			"privateKeys",
			"privateKey2",
			"sessionKeys",
			"sessionIds",
			"sessionKey2",
			"authCodes",
			"authCode2",
			"devCodes",
			"smsCodes",
			"emailCodes",
			"verificationCodes",
			"invitationCodes",
			"loginCodes",
			"securityCodes",
			"idTokens",
			"xapiKeys",
			// 单词表的词带序号
			"cvv2",
			"otp2",
			"pwd1",
			"secretKey2",
		]) {
			expect(isSensitiveKey(key), `键 ${key} 应判敏感`).toBe(true);
		}
		// 序号 / 复数本身不构成敏感：复合词仍须含敏感词
		for (const key of [
			"keys",
			"key2",
			"ids",
			"id2",
			"accounts",
			"indexes",
			"codes",
			"count2",
			"page2",
			"limit2",
			"orgKeys",
			"cacheKeys",
		]) {
			expect(isSensitiveKey(key), `键 ${key} 不应判敏感`).toBe(false);
		}
	});
});

describe("isSensitiveKey：词形归一的属性测试（评审 R3-N4）", () => {
	/** 两词的拼接风格：直接相连 / 驼峰 / 下划线 / 中划线 */
	const joinStyles = [
		(head: string, tail: string) => `${head}${tail}`,
		(head: string, tail: string) =>
			`${head}${tail.charAt(0).toUpperCase()}${tail.slice(1)}`,
		(head: string, tail: string) => `${head}_${tail}`,
		(head: string, tail: string) => `${head}-${tail}`,
	];
	const withOrdinal = (word: string, ordinal: number) =>
		word + (ordinal === 0 ? "" : String(ordinal));

	it("任一敏感短语：任一词带序号、末词带复数（序号在复数前或后）→ 任意拼接风格都判敏感", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...SENSITIVE_PHRASES),
				fc.nat(999),
				fc.nat(999),
				fc.constantFrom("", "s", "es"),
				fc.boolean(),
				fc.nat(joinStyles.length - 1),
				(phrase, headOrdinal, tailOrdinal, plural, pluralFirst, styleIndex) => {
					const [head, tail] = phrase.split(" ") as [string, string];
					// 全小写直接相连时词与词之间没有可切分的边界：词首序号只对带分隔信息的
					// 风格（驼峰 / 下划线 / 中划线）生成——api1key 不是真实的键名形态
					const headWord =
						styleIndex === 0 ? head : withOrdinal(head, headOrdinal);
					const tailWord = pluralFirst
						? withOrdinal(`${tail}${plural}`, tailOrdinal)
						: `${withOrdinal(tail, tailOrdinal)}${plural}`;
					const key = joinStyles[styleIndex]!(headWord, tailWord);
					expect(isSensitiveKey(key), `键 ${key}`).toBe(true);
				},
			),
		);
	});

	it("对偶：不含敏感词的业务复合键，加序号 / 复数后仍不判敏感", () => {
		const businessWords = [
			"currency",
			"account",
			"count",
			"page",
			"limit",
			"status",
			"error",
			"plan",
			"rate",
			"amount",
			"index",
			"usage",
			"name",
			"total",
		];
		fc.assert(
			fc.property(
				fc.constantFrom(...businessWords),
				fc.constantFrom(...businessWords),
				fc.nat(999),
				fc.nat(999),
				fc.constantFrom("", "s", "es"),
				fc.boolean(),
				fc.constantFrom(...joinStyles),
				(head, tail, headOrdinal, tailOrdinal, plural, pluralFirst, join) => {
					const tailWord = pluralFirst
						? withOrdinal(`${tail}${plural}`, tailOrdinal)
						: `${withOrdinal(tail, tailOrdinal)}${plural}`;
					const key = join(withOrdinal(head, headOrdinal), tailWord);
					expect(isSensitiveKey(key), `键 ${key}`).toBe(false);
				},
			),
		);
	});
});

describe("sanitizeAuditDetail：产出必须是合法 JSON 值（评审 R2-I04「永不阻断业务写」）", () => {
	/** 模拟 Prisma 对 JSONB detail 的校验：任何非 JSON 值都会让 create 被拒绝 */
	function assertJsonRoundTrip(value: unknown): unknown {
		const serialized = JSON.stringify(value);
		expect(serialized).toBeDefined();
		return JSON.parse(serialized);
	}

	it("NaN / Infinity / -Infinity → null；function / Symbol → null", () => {
		const result = sanitizeAuditDetail({
			notANumber: Number.NaN,
			positive: Number.POSITIVE_INFINITY,
			negative: Number.NEGATIVE_INFINITY,
			fn: () => "leak",
			symbol: Symbol("leak"),
			fine: 1.5,
			zero: 0,
			text: "x",
		}) as Record<string, unknown>;
		expect(result).toEqual({
			notANumber: null,
			positive: null,
			negative: null,
			fn: null,
			symbol: null,
			fine: 1.5,
			zero: 0,
			text: "x",
		});
		expect(JSON.stringify(result)).not.toContain("leak");
		// 嵌套与数组内同样成立（数组里的 undefined / function 按 JSON 语义为 null）
		const nested = sanitizeAuditDetail({
			list: [Number.NaN, undefined, () => 1, Symbol("s"), 2],
			deep: { inner: { value: Number.POSITIVE_INFINITY } },
		}) as Record<string, unknown>;
		expect(nested.list).toEqual([null, null, null, null, 2]);
		expect(nested.deep).toEqual({ inner: { value: null } });
		expect(assertJsonRoundTrip(result)).toEqual(result);
	});

	it("任意二进制视图 / ArrayBuffer → [BINARY]，不以十进制明文串化", () => {
		const secretBytes = [7, 5, 3, 9, 1];
		const result = sanitizeAuditDetail({
			buffer: Buffer.from(secretBytes),
			uint8: new Uint8Array(secretBytes),
			int32: new Int32Array(secretBytes),
			float64: new Float64Array([1.25, 2.5]),
			dataView: new DataView(new Uint8Array(secretBytes).buffer),
			arrayBuffer: new Uint8Array(secretBytes).buffer,
		}) as Record<string, unknown>;
		expect(Object.values(result)).toEqual(
			Array.from({ length: 6 }, () => "[BINARY]"),
		);
		expect(JSON.stringify(result)).not.toContain("7,5,3");
		expect(JSON.stringify(result)).not.toContain("1.25");
	});

	it("自有 __proto__ 键被跳过：不改写原型、不产生污染、其余键照常保留", () => {
		// JSON.parse 会把 "__proto__" 作为自有可枚举键保留（对象字面量写法不会）
		const hostile = JSON.parse(
			'{"__proto__":{"polluted":"yes","role":"OWNER"},"safe":1}',
		) as Record<string, unknown>;
		expect(Object.prototype.hasOwnProperty.call(hostile, "__proto__")).toBe(true);
		const result = sanitizeAuditDetail(hostile) as Record<string, unknown>;
		expect(Object.keys(result)).toEqual(["safe"]);
		expect(result.safe).toBe(1);
		expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
		expect((result as { polluted?: unknown }).polluted).toBeUndefined();
		expect((result as { role?: unknown }).role).toBeUndefined();
		// 嵌套层同样跳过
		const nested = sanitizeAuditDetail({
			outer: JSON.parse('{"__proto__":{"x":1},"kept":2}'),
		}) as { outer: Record<string, unknown> };
		expect(Object.keys(nested.outer)).toEqual(["kept"]);
	});

	it("toJSON 抛错或返回自身、无原型对象：单值占位，不拖垮整条 detail、不无限递归", () => {
		// 类实例（原型不是 Object.prototype）才走 toJSON 分支
		class SelfReferential {
			toJSON(this: unknown) {
				return this;
			}
		}
		class Throwing {
			toJSON(): never {
				throw new Error("boom");
			}
		}
		/** 无 toJSON、且转字符串会抛错的类实例 */
		class Unprintable {
			toString(): never {
				throw new Error("unprintable");
			}
		}
		// 无原型对象按普通对象枚举（不是类实例分支），其属性照常保留
		const nullProto = Object.create(null) as Record<string, unknown>;
		nullProto.kept = 2;
		const result = sanitizeAuditDetail({
			self: new SelfReferential(),
			throwing: new Throwing(),
			unprintable: new Unprintable(),
			nullProto,
			planId: "p1",
		}) as Record<string, unknown>;
		expect(result.planId).toBe("p1");
		// toJSON 返回自身：靠深度上限终止，不会栈溢出
		expect(result.self).toBe("[TRUNCATED]");
		expect(result.throwing).toBe("[UNSERIALIZABLE]");
		expect(result.unprintable).toBe("[UNSERIALIZABLE]");
		expect(result.nullProto).toEqual({ kept: 2 });
	});
});

describe("sanitizeAuditDetail：值的类型安全序列化（评审 I-14）", () => {
	it("Date → ISO 字符串（此前被 Object.entries 抹成 {}）", () => {
		const at = new Date("2026-11-23T00:00:00.000Z");
		const result = sanitizeAuditDetail({ requestedAt: at }) as {
			requestedAt: unknown;
		};
		expect(result.requestedAt).toBe("2026-11-23T00:00:00.000Z");
	});

	it("BigInt → 字符串（此前令整条 detail 崩为不可序列化）", () => {
		const result = sanitizeAuditDetail({ count: 9007199254740993n }) as {
			count: unknown;
		};
		expect(result.count).toBe("9007199254740993");
		expect(() => JSON.stringify(result)).not.toThrow();
	});

	it("带 toJSON 的类实例取其 JSON 值（Prisma Decimal）", () => {
		const result = sanitizeAuditDetail({
			amount: new Prisma.Decimal("1234.5000"),
		}) as { amount: unknown };
		expect(result.amount).toBe("1234.5");
	});

	it("二进制不尝试解码；undefined 属性不落库；Invalid Date → null", () => {
		const result = sanitizeAuditDetail({
			blob: Buffer.from(sample("bytes")),
			skipped: undefined,
			kept: 1,
			badDate: new Date(Number.NaN),
		}) as Record<string, unknown>;
		expect(result.blob).toBe("[BINARY]");
		expect(JSON.stringify(result)).not.toContain(sample("bytes"));
		expect("skipped" in result).toBe(false);
		expect(result.kept).toBe(1);
		expect(result.badDate).toBeNull();
	});

	it("嵌套的真实凭据字段全部脱敏，且降级预览路径同样不泄露", () => {
		const [jwt, key, access, refresh, hash, otp] = [
			sample("jwt"),
			sample("key"),
			sample("access"),
			sample("refresh"),
			sample("hash"),
			sample("otp"),
		];
		const detail = {
			headers: {
				authorization: jwt,
				"x-api-key": key,
				"content-type": "application/json",
			},
			auth: { accessToken: access, refreshToken: refresh },
			passwordHash: hash,
			devCode: otp,
			currencyCode: "USD",
			errorCode: "RATE_UNAVAILABLE",
		};
		const result = sanitizeAuditDetail(detail) as Record<string, unknown>;
		const serialized = JSON.stringify(result);
		for (const leak of [jwt, key, access, refresh, hash, otp]) {
			expect(serialized).not.toContain(leak);
		}
		expect((result.headers as Record<string, unknown>)["content-type"]).toBe(
			"application/json",
		);
		expect(result.currencyCode).toBe("USD");
		expect(result.errorCode).toBe("RATE_UNAVAILABLE");

		// 降级路径：构造有损压缩后仍超限的 detail，预览里同样只有 [REDACTED]
		const secret = sample("preview-leak");
		const huge: Record<string, unknown> = {};
		huge["api" + "Key"] = secret;
		for (let index = 0; index < 400; index += 1) {
			huge[`field${index}`] = Array.from({ length: 10 }, () => "x".repeat(300));
		}
		const degraded = sanitizeAuditDetail(huge) as {
			truncated: boolean;
			preview: string;
		};
		expect(degraded.truncated).toBe(true);
		expect(degraded.preview).not.toContain(secret);
		expect(Buffer.byteLength(JSON.stringify(degraded))).toBeLessThanOrEqual(
			AUDIT_DETAIL_MAX_BYTES,
		);
	});
});

describe("sanitizeAuditDetail：敏感字段剥离", () => {
	it("顶层敏感键替换为 [REDACTED]，保留键位", () => {
		const result = sanitizeAuditDetail({
			password: "hunter2",
			token: "raw-jwt",
			tokenHash: "abc",
			code: "123456",
			codeHash: "def",
			secret: "s",
			apiKey: "k",
			messages: [{ role: "user", content: "原文会话" }],
			planId: "plan-1",
		}) as Record<string, unknown>;
		expect(result.password).toBe("[REDACTED]");
		expect(result.token).toBe("[REDACTED]");
		expect(result.tokenHash).toBe("[REDACTED]");
		expect(result.code).toBe("[REDACTED]");
		expect(result.codeHash).toBe("[REDACTED]");
		expect(result.secret).toBe("[REDACTED]");
		expect(result.apiKey).toBe("[REDACTED]");
		expect(result.messages).toBe("[REDACTED]");
		expect(result.planId).toBe("plan-1");
	});

	it("嵌套任意层的敏感键同样剥离（大小写不敏感）", () => {
		const result = sanitizeAuditDetail({
			before: { Password: "x", nested: { APIKEY: "y", keep: 1 } },
		}) as { before: { Password: string; nested: Record<string, unknown> } };
		expect(result.before.Password).toBe("[REDACTED]");
		expect(result.before.nested.APIKEY).toBe("[REDACTED]");
		expect(result.before.nested.keep).toBe(1);
	});

	it("非敏感键原样保留（金额/ID/快照可审计）", () => {
		const detail = {
			targetAmount: "300.0000",
			before: { amount: "250.0000" },
			tags: ["A", "B"],
		};
		expect(sanitizeAuditDetail(detail)).toEqual(detail);
	});
});

describe("sanitizeAuditDetail：深度与字节上限", () => {
	it("超过最大深度的嵌套以 [TRUNCATED] 标记", () => {
		const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
		const result = sanitizeAuditDetail(deep) as {
			a: { b: { c: { d: unknown } } };
		};
		expect(result.a.b.c.d).toBe("[TRUNCATED]");
	});

	it("深度上限 − 1 处的 Decimal 不被多计一层而截断；上限处的容器仍截断", () => {
		// 顶层调用深度为 0：a 的值在深度 1、b 的值在深度 2、c 与 flag 的值在深度 3（上限 4）
		const result = sanitizeAuditDetail({
			a: { b: { c: new Prisma.Decimal("1234.5000"), flag: true } },
			// d 的值在深度 4
			over: { b: { c: { d: new Prisma.Decimal("1") } } },
		}) as {
			a: { b: { c: unknown; flag: unknown } };
			over: { b: { c: { d: unknown } } };
		};
		// 与 Decimal 同深度的兄弟标量保留；修复前 Decimal 经 toJSON 多计一层，其字符串值
		// 落在深度 4 而被截断为 [TRUNCATED]
		expect(result.a.b.flag).toBe(true);
		expect(result.a.b.c).toBe("1234.5");
		// 深度 4 处的对象（含 Decimal）仍整体截断
		expect(result.over.b.c.d).toBe("[TRUNCATED]");
	});

	it("超大 detail 先有损压缩再降级 preview，字节不超上限且不抛错", () => {
		const huge = {
			blob: "x".repeat(10_000),
			list: Array.from({ length: 500 }, (_, i) => ({ i, s: "y".repeat(50) })),
			password: "leak",
		};
		const result = sanitizeAuditDetail(huge) as Record<string, unknown>;
		const bytes = Buffer.byteLength(JSON.stringify(result));
		expect(bytes).toBeLessThanOrEqual(AUDIT_DETAIL_MAX_BYTES);
		// 敏感键即便走降级路径也不泄露原文
		expect(JSON.stringify(result)).not.toContain("leak");
	});

	// 评审 R3-P1：按 UTF-16 单元截断会把 4 字节 emoji 的代理对截成两半
	it("R3-P1：有损压缩与降级预览按码点截断——不把 emoji 代理对截成两半", () => {
		const emoji = "\u{1F600}".repeat(300);
		// 值前缀长度取遍一个周期：旧实现按 UTF-16 单元截断，切点是否落在代理对中间
		// 取决于其前面单元数的奇偶——只测一种前缀会因奇偶碰巧而假绿
		for (const prefixLength of [0, 1, 2, 3, 4, 5]) {
			const value = `${"x".repeat(prefixLength)}${emoji}`;
			const detail = Object.fromEntries(
				Array.from({ length: 12 }, (_, index) => [`note${index}`, value]),
			);
			const result = sanitizeAuditDetail(detail);
			const label = `值前缀长度 ${prefixLength}`;
			// 两条截断路径都被走到：先有损压缩（仍超限）→ 降级预览
			expect((result as Record<string, unknown>).truncated, label).toBe(true);
			expectWellFormedUtf16(result, label);
			expect(Buffer.byteLength(JSON.stringify(result)), label).toBeLessThanOrEqual(
				AUDIT_DETAIL_MAX_BYTES,
			);
		}
	});

	it("R3-P1 属性：任意文本、任意规模的 detail，产出都是良构 UTF-16 且不超字节上限", () => {
		// 约一半取值是 4 字节字符（UTF-16 下占两个单元），保证切点经常落在其内部
		const text = fc
			.array(
				fc.constantFrom("😀", "🎉", "𝒳", "🇨🇳", "a", "b", "中", " "),
				{ maxLength: 300 },
			)
			.map((chars) => chars.join(""));
		fc.assert(
			fc.property(text, fc.integer({ min: 1, max: 16 }), fc.nat(7), (value, fields, prefixLength) => {
				const prefixed = `${"x".repeat(prefixLength)}${value}`;
				const detail = Object.fromEntries(
					Array.from({ length: fields }, (_, index) => [`k${index}`, prefixed]),
				);
				const label = `值 ${JSON.stringify(prefixed)}（${fields} 个字段）`;
				const result = sanitizeAuditDetail(detail);
				expectWellFormedUtf16(result, label);
				expect(Buffer.byteLength(JSON.stringify(result)), label).toBeLessThanOrEqual(
					AUDIT_DETAIL_MAX_BYTES,
				);
			}),
		);
	});

	it("循环引用被深度截断安全终止（可序列化、不抛错、不泄露无限嵌套）", () => {
		const circular: Record<string, unknown> = { name: "ok" };
		circular.self = circular;
		const result = sanitizeAuditDetail(circular) as Record<string, unknown>;
		expect(result.name).toBe("ok");
		// 深度上限终止递归：序列化不抛错且字节有限
		const serialized = JSON.stringify(result);
		expect(serialized).toContain("[TRUNCATED]");
		expect(Buffer.byteLength(serialized)).toBeLessThan(
			AUDIT_DETAIL_MAX_BYTES,
		);
	});
});
