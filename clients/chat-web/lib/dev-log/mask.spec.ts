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

	// 评审 R2-I12：此前只匹配明文斜杠，编码态的 token 原样落盘
	describe("邀请 token 的 URL 编码态与 JSON 转义串", () => {
		/** 工厂生成的占位邀请 token（base64url 字符集；非真实凭据） */
		const inviteToken = () =>
			`tok_${Math.random().toString(36).slice(2)}${Math.random()
				.toString(36)
				.slice(2)}`;

		it("登录页回跳参数里的编码态路径脱敏（%2F 大小写不敏感），其余查询参数保留", () => {
			const value = inviteToken();
			expect(
				maskSensitiveText(`/login?redirect=%2Finvitations%2F${value}&next=1`),
			).toBe("/login?redirect=%2Finvitations%2F***&next=1");
			expect(
				maskSensitiveText(`Referer: /login?redirect=%2forganization-invitations%2f${value}`),
			).toBe("Referer: /login?redirect=%2forganization-invitations%2f***");
		});

		// 评审 R3-I05：此前只匹配单层编码，多层编码（%252F、%25252F）的 token 原样落盘
		it("多层编码态（%252F / %25252F）：redirect 参数被整体再编码时出现，同样脱敏", () => {
			const value = inviteToken();
			expect(
				maskSensitiveText(`/onboarding?redirect=%252Finvitations%252F${value}`),
			).toBe("/onboarding?redirect=%252Finvitations%252F***");
			// 登录 → 向导 → 邀请页：redirect 参数被整体再编码一次
			expect(
				maskSensitiveText(
					`/login?redirect=%2Fonboarding%3Fredirect%3D%252Finvitations%252F${value}`,
				),
			).toBe("/login?redirect=%2Fonboarding%3Fredirect%3D%252Finvitations%252F***");
			expect(
				maskSensitiveText(`redirect=%25252Finvitations%25252F${value}`),
			).toBe("redirect=%25252Finvitations%25252F***");
			expect(
				maskSensitiveText(`redirect=%252forganization-invitations%252f${value}`),
			).toBe("redirect=%252forganization-invitations%252f***");
		});

		it("多层编码规则不误伤无关路径", () => {
			expect(maskSensitiveText("/login?redirect=%252Fhome%252Fsettings")).toBe(
				"/login?redirect=%252Fhome%252Fsettings",
			);
		});

		it("JSON 转义串：token 后面的 \" 不被吞掉——脱敏后仍是合法 JSON", () => {
			const value = inviteToken();
			// 字符集未排除反斜杠时，token 的匹配会连带吃掉结尾的 \"，留下未转义的引号撑坏 JSON
			const masked = maskSensitiveText(
				JSON.stringify({ url: `https://app.example.com/invitations/${value}` }),
			);
			expect(masked).not.toContain(value);
			expect(JSON.parse(masked)).toEqual({
				url: "https://app.example.com/invitations/***",
			});
		});

		it("API 路径形态只脱敏 token 段，后续路径保留", () => {
			const value = inviteToken();
			expect(
				maskSensitiveText(
					`POST /api/organization-invitations/${value}/accept → 409`,
				),
			).toBe("POST /api/organization-invitations/***/accept → 409");
		});
	});
});
