import { describe, expect, it } from "vitest";
import { maskSensitiveText, truncate } from "./mask.js";

describe("maskSensitiveText", () => {
	it("脱敏 Bearer Token", () => {
		expect(maskSensitiveText("Authorization: Bearer abc.def.ghi")).toBe(
			"Authorization: Bearer ***",
		);
	});

	it("脱敏 URL query 中的 token/password", () => {
		expect(maskSensitiveText("/api/login?token=abc123&password=pwd&a=1")).toBe(
			"/api/login?token=***&password=***&a=1",
		);
		expect(maskSensitiveText("access_token=xyz")).toBe("access_token=***");
	});

	it("脱敏 JSON 中的 authorization/cookie 头", () => {
		expect(maskSensitiveText('{"authorization":"Bearer abc"}')).toBe(
			'{"authorization":"***"}',
		);
		expect(maskSensitiveText('{"cookie":"session=abc"}')).toBe(
			'{"cookie":"***"}',
		);
	});

	it("脱敏 JSON 中的 password/token 字段", () => {
		expect(maskSensitiveText('{"password":"123456","name":"u"}')).toBe(
			'{"password":"***","name":"u"}',
		);
		expect(maskSensitiveText('{"accessToken":"at","refreshToken":"rt"}')).toBe(
			'{"accessToken":"***","refreshToken":"***"}',
		);
	});

	it("普通文本不受影响", () => {
		expect(
			maskSensitiveText("TypeError: Cannot read properties of undefined"),
		).toBe("TypeError: Cannot read properties of undefined");
	});
});

// 评审 R2-I12：此前服务端没有任何邀请规则——前端漏过一处，一次性邀请 token 就明文落盘
describe("maskSensitiveText：一次性邀请 token（服务端兜底）", () => {
	/** 工厂生成的占位邀请 token（base64url 字符集；非真实凭据） */
	const invite = () =>
		`tok_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

	it("路径明文与 API 路径：只脱敏 token 段", () => {
		const value = invite();
		expect(maskSensitiveText(`https://app.example.com/invitations/${value}`)).toBe(
			"https://app.example.com/invitations/***",
		);
		expect(maskSensitiveText(`POST /api/organization-invitations/${value}/accept`)).toBe(
			"POST /api/organization-invitations/***/accept",
		);
	});

	it("URL 编码态（登录页回跳参数），%2F 大小写不敏感", () => {
		const value = invite();
		expect(maskSensitiveText(`/login?redirect=%2Finvitations%2F${value}&next=1`)).toBe(
			"/login?redirect=%2Finvitations%2F***&next=1",
		);
		expect(maskSensitiveText(`redirect=%2forganization-invitations%2f${value}`)).toBe(
			"redirect=%2forganization-invitations%2f***",
		);
	});

	// 评审 R3-I05：此前只匹配单层编码，多层编码（%252F、%25252F）的 token 原样落盘
	it("多层编码态（%252F / %25252F）：redirect 参数被整体再编码时出现，同样脱敏", () => {
		const value = invite();
		expect(maskSensitiveText(`/onboarding?redirect=%252Finvitations%252F${value}`)).toBe(
			"/onboarding?redirect=%252Finvitations%252F***",
		);
		// 登录 → 向导 → 邀请页：redirect 参数被整体再编码一次
		expect(
			maskSensitiveText(`/login?redirect=%2Fonboarding%3Fredirect%3D%252Finvitations%252F${value}`),
		).toBe("/login?redirect=%2Fonboarding%3Fredirect%3D%252Finvitations%252F***");
		expect(maskSensitiveText(`redirect=%25252Finvitations%25252F${value}`)).toBe(
			"redirect=%25252Finvitations%25252F***",
		);
		expect(maskSensitiveText(`redirect=%252forganization-invitations%252f${value}`)).toBe(
			"redirect=%252forganization-invitations%252f***",
		);
	});

	it("多层编码规则不误伤无关路径", () => {
		expect(maskSensitiveText("/login?redirect=%252Fhome%252Fsettings")).toBe(
			"/login?redirect=%252Fhome%252Fsettings",
		);
	});

	it("上报体是「JSON 里套 JSON 字符串」：脱敏不吞结尾的转义引号，内外两层仍是合法 JSON", () => {
		const value = invite();
		const body = JSON.stringify({
			source: "sentry-browser",
			pageUrl: `http://localhost:3001/invitations/${value}`,
			envelope: [
				JSON.stringify({ event_id: "e1" }),
				JSON.stringify({ type: "event" }),
				JSON.stringify({
					breadcrumbs: [
						{ category: "fetch", data: { url: `/api/organization-invitations/${value}/accept` } },
					],
				}),
			].join("\n"),
		});

		const masked = maskSensitiveText(body);

		expect(masked).not.toContain(value);
		const outer = JSON.parse(masked) as { pageUrl: string; envelope: string };
		expect(outer.pageUrl).toBe("http://localhost:3001/invitations/***");
		// 字符集未排除反斜杠时，内层 token 的匹配会吃掉 \"，留下未转义的引号撑坏内层 JSON
		const inner = JSON.parse(outer.envelope.split("\n")[2] ?? "") as {
			breadcrumbs: Array<{ data: { url: string } }>;
		};
		expect(inner.breadcrumbs[0]?.data.url).toBe(
			"/api/organization-invitations/***/accept",
		);
	});
});

describe("truncate", () => {
	it("超长截断", () => {
		expect(truncate("abcdef", 3)).toBe("abc");
	});

	it("未超长原样返回", () => {
		expect(truncate("abc", 3)).toBe("abc");
	});
});
