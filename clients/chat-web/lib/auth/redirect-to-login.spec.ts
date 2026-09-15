import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	redirectToLogin,
	resetRedirectToLoginForTest,
} from "./redirect-to-login";

const assignMock = vi.fn();

describe("redirectToLogin（统一跳登录出口）", () => {
	beforeEach(() => {
		resetRedirectToLoginForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		// vi.fn() 的调用记录不受 restoreAllMocks 影响，需手动清，避免跨用例串扰
		assignMock.mockClear();
	});

	function stubLocation(pathname: string) {
		vi.stubGlobal("window", {
			location: {
				pathname,
				assign: assignMock,
			},
		});
	}

	it("跳转到 /login 并携带 encodeURIComponent 后的 redirect", () => {
		stubLocation("/plans");

		redirectToLogin("/plans?a=1&b=2");

		expect(assignMock).toHaveBeenCalledTimes(1);
		expect(assignMock).toHaveBeenCalledWith(
			"/login?redirect=%2Fplans%3Fa%3D1%26b%3D2",
		);
	});

	it("已在 /login 时不重复跳转", () => {
		stubLocation("/login");

		redirectToLogin("/login");

		expect(assignMock).not.toHaveBeenCalled();
	});

	it("同一页面生命周期内只跳转一次（防重复）", () => {
		stubLocation("/home");

		redirectToLogin("/home");
		redirectToLogin("/home");

		expect(assignMock).toHaveBeenCalledTimes(1);
		expect(assignMock).toHaveBeenCalledWith("/login?redirect=%2Fhome");
	});
});
