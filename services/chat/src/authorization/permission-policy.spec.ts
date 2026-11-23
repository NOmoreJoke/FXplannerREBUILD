import { describe, expect, it } from "vitest";

import {
	PERMISSIONS,
	type OrganizationRole,
	type Permission,
} from "./authorization.types";
import {
	can,
	canAcceptInvitation,
	canDeleteOrganization,
	canManage,
	canTransferOwnership,
	normalizeEmail,
	ROLE_PERMISSIONS,
} from "./permission-policy";

/**
 * 权限策略防愚弄测试（技术方案 §14.1）：
 * 期望矩阵在测试内独立书写（与实现表互为对照），逐格断言 5 角色 × 28 权限点，
 * 杜绝「表即测试」的同义反复。
 */

/** 期望矩阵（唯一真源 = 需求 §7.3 固定角色矩阵 + 补充规则） */
const EXPECTED: Record<OrganizationRole, ReadonlySet<string>> = {
	OWNER: new Set<string>(PERMISSIONS),
	ADMIN: new Set<string>([
		"organization.read",
		"organization.update",
		"member.read",
		"member.invite",
		"member.update",
		"member.remove",
		"settings.read",
		"settings.update",
		"account.read",
		"plan.read",
		"plan.create",
		"plan.adjust",
		"transaction.read",
		"transaction.create",
		"usage.read",
		"usage.create",
		"correction.read",
		"correction.preview",
		"correction.apply",
		"report.read",
		"audit.read",
		"data.export",
		"data.clear",
		"agent.use",
		"agent.business_read",
		"agent.draft",
	]),
	FINANCE: new Set<string>([
		"organization.read",
		"member.read",
		"settings.read",
		"account.read",
		"plan.read",
		"plan.create",
		"plan.adjust",
		"transaction.read",
		"transaction.create",
		"usage.read",
		"usage.create",
		"correction.read",
		"correction.preview",
		"correction.apply",
		"report.read",
		"audit.read",
		"data.export",
		"agent.use",
		"agent.business_read",
		"agent.draft",
	]),
	OPERATOR: new Set<string>([
		"organization.read",
		"member.read",
		"settings.read",
		"account.read",
		"plan.read",
		"plan.create",
		"plan.adjust",
		"transaction.read",
		"usage.read",
		"correction.read",
		"report.read",
		"agent.use",
		"agent.business_read",
		"agent.draft",
	]),
	VIEWER: new Set<string>([
		"organization.read",
		"member.read",
		"settings.read",
		"account.read",
		"plan.read",
		"transaction.read",
		"usage.read",
		"correction.read",
		"report.read",
		"agent.use",
		"agent.business_read",
	]),
};

const ROLES = Object.keys(EXPECTED) as OrganizationRole[];
const NOW = new Date("2026-11-23T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("PERMISSIONS 枚举", () => {
	it("权限点总数与技术方案 §6.1 一致（28 项，防止静默增删）", () => {
		expect(PERMISSIONS).toHaveLength(28);
	});
});

describe("can：五角色 × 全权限点矩阵", () => {
	it.each(ROLES)("%s：策略表与期望矩阵精确相等（无多授、无漏授）", (role) => {
		expect(new Set<string>(ROLE_PERMISSIONS[role])).toEqual(EXPECTED[role]);
	});

	it.each(ROLES)("%s：can() 逐格判定与期望矩阵一致（含全部拒绝格）", (role) => {
		for (const permission of PERMISSIONS as readonly Permission[]) {
			expect(can(role, permission)).toBe(EXPECTED[role].has(permission));
		}
	});

	it("关键拒绝格显式锁定（业务边界回归保护）", () => {
		// Admin 不可转移所有权、不可删除组织
		expect(can("ADMIN", "owner.transfer")).toBe(false);
		expect(can("ADMIN", "organization.delete")).toBe(false);
		// Finance 不管理成员与组织设置
		expect(can("FINANCE", "member.invite")).toBe(false);
		expect(can("FINANCE", "member.update")).toBe(false);
		expect(can("FINANCE", "organization.update")).toBe(false);
		expect(can("FINANCE", "data.clear")).toBe(false);
		// Operator 不记录买入/使用/更正、无审计与导出
		expect(can("OPERATOR", "transaction.create")).toBe(false);
		expect(can("OPERATOR", "usage.create")).toBe(false);
		expect(can("OPERATOR", "correction.apply")).toBe(false);
		expect(can("OPERATOR", "audit.read")).toBe(false);
		expect(can("OPERATOR", "data.export")).toBe(false);
		// Viewer 无任何写与草稿
		expect(can("VIEWER", "plan.create")).toBe(false);
		expect(can("VIEWER", "agent.draft")).toBe(false);
		expect(can("VIEWER", "data.export")).toBe(false);
		// Finance/Operator 的计划与草稿放行格
		expect(can("FINANCE", "data.export")).toBe(true);
		expect(can("OPERATOR", "agent.draft")).toBe(true);
	});

	it("未知角色默认拒绝（fail-closed）", () => {
		expect(can("SUPERUSER" as OrganizationRole, "account.read")).toBe(false);
		expect(can("" as OrganizationRole, "organization.read")).toBe(false);
	});
});

describe("canManage：成员管理资格矩阵", () => {
	it("Admin 对 Owner 的邀请/修改/移除一律拒绝", () => {
		for (const action of ["invite", "update", "remove"] as const) {
			expect(canManage("ADMIN", "OWNER", action)).toBe(false);
		}
	});

	it("Owner 对 Owner（含自降）拒绝——所有权变更只走转移通道", () => {
		for (const action of ["invite", "update", "remove"] as const) {
			expect(canManage("OWNER", "OWNER", action)).toBe(false);
		}
	});

	it("Owner 可管理全部非 Owner 成员", () => {
		for (const target of ["ADMIN", "FINANCE", "OPERATOR", "VIEWER"] as const) {
			for (const action of ["invite", "update", "remove"] as const) {
				expect(canManage("OWNER", target, action)).toBe(true);
			}
		}
	});

	it("Admin 仅可管理普通角色（Admin 之间互不管理）", () => {
		expect(canManage("ADMIN", "FINANCE", "update")).toBe(true);
		expect(canManage("ADMIN", "OPERATOR", "invite")).toBe(true);
		expect(canManage("ADMIN", "VIEWER", "remove")).toBe(true);
		expect(canManage("ADMIN", "ADMIN", "update")).toBe(false);
		expect(canManage("ADMIN", "ADMIN", "invite")).toBe(false);
	});

	it("Finance/Operator/Viewer 无成员管理资格", () => {
		for (const actor of ["FINANCE", "OPERATOR", "VIEWER"] as const) {
			for (const target of ["ADMIN", "FINANCE", "OPERATOR", "VIEWER"] as const) {
				expect(canManage(actor, target, "invite")).toBe(false);
			}
		}
	});
});

describe("normalizeEmail + canAcceptInvitation", () => {
	const validInvitation = {
		expiresAt: new Date(NOW.getTime() + 7 * DAY),
		acceptedAt: null,
		declinedAt: null,
		revokedAt: null,
	};

	it("邮箱 trim + 大小写规范化后匹配", () => {
		expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
		expect(
			canAcceptInvitation(" User@Example.COM ", "user@example.com", NOW, {
				...validInvitation,
			}),
		).toBe(true);
	});

	it("邮箱不匹配拒绝（规范化后仍不等）", () => {
		expect(
			canAcceptInvitation("other@example.com", "user@example.com", NOW, {
				...validInvitation,
			}),
		).toBe(false);
	});

	it("过期拒绝；恰好等于过期时刻视为已过期", () => {
		expect(
			canAcceptInvitation("user@example.com", "user@example.com", NOW, {
				...validInvitation,
				expiresAt: new Date(NOW.getTime() - 1),
			}),
		).toBe(false);
		expect(
			canAcceptInvitation("user@example.com", "user@example.com", NOW, {
				...validInvitation,
				expiresAt: new Date(NOW.getTime()),
			}),
		).toBe(false);
	});

	it("已接受 / 已拒绝 / 已撤回状态一律拒绝", () => {
		expect(
			canAcceptInvitation("user@example.com", "user@example.com", NOW, {
				...validInvitation,
				acceptedAt: new Date(NOW.getTime() - DAY),
			}),
		).toBe(false);
		expect(
			canAcceptInvitation("user@example.com", "user@example.com", NOW, {
				...validInvitation,
				declinedAt: new Date(NOW.getTime() - DAY),
			}),
		).toBe(false);
		expect(
			canAcceptInvitation("user@example.com", "user@example.com", NOW, {
				...validInvitation,
				revokedAt: new Date(NOW.getTime() - DAY),
			}),
		).toBe(false);
	});
});

describe("canTransferOwnership", () => {
	it("仅 Owner 可发起转移", () => {
		expect(
			canTransferOwnership(
				{ userId: "u1", role: "ADMIN" },
				{ userId: "u2", status: "ACTIVE" },
			),
		).toBe(false);
	});

	it("仅 ACTIVE 成员可接任（DISABLED 拒绝，须先恢复再转移）", () => {
		expect(
			canTransferOwnership(
				{ userId: "u1", role: "OWNER" },
				{ userId: "u2", status: "DISABLED" },
			),
		).toBe(false);
	});

	it("Owner 转己禁止", () => {
		expect(
			canTransferOwnership(
				{ userId: "u1", role: "OWNER" },
				{ userId: "u1", status: "ACTIVE" },
			),
		).toBe(false);
	});

	it("Owner → 其他 ACTIVE 成员放行", () => {
		expect(
			canTransferOwnership(
				{ userId: "u1", role: "OWNER" },
				{ userId: "u2", status: "ACTIVE" },
			),
		).toBe(true);
	});
});

describe("canDeleteOrganization", () => {
	it("仅 Owner 可发起删除", () => {
		expect(canDeleteOrganization({ role: "ADMIN" }, { active: false })).toBe(
			false,
		);
	});

	it("存在进行中的组织锁（清空/导出/删除）时阻断", () => {
		expect(canDeleteOrganization({ role: "OWNER" }, { active: true })).toBe(
			false,
		);
	});

	it("Owner 且无冲突锁放行", () => {
		expect(canDeleteOrganization({ role: "OWNER" }, { active: false })).toBe(
			true,
		);
	});
});
