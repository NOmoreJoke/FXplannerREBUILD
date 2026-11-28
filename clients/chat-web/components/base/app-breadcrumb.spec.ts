import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCrumbs } from "./app-breadcrumb";

const PROTECTED_APP_DIR = path.resolve(__dirname, "../../app/(protected)");
const HAS_CHINESE_RE = /[\u4e00-\u9fff]/;

function collectProtectedRoutes(dir: string, prefix = ""): string[] {
	const routes: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const segment =
			entry.name === "[currency]"
				? "usd"
				: entry.name === "[token]"
					? "inv_SECRET_token_9281"
					: entry.name.startsWith("[") && entry.name.endsWith("]")
						? "rec_123"
						: entry.name;
		const nextPrefix = `${prefix}/${segment}`;
		const subDir = path.join(dir, entry.name);
		if (fs.existsSync(path.join(subDir, "page.tsx"))) {
			routes.push(nextPrefix);
		}
		routes.push(...collectProtectedRoutes(subDir, nextPrefix));
	}
	return routes;
}

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
		expect(resolveCrumbs("/transactions/new")).toEqual([{ label: "快速录入" }]);
		expect(resolveCrumbs("/transactions/tx_01")).toEqual([
			{ label: "交易详情" },
		]);
	});

	it("补齐其余全部受保护路由中文映射", () => {
		expect(resolveCrumbs("/reports")).toEqual([{ label: "我的报告" }]);
		expect(resolveCrumbs("/market")).toEqual([{ label: "汇率行情" }]);
		expect(resolveCrumbs("/chat")).toEqual([{ label: "AI 助手" }]);
		expect(resolveCrumbs("/reminders")).toEqual([{ label: "提醒中心" }]);
		expect(resolveCrumbs("/onboarding")).toEqual([{ label: "首次建账" }]);
		expect(resolveCrumbs("/settings")).toEqual([{ label: "设置" }]);
		expect(resolveCrumbs("/data-requests")).toEqual([{ label: "数据请求进度" }]);
		expect(resolveCrumbs("/corrections/new")).toEqual([{ label: "发起更正" }]);
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

	it("正向守卫：自动扫描 app/(protected) 全部页面，强制全部具备中文面包屑且不泄露 token", () => {
		const routes = collectProtectedRoutes(PROTECTED_APP_DIR);
		expect(routes.length).toBeGreaterThanOrEqual(15);
		for (const route of routes) {
			const crumbs = resolveCrumbs(route);
			expect(crumbs.length).toBeGreaterThan(0);
			for (const crumb of crumbs) {
				expect(crumb.label).toMatch(HAS_CHINESE_RE);
				expect(crumb.label).not.toContain("inv_SECRET_token_9281");
			}
		}
	});

	it("负向反证：未登记的英文路径回退原名且不含中文，确保漏配必被守卫捕获；空路径无面包屑", () => {
		const unmapped = resolveCrumbs("/unmapped-english-route");
		expect(unmapped).toEqual([{ label: "unmapped-english-route" }]);
		expect(unmapped[0]?.label).not.toMatch(HAS_CHINESE_RE);
		expect(resolveCrumbs("/")).toEqual([]);
	});
});
