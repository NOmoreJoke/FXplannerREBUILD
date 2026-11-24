import { describe, expect, test } from "bun:test";
import { maskSensitiveText as maskWeb } from "../../clients/chat-web/lib/dev-log/mask";
import { maskSensitiveText as maskServer } from "../../packages/dev-log-server/src/mask";

/**
 * 邀请 token 脱敏规则：前端（浏览器侧 beforeSend）与服务端（dev-log-server 兜底）
 * 是两份手工同步的纯函数实现——dev-log-server 按包边界不依赖 chat-web，规则无法
 * 共享一份源码。两份规则已各自漂移过两次：评审 R2-I12（服务端完全没有邀请规则）、
 * R3-I05（两边都漏了多层编码）。本用例用同一组向量同时跑两份实现：任何一边单独
 * 改动规则，都会在这里变红。
 */
describe("邀请 token 脱敏：前端 / 服务端两份实现一致", () => {
	/** 工厂生成的占位邀请 token（base64url 字符集；非真实凭据） */
	const token = "tok_QUJDREVGR0hJSktMTU5PUFFSU1RVVndYWV";
	const masked = (template: string) => template.replace("<token>", "***");
	const input = (template: string) => template.replace("<token>", token);

	/** 覆盖两条邀请规则的全部形态：路径明文、API 路径、单层 / 多层编码态 */
	const templates = [
		"https://app.example.com/invitations/<token>",
		"POST /api/organization-invitations/<token>/accept",
		"/login?redirect=%2Finvitations%2F<token>&next=1",
		"redirect=%2forganization-invitations%2f<token>",
		"/onboarding?redirect=%252Finvitations%252F<token>",
		"/login?redirect=%2Fonboarding%3Fredirect%3D%252Finvitations%252F<token>",
		"redirect=%25252Finvitations%25252F<token>",
		"redirect=%252forganization-invitations%252f<token>",
		// 不含邀请路径的输入原样返回（规则不误伤）
		"/login?redirect=%252Fhome%252Fsettings",
		"/organization/members",
		"TypeError: boom",
	];

	test("同一输入，两份实现输出一致、等于预期，且 token 不残留", () => {
		for (const template of templates) {
			const expected = masked(template);
			expect(maskWeb(input(template))).toBe(expected);
			expect(maskServer(input(template))).toBe(expected);
		}
	});
});
