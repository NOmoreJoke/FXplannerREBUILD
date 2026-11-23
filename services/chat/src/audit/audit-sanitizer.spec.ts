import { describe, expect, it } from "vitest";

import {
	AUDIT_DETAIL_MAX_BYTES,
	sanitizeAuditDetail,
} from "./audit-sanitizer";

/** 审计脱敏防愚弄测试（AUDIT-02 / §13.2；W16 必配） */

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
