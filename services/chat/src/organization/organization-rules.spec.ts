import { describe, expect, it } from "vitest";
import {
	buildCapabilities,
	isLastActiveOwner,
	isValidRole,
	normalizeOrganizationName,
} from "./organization-rules";
import { can } from "../authorization/permission-policy";

/** 组织/成员规则防愚弄测试（技术方案 §14.1；W19 必配） */

describe("buildCapabilities（真源一致性）", () => {
	it("与 can() 逐点一致（Owner 全真；Viewer 无写）", () => {
		const owner = buildCapabilities("OWNER");
		const viewer = buildCapabilities("VIEWER");
		for (const [permission, allowed] of Object.entries(owner)) {
			expect(allowed).toBe(can("OWNER", permission as never));
		}
		expect(viewer["plan.create"]).toBe(false);
		expect(viewer["agent.draft"]).toBe(false);
		expect(viewer["organization.read"]).toBe(true);
	});
});

describe("isLastActiveOwner（ORG-03.3 最后 Owner 保护）", () => {
	it("唯一活跃 OWNER → 保护生效（退出/移除/降权全拒绝）", () => {
		expect(isLastActiveOwner(1, "OWNER", "ACTIVE")).toBe(true);
		expect(isLastActiveOwner(0, "OWNER", "ACTIVE")).toBe(true);
	});

	it("多活跃 OWNER 或非 Owner 目标 → 不保护", () => {
		expect(isLastActiveOwner(2, "OWNER", "ACTIVE")).toBe(false);
		expect(isLastActiveOwner(1, "ADMIN", "ACTIVE")).toBe(false);
		expect(isLastActiveOwner(1, "OWNER", "DISABLED")).toBe(false);
	});
});

describe("isValidRole / normalizeOrganizationName", () => {
	it("五角色枚举内合法", () => {
		for (const role of ["OWNER", "ADMIN", "FINANCE", "OPERATOR", "VIEWER"]) {
			expect(isValidRole(role)).toBe(true);
		}
		expect(isValidRole("SUPERUSER")).toBe(false);
		expect(isValidRole("owner ")).toBe(false);
	});

	it("组织名 trim", () => {
		expect(normalizeOrganizationName("  张三的工作台 ")).toBe("张三的工作台");
	});
});
