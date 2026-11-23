import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";

import {
	AUDIT_DETAIL_MAX_BYTES,
	isSensitiveKey,
	sanitizeAuditDetail,
} from "./audit-sanitizer";

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
