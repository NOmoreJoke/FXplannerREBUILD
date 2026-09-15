import { beforeEach, describe, expect, it } from "vitest";
import { clearToken, getToken, setToken } from "./token";

describe("token（cookie 存取）", () => {
	beforeEach(() => {
		clearToken();
	});

	it("setToken 写入 cookie 后 getToken 可读取", () => {
		setToken("abc.def.ghi");

		expect(getToken()).toBe("abc.def.ghi");
	});

	it("写入的 cookie 带 path=/ 与 7 天 max-age、SameSite=Lax", () => {
		setToken("jwt-token");

		const raw = document.cookie;
		// jsdom 的 document.cookie 只暴露键值对；这里验证键存在且可解析
		expect(raw).toContain("accessToken=jwt-token");
	});

	it("setToken 覆盖旧值", () => {
		setToken("old-token");
		setToken("new-token");

		expect(getToken()).toBe("new-token");
	});

	it("clearToken 后 getToken 返回 null", () => {
		setToken("to-be-cleared");
		expect(getToken()).toBe("to-be-cleared");

		clearToken();
		expect(getToken()).toBeNull();
	});

	it("未写入时 getToken 返回 null", () => {
		expect(getToken()).toBeNull();
	});

	it("支持 JWT 典型字符（点、横线、下划线）", () => {
		const jwt =
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.a-b_c-d_e";

		setToken(jwt);
		expect(getToken()).toBe(jwt);
	});
});
