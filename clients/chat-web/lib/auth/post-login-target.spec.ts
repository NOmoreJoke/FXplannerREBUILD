import { describe, expect, it } from "vitest";
import { resolvePostLoginTarget } from "./post-login-target";

/**
 * 登录后落地页解析（W30 · MIG-D：关闭「缺组织头猜唯一默认组织」的兼容窗口）
 *
 * 回归要点：登录时组织选择已被会话重置清空，前端**不得**再靠组织域的
 * GET /onboarding/status 判定建账态（缺组织头一律 400 ORGANIZATION_REQUIRED），
 * 改用个人域的 GET /organizations 列表项（自带 onboardingCompleted）。
 */
describe("resolvePostLoginTarget", () => {
	it("唯一组织且未建账 → 进建账向导（无来源页时不带 redirect 参数）", () => {
		expect(
			resolvePostLoginTarget([{ onboardingCompleted: false }], undefined),
		).toBe("/onboarding");
	});

	it("唯一组织且未建账 → 进建账向导并带上登录前来源页（受邀者据此继续接受邀请）", () => {
		expect(
			resolvePostLoginTarget(
				[{ onboardingCompleted: false }],
				"/invitations/token-123",
			),
		).toBe("/onboarding?redirect=%2Finvitations%2Ftoken-123");
	});

	it("唯一组织且已建账 → 回登录前来源页；无来源页时回首页", () => {
		expect(
			resolvePostLoginTarget([{ onboardingCompleted: true }], "/plans"),
		).toBe("/plans");
		expect(
			resolvePostLoginTarget([{ onboardingCompleted: true }], undefined),
		).toBe("/home");
	});

	it("0 组织 → 回登录前来源页 / 首页（新建组织引导交给受保护区布局）", () => {
		expect(resolvePostLoginTarget([], "/plans")).toBe("/plans");
		expect(resolvePostLoginTarget([], undefined)).toBe("/home");
	});

	it("多组织 → 不猜组织，回登录前来源页 / 首页（由组织选择页分流）", () => {
		const organizations = [
			{ onboardingCompleted: false },
			{ onboardingCompleted: true },
		];
		expect(resolvePostLoginTarget(organizations, "/plans")).toBe("/plans");
		expect(resolvePostLoginTarget(organizations, undefined)).toBe("/home");
	});
});
