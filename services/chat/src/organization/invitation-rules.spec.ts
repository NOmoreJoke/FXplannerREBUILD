import { describe, expect, it } from "vitest";
import {
	findReusableInvitation,
	generateInvitationToken,
	hashInvitationToken,
	invitationExpiresAt,
	invitationStatus,
	isInvitationOpen,
} from "./invitation-rules";

/**
 * 邀请规则防愚弄测试（技术方案 §14.1；W19 必配）。
 * 覆盖：token 熵/单向 hash、7 天有效期、状态机（过期/撤回/接受/拒绝）、
 * 幂等复用、邮箱规范化匹配。
 */

const NOW = new Date("2026-11-23T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function record(overrides: Partial<Parameters<typeof isInvitationOpen>[0]> = {}) {
	return {
		id: "inv-1",
		organizationId: "org-a",
		email: "user@example.com",
		role: "FINANCE",
		expiresAt: new Date(NOW.getTime() + 7 * DAY),
		acceptedAt: null,
		declinedAt: null,
		revokedAt: null,
		...overrides,
	};
}

describe("token 生成与单向 hash", () => {
	it("token 高熵且不重复（43 字符 base64url）", () => {
		const tokens = new Set(
			Array.from({ length: 200 }, () => generateInvitationToken()),
		);
		expect(tokens.size).toBe(200);
		for (const token of tokens) {
			expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		}
	});

	it("hash 为 64 位 hex 且不可逆推原文（SHA-256）", () => {
		const token = generateInvitationToken();
		const hash = hashInvitationToken(token);
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
		expect(hash).not.toContain(token);
		expect(hashInvitationToken(token)).toBe(hash); // 确定性
		expect(hashInvitationToken("另一个token")).not.toBe(hash);
	});

	it("过期时刻 = 创建时刻 + 7 天", () => {
		const expiresAt = invitationExpiresAt(NOW);
		expect(expiresAt.getTime() - NOW.getTime()).toBe(7 * DAY);
	});
});

describe("isInvitationOpen 状态机", () => {
	it("开放邀请：未接受/拒绝/撤回且未过期", () => {
		expect(isInvitationOpen(record(), NOW)).toBe(true);
	});

	it("过期拒绝（恰好到期时刻视为过期）", () => {
		expect(
			isInvitationOpen(record({ expiresAt: new Date(NOW.getTime() - 1) }), NOW),
		).toBe(false);
		expect(isInvitationOpen(record({ expiresAt: NOW }), NOW)).toBe(false);
	});

	it("已接受 / 已拒绝 / 已撤回一律关闭", () => {
		expect(
			isInvitationOpen(record({ acceptedAt: new Date(NOW.getTime() - DAY) }), NOW),
		).toBe(false);
		expect(
			isInvitationOpen(record({ declinedAt: new Date(NOW.getTime() - DAY) }), NOW),
		).toBe(false);
		expect(
			isInvitationOpen(record({ revokedAt: new Date(NOW.getTime() - DAY) }), NOW),
		).toBe(false);
	});
});

describe("invitationStatus 归并", () => {
	it("五态归并与优先级（终态 > 过期 > 开放）", () => {
		expect(invitationStatus(record(), NOW)).toBe("OPEN");
		expect(
			invitationStatus(record({ expiresAt: new Date(NOW.getTime() - 1) }), NOW),
		).toBe("EXPIRED");
		expect(
			invitationStatus(record({ acceptedAt: NOW }), NOW),
		).toBe("ACCEPTED");
		expect(
			invitationStatus(record({ declinedAt: NOW }), NOW),
		).toBe("DECLINED");
		expect(invitationStatus(record({ revokedAt: NOW }), NOW)).toBe("REVOKED");
		// 接受后过期：终态优先
		expect(
			invitationStatus(
				record({ acceptedAt: NOW, expiresAt: new Date(NOW.getTime() - 1) }),
				NOW,
			),
		).toBe("ACCEPTED");
	});
});

describe("findReusableInvitation 幂等复用（MEM-01.5）", () => {
	it("同组织同邮箱的开放邀请被复用（大小写/空白不敏感）", () => {
		const existing = record({ email: "user@example.com" });
		const found = findReusableInvitation(
			[existing],
			"org-a",
			"  User@Example.COM ",
			NOW,
		);
		expect(found?.id).toBe("inv-1");
	});

	it("他组织 / 他邮箱 / 已结束邀请不复用", () => {
		const existing = record();
		expect(findReusableInvitation([existing], "org-b", "user@example.com", NOW)).toBeNull();
		expect(findReusableInvitation([existing], "org-a", "other@example.com", NOW)).toBeNull();
		expect(
			findReusableInvitation(
				[record({ acceptedAt: NOW })],
				"org-a",
				"user@example.com",
				NOW,
			),
		).toBeNull();
	});
});
