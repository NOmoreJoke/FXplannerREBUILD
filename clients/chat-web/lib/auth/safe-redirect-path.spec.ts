import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "./safe-redirect-path";

describe("safeRedirectPath（redirect 白名单）", () => {
	it("接受站内绝对路径", () => {
		expect(safeRedirectPath("/home")).toBe("/home");
		expect(safeRedirectPath("/plans/123")).toBe("/plans/123");
		expect(safeRedirectPath("/")).toBe("/");
	});

	it("接受带查询参数的站内路径", () => {
		expect(safeRedirectPath("/plans?tab=done")).toBe("/plans?tab=done");
	});

	it("拒绝协议相对路径（开放重定向）", () => {
		expect(safeRedirectPath("//evil.com")).toBeUndefined();
		expect(safeRedirectPath("///evil.com")).toBeUndefined();
	});

	it("拒绝绝对外链与协议地址", () => {
		expect(safeRedirectPath("https://evil.com")).toBeUndefined();
		expect(safeRedirectPath("http://evil.com/path")).toBeUndefined();
		expect(safeRedirectPath("javascript:alert(1)")).toBeUndefined();
	});

	it("拒绝相对路径与非 / 开头", () => {
		expect(safeRedirectPath("home")).toBeUndefined();
		expect(safeRedirectPath("../home")).toBeUndefined();
	});

	it("空值返回 undefined", () => {
		expect(safeRedirectPath(null)).toBeUndefined();
		expect(safeRedirectPath(undefined)).toBeUndefined();
		expect(safeRedirectPath("")).toBeUndefined();
	});
});
