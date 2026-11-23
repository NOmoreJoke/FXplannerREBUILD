import { describe, expect, it } from "vitest";
import { maskSensitiveText } from "./mask";

describe("maskSensitiveText（前端）", () => {
	it("脱敏 Bearer / query token / JSON 敏感字段", () => {
		expect(maskSensitiveText("Bearer abc.def")).toBe("Bearer ***");
		expect(maskSensitiveText("/api/x?token=secret1&a=1")).toBe(
			"/api/x?token=***&a=1",
		);
		expect(maskSensitiveText('{"password":"123456"}')).toBe(
			'{"password":"***"}',
		);
	});

	it("普通文本不受影响", () => {
		expect(maskSensitiveText("TypeError: boom")).toBe("TypeError: boom");
	});

	it("邀请链接路径里的一次性 token 脱敏（URL / 路径 / JSON 载荷），路径本身保留", () => {
		// 邀请 token 是一次性入组凭证：日志里只能留下路径形状，不能留下 token
		expect(maskSensitiveText("GET /invitations/abc123DEFxyz?page=1")).toBe(
			"GET /invitations/***?page=1",
		);
		expect(
			maskSensitiveText("https://app.example.com/invitations/tok_SECRET_9281"),
		).toBe("https://app.example.com/invitations/***");
		expect(
			maskSensitiveText(
				'{"endpoint":"/organization-invitations/tok-XYZ-777","status":404}',
			),
		).toBe('{"endpoint":"/organization-invitations/***","status":404}');
		// 大小写不敏感；相邻业务路径不被误伤
		expect(maskSensitiveText("/INVITATIONS/tok-1")).toBe("/INVITATIONS/***");
		expect(maskSensitiveText("/organization/members")).toBe(
			"/organization/members",
		);
		expect(maskSensitiveText("/invitations")).toBe("/invitations");
	});
});
