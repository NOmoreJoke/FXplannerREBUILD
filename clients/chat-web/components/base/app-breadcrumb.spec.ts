import { describe, expect, it } from "vitest";
import { resolveCrumbs } from "./app-breadcrumb";

describe("resolveCrumbs（面包屑唯一映射来源）", () => {
	it("既有路由的标签契约不变", () => {
		expect(resolveCrumbs("/home")).toEqual([{ label: "首页" }]);
		expect(resolveCrumbs("/plans/new")).toEqual([
			{ label: "换汇计划", href: "/plans" },
			{ label: "新建计划" },
		]);
		expect(resolveCrumbs("/plans/plan_abc")).toEqual([
			{ label: "换汇计划", href: "/plans" },
			{ label: "计划详情" },
		]);
	});

	it("邀请页：显示语义化名称，一次性邀请 token 不得出现在面包屑里", () => {
		const crumbs = resolveCrumbs("/invitations/inv_SECRET_token_9281");
		expect(crumbs).toEqual([{ label: "加入组织" }]);
		expect(JSON.stringify(crumbs)).not.toContain("inv_SECRET_token_9281");
	});

	it("组织页：父级可点击回到 /organization，子页语义化", () => {
		expect(resolveCrumbs("/organization")).toEqual([{ label: "组织" }]);
		expect(resolveCrumbs("/organization/members")).toEqual([
			{ label: "组织", href: "/organization" },
			{ label: "成员与邀请" },
		]);
		expect(resolveCrumbs("/organization/audit")).toEqual([
			{ label: "组织", href: "/organization" },
			{ label: "审计记录" },
		]);
	});

	it("未登记路径仍兜底显示段落原名；空路径无面包屑", () => {
		expect(resolveCrumbs("/reports")).toEqual([{ label: "reports" }]);
		expect(resolveCrumbs("/")).toEqual([]);
	});
});
