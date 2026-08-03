import { describe, expect, it } from "vitest";
import { maskSensitiveText, truncate } from "./mask.js";

describe("maskSensitiveText", () => {
	it("脱敏 Bearer Token", () => {
		expect(maskSensitiveText("Authorization: Bearer abc.def.ghi")).toBe(
			"Authorization: Bearer ***",
		);
	});

	it("脱敏 URL query 中的 token/password", () => {
		expect(maskSensitiveText("/api/login?token=abc123&password=pwd&a=1")).toBe(
			"/api/login?token=***&password=***&a=1",
		);
		expect(maskSensitiveText("access_token=xyz")).toBe("access_token=***");
	});

	it("脱敏 JSON 中的 authorization/cookie 头", () => {
		expect(maskSensitiveText('{"authorization":"Bearer abc"}')).toBe(
			'{"authorization":"***"}',
		);
		expect(maskSensitiveText('{"cookie":"session=abc"}')).toBe(
			'{"cookie":"***"}',
		);
	});

	it("脱敏 JSON 中的 password/token 字段", () => {
		expect(maskSensitiveText('{"password":"123456","name":"u"}')).toBe(
			'{"password":"***","name":"u"}',
		);
		expect(maskSensitiveText('{"accessToken":"at","refreshToken":"rt"}')).toBe(
			'{"accessToken":"***","refreshToken":"***"}',
		);
	});

	it("普通文本不受影响", () => {
		expect(
			maskSensitiveText("TypeError: Cannot read properties of undefined"),
		).toBe("TypeError: Cannot read properties of undefined");
	});
});

describe("truncate", () => {
	it("超长截断", () => {
		expect(truncate("abcdef", 3)).toBe("abc");
	});

	it("未超长原样返回", () => {
		expect(truncate("abc", 3)).toBe("abc");
	});
});
